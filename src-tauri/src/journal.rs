//! Follow a machine's systemd journal in its own export format, keeping a compact tail in memory.
use crate::protocol::{Detail, Field};
use crate::shell::{self, quote, Host};
use crate::stream::{preview, Column, ColumnKind, Frame, Row, Viewport};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdout, ExitStatus};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Fields worth carrying for every entry; the rest is fetched by cursor when a row is inspected.
const FIELDS: &str = "MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_PID,_TRANSPORT,_COMM";
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const FIRST_FRAME_PATIENCE: Duration = Duration::from_secs(20);
const LEVEL_NAMES: [&str; 8] = [
    "emerg", "alert", "crit", "err", "warn", "notice", "info", "debug",
];

/// One record as journalctl serializes it: text fields, or length-prefixed binary ones.
struct Record {
    pub fields: Vec<(String, Vec<u8>)>,
}

impl Record {
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.fields
            .iter()
            .find(|(field, _)| field == name)
            .map(|(_, value)| value.as_slice())
    }

    pub fn text(&self, name: &str) -> Option<Cow<'_, str>> {
        self.get(name).map(String::from_utf8_lossy)
    }
}

/// Read export records until the stream ends; a malformed record ends it with an error.
struct Records<R: BufRead> {
    reader: R,
    line: Vec<u8>,
}

impl<R: BufRead> Records<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            line: Vec::new(),
        }
    }

    fn next_record(&mut self) -> Result<Option<Record>, String> {
        let mut fields = Vec::new();
        loop {
            self.line.clear();
            let read = self
                .reader
                .read_until(b'\n', &mut self.line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Ok((!fields.is_empty()).then_some(Record { fields }));
            }
            if self.line.last() == Some(&b'\n') {
                self.line.pop();
            }
            if self.line.is_empty() {
                if fields.is_empty() {
                    continue;
                }
                return Ok(Some(Record { fields }));
            }
            match self.line.iter().position(|&byte| byte == b'=') {
                Some(split) => {
                    let name = String::from_utf8_lossy(&self.line[..split]).into_owned();
                    fields.push((name, self.line[split + 1..].to_vec()));
                }
                None => {
                    let name = String::from_utf8_lossy(&self.line).into_owned();
                    let mut size = [0u8; 8];
                    self.reader
                        .read_exact(&mut size)
                        .map_err(|error| format!("Truncated binary field {name}: {error}"))?;
                    let size = u64::from_le_bytes(size);
                    if size > 64 * 1024 * 1024 {
                        return Err(format!("Binary field {name} claims {size} bytes."));
                    }
                    let mut value = vec![0u8; size as usize];
                    self.reader
                        .read_exact(&mut value)
                        .map_err(|error| format!("Truncated binary field {name}: {error}"))?;
                    let mut newline = [0u8; 1];
                    self.reader
                        .read_exact(&mut newline)
                        .map_err(|error| error.to_string())?;
                    if newline != *b"\n" {
                        return Err(format!(
                            "Binary field {name} is missing its terminating newline."
                        ));
                    }
                    fields.push((name, value));
                }
            }
        }
    }
}

impl<R: BufRead> Iterator for Records<R> {
    type Item = Result<Record, String>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_record().transpose()
    }
}

/// What every listed row needs; the full record stays on the machine until inspected.
struct Entry {
    cursor: Box<str>,
    /// Microseconds since the epoch, as journald stamps it.
    time: u64,
    /// Effective severity: the journal priority, unless a structured message says otherwise.
    level: u8,
    unit: u32,
    ident: u32,
    pid: u32,
    message: Box<str>,
}

#[derive(Default)]
struct Names {
    list: Vec<Box<str>>,
    index: HashMap<Box<str>, u32>,
}

impl Names {
    fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.index.get(name) {
            return id;
        }
        let id = self.list.len() as u32;
        self.list.push(name.into());
        self.index.insert(name.into(), id);
        id
    }

    /// Resolve an ID previously issued by this interner.
    fn get(&self, id: u32) -> &str {
        &self.list[id as usize]
    }
}

/// Positions matching the most recent filter, extended as entries arrive.
struct Matches {
    filter: String,
    positions: Vec<u32>,
    scanned: usize,
}

#[derive(Default)]
struct Journal {
    entries: Vec<Entry>,
    names: Names,
    matches: Option<Matches>,
    /// The latest stream failure; cleared once entries flow again.
    error: Option<String>,
    settled: bool,
}

