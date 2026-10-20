//! Run SQL through psql on the machine: results travel as COPY text, edits as UPDATE … RETURNING.
use crate::protocol::{SqlDetail, SqlField};
use crate::shell::{quote, Host};
use crate::stream::{preview, Column, ColumnKind, Frame, Row, Viewport};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// A usable database connection discovered on its host.
#[derive(Debug)]
pub struct Source {
    /// Opaque identity within one host session, independent of endpoint syntax and display labels.
    pub id: String,
    pub name: String,
    pub psql: String,
}

/// Initial table overview for a newly opened database.
pub const DEFAULT_STATEMENT: &str =
    "select schemaname as schema, relname as table, n_live_tup as rows from pg_stat_user_tables order by 1, 2";

/// Discover usable local PostgreSQL databases without prompts or remote changes.
pub fn discover(host: &Host) -> Result<Vec<Source>, String> {
    let bytes = host.run(include_str!("postgres.sh"), b"")?;
    discovered_sources(&bytes)
}

/// Decode probe batches and retain the first authenticated endpoint for each cluster.
fn discovered_sources(bytes: &[u8]) -> Result<Vec<Source>, String> {
    let mut sources = Vec::new();
    let mut clusters = HashSet::new();
    if bytes.is_empty() {
        return Ok(sources);
    }
    let bytes = bytes
        .strip_suffix(&[0])
        .ok_or("Incomplete PostgreSQL discovery reply.")?;
    let batches = bytes.split(|&byte| byte == 0).collect::<Vec<_>>();
    if batches.len() % 5 != 0 {
        return Err("Incomplete PostgreSQL discovery reply.".into());
    }
    for batch in batches.chunks(5) {
        let fields: Vec<&str> = batch
            .iter()
            .map(|bytes| std::str::from_utf8(bytes))
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        let [mode, client, location, port, rows] = fields.as_slice() else {
            unreachable!()
        };
        let runner = match *mode {
            "direct" | "postgres" => "",
            "runuser" => "runuser -u postgres -- ",
            "sudo" => "sudo -n -u postgres -- ",
            _ => return Err("Unknown PostgreSQL discovery identity.".into()),
        };
        if !location.starts_with('/') && !matches!(*location, "127.0.0.1" | "::1") {
            return Err("PostgreSQL discovery returned a non-local endpoint.".into());
        }
        let port = port.parse::<u16>().map_err(|error| error.to_string())?;
        if port == 0 {
            return Err("PostgreSQL discovery returned port zero.".into());
        }
        let rows: Vec<(String, String)> = rows
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        let Some((cluster, _)) = rows.first() else {
            continue;
        };
        if !clusters.insert(cluster.clone()) {
            continue;
        }
        let user = if *mode == "direct" {
            ""
        } else {
            " -U postgres"
        };
        let command = format!("{runner}env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE PGCONNECT_TIMEOUT=2 {} -w -h {} -p {port}{user}", quote(client), quote(location));
        for (_, database) in rows {
            let connection = format!(
                "dbname='{}'",
                database.replace('\\', "\\\\").replace('\'', "\\'")
            );
            sources.push(Source {
                id: format!("postgres-{}", sources.len()),
                name: if port == 5432 {
                    database
                } else {
                    format!("{database} · {port}")
                },
                psql: format!("{command} -d {}", quote(&connection)),
            });
        }
    }
    Ok(sources)
}

const ROW_CAP: usize = 5_000;
const PSQL_FLAGS: &str = "-X -At -v ON_ERROR_STOP=1 -P pager=off -f -";

struct Table {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

/// A physical column behind a result, as the catalog describes it.
#[derive(Clone)]
struct RelationColumn {
    name: String,
    kind: String,
    primary: bool,
    writable: bool,
}

/// The one relation a result reads from, with result columns mapped onto it.
struct Target {
    schema: String,
    name: String,
    columns: Vec<RelationColumn>,
    /// For each result column, the relation column it carries unchanged.
    origins: Vec<Option<usize>>,
    /// Result columns holding every primary key column; empty when a row cannot be addressed.
    key: Vec<(usize, usize)>,
}

struct Cache {
    statement: String,
    id: u64,
    submission: String,
    outcome: Result<Table, String>,
    target: Metadata,
    /// Attempted writes and their confirmed base rows; the query snapshot remains immutable.
    edited: HashMap<usize, EditedRow>,
}

enum EditedRow {
    Uncertain,
    Current(Vec<Option<String>>),
}

impl EditedRow {
    /// Refuse another edit when the last write may have changed the row's identity.
    fn current(&self) -> Result<&[Option<String>], String> {
        match self {
            Self::Uncertain => {
                Err("Run the query again to verify the last write before editing this row.".into())
            }
            Self::Current(row) => Ok(row),
        }
    }
}

enum Metadata {
    Unresolved,
    ReadOnly,
    Relation(Target),
}

impl Metadata {
    fn relation(&self) -> Option<&Target> {
        match self {
            Self::Unresolved | Self::ReadOnly => None,
            Self::Relation(target) => Some(target),
        }
    }
}

/// Process-wide result identities; replacing a connection cannot revive an old handle.
static NEXT_RESULT: AtomicU64 = AtomicU64::new(1);

/// One SQL source's latest outcome and cached catalog metadata.
/// Each submission uses a fresh psql process; database session state does not persist between runs.
pub struct Workbench {
    host: Host,
    psql: String,
    cache: Mutex<Option<Cache>>,
}

impl Workbench {
    pub fn new(host: Host, psql: String) -> Self {
        Self {
            host,
            psql,
            cache: Mutex::new(None),
        }
    }

