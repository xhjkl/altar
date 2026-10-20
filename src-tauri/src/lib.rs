mod config;
pub use config::command as config_command;
mod fixture;
mod journal;
mod protocol;
mod shell;
mod sql;
mod stream;
mod vitals;

use config::MachineConfig;
use journal::Tail;
use protocol::{
    CellEdit, Detail, FrameRequest, Machine, Metrics, Query, Selection, View, Workspace,
};
use sql::Workbench;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use stream::Frame;
use tauri::{RunEvent, State};
use vitals::Vitals;

/// Successful discovery cached per host; the scan lock never blocks existing workbenches.
#[derive(Default)]
struct SqlDiscovery {
    scanning: Mutex<()>,
    sources: OnceLock<Vec<sql::Source>>,
}

/// One configured machine's long-lived connections, created on first use and kept across reloads.
struct Session {
    config: MachineConfig,
    tail: Arc<Tail>,
    vitals: Arc<Vitals>,
    workbenches: Mutex<HashMap<String, Arc<Workbench>>>,
    discovered: Arc<SqlDiscovery>,
}

impl Session {
    fn new(config: MachineConfig) -> Arc<Self> {
        Arc::new(Self {
            tail: Tail::new(config.host.clone(), config.history),
            vitals: Vitals::new(config.host.clone()),
            workbenches: Mutex::new(HashMap::new()),
            discovered: Arc::new(SqlDiscovery::default()),
            config,
        })
    }

    fn workbench(&self, source: &str) -> Result<Arc<Workbench>, String> {
        let mut workbenches = self
            .workbenches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(workbench) = workbenches.get(source) {
            return Ok(Arc::clone(workbench));
        }
        let discovered = self.discovered.sources.get();
        let view = self
            .config
            .sql
            .iter()
            .chain(discovered.into_iter().flatten())
            .find(|view| view.id == source)
            .ok_or_else(|| format!("{} has no SQL source called {source}.", self.config.name))?;
        let workbench = Arc::new(Workbench::new(self.config.host.clone(), view.psql.clone()));
        workbenches.insert(source.into(), Arc::clone(&workbench));
        Ok(workbench)
    }

    /// Cache one quiet discovery per host session; failed SSH attempts can be retried on reopening.
    fn discover_sql(&self) -> Result<(), String> {
        let _scanning = self
            .discovered
            .scanning
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.discovered.sources.get().is_some() {
            return Ok(());
        }
        let sources = sql::discover(&self.config.host)?;
        self.discovered
            .sources
            .set(sources)
            .expect("discovery lock serializes initialization");
        Ok(())
    }

    fn machine(&self) -> Machine {
        let logs = self.config.logs.iter().map(|view| View {
            id: view.id.clone(),
            name: view.name.clone(),
            query: Query::Logs {
                filter: view.filter.clone(),
            },
        });
        let discovered = self.discovered.sources.get();
        let sql = self
            .config
            .sql
            .iter()
            .chain(discovered.into_iter().flatten().filter(|view| {
                !self
                    .config
                    .sql
                    .iter()
                    .any(|configured| configured.name == view.name)
            }))
            .map(|view| View {
                id: view.id.clone(),
                name: view.name.clone(),
                query: Query::Sql {
                    source: view.id.clone(),
                    statement: view.statement.clone(),
                    run: 0,
                },
            });
        Machine {
            id: self.config.id.clone(),
            name: self.config.name.clone(),
            online: true,
            views: logs.chain(sql).collect(),
        }
    }
}

#[derive(Default)]
struct App {
    sessions: Mutex<Vec<Arc<Session>>>,
}