impl Journal {
    fn push(&mut self, record: &Record) {
        let Some(cursor) = record.text("__CURSOR") else {
            return;
        };
        let time = record
            .text("__REALTIME_TIMESTAMP")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let priority = record
            .text("PRIORITY")
            .and_then(|value| value.parse().ok())
            .unwrap_or(6u8)
            .min(7);
        let message = record.text("MESSAGE").unwrap_or_default();
        let message = message.trim_end_matches(['\n', '\r', ' ']);
        let level = structured_level(message).unwrap_or(priority);
        let unit = record.text("_SYSTEMD_UNIT").unwrap_or_default();
        let ident = match record.text("SYSLOG_IDENTIFIER") {
            Some(ident) if !ident.is_empty() => ident,
            _ => match record.text("_TRANSPORT").as_deref() {
                Some("kernel") => "kernel".into(),
                _ => record.text("_COMM").unwrap_or_default(),
            },
        };
        let pid = record
            .text("_PID")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        self.entries.push(Entry {
            cursor: cursor.as_ref().into(),
            time,
            level,
            unit: self.names.intern(&unit),
            ident: self.names.intern(&ident),
            pid,
            message: message.into(),
        });
    }

    /// Positions of entries matching `filter`, reusing the previous scan when the filter is unchanged.
    fn matching(&mut self, filter: &str) -> &[u32] {
        let stale = self
            .matches
            .as_ref()
            .is_none_or(|matches| matches.filter != filter);
        if stale {
            self.matches = Some(Matches {
                filter: filter.into(),
                positions: Vec::new(),
                scanned: 0,
            });
        }
        let matches = self.matches.as_mut().expect("matches were just ensured");
        if matches.scanned < self.entries.len() {
            let terms = Filter::parse(filter);
            for (position, entry) in self.entries.iter().enumerate().skip(matches.scanned) {
                if terms.matches(entry, &self.names) {
                    matches.positions.push(position as u32);
                }
            }
            matches.scanned = self.entries.len();
        }
        &matches.positions
    }

    /// Project matching positions directly; the full index stays behind the IPC boundary.
    fn frame(
        &mut self,
        filter: &str,
        paused_at: Option<usize>,
        viewport: &Viewport,
    ) -> Result<Frame, String> {
        self.matching(filter);
        let positions = &self
            .matches
            .as_ref()
            .expect("matching initialized the index")
            .positions;
        let total = paused_at.map_or(positions.len(), |paused| {
            positions.partition_point(|&position| (position as usize) < paused)
        });
        let columns = vec![
            Column {
                name: "Time".into(),
                kind: ColumnKind::Time,
            },
            Column {
                name: "Unit".into(),
                kind: ColumnKind::Unit,
            },
            Column {
                name: String::new(),
                kind: ColumnKind::Severity,
            },
            Column {
                name: "Message".into(),
                kind: ColumnKind::Message,
            },
        ];
        Frame::new(
            total,
            positions.len() - total,
            self.entries.len(),
            viewport,
            columns,
            |position| {
                let id = positions[position] as usize;
                let entry = &self.entries[id];
                Row {
                    id,
                    cells: vec![
                        local_time(entry.time, "%m-%d %H:%M:%S%.3f"),
                        unit_label(self.names.get(entry.unit), self.names.get(entry.ident)).into(),
                        LEVEL_NAMES[entry.level as usize].into(),
                        preview(&headline(&entry.message)),
                    ],
                    tone: tone(entry.level),
                }
            },
        )
    }
}

enum Term {
    Text(String),
    Level([bool; 8]),
    /// Any of several names, each matched as a substring.
    Unit(Vec<String>),
    Ident(Vec<String>),
    Pid(u32),
}

/// Space-separated terms, all of which must hold; `-` negates, `key:a,b` takes either value of a field.
struct Filter {
    terms: Vec<(bool, Term)>,
}

impl Filter {
    fn parse(filter: &str) -> Self {
        let terms = filter
            .split_whitespace()
            .filter_map(|raw| {
                let (negated, raw) = match raw.strip_prefix('-') {
                    Some(rest) => (true, rest),
                    None => (false, raw),
                };
                if raw.is_empty() {
                    return None;
                }
                let lower = raw.to_lowercase();
                let term = match lower.split_once(':') {
                    Some(("level" | "priority" | "prio", levels)) => Term::Level(level_set(levels)),
                    Some(("unit" | "service" | "u", units)) => Term::Unit(names(units)),
                    Some(("tag" | "ident" | "identifier" | "t", idents)) => {
                        Term::Ident(names(idents))
                    }
                    Some(("pid", pid)) => match pid.parse() {
                        Ok(pid) => Term::Pid(pid),
                        Err(_) => Term::Text(lower.clone()),
                    },
                    _ => Term::Text(lower),
                };
                Some((negated, term))
            })
            .collect();
        Self { terms }
    }

