use crate::stream::Viewport;
use serde::{Deserialize, Serialize};

/// Content to evaluate, independent of machine-local navigation IDs.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Query {
    Logs {
        filter: String,
    },
    Sql {
        /// The machine's SQL view that owns the connection; a machine may reach several databases.
        source: String,
        statement: String,
        /// Bumped by each explicit run; viewport changes alone never execute a statement again.
        run: u64,
    },
}

#[derive(Clone, Serialize)]
pub struct View {
    pub id: String,
    pub name: String,
    pub query: Query,
}

#[derive(Serialize)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub connection: Connection,
    pub views: Vec<View>,
}

/// Reachability observed by the machine's persistent sampler.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    Connecting,
    Connected,
    Reconnecting,
}

/// Machine-scoped navigation identity; unrelated to query execution.
#[derive(Serialize)]
pub struct Selection {
    pub machine: String,
    pub view: Option<String>,
}

/// Workspace and initial fixture state returned together through the real IPC boundary.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub local_hostname: String,
    pub machines: Vec<Machine>,
    pub selection: Option<Selection>,
    pub tick: usize,
    pub paused_at: Option<usize>,
    pub inspect: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    pub machine: String,
    pub query: Query,
    pub tick: usize,
    /// Frozen collection tick while browsing; None keeps the collection live.
    pub paused_at: Option<usize>,
    pub viewport: Viewport,
}

/// Machine-owned sample, with nonempty percentage histories ordered oldest to newest.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub machine: String,
    pub cpu: Vec<usize>,
    pub memory: Vec<usize>,
    pub disk: usize,
    pub cpu_cores: u16,
    pub memory_gb: f64,
    pub disk_gb: f64,
    pub uptime: String,
    pub last_sample: Option<String>,
}

#[derive(Serialize)]
pub struct Detail {
    pub title: String,
    pub tone: &'static str,
    pub fields: Vec<Field>,
    pub trace: Vec<TraceSpan>,
}

/// One inspected value; a writable field belongs to a row the backend can address by primary key.
#[derive(Serialize)]
pub struct Field {
    pub name: String,
    pub value: Option<String>,
    pub writable: bool,
    /// The SQL type behind a writable field, shown next to its editor.
    pub kind: Option<String>,
}

impl Field {
    pub fn read_only(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: Some(value.into()),
            writable: false,
            kind: None,
        }
    }
}

/// A cell edit addressed through the same identity as an inspection.
#[derive(Deserialize)]
pub struct CellEdit {
    pub machine: String,
    pub query: Query,
    pub id: usize,
    pub field: String,
    pub value: Option<String>,
}

#[derive(Serialize)]
pub struct TraceSpan {
    pub name: String,
    pub duration: String,
    pub start: u8,
    pub width: u8,
}