impl App {
    /// Recover the last loaded workspace after a request panics.
    fn sessions(&self) -> MutexGuard<'_, Vec<Arc<Session>>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reconcile configured machines while retaining connections whose settings still match.
    fn configure(&self, configs: Vec<MachineConfig>) -> Vec<Arc<Session>> {
        let mut sessions = self.sessions();
        let next: Vec<Arc<Session>> = configs
            .into_iter()
            .map(|config| {
                let Some(existing) = sessions.iter().find(|session| {
                    session.config.id == config.id && session.config.host == config.host
                }) else {
                    return Session::new(config);
                };
                let workbenches = existing
                    .workbenches
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let discovered = existing.discovered.sources.get();
                let workbenches = workbenches
                    .iter()
                    .filter(|(source, _)| {
                        if discovered.into_iter().flatten().any(|view| view.id == **source) { return true; }
                        let previous = existing.config.sql.iter().find(|view| view.id == **source);
                        let next = config.sql.iter().find(|view| view.id == **source);
                        matches!((previous, next), (Some(previous), Some(next)) if previous.psql == next.psql)
                    })
                    .map(|(source, workbench)| (source.clone(), Arc::clone(workbench)))
                    .collect();
                let tail = if existing.config.history == config.history {
                    Arc::clone(&existing.tail)
                } else {
                    Tail::new(config.host.clone(), config.history)
                };
                Arc::new(Session {
                    tail,
                    vitals: Arc::clone(&existing.vitals),
                    workbenches: Mutex::new(workbenches),
                    discovered: Arc::clone(&existing.discovered),
                    config,
                })
            })
            .collect();
        *sessions = next.clone();
        next
    }