    fn matches(&self, entry: &Entry, names: &Names) -> bool {
        self.terms.iter().all(|(negated, term)| {
            let hit = match term {
                Term::Text(text) => {
                    entry.message.to_lowercase().contains(text.as_str())
                        || names.get(entry.unit).to_lowercase().contains(text.as_str())
                        || names
                            .get(entry.ident)
                            .to_lowercase()
                            .contains(text.as_str())
                }
                Term::Level(levels) => levels[entry.level as usize],
                Term::Unit(units) => any_of(units, names.get(entry.unit)),
                Term::Ident(idents) => any_of(idents, names.get(entry.ident)),
                Term::Pid(pid) => entry.pid == *pid,
            };
            hit != *negated
        })
    }
}

fn names(spec: &str) -> Vec<String> {
    spec.split(',')
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

fn any_of(needles: &[String], haystack: &str) -> bool {
    let haystack = haystack.to_lowercase();
    needles
        .iter()
        .any(|needle| haystack.contains(needle.as_str()))
}

/// Comma-separated names or numbers; a trailing `+` also takes everything more severe.
fn level_set(spec: &str) -> [bool; 8] {
    let mut set = [false; 8];
    for item in spec.split(',') {
        let (item, and_worse) = match item.strip_suffix('+') {
            Some(item) => (item, true),
            None => (item, false),
        };
        let Some(level) = level_number(item) else {
            continue;
        };
        set[level as usize] = true;
        if and_worse {
            set[..level as usize].fill(true);
        }
    }
    set
}

fn level_number(name: &str) -> Option<u8> {
    match name {
        "emerg" | "emergency" | "panic" | "0" => Some(0),
        "alert" | "1" => Some(1),
        "crit" | "critical" | "fatal" | "2" => Some(2),
        "err" | "error" | "3" => Some(3),
        "warn" | "warning" | "4" => Some(4),
        "notice" | "5" => Some(5),
        "info" | "6" => Some(6),
        "debug" | "trace" | "7" => Some(7),
        _ => None,
    }
}

/// Severity declared inside a JSON message, as structured loggers emit to stdout.
fn structured_level(message: &str) -> Option<u8> {
    let value = structured(message)?;
    let level = value.get("level")?.as_str()?;
    level_number(&level.to_lowercase())
}

fn structured(message: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    if !message.starts_with('{') {
        return None;
    }
    match serde_json::from_str(message).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The line a row shows: a structured message's own text, otherwise the first line.
fn headline(message: &str) -> Cow<'_, str> {
    if let Some(map) = structured(message) {
        if let Some(text) = map.get("message").and_then(|value| value.as_str()) {
            return Cow::Owned(text.lines().next().unwrap_or_default().to_string());
        }
    }
    Cow::Borrowed(message.lines().next().unwrap_or_default())
}

fn tone(level: u8) -> &'static str {
    match level {
        0..=3 => "error",
        4 => "warn",
        7 => "debug",
        _ => "info",
    }
}

fn local_time(microseconds: u64, format: &str) -> String {
    let timezone = jiff::tz::TimeZone::system();
    jiff::Timestamp::from_microsecond(microseconds as i64)
        .map(|stamp| stamp.to_zoned(timezone).strftime(format).to_string())
        .unwrap_or_default()
}

/// The unit a row names: the service, falling back to the identifier for scopes and slices.
fn unit_label<'a>(unit: &'a str, ident: &'a str) -> &'a str {
    if unit.is_empty()
        || unit == "init.scope"
        || unit.starts_with("session-")
        || unit.starts_with("user@")
    {
        return ident;
    }
    unit.strip_suffix(".service").unwrap_or(unit)
}

/// How the follower resumes after its stream ends.
enum Resume {
    History,
    After(String),
    TailOnly,
}

/// Owner of a follower's lifetime; the worker holds shared state, never this handle.
pub struct Tail {
    follower: Arc<Follower>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

/// Process ownership shared with the worker; stopping prevents all subsequent spawns.
enum Process {
    Idle,
    Active(Child),
    Stopped,
}

/// Journal and process state shared with the worker until shutdown completes.
struct Follower {
    host: Host,
    history: usize,
    journal: Mutex<Journal>,
    changed: Condvar,
    process: Mutex<Process>,
    wake: Condvar,
}

impl Tail {
    pub fn new(host: Host, history: usize) -> Arc<Self> {
        Arc::new(Self {
            follower: Arc::new(Follower {
                host,
                history,
                journal: Mutex::new(Journal::default()),
                changed: Condvar::new(),
                process: Mutex::new(Process::Idle),
                wake: Condvar::new(),
            }),
            worker: Mutex::new(None),
        })
    }

    fn start(&self) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return;
        }
        let follower = Arc::clone(&self.follower);
        let thread = std::thread::Builder::new()
            .name(format!("journal {}", self.follower.host.label()))
            .spawn(move || follower.follow())
            .expect("a journal thread can be spawned");
        *worker = Some(thread);
    }
}

impl Follower {
    fn lock(&self) -> MutexGuard<'_, Journal> {
        self.journal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn settle(&self, error: Option<String>) {
        let mut journal = self.lock();
        journal.error = error;
        journal.settled = true;
        self.changed.notify_all();
    }

