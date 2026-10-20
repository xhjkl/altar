//! Sample a machine's load from what it already exposes: /proc on Linux, top and vm_stat on macOS.
use crate::protocol::{Connection, Metrics};
use crate::shell::{self, Host};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

const INTERVAL_SECONDS: u64 = 5;
const INTERVAL: Duration = Duration::from_secs(INTERVAL_SECONDS);
/// How long one request keeps the sampler busy before it idles.
const WANTED_FOR: Duration = Duration::from_secs(30);
const FIRST_SAMPLE_PATIENCE: Duration = Duration::from_secs(15);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const HISTORY: usize = 32;
/// Ends each sample; the loop keeps one session open so audited hosts do not log every poll.
const END: &str = "--";

/// Five terse lines; Linux reports cumulative CPU counters, macOS an instantaneous percentage.
const LINUX_SCRIPT: &str = r#"awk '/^cpu /{print "cpu", $2+$3+$4+$7+$8+$9, $2+$3+$4+$5+$6+$7+$8+$9+$10}' /proc/stat
awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{print "mem", t*1024, a*1024}' /proc/meminfo
df -B1 --output=size,used / | awk 'NR==2{print "disk", $1, $2}'
awk '{print "uptime", int($1)}' /proc/uptime
echo cores $(nproc)"#;

const DARWIN_SCRIPT: &str = r#"top -l 2 -n 0 -s 1 | awk '/^CPU usage/{u=$3; s=$5} END{gsub("%","",u); gsub("%","",s); print "cpupct", u+s}'
vm_stat | awk -v ps=$(sysctl -n hw.pagesize) -v total=$(sysctl -n hw.memsize) '{gsub(/\./,"")} /Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3} END{print "mem", total, (f+i+s)*ps}'
df -k / | awk 'NR==2{print "disk", $2*1024, $3*1024}'
echo uptime $(( $(date +%s) - $(sysctl -n kern.boottime | sed 's/^{ sec = \([0-9]*\).*/\1/') ))
echo cores $(sysctl -n hw.ncpu)"#;

/// Machine-reported CPU usage, preserving cumulative and instantaneous sampling semantics.
enum Cpu {
    Counters { busy: u64, total: u64 },
    Percent(f64),
}

#[derive(Default)]
struct Sample {
    cpu: Option<Cpu>,
    memory: Option<(u64, u64)>,
    disk: Option<(u64, u64)>,
    uptime: Option<u64>,
    cores: Option<u16>,
}

fn parse(output: &str) -> Result<Sample, String> {
    let mut sample = Sample::default();
    for line in output.lines() {
        let mut words = line.split_whitespace();
        let Some(key) = words.next() else {
            continue;
        };
        let numbers: Vec<f64> = words.filter_map(|word| word.parse().ok()).collect();
        match (key, numbers.as_slice()) {
            ("cpu", [busy, total]) => {
                sample.cpu = Some(Cpu::Counters {
                    busy: *busy as u64,
                    total: *total as u64,
                })
            }
            ("cpupct", [percent]) => sample.cpu = Some(Cpu::Percent(*percent)),
            ("mem", [total, available]) => sample.memory = Some((*total as u64, *available as u64)),
            ("disk", [total, used]) => sample.disk = Some((*total as u64, *used as u64)),
            ("uptime", [seconds]) => sample.uptime = Some(*seconds as u64),
            ("cores", [cores]) => sample.cores = Some(*cores as u16),
            _ => {}
        }
    }
    if sample.memory.is_none() || sample.cpu.is_none() {
        return Err(format!("Unreadable vitals: {}", output.trim()));
    }
    Ok(sample)
}

#[derive(Default)]
struct State {
    cpu: VecDeque<usize>,
    memory: VecDeque<usize>,
    disk: usize,
    cores: u16,
    memory_bytes: u64,
    disk_bytes: u64,
    uptime: u64,
    sampled_at: Option<Instant>,
    error: Option<String>,
    previous_cpu: Option<(u64, u64)>,
    wanted_until: Option<Instant>,
    started: bool,
}

/// One machine's sampler, running only while someone keeps asking.
pub struct Vitals {
    host: Host,
    state: Mutex<State>,
    changed: Condvar,
}

impl Vitals {
    pub fn new(host: Host) -> Arc<Self> {
        Arc::new(Self {
            host,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        })
    }

