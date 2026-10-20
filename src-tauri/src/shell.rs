//! Run shell scripts on a machine: locally, or over one multiplexed SSH connection per host.
use std::io::Write;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Host {
    Local,
    Ssh(String),
}

/// Streams that outlive a request, so a closing app takes its remote journal followers with it.
static STREAMS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

impl Host {
    /// Construct a process that runs `script` through the host's shell, with stdio piped.
    pub fn command(&self, script: &str) -> Command {
        let mut command = Command::new(self.program());
        match self {
            Host::Local => {
                command.arg("-c").arg(script);
            }
            Host::Ssh(target) => {
                command.args([
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=10",
                    "-o",
                    "ServerAliveInterval=15",
                    "-o",
                    "ControlMaster=auto",
                    // Keeping the path short: a macOS socket path cannot exceed 104 bytes.
                    "-o",
                    "ControlPath=/tmp/altar-%C",
                    "-o",
                    "ControlPersist=300",
                    target,
                    script,
                ]);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// Run a script to completion, feeding `stdin`; a failing exit becomes the script's stderr.
    pub fn run(&self, script: &str, stdin: &[u8]) -> Result<Vec<u8>, String> {
        let mut child = self
            .command(script)
            .spawn()
            .map_err(|error| format!("Cannot start {}: {error}", self.program()))?;
        let mut input = child.stdin.take().expect("stdin is piped");
        let stdin = stdin.to_vec();
        // Writing on a thread so a large script never deadlocks against a full stdout pipe.
        let writer = std::thread::spawn(move || {
            let _ = input.write_all(&stdin);
        });
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        let _ = writer.join();
        if output.status.success() {
            return Ok(output.stdout);
        }
        Err(failure(&output.stderr, output.status.code()))
    }

    /// Start an owned process group whose stdout the caller reads.
    pub fn stream(&self, script: &str) -> Result<Child, String> {
        let mut command = self.command(script);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Cannot start {}: {error}", self.program()))?;
        STREAMS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(child.id());
        Ok(child)
    }

    pub fn label(&self) -> &str {
        match self {
            Host::Local => "this computer",
            Host::Ssh(target) => target,
        }
    }

    /// Select the executable shared by process construction and startup diagnostics.
    fn program(&self) -> &'static str {
        match self {
            Host::Local => "/bin/sh",
            Host::Ssh(_) => "ssh",
        }
    }
}

/// Quote one literal argument for a host's POSIX shell.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Read the local computer's hostname for navigation and connection diagnostics.
pub fn hostname() -> Result<String, String> {
    let script = if cfg!(target_os = "macos") {
        "scutil --get LocalHostName 2>/dev/null || hostname -s"
    } else {
        "hostname -s"
    };
    let bytes = Host::Local.run(script, b"")?;
    let name = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    let name = name.trim();
    if name.is_empty() {
        return Err("The local hostname is empty.".into());
    }
    Ok(name.into())
}

/// Unregister a stream after its caller has waited for it.
pub fn forget(child: &Child) {
    STREAMS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|&id| id != child.id());
}

/// Stop and reap a stream, including descendants that could otherwise keep its pipes open.
pub fn stop(child: &mut Child) -> Option<ExitStatus> {
    terminate(child.id());
    let _ = child.kill();
    let status = child.wait().ok();
    forget(child);
    status
}

/// Terminate the process group created by `stream`; its child owner performs the wait.
fn terminate(id: u32) {
    let id = id.to_string();
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("taskkill");
        command.args(["/F", "/T", "/PID", &id]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("kill");
        #[cfg(unix)]
        let id = format!("-{id}");
        command.args(["-KILL", "--", &id]);
        command
    };
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let _ = command.status();
}

/// End every live stream; the app is leaving and their remote `journalctl -f` must not linger.
pub fn reap() {
    let streams = {
        let mut streams = STREAMS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *streams)
    };
    for id in streams {
        terminate(id);
    }
}

/// Condense stderr into one message, keeping the last meaningful lines.
pub fn failure(stderr: &[u8], code: Option<i32>) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("Warning: Permanently added"))
        .collect();
    if lines.is_empty() {
        return match code {
            Some(code) => format!("Exited with status {code}."),
            None => "Ended by a signal.".into(),
        };
    }
    lines[lines.len().saturating_sub(3)..].join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_scripts_receive_stdin_and_report_failures() {
        let output = Host::Local.run("cat", b"hello").unwrap();
        assert_eq!(output, b"hello");
        let error = Host::Local
            .run("echo first >&2; echo second >&2; exit 3", b"")
            .unwrap_err();
        assert_eq!(error, "first · second");
        let error = Host::Local.run("exit 4", b"").unwrap_err();
        assert_eq!(error, "Exited with status 4.");
    }

    #[test]
    fn ssh_commands_multiplex_without_prompting() {
        let command = Host::Ssh("root@cerise".into()).command("journalctl -f");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ControlMaster=auto".to_string()));
        assert_eq!(args[args.len() - 2..], ["root@cerise", "journalctl -f"]);
    }
}