    /// Start a cancellable child before handing its pipes to the worker.
    fn spawn(&self, script: &str) -> Result<(ChildStdout, JoinHandle<Vec<u8>>), String> {
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(*process, Process::Stopped) {
            return Err("The journal follower stopped.".into());
        }
        let mut child = self.host.stream(script)?;
        let stdin = child.stdin.take();
        drop(stdin);
        let stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        *process = Process::Active(child);
        drop(process);
        let stderr = std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.read_to_end(&mut text);
            text
        });
        Ok((stdout, stderr))
    }

    fn finish(&self) -> Option<ExitStatus> {
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut child = match std::mem::replace(&mut *process, Process::Idle) {
            Process::Stopped => {
                *process = Process::Stopped;
                return None;
            }
            Process::Idle => return None,
            Process::Active(child) => child,
        };
        drop(process);
        shell::stop(&mut child)
    }

    /// Reap a completed history command without racing its final exit with a kill.
    fn wait(&self) -> Option<ExitStatus> {
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            let child = match &mut *process {
                Process::Stopped | Process::Idle => return None,
                Process::Active(child) => child,
            };
            let status = child.try_wait();
            match status {
                Err(_) => {
                    drop(process);
                    return self.finish();
                }
                Ok(Some(status)) => {
                    shell::forget(child);
                    *process = Process::Idle;
                    return Some(status);
                }
                Ok(None) => {}
            }
            // Waiting only after stdout closes; cancellation remains possible until the child exits.
            let waited = self.wake.wait_timeout(process, Duration::from_millis(10));
            (process, _) = waited.unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Wait between failures, waking immediately when the owner is dropped.
    fn reconnect(&self) -> bool {
        let process = self
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (process, _) = self
            .wake
            .wait_timeout_while(process, RECONNECT_DELAY, |process| {
                !matches!(process, Process::Stopped)
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        !matches!(*process, Process::Stopped)
    }

    fn history(&self) -> Result<Vec<u8>, String> {
        let script = history_script(self.history);
        let (mut stdout, stderr) = self.spawn(&script)?;
        let mut bytes = Vec::new();
        let read = stdout.read_to_end(&mut bytes);
        let status = match &read {
            Err(_) => self.finish(),
            Ok(_) => self.wait(),
        };
        let stderr = stderr.join().unwrap_or_default();
        read.map_err(|error| error.to_string())?;
        if !status.as_ref().is_some_and(ExitStatus::success) {
            return Err(shell::failure(
                &stderr,
                status.and_then(|status| status.code()),
            ));
        }
        Ok(bytes)
    }

    fn follow(self: Arc<Self>) {
        let mut resume = Resume::History;
        let mut stale_cursor_failures = 0;
        loop {
            if let Resume::History = resume {
                let history = self.history();
                let bytes = match history {
                    Err(error) => {
                        self.settle(Some(error));
                        let reconnect = self.reconnect();
                        if !reconnect {
                            return;
                        }
                        continue;
                    }
                    Ok(bytes) => bytes,
                };
                let mut last = None;
                let records = decode(&bytes);
                let mut journal = self.lock();
                journal.error = None;
                for record in records {
                    let record = match record {
                        Err(error) => {
                            journal.error = Some(error);
                            break;
                        }
                        Ok(record) => record,
                    };
                    last = record.text("__CURSOR").map(|cursor| cursor.into_owned());
                    journal.push(&record);
                }
                journal.settled = true;
                self.changed.notify_all();
                drop(journal);
                resume = match last {
                    Some(cursor) => Resume::After(cursor),
                    None => Resume::TailOnly,
                };
            }
            let after = match &resume {
                Resume::After(cursor) => Some(cursor.clone()),
                _ => None,
            };
            let script = follow_script(after.as_deref());
            let stream = self.spawn(&script);
            let (stdout, stderr) = match stream {
                Err(error) => {
                    self.settle(Some(error));
                    let reconnect = self.reconnect();
                    if !reconnect {
                        return;
                    }
                    continue;
                }
                Ok(stream) => stream,
            };
            let mut received = 0usize;
            let mut parse_error = None;
            let mut stdout = BufReader::new(stdout);
            let mut ready = [0];
            let started = stdout.read_exact(&mut ready);
            if started.is_ok() && ready == *b"R" {
                self.settle(None);
            }
            for record in Records::new(stdout) {
                let record = match record {
                    Err(error) => {
                        parse_error = Some(error);
                        break;
                    }
                    Ok(record) => record,
                };
                received += 1;
                let mut journal = self.lock();
                journal.push(&record);
                journal.error = None;
                journal.settled = true;
                if let Some(cursor) = record.text("__CURSOR") {
                    resume = Resume::After(cursor.into_owned());
                }
                self.changed.notify_all();
            }
            let status = self.finish();
            let stderr = stderr.join().unwrap_or_default();
            let failed = status.as_ref().is_none_or(|status| !status.success());
            let error = parse_error.or_else(|| {
                failed.then(|| shell::failure(&stderr, status.and_then(|status| status.code())))
            });
            // Forgetting a cursor the machine no longer has; the gap is visible, the stream continues.
            let missing_cursor =
                String::from_utf8_lossy(&stderr).contains("Failed to seek to cursor");
            if received == 0 && after.is_some() && missing_cursor {
                stale_cursor_failures += 1;
                if stale_cursor_failures >= 2 {
                    resume = Resume::TailOnly;
                    stale_cursor_failures = 0;
                }
            } else {
                stale_cursor_failures = 0;
            }
            self.settle(error.or_else(|| Some("The journal stream ended.".into())));
            let reconnect = self.reconnect();
            if !reconnect {
                return;
            }
        }
    }
}

impl Tail {
    /// Project the filtered tail; a first request waits for history rather than showing nothing.
    pub fn frame(
        &self,
        filter: &str,
        paused_at: Option<usize>,
        viewport: &Viewport,
    ) -> Result<Frame, String> {
        self.start();
        let mut journal = self.follower.lock();
        if !journal.settled {
            let now = Instant::now();
            let deadline = now + FIRST_FRAME_PATIENCE;
            while !journal.settled {
                let now = Instant::now();
                let left = deadline.saturating_duration_since(now);
                if left.is_zero() {
                    return Err(format!("Still waiting for {}.", self.follower.host.label()));
                }
                journal = self
                    .follower
                    .changed
                    .wait_timeout(journal, left)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
        }
        if journal.entries.is_empty() {
            if let Some(error) = &journal.error {
                return Err(error.clone());
            }
        }
        journal.frame(filter, paused_at, viewport)
    }

    /// Fetch the whole record behind a row using its retained journal cursor.
    pub fn detail(&self, id: usize) -> Result<Detail, String> {
        let (cursor, level) = {
            let journal = self.follower.lock();
            let entry = journal
                .entries
                .get(id)
                .ok_or("That entry is no longer in the tail.")?;
            (entry.cursor.to_string(), entry.level)
        };
        let script = format!(
            "journalctl -q --no-pager -o export -n 1 --cursor={}",
            quote(&cursor)
        );
        let bytes = self.follower.host.run(&script, b"")?;
        let record = Records::new(bytes.as_slice())
            .next()
            .ok_or("The machine no longer has that entry.")??;
        Ok(detail(&record, level))
    }
}

impl Drop for Tail {
    fn drop(&mut self) {
        let mut process = self
            .follower
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::mem::replace(&mut *process, Process::Stopped);
        drop(process);
        self.follower.wake.notify_all();
        if let Process::Active(mut child) = previous {
            let _ = shell::stop(&mut child);
        }
        let worker = self
            .worker
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(worker) = worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::mpsc;

    fn drop_promptly(tail: Arc<Tail>) {
        let (finished, done) = mpsc::channel();
        let dropper = std::thread::spawn(move || {
            drop(tail);
            finished.send(()).unwrap();
        });
        let result = done.recv_timeout(Duration::from_secs(2));
        result.expect("dropping a tail must stop and join its worker");
        dropper.join().unwrap();
    }

    #[test]
    fn dropping_tail_stops_active_pipeline_and_releases_worker() {
        let tail = Tail::new(Host::Local, 1);
        let follower = Arc::clone(&tail.follower);
        let weak = Arc::downgrade(&follower);
        let (started, ready) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (stdout, stderr) = follower
                .spawn("sleep 60 & printf 'ready\\n'; wait")
                .unwrap();
            let mut stdout = BufReader::new(stdout);
            let mut line = String::new();
            stdout.read_line(&mut line).unwrap();
            assert_eq!(line, "ready\n");
            started.send(()).unwrap();
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).unwrap();
            let _ = follower.finish();
            stderr.join().unwrap();
        });
        *tail.worker.lock().unwrap() = Some(worker);
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        drop_promptly(tail);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn dropping_tail_cancels_a_child_that_closed_stdout_before_exiting() {
        let tail = Tail::new(Host::Local, 1);
        let follower = Arc::clone(&tail.follower);
        let (started, ready) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut stdout, stderr) = follower.spawn("exec 1>&-; sleep 60 & wait").unwrap();
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).unwrap();
            started.send(()).unwrap();
            let _ = follower.wait();
            stderr.join().unwrap();
        });
        *tail.worker.lock().unwrap() = Some(worker);
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        drop_promptly(tail);
    }

    #[test]
    fn dropping_tail_wakes_reconnect_delay() {
        let tail = Tail::new(Host::Local, 1);
        let follower = Arc::clone(&tail.follower);
        let (started, ready) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            let reconnect = follower.reconnect();
            assert!(!reconnect);
        });
        *tail.worker.lock().unwrap() = Some(worker);
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        drop_promptly(tail);
    }

    #[test]
    fn completed_history_is_reaped_without_changing_success_to_a_signal() {
        let tail = Tail::new(Host::Local, 1);
        for _ in 0..8 {
            let (mut stdout, stderr) = tail.follower.spawn("printf P").unwrap();
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).unwrap();
            let status = tail.follower.wait().unwrap();
            assert!(status.success());
            assert_eq!(bytes, b"P");
            stderr.join().unwrap();
        }
    }
}

