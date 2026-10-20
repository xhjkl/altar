//! Persist machines connected through the app in the key-less Postcard file `~/.altar`.
use crate::shell::Host;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Discovered identity and capabilities retained between launches; SQL endpoints are probed per session.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MachineConfig {
    pub name: String,
    pub host: Host,
    pub journal: bool,
}

impl MachineConfig {
    /// Identify a connection independently of its hostname, which several machines may share.
    pub fn id(&self) -> String {
        match &self.host {
            Host::Local => "local".into(),
            Host::Ssh(destination) => format!("ssh-{destination}"),
        }
    }
}

fn path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME");
    let user_profile = std::env::var_os("USERPROFILE");
    let home = home
        .or(user_profile)
        .ok_or("Cannot locate the home directory.")?;
    Ok(PathBuf::from(home).join(".altar"))
}

/// Load saved connections; a missing file is an empty workspace.
pub fn load() -> Result<Vec<MachineConfig>, String> {
    let path = path()?;
    load_file(&path)
}

fn load_file(path: &Path) -> Result<Vec<MachineConfig>, String> {
    let bytes = std::fs::read(path);
    let bytes = match bytes {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
        Ok(bytes) => bytes,
    };
    decode(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn validate(machines: &[MachineConfig]) -> Result<(), String> {
    let mut hosts = HashSet::new();
    for machine in machines {
        machine.host.validate()?;
        if machine.name.trim().is_empty() {
            return Err("A saved machine has no hostname.".into());
        }
        if !hosts.insert(machine.id()) {
            return Err(format!("{} is saved more than once.", machine.name));
        }
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Result<Vec<MachineConfig>, String> {
    let (machines, remaining): (Vec<MachineConfig>, _) = postcard::take_from_bytes(bytes)
        .map_err(|error| format!("Invalid .altar data: {error}"))?;
    if !remaining.is_empty() {
        return Err("Unexpected bytes after the .altar data.".into());
    }
    validate(&machines)?;
    Ok(machines)
}

/// Save connected machines before publishing them to the workspace.
pub fn save(machines: &[MachineConfig]) -> Result<(), String> {
    let path = path()?;
    write_file(&path, machines)
}

/// Replace the file only after validating and fully writing a private sibling.
fn write_file(path: &Path, machines: &[MachineConfig]) -> Result<(), String> {
    validate(machines)?;
    let payload = postcard::to_allocvec(machines).map_err(|error| error.to_string())?;
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
        .map_err(|error| format!("Cannot create {}: {error}", path.display()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn machines() -> Vec<MachineConfig> {
        vec![
            MachineConfig {
                name: "Server 🐘".into(),
                host: Host::Ssh("user@server".into()),
                journal: true,
            },
            MachineConfig {
                name: "Trakktor".into(),
                host: Host::Local,
                journal: false,
            },
        ]
    }

    #[test]
    fn binary_decoding_requires_complete_valid_connections() {
        let machines = machines();
        let mut bytes = postcard::to_allocvec(&machines).unwrap();
        assert_eq!(decode(&bytes).unwrap(), machines);
        for length in 0..bytes.len() {
            assert!(decode(&bytes[..length]).is_err(), "accepted {length} bytes");
        }
        bytes.push(0);
        assert!(decode(&bytes).err().unwrap().contains("Unexpected bytes"));
        let mut invalid = machines.clone();
        invalid[0].host = Host::Ssh("-Fanything".into());
        let bytes = postcard::to_allocvec(&invalid).unwrap();
        assert!(decode(&bytes).is_err());
        invalid[0] = machines[1].clone();
        let bytes = postcard::to_allocvec(&invalid).unwrap();
        assert!(decode(&bytes).err().unwrap().contains("more than once"));
        assert!(
            decode(&postcard::to_allocvec(&Vec::<MachineConfig>::new()).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn binary_files_are_private_and_invalid_data_is_preserved() {
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
        assert!(load_file(&path).unwrap().is_empty());
        assert!(!path.exists());
        let machines = machines();
        write_file(&path, &machines).unwrap();
        assert_eq!(load_file(&path).unwrap(), machines);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(&path).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        }
        let bytes = std::fs::read(&path).unwrap();
        let mut invalid = machines;
        invalid[0].name.clear();
        assert!(write_file(&path, &invalid).is_err());
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
