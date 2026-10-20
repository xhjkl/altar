use crate::stream::Viewport;
use serde::{Deserialize, Serialize};

/// Initial content stored in a machine-local view.
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
    },
}

/// Lookup-only content; SQL execution is owned by the submission command.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Content {
    Logs { filter: String },
    Sql { source: String, result: u64 },
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

/// Workspace navigation and local machine identity.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub local_hostname: String,
    pub machines: Vec<Machine>,
    pub selection: Option<Selection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    pub machine: String,
    pub query: Content,
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

/// Domain-specific inspection data; an SQL result never acquires journal or trace fields.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Detail {
    Journal(JournalDetail),
    Sql(SqlDetail),
}

#[derive(Serialize)]
pub struct JournalDetail {
    pub title: String,
    pub tone: &'static str,
    pub fields: Vec<JournalField>,
}

#[derive(Serialize)]
pub struct JournalField {
    pub name: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct SqlDetail {
    pub title: String,
    pub fields: Vec<SqlField>,
}

#[derive(Serialize)]
pub struct SqlField {
    pub name: String,
    pub value: Option<String>,
    pub kind: Option<String>,
    /// Physical column index, present only when this row and column can be edited safely.
    pub edit: Option<usize>,
}

/// SQL-only cell address within one retained result.
#[derive(Deserialize)]
pub struct CellEdit {
    pub machine: String,
    pub source: String,
    pub result: u64,
    pub id: usize,
    pub column: usize,
    pub value: Option<String>,
}