fn detail(record: &Record, level: u8) -> Detail {
    let message = record.text("MESSAGE").unwrap_or_default().into_owned();
    let structured = structured(&message);
    let title = match &structured {
        Some(map) => map
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or(&message)
            .to_string(),
        None => message.clone(),
    };
    let time = record
        .text("__REALTIME_TIMESTAMP")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let unit = record.text("_SYSTEMD_UNIT").unwrap_or_default();
    let ident = record.text("SYSLOG_IDENTIFIER").unwrap_or_default();
    let mut fields = vec![
        Field::read_only("time", local_time(time, "%Y-%m-%d %H:%M:%S%.6f %Z")),
        Field::read_only("level", LEVEL_NAMES[level as usize]),
        Field::read_only("unit", unit_label(&unit, &ident)),
    ];
    if let Some(map) = &structured {
        for (key, value) in map {
            if key == "message" {
                continue;
            }
            let text = match value {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            fields.push(Field::read_only(format!("message.{key}"), text));
        }
    }
    let mut rest: Vec<&(String, Vec<u8>)> = record
        .fields
        .iter()
        .filter(|(name, _)| {
            !name.starts_with("__")
                && !matches!(
                    name.as_str(),
                    "MESSAGE" | "PRIORITY" | "_SOURCE_REALTIME_TIMESTAMP"
                )
        })
        .collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, value) in rest {
        let text = match std::str::from_utf8(value) {
            Ok(text) => text.trim().to_string(),
            Err(_) => format!("{} bytes", value.len()),
        };
        fields.push(Field::read_only(name.clone(), text));
    }
    Detail {
        title,
        tone: tone(level),
        fields,
        trace: Vec::new(),
    }
}