    fn session(&self, machine: &str) -> Option<Arc<Session>> {
        self.sessions()
            .iter()
            .find(|session| session.config.id == machine)
            .cloned()
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// Load configured machines unless a fixture scene was explicitly requested.
#[tauri::command]
async fn workspace(scene: Option<String>, app: State<'_, Arc<App>>) -> Result<Workspace, String> {
    if let Some(scene) = scene {
        return Ok(fixture::workspace(&scene));
    }
    let app = Arc::clone(&app);
    blocking(move || {
        let configs = config::load()?;
        let sessions = app.configure(configs);
        let machines: Vec<Machine> = sessions.iter().map(|session| session.machine()).collect();
        let first = machines
            .iter()
            .find(|machine| !machine.views.is_empty())
            .ok_or("No machine has a view yet.")?;
        let selection = Selection {
            machine: first.id.clone(),
            view: first.views[0].id.clone(),
        };
        Ok(Workspace {
            machines,
            selection,
            tick: 0,
            paused_at: None,
            inspect: None,
        })
    })
    .await
}

/// Add usable databases after opening a machine, without delaying its logs or vitals.
#[tauri::command]
async fn discover_sql(machine: String, app: State<'_, Arc<App>>) -> Result<Machine, String> {
    let session = app
        .session(&machine)
        .ok_or("That machine is no longer configured.")?;
    blocking(move || {
        session.discover_sql()?;
        Ok(session.machine())
    })
    .await
}

#[tauri::command]
async fn render_frame(request: FrameRequest, app: State<'_, Arc<App>>) -> Result<Frame, String> {
    let Some(session) = app.session(&request.machine) else {
        return fixture::render_frame(request);
    };
    blocking(move || match &request.query {
        Query::Logs { filter } => session
            .tail
            .frame(filter, request.paused_at, &request.viewport),
        Query::Sql {
            source,
            statement,
            run,
        } => session
            .workbench(source)?
            .frame(statement, *run, &request.viewport),
    })
    .await
}

#[tauri::command]
async fn inspect_row(
    machine: String,
    query: Query,
    id: usize,
    app: State<'_, Arc<App>>,
) -> Result<Detail, String> {
    let Some(session) = app.session(&machine) else {
        return Ok(fixture::inspect_row(&machine, query, id));
    };
    blocking(move || match &query {
        Query::Logs { .. } => session.tail.detail(id),
        Query::Sql {
            source,
            statement,
            run,
        } => session.workbench(source)?.detail(statement, *run, id),
    })
    .await
}

#[tauri::command]
async fn update_cell(edit: CellEdit, app: State<'_, Arc<App>>) -> Result<Detail, String> {
    let session = app
        .session(&edit.machine)
        .ok_or("Sample rows are read only.")?;
    blocking(move || match &edit.query {
        Query::Logs { .. } => Err("Journal entries are read only.".into()),
        Query::Sql {
            source,
            statement,
            run,
        } => session.workbench(source)?.update(
            statement,
            *run,
            edit.id,
            &edit.field,
            edit.value.as_deref(),
        ),
    })
    .await
}

#[tauri::command]
async fn metrics(
    machine: String,
    tick: usize,
    app: State<'_, Arc<App>>,
) -> Result<Metrics, String> {
    let Some(session) = app.session(&machine) else {
        return Ok(fixture::metrics(&machine, tick));
    };
    blocking(move || session.vitals.metrics(&machine)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(App::default()))
        .invoke_handler(tauri::generate_handler![
            workspace,
            discover_sql,
            render_frame,
            inspect_row,
            update_cell,
            metrics
        ])
        .build(tauri::generate_context!())
        .expect("error while building Altar")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                // Remote `journalctl -f` processes would otherwise outlive their reader.
                shell::reap();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use config::LogsView;
    use shell::Host;
    use sql::Source;

    #[test]
    fn configuration_changes_retain_only_matching_connections() {
        let machine = |host: Host, history, psql: &str| MachineConfig {
            id: "machine".into(),
            name: "Machine".into(),
            host,
            history,
            logs: vec![LogsView {
                id: "logs".into(),
                name: "Logs".into(),
                filter: String::new(),
            }],
            sql: vec![Source {
                id: "sql".into(),
                name: "SQL".into(),
                psql: psql.into(),
                statement: "select 1".into(),
            }],
        };
        let app = App::default();
        let first = app.configure(vec![machine(Host::Local, 20, "psql first")]);
        let first = &first[0];
        let workbench = first.workbench("sql").unwrap();
        first
            .discovered
            .sources
            .set(vec![Source {
                id: "discovered".into(),
                name: "Database".into(),
                psql: "psql discovered".into(),
                statement: sql::DEFAULT_STATEMENT.into(),
            }])
            .unwrap();
        let discovered = first.workbench("discovered").unwrap();
        assert!(first
            .machine()
            .views
            .iter()
            .any(|view| view.id == "discovered"));
        let same = app.configure(vec![machine(Host::Local, 20, "psql first")]);
        let same = &same[0];
        let same_workbench = same.workbench("sql").unwrap();
        assert!(Arc::ptr_eq(&first.tail, &same.tail));
        assert!(Arc::ptr_eq(&first.vitals, &same.vitals));
        assert!(Arc::ptr_eq(&workbench, &same_workbench));
        assert!(Arc::ptr_eq(
            &discovered,
            &same.workbench("discovered").unwrap()
        ));

        let history = app.configure(vec![machine(Host::Local, 40, "psql first")]);
        let history = &history[0];
        let history_workbench = history.workbench("sql").unwrap();
        assert!(!Arc::ptr_eq(&same.tail, &history.tail));
        assert!(Arc::ptr_eq(&same.vitals, &history.vitals));
        assert!(Arc::ptr_eq(&workbench, &history_workbench));

        let database = app.configure(vec![machine(Host::Local, 40, "psql second")]);
        let database = &database[0];
        let database_workbench = database.workbench("sql").unwrap();
        assert!(Arc::ptr_eq(&history.tail, &database.tail));
        assert!(Arc::ptr_eq(&history.vitals, &database.vitals));
        assert!(!Arc::ptr_eq(&workbench, &database_workbench));

        let host = app.configure(vec![machine(Host::Ssh("other".into()), 40, "psql second")]);
        let host = &host[0];
        let host_workbench = host.workbench("sql").unwrap();
        assert!(!Arc::ptr_eq(&database.tail, &host.tail));
        assert!(!Arc::ptr_eq(&database.vitals, &host.vitals));
        assert!(!Arc::ptr_eq(&database_workbench, &host_workbench));
        assert!(host.workbench("discovered").is_err());

        let mut without_sql = machine(Host::Ssh("other".into()), 40, "psql second");
        without_sql.sql.clear();
        let without_sql = app.configure(vec![without_sql]);
        assert!(without_sql[0].workbench("sql").is_err());
        assert!(app.session("machine").is_some());
        let none = app.configure(Vec::new());
        assert!(none.is_empty());
        assert!(app.session("machine").is_none());
    }
}
