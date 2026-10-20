//! Run shell scripts on a machine: locally, or over one multiplexed SSH connection per host.
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread::JoinHandle;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Host {
    Local,
    Ssh(String),
}

/// Streams that outlive a request, so a closing app takes its remote journal followers with it.
static STREAMS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

impl Host {
    /// Reject options and malformed SSH destinations before connecting.
    pub fn validate(&self) -> Result<(), String> {
        let Self::Ssh(destination) = self else {
            return Ok(());
        };
        if destination.is_empty()
            || destination.starts_with('-')
            || destination
                .chars()
                .any(|character| character.is_whitespace() || character == '\0')
        {
            return Err("Enter an SSH destination.".into());
        }
        Ok(())
    }

    /// Verify access and discover the hostname and journal capability in one round trip.
    pub fn connect(&self) -> Result<(String, bool), String> {
        self.validate()?;
        let bytes = self.run("name=$(hostname -s) || exit; printf '%s\\0' \"$name\"; if command -v journalctl >/dev/null 2>&1; then printf 1; else printf 0; fi", b"")?;
        let separator = bytes
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("The machine did not return its hostname.")?;
        let name =
            String::from_utf8(bytes[..separator].to_vec()).map_err(|error| error.to_string())?;
        if name.trim().is_empty() {
            return Err("The machine returned an empty hostname.".into());
        }
        let journal = bytes[separator + 1..] == *b"1";
        if *self == Host::Local {
            let name = hostname()?;
            return Ok((name, journal));
        }
        Ok((name.trim().into(), journal))
    }

    /// Construct a process that runs `script` through the host's shell, with stdio piped.
    fn command(&self, script: &str) -> Command {
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
                    "ConnectTimeout=5",
                    "-o",
                    "ServerAliveInterval=5",
                    "-o",
                    "ServerAliveCountMax=2",
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
        let mut command = self.command(script);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start {}: {error}", self.program()))?;
        let mut input = child.stdin.take().expect("stdin is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        std::thread::scope(|scope| {
            // Draining both output pipes while writing; large requests must not deadlock on backpressure.
            let writer = scope.spawn(move || input.write_all(stdin));
            let reader = scope.spawn(move || stderr_tail(stderr));
            let output = child.wait_with_output();
            let written = writer
                .join()
                .map_err(|_| "The script input writer stopped.")?;
            let stderr = reader
                .join()
                .map_err(|_| "The script error reader stopped.")?;
            let output = output.map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(failure(&stderr, output.status.code()));
            }
            written.map_err(|error| format!("Cannot send the script: {error}"))?;
            Ok(output.stdout)
        })
    }

    /// Start a stream that owns its process group, registration, and bounded diagnostic reader.
    pub fn stream(&self, script: &str) -> Result<Stream, String> {
        let mut command = self.command(script);
        command.stdin(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start {}: {error}", self.program()))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take().expect("stderr is piped");
        let stderr = std::thread::spawn(move || stderr_tail(stderr));
        let mut streams = STREAMS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        streams.push(child.id());
        Ok(Stream {
            child,
            stdout,
            stderr: Some(stderr),
        })
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

/// A running producer; dropping it terminates descendants and joins its diagnostic reader.
pub struct Stream {
    child: Child,
    pub stdout: Option<ChildStdout>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}

impl Stream {
    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Stop the group and reap the child, preserving a natural exit observed by try_wait.
    pub fn finish(mut self) -> (Option<ExitStatus>, Vec<u8>) {
        self.close()
    }

    fn close(&mut self) -> (Option<ExitStatus>, Vec<u8>) {
        terminate(self.child.id());
        let _ = self.child.kill();
        let status = self.child.wait().ok();
        let mut streams = STREAMS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        streams.retain(|&id| id != self.child.id());
        drop(streams);
        let stderr = self
            .stderr
            .take()
            .expect("an open stream owns its diagnostic reader");
        let stderr = stderr.join().unwrap_or_default();
        (status, stderr)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if self.stderr.is_some() {
            let _ = self.close();
        }
    }
}

/// Drain stderr continuously while retaining only a bounded suffix for failure reporting.
fn stderr_tail(mut stderr: impl Read) -> Vec<u8> {
    let mut tail = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let read = stderr.read(&mut buffer);
        let count = match read {
            Err(_) | Ok(0) => return tail,
            Ok(count) => count,
        };
        tail.extend_from_slice(&buffer[..count]);
        let excess = tail.len().saturating_sub(8192);
        tail.drain(..excess);
    }
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
    fn connecting_discovers_this_computer_and_rejects_ssh_options() {
        let (name, journal) = Host::Local.connect().unwrap();
        assert!(!name.is_empty());
        let expected = hostname().unwrap();
        assert_eq!(name, expected);
        let output = Host::Local
            .run(
                "command -v journalctl >/dev/null 2>&1 && printf 1; exit 0",
                b"",
            )
            .unwrap();
        assert_eq!(journal, output == b"1");
        for destination in [
            "",
            "-F/path",
            "host command",
            "host\ncommand",
            "host\0command",
        ] {
            assert!(Host::Ssh(destination.into()).validate().is_err());
        }
        for destination in ["server", "user@server", "root@100.64.0.1", "root@::1"] {
            assert!(Host::Ssh(destination.into()).validate().is_ok());
        }
    }

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
    fn diagnostic_capture_is_bounded_and_keeps_the_last_error_lines() {
        let mut bytes = vec![b'x'; 1_000_000];
        bytes.extend_from_slice(b"\none\ntwo\nthree\n");
        let tail = stderr_tail(bytes.as_slice());
        assert!(tail.len() <= 8192);
        assert_eq!(failure(&tail, Some(1)), "one · two · three");
        let mut stream = Host::Local
            .stream("printf ready; printf diagnostic >&2")
            .unwrap();
        let mut output = String::new();
        stream
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        loop {
            let status = stream.try_wait().unwrap();
            if status.is_some() {
                break;
            }
            std::thread::yield_now();
        }
        let (status, stderr) = stream.finish();
        assert!(status.unwrap().success());
        assert_eq!(output, "ready");
        assert_eq!(stderr, b"diagnostic");
    }

    #[test]
    fn ssh_commands_multiplex_without_prompting() {
        let command = Host::Ssh("user@server".into()).command("journalctl -f");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ControlMaster=auto".to_string()));
        assert!(args.contains(&"ConnectTimeout=5".to_string()));
        assert!(args.contains(&"ServerAliveInterval=5".to_string()));
        assert!(args.contains(&"ServerAliveCountMax=2".to_string()));
        assert_eq!(args[args.len() - 2..], ["user@server", "journalctl -f"]);
    }
}