    /// Retain the latest run even after a request panics, instead of poisoning later requests.
    fn lock(&self) -> MutexGuard<'_, Option<Cache>> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn psql(&self, script: &str, quiet: bool) -> Result<String, String> {
        let command = format!(
            "{} {}{}",
            self.psql,
            if quiet { "-q " } else { "" },
            PSQL_FLAGS
        );
        let output = self.host.run(&command, script.as_bytes())?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    fn execute(&self, statement: &str) -> Result<Table, String> {
        let sql = bare(statement);
        if sql.is_empty() {
            return Ok(Table {
                columns: Vec::new(),
                rows: Vec::new(),
            });
        }
        if reads(sql) {
            let script = format!("COPY (SELECT * FROM ({sql}) AS altar_result LIMIT {ROW_CAP}) TO STDOUT WITH (FORMAT text, HEADER true);\n");
            let output = self.psql(&script, true)?;
            return parse_copy(&output);
        }
        let output = self.psql(&format!("{sql};\n"), false)?;
        Ok(Table {
            columns: vec!["result".into()],
            rows: output
                .lines()
                .map(|line| vec![Some(line.to_string())])
                .collect(),
        })
    }

    /// Execute one explicit submission, retaining its outcome even when SQL fails.
    pub fn submit(&self, statement: &str, submission: &str) -> Result<u64, String> {
        let mut cache = self.lock();
        if let Some(entry) = cache
            .as_ref()
            .filter(|entry| entry.submission == submission)
        {
            if entry.statement != statement {
                return Err("A submission cannot change its statement.".into());
            }
            return Ok(entry.id);
        }
        // Serializing submissions; concurrent copies of one request must not repeat effects.
        let id = NEXT_RESULT.fetch_add(1, Ordering::Relaxed);
        let outcome = self.execute(statement);
        *cache = Some(Cache {
            statement: statement.into(),
            id,
            submission: submission.into(),
            outcome,
            target: Metadata::Unresolved,
            edited: HashMap::new(),
        });
        Ok(id)
    }

    /// Reject expired handles before any catalog access or SQL execution.
    fn with_result<T>(
        &self,
        result: u64,
        read: impl FnOnce(&mut Cache) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut cache = self.lock();
        let entry = cache
            .as_mut()
            .filter(|entry| entry.id == result)
            .ok_or("That SQL result has expired. Run the query again.")?;
        read(entry)
    }

    pub fn frame(&self, result: u64, viewport: &Viewport) -> Result<Frame, String> {
        self.with_result(result, |entry| {
            let table = entry.outcome.as_ref().map_err(Clone::clone)?;
            let columns = columns(table);
            let mut frame = Frame::new(table.rows.len(), 0, 0, viewport, columns, |id| Row {
                id,
                cells: table.rows[id]
                    .iter()
                    .map(|cell| preview(cell.as_deref().unwrap_or("NULL")))
                    .collect(),
                tone: "",
            })?;
            if !entry.edited.is_empty() {
                frame.notice = Some("Result snapshot is stale. Run to refresh.".into());
            }
            Ok(frame)
        })
    }

    pub fn detail(&self, result: u64, id: usize) -> Result<SqlDetail, String> {
        self.with_result(result, |entry| {
            let table = entry.outcome.as_ref().map_err(Clone::clone)?;
            if id >= table.rows.len() {
                return Err("That row is no longer in the result.".into());
            }
            if matches!(entry.target, Metadata::Unresolved) {
                let target = if reads(bare(&entry.statement)) {
                    self.derive_target(bare(&entry.statement), &table.columns)
                } else {
                    None
                };
                entry.target = match target {
                    None => Metadata::ReadOnly,
                    Some(target) => Metadata::Relation(target),
                };
            }
            let target = entry.target.relation();
            let current = entry.edited.get(&id).map(EditedRow::current).transpose()?;
            if let (Some(row), Some(target)) = (current, target) {
                return Ok(base_row(target, row));
            }
            Ok(detail(table, target, id))
        })
    }