/// Bounded recent history in one round trip, compressed when the machine can.
fn history_script(history: usize) -> String {
    format!(
        "if command -v zstd >/dev/null 2>&1; then printf Z; journalctl -q --no-pager -o export --output-fields={FIELDS} -n {history} | zstd -q -3; else printf P; journalctl -q --no-pager -o export --output-fields={FIELDS} -n {history}; fi"
    )
}

/// Entries after a cursor, then the live tail; without a cursor only the tail from now on.
fn follow_script(after: Option<&str>) -> String {
    let command = match after {
        Some(cursor) => format!("journalctl -q --no-pager -o export --output-fields={FIELDS} -n all --after-cursor={} -f", quote(cursor)),
        None => format!("journalctl -q --no-pager -o export --output-fields={FIELDS} -n 0 -f"),
    };
    format!("export LC_ALL=C; printf R; exec {command}")
}

/// Decode a history reply by its leading format byte: zstd, or plain export.
fn decode(bytes: &[u8]) -> Box<dyn Iterator<Item = Result<Record, String>> + '_> {
    match bytes.split_first() {
        Some((b'Z', body)) => match ruzstd::decoding::StreamingDecoder::new(body) {
            Ok(decoder) => Box::new(Records::new(BufReader::new(decoder))),
            Err(error) => Box::new(std::iter::once(Err(format!(
                "Cannot decode the history: {error}"
            )))),
        },
        Some((b'P', body)) => Box::new(Records::new(body)),
        Some(_) => Box::new(Records::new(bytes)),
        None => Box::new(std::iter::empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate varied parser input without retaining any machine's captured logs.
    fn export() -> Vec<u8> {
        let mut bytes = Vec::new();
        for index in 0..400 {
            let unit = ["", "cloud-init.service", "api.service", "worker.service"][index % 4];
            let identifier = if unit.is_empty() { "kernel" } else { "example" };
            let priority = if index % 25 == 0 {
                3
            } else if index % 5 == 0 {
                4
            } else {
                6
            };
            let message = if unit == "worker.service" {
                if index % 8 == 3 {
                    r#"{"level":"TRACE","message":"processing","target":"worker"}"#
                } else {
                    r#"{"level":"ERROR","message":"request failed","target":"worker"}"#
                }
            } else {
                "Listening for requests"
            };
            let record = format!("__CURSOR=s=fixture;i={index}\n__REALTIME_TIMESTAMP={}\n_SYSTEMD_UNIT={unit}\nSYSLOG_IDENTIFIER={identifier}\nPRIORITY={priority}\nMESSAGE={message}\n\n", 1_700_000_000_000_000u64 + index as u64);
            bytes.extend_from_slice(record.as_bytes());
        }
        bytes
    }

    fn load(export: &[u8]) -> Journal {
        let mut journal = Journal::default();
        for record in Records::new(export) {
            journal.push(&record.unwrap());
        }
        journal
    }

    fn viewport() -> Viewport {
        Viewport {
            top: None,
            row_height: 36.0,
            padding_top: 72.0,
            padding_bottom: 108.0,
            overscan: 3,
            height: 600.0,
            inset_top: 88.0,
        }
    }

    fn frame(journal: &mut Journal, filter: &str, paused_at: Option<usize>) -> Frame {
        journal.frame(filter, paused_at, &viewport()).unwrap()
    }

    #[test]
    fn export_records_round_trip_text_and_binary_fields() {
        let records: Vec<Record> = Records::new(export().as_slice())
            .map(Result::unwrap)
            .collect();
        assert_eq!(records.len(), 400);
        assert!(records
            .iter()
            .all(|record| record.get("__CURSOR").is_some() && record.get("MESSAGE").is_some()));
        let mut export = b"__CURSOR=s=1;i=2\nMESSAGE\n".to_vec();
        export.extend_from_slice(&11u64.to_le_bytes());
        export
            .extend_from_slice(b"two\nlines\xff!\nPRIORITY=4\n\n__CURSOR=s=1;i=3\nMESSAGE=plain\n");
        let records: Vec<Record> = Records::new(export.as_slice())
            .map(Result::unwrap)
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].get("MESSAGE").unwrap(), b"two\nlines\xff!");
        assert_eq!(records[0].text("PRIORITY").unwrap(), "4");
        assert_eq!(records[1].text("MESSAGE").unwrap(), "plain");
        let truncated = b"__CURSOR=x\nMESSAGE\n\x10\x00\x00\x00\x00\x00\x00\x00abc".as_slice();
        assert!(Records::new(truncated).next().unwrap().is_err());
        let malformed = b"MESSAGE\n\x03\x00\x00\x00\x00\x00\x00\x00abc!".as_slice();
        assert!(Records::new(malformed).next().unwrap().is_err());
    }

    #[test]
    fn levels_come_from_the_journal_or_a_structured_message() {
        let mut journal = load(&export());
        let errors = frame(&mut journal, "level:err", None);
        assert!(errors.total > 0);
        assert!(errors.rows.iter().all(|row| row.tone == "error"));
        let trouble = frame(&mut journal, "level:warn+", None);
        assert!(trouble.total >= errors.total);
        let mut journal = load(&export());
        let trace = frame(&mut journal, "level:debug unit:worker", None);
        assert!(trace.total >= 50, "stdout TRACE lines are demoted to debug");
        assert!(trace
            .rows
            .iter()
            .all(|row| row.tone == "debug" && !row.cells[3].starts_with('{')));
        let errors = frame(&mut journal, "level:error", None);
        assert!(errors.total > 0);
        assert!(frame(&mut journal, "level:error unit:worker", None).total > 0);
    }

    #[test]
    fn filters_combine_fields_text_and_negation() {
        let mut journal = load(&export());
        let all = frame(&mut journal, "", None).total;
        assert_eq!(all, 400);
        let api = frame(&mut journal, "unit:api", None).total;
        assert!(api > 0);
        assert_eq!(frame(&mut journal, "-unit:api", None).total, all - api);
        assert_eq!(frame(&mut journal, "unit:api -unit:api", None).total, 0);
        let either = frame(&mut journal, "unit:api,cloud-init", None).total;
        assert_eq!(
            either,
            api + frame(&mut journal, "unit:cloud-init", None).total
        );
        let kernel = frame(&mut journal, "tag:kernel", None);
        assert_eq!(kernel.total, 100);
        assert!(kernel.rows.iter().all(|row| row.cells[1] == "kernel"));
        assert!(
            frame(&mut journal, "LISTENING", None).total > 0,
            "text terms ignore case"
        );
        assert_eq!(frame(&mut journal, "no-such-text-anywhere", None).total, 0);
        let paused = frame(&mut journal, "", Some(100));
        assert_eq!((paused.total, paused.pending, paused.tick), (100, 300, 400));
    }

    #[test]
    fn matches_extend_incrementally_when_entries_arrive() {
        let mut journal = Journal::default();
        let records: Vec<Record> = Records::new(export().as_slice())
            .map(Result::unwrap)
            .collect();
        for record in &records[..100] {
            journal.push(record);
        }
        let first = frame(&mut journal, "unit:worker", None).total;
        for record in &records[100..] {
            journal.push(record);
        }
        let later = frame(&mut journal, "unit:worker", None);
        assert!(later.total > first);
        assert_eq!(journal.matches.as_ref().unwrap().scanned, records.len());
        assert!(later.rows.windows(2).all(|pair| pair[0].id < pair[1].id));
    }

    #[test]
    fn details_surface_structured_fields_and_scripts_quote_cursors() {
        let record = Records::new(export().as_slice())
            .map(Result::unwrap)
            .find(|record| {
                record
                    .text("MESSAGE")
                    .unwrap()
                    .contains("\"level\":\"ERROR\"")
            })
            .unwrap();
        let detail = detail(&record, 3);
        assert_eq!(detail.tone, "error");
        assert!(!detail.title.starts_with('{'));
        assert!(detail
            .fields
            .iter()
            .any(|field| field.name == "message.target"));
        assert!(detail
            .fields
            .iter()
            .any(|field| field.name == "_SYSTEMD_UNIT"
                && field.value.as_deref() == Some("worker.service")));
        assert!(detail.fields.iter().all(|field| !field.writable));
        assert_eq!(quote("s=1;i='2'"), "'s=1;i='\\''2'\\'''");
        assert!(follow_script(Some("s=1")).contains("--after-cursor='s=1' -f"));
        assert!(follow_script(None).ends_with("-n 0 -f"));
        assert!(history_script(20).contains("-n 20 | zstd"));
    }

    #[test]
    fn history_replies_decode_by_their_leading_byte() {
        let mut plain = b"P".to_vec();
        plain.extend_from_slice(&export());
        assert_eq!(decode(&plain).count(), 400);
        assert_eq!(decode(&export()).count(), 400);
        assert_eq!(decode(b"").count(), 0);
        let mut compressed = b"Z".to_vec();
        compressed.extend_from_slice(&zstd_compress(&export()));
        assert_eq!(decode(&compressed).map(Result::unwrap).count(), 400);
    }

    fn zstd_compress(bytes: &[u8]) -> Vec<u8> {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg("zstd -q -3")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(bytes)?;
                child.wait_with_output()
            })
            .expect("zstd is installed for this test");
        output.stdout
    }

    #[test]
    fn unit_labels_prefer_services_over_sessions() {
        assert_eq!(unit_label("api@next.service", "bun"), "api@next");
        assert_eq!(
            unit_label("session-c5.scope", "sshd-session"),
            "sshd-session"
        );
        assert_eq!(unit_label("init.scope", "systemd"), "systemd");
        assert_eq!(unit_label("", "kernel"), "kernel");
        assert_eq!(
            level_set("warn+"),
            [true, true, true, true, true, false, false, false]
        );
        assert_eq!(
            level_set("err,debug"),
            [false, false, false, true, false, false, false, true]
        );
        assert_eq!(
            headline("{\"level\":\"INFO\",\"message\":\"hi\\nthere\"}"),
            "hi"
        );
        assert_eq!(headline("first\nsecond"), "first");
    }
}

