//! Persist the machine list in `~/.altar`; TOML is the explicit editing interchange.
use crate::shell::Host;
use crate::sql::{Source, DEFAULT_STATEMENT};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Current persisted machine choices.
#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    machine: Vec<MachineEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MachineEntry {
    name: String,
    /// Any ssh destination, like `root@cerise`; absent for this computer.
    ssh: Option<String>,
    /// Journal entries to load before following the tail.
    history: Option<usize>,
    #[serde(default)]
    logs: Vec<LogsEntry>,
    #[serde(default)]
    sql: Vec<SqlEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LogsEntry {
    name: String,
    #[serde(default)]
    filter: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SqlEntry {
    name: String,
    /// A psql invocation that runs on the machine, like `sudo -u postgres psql para`.
    psql: String,
    statement: Option<String>,
}

#[derive(Debug)]
pub struct MachineConfig {
    pub id: String,
    pub name: String,
    pub host: Host,
    pub history: usize,
    pub logs: Vec<LogsView>,
    pub sql: Vec<Source>,
}

#[derive(Debug)]
pub struct LogsView {
    pub id: String,
    pub name: String,
    pub filter: String,
}

const DEFAULT_HISTORY: usize = 20_000;

const TEMPLATE: &str = r#"# Altar reaches each machine with the ssh command on this computer.
# Logs come from journalctl; SQL goes through a psql invocation that runs on the machine.
#
# [[machine]]
# name = "cerise"
# ssh = "root@cerise"
# history = 20000
#
# [[machine.logs]]
# name = "dive"
# filter = "unit:dive"
#
# [[machine.sql]]
# name = "dive"
# psql = "sudo -u postgres psql dive"
#
# A machine without `ssh` is this computer; its views run locally.
# [[machine]]
# name = "local"        # shown using this computer's hostname
#
# [[machine.sql]]
# name = "demo"
# psql = "psql demo"
"#;

/// Locate the binary configuration in the user's home directory.
fn path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME");
    let user_profile = std::env::var_os("USERPROFILE");
    let home = home
        .or(user_profile)
        .ok_or("Cannot locate the home directory.")?;
    Ok(PathBuf::from(home).join(".altar"))
}

/// Load the current schema, reporting invalid data without replacing it.
pub fn load() -> Result<Vec<MachineConfig>, String> {
    let path = path()?;
    let file = load_file(&path)?;
    let mut machines = file.machines()?;
    if machines.is_empty() {
        return Err(format!(
            "No machines yet. Run `altar config export > machines.toml`, edit the file, then `altar config import machines.toml` to populate {}.",
            path.display()
        ));
    }
    if machines.iter().any(|machine| machine.host == Host::Local) {
        let hostname = crate::shell::hostname()?;
        for machine in &mut machines {
            if machine.host == Host::Local {
                machine.name = hostname.clone();
            }
        }
    }
    Ok(machines)
}

/// Run config import/export before starting the desktop app; return whether a command ran.
pub fn command(arguments: &[OsString]) -> Result<bool, String> {
    if arguments.first().and_then(|argument| argument.to_str()) != Some("config") {
        return Ok(false);
    }
    let path = path()?;
    match arguments.get(1).and_then(|argument| argument.to_str()) {
        Some("export") if arguments.len() == 2 => {
            let file = load_file(&path)?;
            let text = if file.machine.is_empty() {
                String::new()
            } else {
                toml::to_string_pretty(&file).map_err(|error| error.to_string())?
            };
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            stdout
                .write_all(TEMPLATE.as_bytes())
                .map_err(|error| error.to_string())?;
            stdout
                .write_all(text.as_bytes())
                .map_err(|error| error.to_string())?;
        }
        Some("import") if arguments.len() == 3 => {
            let mut text = String::new();
            if arguments[2] == "-" {
                let stdin = std::io::stdin();
                let mut stdin = stdin.lock();
                stdin
                    .read_to_string(&mut text)
                    .map_err(|error| format!("Cannot read stdin: {error}"))?;
            } else {
                text = std::fs::read_to_string(&arguments[2]).map_err(|error| {
                    format!(
                        "Cannot read {}: {error}",
                        Path::new(&arguments[2]).display()
                    )
                })?;
            }
            let file = parse(&text)?;
            save(&path, &file)?;
        }
        _ => {
            return Err(
                "Usage: altar config export | altar config import <machines.toml | ->".into(),
            )
        }
    }
    Ok(true)
}