    /// Update an addressed base row and return every stored value, preserving the query snapshot.
    pub fn update(
        &self,
        result: u64,
        id: usize,
        column: usize,
        value: Option<&str>,
    ) -> Result<SqlDetail, String> {
        self.detail(result, id)?;
        self.with_result(result, |entry| {
            let table = entry.outcome.as_ref().map_err(Clone::clone)?;
            let target = entry.target.relation().ok_or("This result cannot be edited.")?;
            let current = entry.edited.get(&id).map(EditedRow::current).transpose()?;
            if target.key.is_empty() {
                return Err("Select every primary key column to edit rows.".into());
            }
            let field = target.columns.get(column).ok_or("No such column.")?;
            if !field.writable {
                return Err(format!("{} is generated by the database.", field.name));
            }
            if !target.origins.contains(&Some(column)) && current.is_none() {
                return Err("That column is not in the result.".into());
            }
            let conditions: Vec<String> = target.key.iter().map(|(result, relation)| {
                let value = match current {
                    None => table.rows[id][*result].as_deref(),
                    Some(row) => row[*relation].as_deref(),
                };
                format!("{} = {}::{}", identifier(&target.columns[*relation].name), literal(value), target.columns[*relation].kind)
            }).collect();
            let script = format!(
                "COPY (UPDATE {}.{} SET {} = {}::{} WHERE {} RETURNING *) TO STDOUT WITH (FORMAT text, HEADER true);\n",
                identifier(&target.schema), identifier(&target.name), identifier(&field.name),
                literal(value), field.kind, conditions.join(" AND "),
            );
            // Invalidating before I/O; transport failure cannot prove that PostgreSQL rolled back.
            entry.edited.insert(id, EditedRow::Uncertain);
            let output = self.psql(&script, true)?;
            let returned = parse_copy(&output)?;
            let mut returned = returned.rows.into_iter();
            let row = returned.next().ok_or("The row is gone; its key no longer matches.")?;
            if returned.next().is_some() || row.len() != target.columns.len() {
                return Err("The database returned an unexpected row after editing.".into());
            }
            let detail = base_row(target, &row);
            entry.edited.insert(id, EditedRow::Current(row));
            Ok(detail)
        })
    }

    fn derive_target(&self, sql: &str, result_columns: &[String]) -> Option<Target> {
        let plan = self
            .psql(&format!("EXPLAIN (VERBOSE, FORMAT JSON) {sql};\n"), true)
            .ok()?;
        let plan: serde_json::Value = serde_json::from_str(&plan).ok()?;
        let origin = origin(plan.get(0)?.get("Plan")?)?;
        if origin.sources.len() != result_columns.len() || origin.relations.len() != 1 {
            return None;
        }
        let (schema, name) = origin.relations[0].clone();
        let columns = self.describe(&schema, &name).ok()?;
        let origins: Vec<Option<usize>> = origin
            .sources
            .iter()
            .map(|source| {
                let (source_schema, source_name, column) = source.as_ref()?;
                if (source_schema, source_name) != (&schema, &name) {
                    return None;
                }
                columns
                    .iter()
                    .position(|candidate| &candidate.name == column)
            })
            .collect();
        let key = primary_key(&columns, &origins);
        Some(Target {
            schema,
            name,
            columns,
            origins,
            key,
        })
    }

    fn describe(&self, schema: &str, name: &str) -> Result<Vec<RelationColumn>, String> {
        let relation = format!("{}.{}", identifier(schema), identifier(name));
        let script = format!(
            "COPY (SELECT a.attname, format_type(a.atttypid, a.atttypmod), coalesce(i.indisprimary, false), a.attgenerated = '' AND a.attidentity = '' FROM pg_attribute a LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey) WHERE a.attrelid = to_regclass({}) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) TO STDOUT;\n",
            literal(Some(&relation))
        );
        let output = self.psql(&script, true)?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let cells: Vec<&str> = line.split('\t').collect();
                let [name, kind, primary, writable] = cells[..] else {
                    return None;
                };
                Some(RelationColumn {
                    name: unescape_cell(name).unwrap_or_default(),
                    kind: kind.to_string(),
                    primary: primary == "t",
                    writable: writable == "t",
                })
            })
            .collect())
    }
}

/// Map every primary key column to its unique result column; an empty key leaves rows unaddressable.
fn primary_key(columns: &[RelationColumn], origins: &[Option<usize>]) -> Vec<(usize, usize)> {
    let mut key = Vec::new();
    for (relation_index, column) in columns.iter().enumerate() {
        if !column.primary {
            continue;
        }
        let mut holders = origins
            .iter()
            .enumerate()
            .filter(|(_, origin)| **origin == Some(relation_index))
            .map(|(index, _)| index);
        let Some(result_index) = holders.next() else {
            return Vec::new();
        };
        if holders.next().is_some() {
            return Vec::new();
        }
        key.push((result_index, relation_index));
    }
    key
}