/// Opt-in checks against a reachable machine: `ALTAR_TEST_SSH=user@host cargo test -- --ignored`.
#[cfg(test)]
mod machine_tests {
    use super::*;

    fn host() -> Option<Host> {
        std::env::var("ALTAR_TEST_SSH").ok().map(Host::Ssh)
    }

    #[test]
    #[ignore]
    fn history_streams_and_entries_resolve_to_full_records() {
        let Some(host) = host() else { return };
        let tail = Tail::new(host, 300);
        let viewport = Viewport {
            top: None,
            row_height: 36.0,
            padding_top: 72.0,
            padding_bottom: 108.0,
            overscan: 3,
            height: 600.0,
            inset_top: 88.0,
        };
        let frame = tail.frame("", None, &viewport).unwrap();
        assert!(
            frame.total > 0 && frame.total <= 300,
            "history is bounded: {}",
            frame.total
        );
        assert_eq!(frame.tick, frame.total);
        let last = frame.rows.last().unwrap();
        assert_eq!(frame.columns.len(), 4);
        let detail = tail.detail(last.id).unwrap();
        assert!(detail.fields.iter().any(|field| field.name == "_HOSTNAME"));
        assert!(!detail.fields.iter().any(|field| field.name == "__CURSOR"));
        let paused = tail.frame("", Some(10), &viewport).unwrap();
        assert_eq!(paused.total, 10);
        assert!(paused.pending >= frame.total - 10);
        // Something lands in the journal every few seconds on a busy host; our own ssh sessions make sure of it.
        let before = tail.follower.lock().entries.len();
        let _ = tail.follower.host.run("true", b"");
        std::thread::sleep(Duration::from_secs(3));
        let after = tail.follower.lock().entries.len();
        assert!(
            after > before,
            "the follower picks up new entries ({before} -> {after})"
        );
        assert!(tail.follower.lock().error.is_none());
    }
}
