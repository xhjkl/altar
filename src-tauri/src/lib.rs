mod config;
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

/// One machine's connections, created on first use and retained while the app is open.
struct Session {
    config: MachineConfig,
    tail: Option<Arc<Tail>>,
    vitals: Arc<Vitals>,
    workbenches: Mutex<HashMap<String, Arc<Workbench>>>,
    discovered: SqlDiscovery,
}

impl Session {
    fn new(config: MachineConfig) -> Arc<Self> {
        let tail = if config.journal {
            let tail = Tail::new(config.host.clone(), 20_000);
            Some(tail)
        } else {
            None
        };
        let vitals = Vitals::new(config.host.clone());
        Arc::new(Self {
            tail,
            vitals,
            workbenches: Mutex::new(HashMap::new()),
            discovered: SqlDiscovery::default(),
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
        let view = self
            .discovered
            .sources
            .get()
            .into_iter()
            .flatten()
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
        let mut views = Vec::new();
        if self.config.journal {
            views.extend([
                View {
                    id: "logs-all".into(),
                    name: "All activity".into(),
                    query: Query::Logs {
                        filter: String::new(),
                    },
                },
                View {
                    id: "logs-trouble".into(),
                    name: "Warnings & errors".into(),
                    query: Query::Logs {
                        filter: "level:warn+".into(),
                    },
                },
            ]);
        }
        views.extend(
            self.discovered
                .sources
                .get()
                .into_iter()
                .flatten()
                .map(|view| View {
                    id: view.id.clone(),
                    name: view.name.clone(),
                    query: Query::Sql {
                        source: view.id.clone(),
                        statement: view.statement.clone(),
                        run: 0,
                    },
                }),
        );
        let connection = self.vitals.connection();
        Machine {
            id: self.config.id(),
            name: self.config.name.clone(),
            connection,
            views,
        }
    }
}

#[derive(Default)]
struct App {
    sessions: Mutex<Vec<Arc<Session>>>,
}

impl App {
    fn sessions(&self) -> MutexGuard<'_, Vec<Arc<Session>>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Retain live connections when reopening the workspace.
    fn configure(&self, configs: Vec<MachineConfig>) -> Vec<Arc<Session>> {
        let mut sessions = self.sessions();
        let mut next = Vec::with_capacity(configs.len());
        for config in configs {
            if let Some(existing) = sessions.iter().find(|session| session.config == config) {
                next.push(Arc::clone(existing));
                continue;
            }
            let session = Session::new(config);
            next.push(session);
        }
        *sessions = next.clone();
        next
    }

    /// Persist a verified connection before making it visible; repeated connects select the existing machine.
    fn add(&self, config: MachineConfig) -> Result<Arc<Session>, String> {
        let mut sessions = self.sessions();
        if let Some(existing) = sessions
            .iter()
            .find(|session| session.config.host == config.host)
        {
            return Ok(Arc::clone(existing));
        }
        let mut configs = config::load()?;
        let config = if let Some(saved) = configs.iter().find(|saved| saved.host == config.host) {
            saved.clone()
        } else {
            configs.push(config.clone());
            config::save(&configs)?;
            config
        };
        let session = Session::new(config);
        sessions.push(Arc::clone(&session));
        Ok(session)
    }

    fn session(&self, machine: &str) -> Option<Arc<Session>> {
        self.sessions()
            .iter()
            .find(|session| session.config.id() == machine)
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
        let local_hostname = shell::hostname()?;
        let sessions = if configs.is_empty() && cfg!(unix) {
            let host = shell::Host::Local;
            let (name, journal) = host.connect()?;
            let session = app.add(MachineConfig {
                name,
                host,
                journal,
            })?;
            vec![session]
        } else {
            app.configure(configs)
        };
        let machines: Vec<Machine> = sessions.iter().map(|session| session.machine()).collect();
        let selection = machines.first().map(|machine| Selection {
            machine: machine.id.clone(),
            view: machine.views.first().map(|view| view.id.clone()),
        });
        Ok(Workspace {
            local_hostname,
            machines,
            selection,
            tick: 0,
            paused_at: None,
            inspect: None,
        })
    })
    .await
}

/// Connect through the user's SSH setup, then save the verified machine for subsequent launches.
#[tauri::command]
async fn connect_machine(
    destination: Option<String>,
    app: State<'_, Arc<App>>,
) -> Result<Machine, String> {
    let app = Arc::clone(&app);
    blocking(move || {
        let host = match destination {
            Some(destination) => shell::Host::Ssh(destination.trim().into()),
            None => shell::Host::Local,
        };
        let (name, journal) = host.connect()?;
        let session = app.add(MachineConfig {
            name,
            host,
            journal,
        })?;
        Ok(session.machine())
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

/// Keep reachability monitoring active independently of workbench and vitals visibility.
#[tauri::command]
fn machine_status(
    machine: String,
    app: State<'_, Arc<App>>,
) -> Result<protocol::Connection, String> {
    let session = app
        .session(&machine)
        .ok_or("That machine is no longer configured.")?;
    session.vitals.watch()?;
    let connection = session.vitals.connection();
    Ok(connection)
}

#[tauri::command]
async fn render_frame(request: FrameRequest, app: State<'_, Arc<App>>) -> Result<Frame, String> {
    let Some(session) = app.session(&request.machine) else {
        return fixture::render_frame(request);
    };
    blocking(move || match &request.query {
        Query::Logs { filter } => session
            .tail
            .as_ref()
            .ok_or("This machine has no system journal.")?
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
        Query::Logs { .. } => session
            .tail
            .as_ref()
            .ok_or("This machine has no system journal.")?
            .detail(id),
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
            connect_machine,
            discover_sql,
            machine_status,
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
    use shell::Host;

    #[cfg(unix)]
    #[test]
    #[ignore = "exercises real retry delays in an isolated subprocess"]
    fn a_network_outage_preserves_the_cursor_and_recovers_without_user_input() {
        use std::path::PathBuf;
        use std::time::{Duration, Instant};

        let directory = std::env::var_os("ALTAR_NETWORK_TEST_DIRECTORY");
        if let Some(directory) = directory {
            let directory = PathBuf::from(directory);
            let session = Session::new(MachineConfig {
                name: "Test machine".into(),
                host: Host::Ssh("fixture.test".into()),
                journal: true,
            });
            let viewport = stream::Viewport {
                top: None,
                row_height: 36.0,
                padding_top: 72.0,
                padding_bottom: 108.0,
                overscan: 3,
                height: 600.0,
                inset_top: 88.0,
            };
            session.vitals.watch().unwrap();
            let wait = |condition: &dyn Fn() -> bool| {
                let deadline = Instant::now() + Duration::from_secs(25);
                loop {
                    let ready = condition();
                    if ready {
                        break;
                    }
                    let now = Instant::now();
                    assert!(now < deadline, "connection state did not settle");
                    session.vitals.watch().unwrap();
                    std::thread::sleep(Duration::from_millis(25));
                }
            };
            wait(&|| {
                let machine = session.machine();
                let frame = session.tail.as_ref().unwrap().frame("", None, &viewport);
                machine.connection == protocol::Connection::Connected
                    && frame.is_ok_and(|frame| frame.total == 2)
            });
            std::fs::write(directory.join("link"), "down").unwrap();
            wait(&|| {
                let failures =
                    std::fs::read_to_string(directory.join("failed")).unwrap_or_default();
                let machine = session.machine();
                machine.connection == protocol::Connection::Reconnecting
                    && failures.lines().filter(|line| *line == "journal").count() >= 2
            });
            let retained = session
                .tail
                .as_ref()
                .unwrap()
                .frame("", None, &viewport)
                .unwrap();
            assert_eq!(retained.total, 2);
            std::fs::write(directory.join("link"), "restored").unwrap();
            wait(&|| {
                let machine = session.machine();
                let frame = session.tail.as_ref().unwrap().frame("", None, &viewport);
                machine.connection == protocol::Connection::Connected
                    && frame.is_ok_and(|frame| frame.total == 3)
            });
            let recovered = session
                .tail
                .as_ref()
                .unwrap()
                .frame("", None, &viewport)
                .unwrap();
            assert_eq!(recovered.rows.last().unwrap().cells[3], "event-3");
            drop(session);
            shell::reap();
            return;
        }

        use std::os::unix::fs::PermissionsExt;
        let process = std::process::id();
        let directory = std::env::temp_dir();
        let directory = directory.join(format!("altar-network-{process}"));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("ssh");
        std::fs::write(&executable, include_str!("../tests/network-ssh.sh")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(directory.join("link"), "up").unwrap();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(
            std::iter::once(directory.clone()).chain(std::env::split_paths(&path)),
        )
        .unwrap();
        let executable = std::env::current_exe().unwrap();
        let output = std::process::Command::new(executable)
            .args([
                "--exact",
                "tests::a_network_outage_preserves_the_cursor_and_recovers_without_user_input",
                "--ignored",
                "--nocapture",
            ])
            .env("ALTAR_NETWORK_TEST_DIRECTORY", &directory)
            .env("PATH", path)
            .output()
            .unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn reopening_retains_sessions_and_only_available_capabilities_become_views() {
        let config = MachineConfig {
            name: "Machine".into(),
            host: Host::Local,
            journal: false,
        };
        let app = App::default();
        let first = app.configure(vec![config.clone()]);
        assert!(first[0].machine().views.is_empty());
        assert!(first[0].tail.is_none());
        first[0]
            .discovered
            .sources
            .set(vec![sql::Source {
                id: "database".into(),
                name: "Database".into(),
                psql: "psql demo".into(),
                statement: sql::DEFAULT_STATEMENT.into(),
            }])
            .unwrap();
        let workbench = first[0].workbench("database").unwrap();
        let same = app.configure(vec![config.clone()]);
        assert!(Arc::ptr_eq(&first[0], &same[0]));
        assert!(Arc::ptr_eq(
            &workbench,
            &same[0].workbench("database").unwrap()
        ));
        assert_eq!(same[0].machine().views.len(), 1);
        let changed = app.configure(vec![MachineConfig {
            journal: true,
            ..config
        }]);
        assert!(!Arc::ptr_eq(&first[0], &changed[0]));
        assert_eq!(changed[0].machine().views.len(), 2);
        assert!(changed[0].workbench("database").is_err());
        assert!(app.session("local").is_some());
        app.configure(Vec::new());
        assert!(app.session("local").is_none());
    }
}