fn detail(table: &Table, target: Option<&Target>, id: usize) -> SqlDetail {
    let row = &table.rows[id];
    let editable = target.is_some_and(|target| !target.key.is_empty());
    let title = match target {
        Some(target) if editable => {
            let key: Vec<String> = target
                .key
                .iter()
                .map(|(result, _)| row[*result].clone().unwrap_or_else(|| "NULL".into()))
                .collect();
            format!("{}.{} · {}", target.schema, target.name, key.join(", "))
        }
        Some(target) => format!("{}.{} · row {}", target.schema, target.name, id + 1),
        None => format!("Row {}", id + 1),
    };
    let fields = table
        .columns
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let column = target
                .and_then(|target| target.origins[index].map(|origin| &target.columns[origin]));
            SqlField {
                name: name.clone(),
                value: row[index].clone(),
                edit: (editable
                    && column.is_some_and(|column| column.writable)
                    && table
                        .columns
                        .iter()
                        .filter(|column| *column == name)
                        .count()
                        == 1)
                    .then(|| target.and_then(|target| target.origins[index]))
                    .flatten(),
                kind: column.map(|column| column.kind.clone()),
            }
        })
        .collect();
    SqlDetail { title, fields }
}

/// Describe the current physical row, including generated and trigger-maintained columns.
fn base_row(target: &Target, row: &[Option<String>]) -> SqlDetail {
    let key = target
        .key
        .iter()
        .map(|(_, column)| row[*column].as_deref().unwrap_or("NULL"))
        .collect::<Vec<_>>();
    SqlDetail {
        title: format!("{}.{} · {}", target.schema, target.name, key.join(", ")),
        fields: target
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| SqlField {
                name: column.name.clone(),
                value: row[index].clone(),
                kind: Some(column.kind.clone()),
                edit: column.writable.then_some(index),
            })
            .collect(),
    }
}

/// Measure bounded cell lengths; the frontend owns column widths and layout.
fn columns(table: &Table) -> Vec<Column> {
    table
        .columns
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let characters = table
                .rows
                .iter()
                .take(500)
                .map(|row| {
                    row[index]
                        .as_deref()
                        .map_or(4, |cell| cell.chars().take(64).count())
                })
                .chain(std::iter::once(name.chars().count()))
                .max()
                .unwrap_or(4)
                .clamp(3, 64)
                + 1;
            Column {
                name: name.clone(),
                kind: ColumnKind::Value { characters },
            }
        })
        .collect()
}

/// Strip leading comments, surrounding space, and trailing semicolons.
fn bare(statement: &str) -> &str {
    let mut rest = statement.trim();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after
                .split_once('\n')
                .map_or("", |(_, rest)| rest)
                .trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after
                .split_once("*/")
                .map_or("", |(_, rest)| rest)
                .trim_start();
        } else {
            break;
        }
    }
    rest.trim_end_matches(|character: char| character == ';' || character.is_whitespace())
}

/// Identify statements whose rows fit under a wrapping SELECT.
fn reads(sql: &str) -> bool {
    let word: String = sql
        .chars()
        .take_while(|character| character.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    matches!(word.as_str(), "select" | "with" | "values" | "table")
}

fn parse_copy(output: &str) -> Result<Table, String> {
    let mut lines = output.split_terminator('\n');
    let header = lines.next().unwrap_or_default();
    if header.is_empty() {
        return Ok(Table {
            columns: Vec::new(),
            rows: Vec::new(),
        });
    }
    let columns: Vec<String> = header
        .split('\t')
        .map(|name| unescape_cell(name).unwrap_or_default())
        .collect();
    let rows = lines
        .map(|line| {
            let row: Vec<Option<String>> = line.split('\t').map(unescape_cell).collect();
            if row.len() != columns.len() {
                return Err("The database returned an incomplete row.".into());
            }
            Ok(row)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Table { columns, rows })
}

/// Decode COPY text, where `\N` is NULL and backslashes escape control characters.
fn unescape_cell(cell: &str) -> Option<String> {
    if cell == "\\N" {
        return None;
    }
    let mut text = String::with_capacity(cell.len());
    let mut characters = cell.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            text.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => text.push('\n'),
            Some('t') => text.push('\t'),
            Some('r') => text.push('\r'),
            Some('b') => text.push('\u{8}'),
            Some('f') => text.push('\u{c}'),
            Some('v') => text.push('\u{b}'),
            Some(other) => text.push(other),
            None => text.push('\\'),
        }
    }
    Some(text)
}

