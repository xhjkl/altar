//! Run SQL through psql on the machine: results travel as COPY text, edits as UPDATE … RETURNING.
use crate::protocol::{Detail, Field};
use crate::shell::{quote, Host};
use crate::stream::{preview, Column, ColumnKind, Frame, Row, Viewport};
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

/// A usable database connection discovered on its host.
#[derive(Debug)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub psql: String,
    pub statement: String,
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
            let identity = format!("{location}:{port}:{database}");
            let identity: String = identity.bytes().map(|byte| format!("{byte:02x}")).collect();
            let connection = format!(
                "dbname='{}'",
                database.replace('\\', "\\\\").replace('\'', "\\'")
            );
            sources.push(Source {
                id: format!("postgres-{identity}"),
                name: if port == 5432 {
                    database
                } else {
                    format!("{database} · {port}")
                },
                psql: format!("{command} -d {}", quote(&connection)),
                statement: DEFAULT_STATEMENT.into(),
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
    run: u64,
    outcome: Result<Table, String>,
    /// Derived once a row is inspected; `Some(None)` means the result is read-only.
    target: Option<Option<Target>>,
}

/// One SQL view's session: the latest result and what the catalog says about it.
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
            return Ok(parse_copy(&output));
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

    /// Reuse the result for the same run; viewport changes alone never execute a statement again.
    fn ensure(&self, statement: &str, run: u64) -> MutexGuard<'_, Option<Cache>> {
        let mut cache = self.lock();
        let fresh = cache
            .as_ref()
            .is_some_and(|cache| cache.statement == statement && cache.run == run);
        if !fresh {
            // Holding the run lock through execution; duplicate requests must not repeat SQL effects.
            let outcome = self.execute(statement);
            *cache = Some(Cache {
                statement: statement.into(),
                run,
                outcome,
                target: None,
            });
        }
        cache
    }

    pub fn frame(&self, statement: &str, run: u64, viewport: &Viewport) -> Result<Frame, String> {
        let cache = self.ensure(statement, run);
        let table = cache
            .as_ref()
            .expect("ensured")
            .outcome
            .as_ref()
            .map_err(Clone::clone)?;
        let columns = columns(table);
        Frame::new(table.rows.len(), 0, 0, viewport, columns, |position| Row {
            id: position,
            cells: table.rows[position]
                .iter()
                .map(|cell| preview(cell.as_deref().unwrap_or("NULL")))
                .collect(),
            tone: "",
        })
    }

    /// Describe a row, learning on first inspection whether its result can be edited.
    pub fn detail(&self, statement: &str, run: u64, id: usize) -> Result<Detail, String> {
        let mut cache = self.ensure(statement, run);
        let entry = cache.as_mut().expect("ensured");
        let table = entry.outcome.as_ref().map_err(Clone::clone)?;
        if id >= table.rows.len() {
            return Err("That row is no longer in the result.".into());
        }
        if entry.target.is_none() {
            let target = if reads(bare(statement)) {
                self.derive_target(bare(statement), &table.columns)
            } else {
                None
            };
            entry.target = Some(target);
        }
        Ok(detail(
            table,
            entry.target.as_ref().and_then(Option::as_ref),
            id,
        ))
    }

    /// Change one cell of a row addressed by its primary key, keeping the cached result in step.
    pub fn update(
        &self,
        statement: &str,
        run: u64,
        id: usize,
        field: &str,
        value: Option<&str>,
    ) -> Result<Detail, String> {
        self.detail(statement, run, id)?;
        let mut cache = self.lock();
        let entry = cache
            .as_mut()
            .filter(|cache| cache.statement == statement && cache.run == run)
            .ok_or("Run the query again before editing.")?;
        let table = entry.outcome.as_mut().map_err(|error| error.clone())?;
        let target = entry
            .target
            .as_ref()
            .and_then(Option::as_ref)
            .ok_or("This result cannot be edited.")?;
        if target.key.is_empty() {
            return Err("Select every primary key column to edit rows.".into());
        }
        let mut result_indices = table
            .columns
            .iter()
            .enumerate()
            .filter(|(_, column)| *column == field)
            .map(|(index, _)| index);
        let result_index = result_indices.next().ok_or("No such column.")?;
        if result_indices.next().is_some() {
            return Err(
                "That column name is ambiguous; give result columns distinct names.".into(),
            );
        }
        let relation_index =
            target.origins[result_index].ok_or("That column is computed, not stored.")?;
        let column = &target.columns[relation_index];
        if !column.writable {
            return Err(format!("{} is generated by the database.", column.name));
        }
        let row = &table.rows[id];
        let conditions: Vec<String> = target
            .key
            .iter()
            .map(|(result, relation)| {
                format!(
                    "{} = {}::{}",
                    identifier(&target.columns[*relation].name),
                    literal(row[*result].as_deref()),
                    target.columns[*relation].kind
                )
            })
            .collect();
        let script = format!(
            "COPY (UPDATE {}.{} SET {} = {}::{} WHERE {} RETURNING {}::text) TO STDOUT;\n",
            identifier(&target.schema),
            identifier(&target.name),
            identifier(&column.name),
            literal(value),
            column.kind,
            conditions.join(" AND "),
            identifier(&column.name),
        );
        let output = self.psql(&script, true)?;
        let mut returned = output.lines();
        let stored = match returned.next() {
            Some(line) => unescape_cell(line),
            None => return Err("The row is gone; its key no longer matches.".into()),
        };
        for (index, origin) in target.origins.iter().enumerate() {
            if *origin == Some(relation_index) {
                table.rows[id][index] = stored.clone();
            }
        }
        Ok(detail(table, Some(target), id))
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

fn detail(table: &Table, target: Option<&Target>, id: usize) -> Detail {
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
            Field {
                name: name.clone(),
                value: row[index].clone(),
                writable: editable
                    && column.is_some_and(|column| column.writable)
                    && table
                        .columns
                        .iter()
                        .filter(|column| *column == name)
                        .count()
                        == 1,
                kind: column.map(|column| column.kind.clone()),
            }
        })
        .collect();
    Detail {
        title,
        tone: "info",
        fields,
        trace: Vec::new(),
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

fn parse_copy(output: &str) -> Table {
    let mut lines = output.split_terminator('\n');
    let header = lines.next().unwrap_or_default();
    if header.is_empty() {
        return Table {
            columns: Vec::new(),
            rows: Vec::new(),
        };
    }
    let columns: Vec<String> = header
        .split('\t')
        .map(|name| unescape_cell(name).unwrap_or_default())
        .collect();
    let rows = lines
        .map(|line| {
            let mut row: Vec<Option<String>> = line.split('\t').map(unescape_cell).collect();
            row.resize(columns.len(), None);
            row
        })
        .collect();
    Table { columns, rows }
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
        Some(value) => format!("'{}'", value.replace('\'', "''")),
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
        assert_eq!(sources[0].statement, DEFAULT_STATEMENT);
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
    fn copy_text_round_trips_nulls_tabs_and_newlines() {
        let table = parse_copy("t\tn\te\na\t\\N\t\t\nx\\ty\\nz\\\\w\t1\tq\"w\n");
        assert_eq!(table.columns, ["t", "n", "e"]);
        assert_eq!(table.rows[0], [Some("a".into()), None, Some("".into())]);
        assert_eq!(table.rows[1][0].as_deref(), Some("x\ty\nz\\w"));
        assert!(parse_copy("").columns.is_empty());
        assert_eq!(literal(Some("it's")), "'it''s'");
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
                .map(|field| field.writable)
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
        assert!(!detail.fields[0].writable);
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

/// Opt-in checks against a scratch database: `ALTAR_TEST_PSQL="psql altar_scratch" cargo test -- --ignored`.
#[cfg(test)]
mod database_tests {
    use super::*;

    fn workbench() -> Option<Workbench> {
        std::env::var("ALTAR_TEST_PSQL")
            .ok()
            .map(|psql| Workbench::new(Host::Local, psql))
    }

    /// Run against a disposable database with ALTAR_TEST_DISCOVERY_DATABASE set to its literal name.
    #[test]
    #[ignore]
    fn discovery_opens_the_database_it_onboards() {
        let database = std::env::var("ALTAR_TEST_DISCOVERY_DATABASE");
        let Ok(database) = database else { return };
        let sources = discover(&Host::Local).unwrap();
        let source = sources
            .into_iter()
            .find(|source| {
                source.name == database || source.name.starts_with(&format!("{database} · "))
            })
            .expect("database was discovered");
        // Supplying a conflicting loopback address; the discovered command owns its endpoint.
        let command = format!("env PGHOSTADDR=127.0.0.2 {}", source.psql);
        let workbench = Workbench::new(Host::Local, command);
        let table = workbench
            .execute("select current_database() as database")
            .unwrap();
        assert_eq!(table.rows[0][0].as_deref(), Some(database.as_str()));
    }

    #[test]
    #[ignore]
    fn rows_with_a_whole_key_are_edited_in_place() {
        let Some(bench) = workbench() else { return };
        bench
            .psql(
                "CREATE TABLE IF NOT EXISTS altar_note (id serial PRIMARY KEY, body text, mood text NOT NULL DEFAULT 'calm', made timestamptz NOT NULL DEFAULT now(), tally integer GENERATED ALWAYS AS (length(coalesce(body, ''))) STORED);\nTRUNCATE altar_note RESTART IDENTITY;\nINSERT INTO altar_note (body) VALUES ('first'), (NULL), ('it''s got\ttabs\nand lines');\n",
                true,
            )
            .unwrap();
        let viewport = Viewport {
            top: Some(0.0),
            height: 600.0,
            inset_top: 88.0,
            row_height: 36.0,
            padding_top: 72.0,
            padding_bottom: 108.0,
            overscan: 3,
        };
        let statement = "select id, body, mood, tally from altar_note order by id";
        let frame = bench.frame(statement, 1, &viewport).unwrap();
        assert_eq!(frame.total, 3);
        assert_eq!(frame.rows[1].cells[1], "NULL");
        assert_eq!(frame.rows[2].cells[1], "it's got\ttabs\nand lines");

        let detail = bench.detail(statement, 1, 0).unwrap();
        assert_eq!(detail.title, "public.altar_note · 1");
        let writable: Vec<&str> = detail
            .fields
            .iter()
            .filter(|field| field.writable)
            .map(|field| field.name.as_str())
            .collect();
        assert_eq!(
            writable,
            ["id", "body", "mood"],
            "generated columns stay read only"
        );
        assert_eq!(detail.fields[1].kind.as_deref(), Some("text"));

        let updated = bench
            .update(statement, 1, 1, "body", Some("quote ' and\nnewline"))
            .unwrap();
        assert_eq!(
            updated.fields[1].value.as_deref(),
            Some("quote ' and\nnewline")
        );
        let frame = bench.frame(statement, 1, &viewport).unwrap();
        assert_eq!(
            frame.rows[1].cells[1], "quote ' and\nnewline",
            "the cached result follows the edit"
        );
        let nulled = bench.update(statement, 1, 0, "body", None).unwrap();
        assert_eq!(nulled.fields[1].value, None);
        assert!(bench
            .update(statement, 1, 0, "tally", Some("3"))
            .err()
            .unwrap()
            .contains("generated"));
        assert!(bench
            .update(statement, 1, 0, "mood", None)
            .err()
            .unwrap()
            .to_lowercase()
            .contains("null"));

        let rerun = bench.frame(statement, 2, &viewport).unwrap();
        assert_eq!(rerun.rows[0].cells[1], "NULL");
        assert_eq!(rerun.rows[1].cells[1], "quote ' and\nnewline");

        // Without the key column, rows are described but cannot be addressed.
        let partial = "select body from altar_note";
        let detail = bench.detail(partial, 1, 0).unwrap();
        assert_eq!(detail.title, "public.altar_note · row 1");
        assert!(detail.fields.iter().all(|field| !field.writable));
        assert!(bench
            .update(partial, 1, 0, "body", Some("x"))
            .err()
            .unwrap()
            .contains("primary key"));

        let empty = bench
            .frame("values (''::text), (NULL), ('after')", 1, &viewport)
            .unwrap();
        assert_eq!(empty.total, 3);
        assert_eq!(
            empty
                .rows
                .iter()
                .map(|row| row.cells[0].as_str())
                .collect::<Vec<_>>(),
            ["", "NULL", "after"]
        );

        let duplicates = "select id, body as id from altar_note";
        let detail = bench.detail(duplicates, 1, 0).unwrap();
        assert!(detail.fields.iter().all(|field| !field.writable));
        let error = bench
            .update(duplicates, 1, 0, "id", Some("9"))
            .err()
            .unwrap();
        assert!(error.contains("ambiguous"));

        bench
            .psql("CREATE SEQUENCE altar_query_runs;\n", true)
            .unwrap();
        let barrier = std::sync::Barrier::new(3);
        let repeated = "select nextval('altar_query_runs'), pg_sleep(0.05)";
        let (left, right) = std::thread::scope(|scope| {
            let left = scope.spawn(|| {
                barrier.wait();
                bench.frame(repeated, 1, &viewport).unwrap()
            });
            let right = scope.spawn(|| {
                barrier.wait();
                bench.frame(repeated, 1, &viewport).unwrap()
            });
            barrier.wait();
            let left = left.join().unwrap();
            let right = right.join().unwrap();
            (left, right)
        });
        assert_eq!(left.rows[0].cells[0], "1");
        assert_eq!(left.rows[0].cells, right.rows[0].cells);
        bench
            .psql("DROP SEQUENCE altar_query_runs;\n", true)
            .unwrap();

        // Expressions and joins stay read only too, and errors are the database's own words.
        let joined = "select a.id, b.body from altar_note a join altar_note b on a.id = b.id";
        assert!(bench
            .detail(joined, 1, 0)
            .unwrap()
            .fields
            .iter()
            .all(|field| !field.writable));
        assert!(bench
            .frame("select nope from altar_note", 1, &viewport)
            .err()
            .unwrap()
            .contains("nope"));
        let tag = bench
            .frame(
                "update altar_note set mood = 'tense' where false",
                1,
                &viewport,
            )
            .unwrap();
        assert_eq!(tag.rows[0].cells[0], "UPDATE 0");
        bench.psql("DROP TABLE altar_note;\n", true).unwrap();
    }
}