    /// Keep accumulated samples available after a worker panics.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wanted(&self) -> bool {
        let state = self.lock();
        let now = Instant::now();
        state.wanted_until.is_some_and(|until| until > now)
    }

    fn settle(&self, outcome: Result<Sample, String>) {
        let mut state = self.lock();
        match outcome {
            Err(error) => state.error = Some(error),
            Ok(sample) => state.absorb(sample),
        }
        self.changed.notify_all();
    }

    /// Report stale samples as disconnected even before SSH finishes detecting a dead link.
    pub fn connection(&self) -> Connection {
        let state = self.lock();
        let now = Instant::now();
        state.connection(now)
    }

    /// Keep the existing sampler alive for connection status, including while vitals are collapsed.
    pub fn watch(self: &Arc<Self>) -> Result<(), String> {
        let mut state = self.lock();
        let now = Instant::now();
        state.wanted_until = Some(now + WANTED_FOR);
        if state.started {
            return Ok(());
        }
        let vitals = Arc::downgrade(self);
        let _thread = std::thread::Builder::new()
            .name(format!("vitals {}", self.host.label()))
            .spawn(move || Self::run(vitals))
            .map_err(|error| format!("Cannot start the vitals sampler: {error}"))?;
        state.started = true;
        Ok(())
    }

    /// Sample while requested; release the session between idle checks so removed machines can drop.
    fn run(weak: Weak<Self>) {
        loop {
            let Some(vitals) = weak.upgrade() else {
                return;
            };
            if !vitals.wanted() {
                drop(vitals);
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            let sample_script = match vitals.host {
                Host::Local if cfg!(target_os = "macos") => DARWIN_SCRIPT,
                _ => LINUX_SCRIPT,
            };
            let script = format!(
                "while true; do
{}
echo {END}
sleep {INTERVAL_SECONDS}
done",
                sample_script
            );
            let child = vitals.host.stream(&script);
            let mut child = match child {
                Err(error) => {
                    vitals.settle(Err(error));
                    std::thread::sleep(RETRY_DELAY);
                    continue;
                }
                Ok(child) => child,
            };
            let stdout = child.stdout.take().expect("stdout is piped");
            let mut stderr = child.stderr.take().expect("stderr is piped");
            let stderr = std::thread::spawn(move || {
                let mut text = Vec::new();
                let _ = std::io::Read::read_to_end(&mut stderr, &mut text);
                text
            });
            let mut block = String::new();
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line != END {
                    block.push_str(&line);
                    block.push('\n');
                    continue;
                }
                vitals.settle(parse(&block));
                block.clear();
                if !vitals.wanted() {
                    break;
                }
            }
            let status = shell::stop(&mut child);
            let stderr = stderr.join().unwrap_or_default();
            if vitals.wanted() {
                vitals.settle(Err(shell::failure(
                    &stderr,
                    status.and_then(|status| status.code()),
                )));
                std::thread::sleep(RETRY_DELAY);
            }
        }
    }

    /// Return the current history, waiting for a first sample rather than reporting nothing.
    pub fn metrics(self: &Arc<Self>, machine: &str) -> Result<Metrics, String> {
        self.watch()?;
        let mut state = self.lock();
        let now = Instant::now();
        let deadline = now + FIRST_SAMPLE_PATIENCE;
        while state.sampled_at.is_none() && state.error.is_none() {
            let now = Instant::now();
            let left = deadline.saturating_duration_since(now);
            if left.is_zero() {
                return Err(format!("Still waiting for {}.", self.host.label()));
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        if state.sampled_at.is_none() {
            return Err(state.error.clone().unwrap_or_default());
        }
        let age = state.sampled_at.map(|at| at.elapsed()).unwrap_or_default();
        Ok(Metrics {
            machine: machine.into(),
            cpu: state.cpu.iter().copied().collect(),
            memory: state.memory.iter().copied().collect(),
            disk: state.disk,
            cpu_cores: state.cores,
            memory_gb: gigabytes(state.memory_bytes),
            disk_gb: gigabytes(state.disk_bytes),
            uptime: describe_uptime(state.uptime),
            last_sample: (age > INTERVAL * 3).then(|| describe_age(age)),
        })
    }
}

impl State {
    fn connection(&self, now: Instant) -> Connection {
        if self.error.is_some() {
            return Connection::Reconnecting;
        }
        match self.sampled_at {
            None => Connection::Connecting,
            Some(at) if now.saturating_duration_since(at) > INTERVAL * 3 => {
                Connection::Reconnecting
            }
            Some(_) => Connection::Connected,
        }
    }

    fn absorb(&mut self, sample: Sample) {
        let cpu_percent = match sample.cpu {
            None => 0.0,
            Some(Cpu::Percent(percent)) => percent,
            Some(Cpu::Counters { busy, total }) => {
                let (busy_delta, total_delta) = match self.previous_cpu {
                    Some((previous_busy, previous_total)) if total > previous_total => {
                        (busy.saturating_sub(previous_busy), total - previous_total)
                    }
                    _ => (busy, total),
                };
                self.previous_cpu = Some((busy, total));
                if total_delta == 0 {
                    0.0
                } else {
                    busy_delta as f64 * 100.0 / total_delta as f64
                }
            }
        };
        push(&mut self.cpu, cpu_percent);
        if let Some((total, available)) = sample.memory {
            let used = total.saturating_sub(available);
            push(
                &mut self.memory,
                if total == 0 {
                    0.0
                } else {
                    used as f64 * 100.0 / total as f64
                },
            );
            self.memory_bytes = total;
        }
        if let Some((total, used)) = sample.disk {
            self.disk = if total == 0 {
                0
            } else {
                (used as f64 * 100.0 / total as f64).round() as usize
            };
            self.disk_bytes = total;
        }
        if let Some(cores) = sample.cores {
            self.cores = cores.max(1);
        }
        if let Some(seconds) = sample.uptime {
            self.uptime = seconds;
        }
        self.sampled_at = Some(Instant::now());
        self.error = None;
    }
}

fn push(history: &mut VecDeque<usize>, percent: f64) {
    if history.len() == HISTORY {
        history.pop_front();
    }
    history.push_back(percent.round().clamp(0.0, 100.0) as usize);
}

/// Express byte capacities in the display unit shared by memory and disk.
fn gigabytes(bytes: u64) -> f64 {
    (bytes as f64 / 1024f64.powi(3) * 10.0).round() / 10.0
}

fn describe_uptime(seconds: u64) -> String {
    let (days, hours, minutes) = (seconds / 86_400, seconds / 3_600 % 24, seconds / 60 % 60);
    if days > 0 {
        format!("{days}d {hours}h {minutes}m")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

fn describe_age(age: Duration) -> String {
    let seconds = age.as_secs();
    if seconds < 90 {
        format!("{seconds} seconds ago")
    } else if seconds < 5_400 {
        format!("{} minutes ago", seconds / 60)
    } else {
        format!("{} hours ago", seconds / 3_600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_tracks_failure_staleness_and_recovery_without_discarding_samples() {
        let mut state = State::default();
        let now = Instant::now();
        assert_eq!(state.connection(now), Connection::Connecting);
        state.absorb(parse("cpupct 12\nmem 10 5\n").unwrap());
        let sampled_at = state.sampled_at.unwrap();
        assert_eq!(state.connection(sampled_at), Connection::Connected);
        assert_eq!(
            state.connection(sampled_at + INTERVAL * 4),
            Connection::Reconnecting
        );
        state.error = Some("Connection lost".into());
        assert_eq!(state.connection(sampled_at), Connection::Reconnecting);
        assert_eq!(state.cpu.back(), Some(&12));
        state.absorb(parse("cpupct 20\nmem 10 4\n").unwrap());
        assert_eq!(
            state.connection(state.sampled_at.unwrap()),
            Connection::Connected
        );
        assert!(state.error.is_none());
        assert_eq!(state.cpu.iter().copied().collect::<Vec<_>>(), [12, 20]);
    }

    #[test]
    fn linux_counters_become_deltas_and_macos_percentages_pass_through() {
        let mut state = State::default();
        state.absorb(parse("cpu 100 1000\nmem 1000000000 400000000\ndisk 2000000000 500000000\nuptime 90061\ncores 2\n").unwrap());
        assert_eq!(state.cpu.back(), Some(&10));
        state.absorb(parse("cpu 200 1200\nmem 1000000000 500000000\n").unwrap());
        assert_eq!(state.cpu.back(), Some(&50));
        assert_eq!(state.memory.iter().copied().collect::<Vec<_>>(), [60, 50]);
        assert_eq!(
            (state.disk, state.cores, describe_uptime(state.uptime)),
            (25, 2, "1d 1h 1m".into())
        );
        state.absorb(parse("cpupct 12.6\nmem 10 5\n").unwrap());
        assert_eq!(state.cpu.back(), Some(&13));
        for _ in 0..HISTORY {
            state.absorb(parse("cpupct 1\nmem 10 5\n").unwrap());
        }
        assert_eq!(state.cpu.len(), HISTORY);
        assert!(parse("nothing here").is_err());
        assert_eq!(describe_age(Duration::from_secs(600)), "10 minutes ago");
    }

    #[test]
    fn the_local_script_reports_this_computer() {
        let output = Host::Local
            .run(
                if cfg!(target_os = "macos") {
                    DARWIN_SCRIPT
                } else {
                    LINUX_SCRIPT
                },
                b"",
            )
            .unwrap();
        let sample = parse(&String::from_utf8_lossy(&output)).unwrap();
        assert!(sample.cores.unwrap_or(0) > 0);
        assert!(sample.memory.unwrap().0 > sample.memory.unwrap().1);
        assert!(sample.disk.unwrap().0 > 0);
        assert!(sample.uptime.unwrap() > 0);
    }
}