fn identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(value: Option<&str>) -> String {
    match value {
        Some(value) => format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
        None => "NULL".into(),
    }
}

/// Output provenance read conservatively from a verbose plan.
struct Origin {
    sources: Vec<Option<(String, String, String)>>,
    relations: Vec<(String, String)>,
}

fn origin(plan: &serde_json::Value) -> Option<Origin> {
    let output: Vec<String> = plan
        .get("Output")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<_>>()?;
    let mut aliases: Vec<(String, Option<(String, String)>)> = Vec::new();
    let mut relations = Vec::new();
    collect(plan, &mut aliases, &mut relations);
    let sources = output
        .iter()
        .map(|value| source(value, &aliases, &relations))
        .collect();
    Some(Origin { sources, relations })
}

fn collect(
    plan: &serde_json::Value,
    aliases: &mut Vec<(String, Option<(String, String)>)>,
    relations: &mut Vec<(String, String)>,
) {
    if let (Some(name), Some(schema)) = (
        plan.get("Relation Name").and_then(|v| v.as_str()),
        plan.get("Schema").and_then(|v| v.as_str()),
    ) {
        let relation = (schema.to_string(), name.to_string());
        // Keeping scan multiplicity: a self-join is not a single update target.
        relations.push(relation.clone());
        alias(aliases, name, &relation);
        if let Some(label) = plan.get("Alias").and_then(|v| v.as_str()) {
            if label != name {
                alias(aliases, label, &relation);
            }
        }
    }
    if let Some(children) = plan.get("Plans").and_then(|v| v.as_array()) {
        for child in children {
            collect(child, aliases, relations);
        }
    }
}

fn alias(
    aliases: &mut Vec<(String, Option<(String, String)>)>,
    label: &str,
    relation: &(String, String),
) {
    match aliases.iter_mut().find(|(name, _)| name == label) {
        // A reused name cannot establish one scan origin.
        Some((_, target)) => *target = None,
        None => aliases.push((label.to_string(), Some(relation.clone()))),
    }
}

fn source(
    value: &str,
    aliases: &[(String, Option<(String, String)>)],
    relations: &[(String, String)],
) -> Option<(String, String, String)> {
    let path = identifier_path(value)?;
    let column = path.last()?.clone();
    if path.len() == 1 {
        return match relations {
            [(schema, name)] => Some((schema.clone(), name.clone(), column)),
            _ => None,
        };
    }
    for label in path[..path.len() - 1].iter().rev() {
        if let Some((_, Some((schema, name)))) = aliases.iter().find(|(name, _)| name == label) {
            return Some((schema.clone(), name.clone(), column));
        }
    }
    None
}