fn load_file(path: &Path) -> Result<File, String> {
    let bytes = std::fs::read(path);
    let bytes = match bytes {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(File::default()),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
        Ok(bytes) => bytes,
    };
    decode(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

/// Decode the interchange and enforce the same invariants as the binary file.
fn parse(text: &str) -> Result<File, String> {
    let file: File = toml::from_str(text).map_err(|error| error.message().to_string())?;
    file.machines()?;
    Ok(file)
}

fn decode(bytes: &[u8]) -> Result<File, String> {
    let (file, remaining): (File, _) = postcard::take_from_bytes(bytes)
        .map_err(|error| format!("Invalid .altar data: {error}"))?;
    if !remaining.is_empty() {
        return Err("Unexpected bytes after the .altar data.".into());
    }
    file.machines()?;
    Ok(file)
}

/// Replace the file only after validating and fully writing a private sibling.
fn save(path: &Path, file: &File) -> Result<(), String> {
    file.machines()?;
    let payload = postcard::to_allocvec(file).map_err(|error| error.to_string())?;
    let process = std::process::id();
    let temporary = path.with_extension(format!("tmp-{process}"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&temporary)
        .map_err(|error| format!("Cannot create {}: {error}", temporary.display()))?;
    let result = (|| -> std::io::Result<()> {
        output.write_all(&payload)?;
        output.sync_all()?;
        drop(output);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Cannot save {}: {error}", path.display()));
    }
    Ok(())
}

impl File {
    /// Resolve stable identifiers and runtime defaults, rejecting ambiguous or unusable views.
    fn machines(&self) -> Result<Vec<MachineConfig>, String> {
        let mut machines: Vec<MachineConfig> = Vec::new();
        for entry in &self.machine {
            let name = entry.name.trim().to_string();
            if name.is_empty() {
                return Err("Every machine needs a name.".into());
            }
            let id = slug(&name);
            if id.is_empty() {
                return Err(format!(
                    "Machine {name} needs a letter or number in its name."
                ));
            }
            if machines.iter().any(|machine| machine.id == id) {
                return Err(format!("Two machines are both called {name}."));
            }
            let host = match entry.ssh.as_deref().map(str::trim) {
                Some(target) if !target.is_empty() => Host::Ssh(target.into()),
                _ => Host::Local,
            };
            let mut logs: Vec<LogsView> = entry
                .logs
                .iter()
                .map(|view| LogsView {
                    id: format!("logs-{}", slug(&view.name)),
                    name: view.name.trim().into(),
                    filter: view.filter.trim().into(),
                })
                .collect();
            if logs.is_empty() && host != Host::Local {
                logs = vec![
                    LogsView {
                        id: "logs-all".into(),
                        name: "All activity".into(),
                        filter: String::new(),
                    },
                    LogsView {
                        id: "logs-trouble".into(),
                        name: "Warnings & errors".into(),
                        filter: "level:warn+".into(),
                    },
                ];
            }
            let sql: Vec<Source> = entry
                .sql
                .iter()
                .map(|view| Source {
                    id: format!("sql-{}", slug(&view.name)),
                    name: view.name.trim().into(),
                    psql: view.psql.trim().into(),
                    statement: view
                        .statement
                        .as_deref()
                        .map(str::trim)
                        .filter(|statement| !statement.is_empty())
                        .unwrap_or(DEFAULT_STATEMENT)
                        .into(),
                })
                .collect();
            let mut ids = HashSet::new();
            for (id, view_name) in logs
                .iter()
                .map(|view| (&view.id, &view.name))
                .chain(sql.iter().map(|view| (&view.id, &view.name)))
            {
                if slug(view_name).is_empty() {
                    return Err(format!(
                        "{name}: every view needs a letter or number in its name."
                    ));
                }
                if !ids.insert(id) {
                    return Err(format!("{name} has two views named alike ({id})."));
                }
            }
            if sql.iter().any(|view| view.psql.is_empty()) {
                return Err(format!("{name}: every sql view needs a psql command."));
            }
            if ids.is_empty() {
                return Err(format!("{name} has no views; a machine without ssh needs at least one [[machine.sql]] or [[machine.logs]] entry."));
            }
            machines.push(MachineConfig {
                id,
                name,
                host,
                history: entry.history.unwrap_or(DEFAULT_HISTORY).max(1),
                logs,
                sql,
            });
        }
        Ok(machines)
    }
}

fn slug(name: &str) -> String {
    let mut slug = String::new();
    for character in name.trim().chars() {
        if character.is_alphanumeric() {
            slug.extend(character.to_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_machines_get_default_log_views_and_local_ones_run_here() {
        let machines = parse(
            r#"
            [[machine]]
            name = "Cerise"
            ssh = "root@cerise"
            [[machine.sql]]
            name = "dive"
            psql = "sudo -u postgres psql dive"

            [[machine]]
            name = "this mac"
            [[machine.sql]]
            name = "demo"
            psql = "psql demo"
            statement = "select 1"
            "#,
        )
        .unwrap();
        let machines = machines.machines().unwrap();
        assert_eq!(machines.len(), 2);
        assert_eq!(machines[0].id, "cerise");
        assert_eq!(machines[0].host, Host::Ssh("root@cerise".into()));
        assert_eq!(machines[0].history, DEFAULT_HISTORY);
        assert_eq!(
            machines[0]
                .logs
                .iter()
                .map(|view| view.id.as_str())
                .collect::<Vec<_>>(),
            ["logs-all", "logs-trouble"]
        );
        assert_eq!(machines[0].sql[0].statement, DEFAULT_STATEMENT);
        assert_eq!(machines[1].id, "this-mac");
        assert_eq!(machines[1].host, Host::Local);
        assert!(machines[1].logs.is_empty());
        assert_eq!(machines[1].sql[0].statement, "select 1");
    }

    #[test]
    fn mistakes_are_named() {
        assert!(parse(
            "[[machine]]\nname = \"a\"\nssh = \"x\"\n[[machine]]\nname = \"A\"\nssh = \"y\""
        )
        .err()
        .unwrap()
        .contains("both called"));
        assert!(parse("[[machine]]\nname = \"a\"")
            .err()
            .unwrap()
            .contains("no views"));
        assert!(parse("[[machine]]\nname = \"a\"\nport = 1")
            .err()
            .unwrap()
            .contains("port"));
        assert!(parse("[[machine]]\nname = \"a\"\nssh = \"x\"\n[[machine.logs]]\nname = \"Q\"\n[[machine.logs]]\nname = \"q\"").err().unwrap().contains("alike"));
        assert!(parse("[[machine]]\nname = \"---\"\nssh = \"x\"")
            .err()
            .unwrap()
            .contains("letter or number"));
        assert!(
            parse("[[machine]]\nname = \"a\"\nssh = \"x\"\n[[machine.logs]]\nname = \" \"")
                .err()
                .unwrap()
                .contains("letter or number")
        );
        assert!(parse("").unwrap().machine.is_empty());
    }

    #[test]
    fn binary_decoding_checks_completeness_and_machine_invariants() {
        let file = parse(
            r#"
            [[machine]]
            name = "cerise"
            ssh = "root@cerise"
            history = 40000
            [[machine.logs]]
            name = "Warnings"
            filter = "level:warn+"
            [[machine.sql]]
            name = "dive"
            psql = "psql dive"
            statement = "select '🍒'"

            [[machine]]
            name = "local"
            [[machine.sql]]
            name = "demo"
            psql = "psql demo"
            "#,
        )
        .unwrap();
        let mut bytes = postcard::to_allocvec(&file).unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.machines().unwrap()[0].name, "cerise");
        assert_eq!(
            toml::to_string(&decoded).unwrap(),
            toml::to_string(&file).unwrap()
        );
        for length in 0..bytes.len() {
            assert!(decode(&bytes[..length]).is_err(), "accepted {length} bytes");
        }
        bytes.push(0);
        assert!(decode(&bytes).err().unwrap().contains("Unexpected bytes"));

        let file: File = toml::from_str("[[machine]]\nname = \"---\"").unwrap();
        let bytes = postcard::to_allocvec(&file).unwrap();
        assert!(decode(&bytes).err().unwrap().contains("letter or number"));
    }

    #[test]
    fn binary_files_are_atomic_and_invalid_data_is_reported() {
        let process = std::process::id();
        let now = std::time::SystemTime::now();
        let nonce = now
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir();
        let directory = directory.join(format!("altar-config-{process}-{nonce}"));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(".altar");
        assert!(load_file(&path).unwrap().machine.is_empty());
        assert!(!path.exists());
        let file = parse("[[machine]]\nname = \"cerise\"\nssh = \"root@cerise\"").unwrap();
        save(&path, &file).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, postcard::to_allocvec(&file).unwrap());
        assert_eq!(
            load_file(&path).unwrap().machines().unwrap()[0].id,
            "cerise"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(&path).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        }
        let invalid: File = toml::from_str("[[machine]]\nname = \"empty\"").unwrap();
        assert!(save(&path, &invalid).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::write(&path, b"broken").unwrap();
        assert!(load_file(&path)
            .err()
            .unwrap()
            .contains("Invalid .altar data"));
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