/// Split `alias.column` or `"quoted name"."column"`; anything else is an expression.
fn identifier_path(value: &str) -> Option<Vec<String>> {
    let mut path = Vec::new();
    let mut characters = value.chars().peekable();
    loop {
        let mut part = String::new();
        if characters.peek() == Some(&'"') {
            characters.next();
            loop {
                match characters.next()? {
                    '"' if characters.peek() == Some(&'"') => {
                        characters.next();
                        part.push('"');
                    }
                    '"' => break,
                    other => part.push(other),
                }
            }
            if part.is_empty() {
                return None;
            }
        } else {
            let first = *characters.peek()?;
            if !first.is_alphabetic() && first != '_' {
                return None;
            }
            while let Some(&character) = characters.peek() {
                if character.is_alphanumeric() || character == '_' || character == '$' {
                    part.push(character);
                    characters.next();
                } else {
                    break;
                }
            }
            if part.is_empty() {
                return None;
            }
        }
        path.push(part);
        match characters.next() {
            None => return Some(path),
            Some('.') => continue,
            Some(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_deduplicates_clusters_and_quotes_database_names() {
        let database = "a '= db\nwith\\slashes";
        let rows = serde_json::to_string(&("cluster", database)).unwrap();
        let second = serde_json::to_string(&("cluster", "other")).unwrap();
        let databases = format!("{rows}\n{second}");
        let bytes = [
            "direct",
            "/usr/bin/psql",
            "/tmp",
            "5432",
            &databases,
            "postgres",
            "/usr/bin/psql",
            "127.0.0.1",
            "5432",
            &rows,
            "",
        ]
        .join("\0");
        let sources = discovered_sources(bytes.as_bytes()).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].name, database);
        assert_ne!(sources[0].id, sources[1].id);
        assert!(sources[0].psql.contains("-w -h '/tmp' -p 5432"));
        assert!(sources[0].psql.contains("-u PGHOSTADDR"));
        assert!(discovered_sources(
            ["direct", "psql", "example.com", "5432", "[]", ""]
                .join("\0")
                .as_bytes()
        )
        .is_err());
        assert!(discovered_sources(b"truncated").is_err());
        assert!(discovered_sources(b"").unwrap().is_empty());
    }

    #[test]
    fn expired_lookups_and_duplicate_submissions_never_execute_sql() {
        let directory = std::env::temp_dir();
        let counter = directory.join(format!("altar-sql-submissions-{}", std::process::id()));
        let counter_argument = quote(&counter.to_string_lossy());
        let psql = format!("input=$(cat); case \"$input\" in EXPLAIN*) printf '[]' ;; *broken*) printf x >> {counter_argument}; printf 'query failed' >&2; exit 23 ;; *) printf x >> {counter_argument}; printf 'id\\n1\\n' ;; esac #");
        let bench = Workbench::new(Host::Local, psql);
        let first = bench.submit("select 1", "first").unwrap();
        let (left, right) = std::thread::scope(|scope| {
            let left = scope.spawn(|| bench.submit("select 1", "first").unwrap());
            let right = scope.spawn(|| bench.submit("select 1", "first").unwrap());
            (left.join().unwrap(), right.join().unwrap())
        });
        assert_eq!((left, right), (first, first));
        let second = bench.submit("select 2", "second").unwrap();
        let viewport = Viewport {
            top: Some(0.0),
            height: 600.0,
            inset_top: 88.0,
            row_height: 36.0,
            padding_top: 72.0,
            padding_bottom: 108.0,
            overscan: 3,
        };
        assert!(bench.frame(first, &viewport).is_err());
        assert!(bench.detail(first, 0).is_err());
        assert!(bench.update(first, 0, 0, Some("x")).is_err());
        assert!(bench.detail(second, usize::MAX).is_err());
        assert_eq!(bench.frame(second, &viewport).unwrap().total, 1);
        let failed = bench.submit("select broken", "failed").unwrap();
        assert_eq!(bench.submit("select broken", "failed").unwrap(), failed);
        assert!(bench
            .frame(failed, &viewport)
            .err()
            .unwrap()
            .contains("query failed"));
        assert!(bench
            .detail(failed, 0)
            .err()
            .unwrap()
            .contains("query failed"));
        let count = std::fs::read(&counter).unwrap();
        std::fs::remove_file(counter).unwrap();
        assert_eq!(count, b"xxx");
    }

    #[test]
    fn copy_text_round_trips_nulls_tabs_and_newlines() {
        let table = parse_copy("t\tn\te\na\t\\N\t\nx\\ty\\nz\\\\w\t1\tq\"w\n").unwrap();
        assert_eq!(table.columns, ["t", "n", "e"]);
        assert_eq!(table.rows[0], [Some("a".into()), None, Some("".into())]);
        assert_eq!(table.rows[1][0].as_deref(), Some("x\ty\nz\\w"));
        assert!(parse_copy("").unwrap().columns.is_empty());
        assert!(parse_copy("a\tb\nonly-one\n").is_err());
        assert!(parse_copy("a\nextra\tcell\n").is_err());
        assert_eq!(literal(Some("it's")), "E'it''s'");
        assert_eq!(identifier("odd\"name"), "\"odd\"\"name\"");
        assert_eq!(bare("  -- note\n/* c */ select 1 ; "), "select 1");
        assert!(reads("WITH x AS (select 1) select * from x"));
        assert!(!reads("update t set a = 1"));
        assert!(!reads("selection"));
    }

    #[test]
    fn provenance_requires_a_single_relation_with_its_whole_key() {
        let scan = |relation: &str, alias: &str, output: Vec<&str>| json!({ "Relation Name": relation, "Schema": "public", "Alias": alias, "Output": output });
        let join = json!({
            "Output": ["u.user_id", "u.name", "e.address", "(u.name || e.address)"],
            "Plans": [scan("email", "e", vec!["e.user_id", "e.address"]), scan("user", "u", vec!["u.user_id", "u.name"])]
        });
        let joined = origin(&join).unwrap();
        assert_eq!(joined.relations.len(), 2);
        assert_eq!(
            joined.sources[0],
            Some(("public".into(), "user".into(), "user_id".into()))
        );
        assert_eq!(joined.sources[3], None);
        let single = json!({ "Output": ["user_id", "\"user\".name", "upper(name)"], "Plans": [scan("user", "user", vec!["user_id", "name"])] });
        let alone = origin(&single).unwrap();
        assert_eq!(alone.relations, [("public".into(), "user".into())]);
        assert_eq!(
            alone.sources[1].as_ref().map(|source| source.2.as_str()),
            Some("name")
        );
        assert_eq!(alone.sources[2], None);
        let columns = vec![
            RelationColumn {
                name: "user_id".into(),
                kind: "uuid".into(),
                primary: true,
                writable: true,
            },
            RelationColumn {
                name: "name".into(),
                kind: "text".into(),
                primary: false,
                writable: true,
            },
        ];
        assert_eq!(primary_key(&columns, &[Some(0), Some(1), None]), [(0, 0)]);
        assert!(primary_key(&columns, &[Some(1), None]).is_empty());
        assert!(primary_key(&columns, &[Some(0), Some(0)]).is_empty());
        let self_join = json!({ "Output": ["a.id"], "Plans": [scan("t", "a", vec!["a.id"]), scan("t", "b", vec!["b.id"])] });
        assert_eq!(origin(&self_join).unwrap().relations.len(), 2);
        assert_eq!(
            identifier_path("\"we\"\"ird\".col"),
            Some(vec!["we\"ird".into(), "col".into()])
        );
        assert_eq!(identifier_path("(a + b)"), None);
        assert_eq!(identifier_path("1"), None);
        assert_eq!(identifier_path("1.2"), None);
        assert_eq!(identifier_path(r#""1""#), Some(vec!["1".into()]));
    }

    #[test]
    fn details_mark_only_stored_columns_of_addressable_rows_writable() {
        let table = Table {
            columns: vec!["id".into(), "name".into(), "shout".into()],
            rows: vec![vec![Some("7".into()), None, Some("X".into())]],
        };
        let columns = vec![
            RelationColumn {
                name: "id".into(),
                kind: "integer".into(),
                primary: true,
                writable: false,
            },
            RelationColumn {
                name: "name".into(),
                kind: "text".into(),
                primary: false,
                writable: true,
            },
        ];
        let target = Target {
            schema: "public".into(),
            name: "t".into(),
            columns: columns.clone(),
            origins: vec![Some(0), Some(1), None],
            key: vec![(0, 0)],
        };
        let detail = detail(&table, Some(&target), 0);
        assert_eq!(detail.title, "public.t · 7");
        assert_eq!(
            detail
                .fields
                .iter()
                .map(|field| field.edit.is_some())
                .collect::<Vec<_>>(),
            [false, true, false]
        );
        assert_eq!(detail.fields[1].kind.as_deref(), Some("text"));
        let unaddressed = Target {
            schema: "public".into(),
            name: "t".into(),
            columns,
            origins: vec![Some(1)],
            key: Vec::new(),
        };
        let detail = super::detail(
            &Table {
                columns: vec!["name".into()],
                rows: vec![vec![None]],
            },
            Some(&unaddressed),
            0,
        );
        assert_eq!(detail.title, "public.t · row 1");
        assert!(detail.fields[0].edit.is_none());
        let columns = super::columns(&table);
        let characters: Vec<usize> = columns
            .into_iter()
            .map(|column| match column.kind {
                ColumnKind::Value { characters } => characters,
                _ => panic!("SQL columns carry value lengths"),
            })
            .collect();
        assert_eq!(characters, [4, 5, 6]);
    }
}

/// Opt-in checks against a disposable database; these tests create and remove their own objects.
#[cfg(test)]
mod database_tests {
    use super::*;

    fn workbench() -> Workbench {
        let psql = std::env::var("ALTAR_TEST_PSQL")
            .expect("Set ALTAR_TEST_PSQL to a disposable PostgreSQL database.");
        Workbench::new(Host::Local, psql)
    }

    #[test]
    #[ignore]
    fn discovery_opens_the_database_it_onboards() {
        let database = std::env::var("ALTAR_TEST_DISCOVERY_DATABASE")
            .expect("Set ALTAR_TEST_DISCOVERY_DATABASE to the disposable database's literal name.");
        let sources = discover(&Host::Local).unwrap();
        let source = sources
            .into_iter()
            .find(|source| {
                source.name == database || source.name.starts_with(&format!("{database} · "))
            })
            .expect("database was discovered");
        let command = format!("env PGHOSTADDR=127.0.0.2 {}", source.psql);
        let workbench = Workbench::new(Host::Local, command);
        let table = workbench
            .execute("select current_database() as database")
            .unwrap();
        assert_eq!(table.rows[0][0].as_deref(), Some(database.as_str()));
    }

    #[test]
    #[ignore]
    fn a_lost_write_reply_requires_a_new_query_before_reusing_row_identity() {
        let bench = workbench();
        bench.psql("CREATE TABLE altar_uncertain_write (id integer PRIMARY KEY, body text); INSERT INTO altar_uncertain_write VALUES (1, 'first');", true).unwrap();
        // Reporting a transport failure after the real psql process has committed its UPDATE.
        let psql = format!("input=$(cat); printf '%s' \"$input\" | {} -q {}; status=$?; if [ \"$status\" -ne 0 ]; then exit \"$status\"; fi; case \"$input\" in 'COPY (UPDATE '*) exit 23;; esac #", bench.psql, PSQL_FLAGS);
        let uncertain = Workbench::new(Host::Local, psql);
        let statement = "select id, body from altar_uncertain_write";
        let result = uncertain.submit(statement, "initial").unwrap();
        assert!(uncertain.update(result, 0, 0, Some("2")).is_err());
        assert!(uncertain
            .detail(result, 0)
            .err()
            .unwrap()
            .contains("verify the last write"));
        assert!(uncertain.update(result, 0, 1, Some("second")).is_err());
        let stored = bench.execute(statement).unwrap();
        assert_eq!(stored.rows[0], [Some("2".into()), Some("first".into())]);
        let refreshed = uncertain.submit(statement, "refresh").unwrap();
        assert!(uncertain
            .detail(refreshed, 0)
            .unwrap()
            .title
            .ends_with(" · 2"));
        bench
            .psql("DROP TABLE altar_uncertain_write;", true)
            .unwrap();
    }

    #[test]
    #[ignore]
    fn edits_return_complete_rows_and_leave_query_snapshots_immutable() {
        let bench = workbench();
        bench.psql("CREATE TABLE altar_note (id integer PRIMARY KEY, body text, tally integer GENERATED ALWAYS AS (length(coalesce(body, ''))) STORED, \"1\" text DEFAULT 'stored');\nINSERT INTO altar_note VALUES (1, 'first'), (2, NULL), (3, 'it''s got\ttabs\nand lines');\n", true).unwrap();
        let viewport = Viewport {
            top: Some(0.0),
            height: 600.0,
            inset_top: 88.0,
            row_height: 36.0,
            padding_top: 72.0,
            padding_bottom: 108.0,
            overscan: 3,
        };
        let statement =
            "select id, body as text, tally, upper(body) as computed from altar_note order by id";
        let result = bench.submit(statement, "initial").unwrap();
        let frame = bench.frame(result, &viewport).unwrap();
        assert_eq!(frame.total, 3);
        assert_eq!(frame.rows[1].cells[1], "NULL");
        assert_eq!(frame.rows[2].cells[1], "it's got\ttabs\nand lines");
        let detail = bench.detail(result, 1).unwrap();
        assert_eq!(
            detail
                .fields
                .iter()
                .map(|field| field.edit)
                .collect::<Vec<_>>(),
            [Some(0), Some(1), None, None]
        );
        assert_eq!(detail.fields[2].kind.as_deref(), Some("integer"));
        let updated = bench.update(result, 1, 1, Some("new body")).unwrap();
        assert_eq!(
            updated.fields[1].name, "body",
            "edit feedback is the complete physical row"
        );
        assert_eq!(updated.fields[1].value.as_deref(), Some("new body"));
        assert_eq!(
            updated.fields[2].value.as_deref(),
            Some("8"),
            "generated values are current"
        );
        let snapshot = bench.frame(result, &viewport).unwrap();
        assert_eq!(snapshot.rows[1].cells[1], "NULL");
        assert!(snapshot.notice.is_some());
        let renamed = bench.update(result, 1, 0, Some("20")).unwrap();
        assert!(renamed.title.ends_with(" · 20"));
        let nulled = bench.update(result, 1, 1, None).unwrap();
        assert_eq!(nulled.fields[1].value, None);
        assert_eq!(nulled.fields[2].value.as_deref(), Some("0"));
        assert!(bench
            .update(result, 1, 2, Some("3"))
            .err()
            .unwrap()
            .contains("generated"));
        let latest = bench.submit(statement, "refresh").unwrap();
        assert!(bench.detail(result, 0).is_err());
        assert!(bench.frame(latest, &viewport).unwrap().notice.is_none());
        let partial = bench
            .submit("select body from altar_note", "partial")
            .unwrap();
        assert!(bench
            .detail(partial, 0)
            .unwrap()
            .fields
            .iter()
            .all(|field| field.edit.is_none()));
        assert!(bench
            .update(partial, 0, 1, Some("x"))
            .err()
            .unwrap()
            .contains("primary key"));
        let constant = bench
            .submit("select id, 1 as constant from altar_note", "constant")
            .unwrap();
        assert!(bench.detail(constant, 0).unwrap().fields[1].edit.is_none());
        let joined = bench
            .submit(
                "select a.id, b.body from altar_note a join altar_note b on a.id = b.id",
                "joined",
            )
            .unwrap();
        assert!(bench
            .detail(joined, 0)
            .unwrap()
            .fields
            .iter()
            .all(|field| field.edit.is_none()));
        let failed = bench
            .submit("select nope from altar_note", "error")
            .unwrap();
        assert!(bench
            .frame(failed, &viewport)
            .err()
            .unwrap()
            .contains("nope"));
        bench.psql("DROP TABLE altar_note;\n", true).unwrap();
    }
}
