import type {
  Catalog,
  CatalogRelation,
  CellValue,
  ColumnKind,
  DbRequest,
  DbResult,
  PreviewCell,
  QueryResult,
  QuerySource,
  RelationRef,
  ResultColumn,
  Row,
  RowCount,
  RowUpdate,
  ScalarValue,
  UpdateResult,
  UpdateTarget,
} from "~/lib/db-contract";
import { isPreviewCell, sameRelation } from "~/lib/db-contract";
import { queryOrigin, type PlanNode } from "~/server/query-origin";

type SqlClient = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe: (sql: string, values?: unknown[]) => Promise<unknown[]>;
  begin: <T>(callback: (tx: SqlClient) => Promise<T> | T) => Promise<T>;
  close?: () => Promise<void> | void;
  end?: () => Promise<void> | void;
};

declare const Bun: {
  SQL: new (url?: string) => SqlClient;
  sql: SqlClient;
};

type SqlConnection = { key: string; client: SqlClient };
type SqlSlot = { current: SqlConnection | null };
/** Physical column metadata kept behind the database boundary. */
type RelationColumn = {
  name: string;
  sqlType: string;
  valueKind: ColumnKind;
  nullable: boolean;
  primaryKey: boolean;
  writable: boolean;
};
type ColumnShape = Pick<ResultColumn, "name" | "valueKind">;
/** Query outputs paired with the complete set of base-relation scans. */
type QueryDescription = {
  columns: ResultColumn[];
  relations: RelationRef[];
  targetColumns: RelationColumn[] | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_TEXT = 8_000;
const BYTE_PREVIEW = 64;
const NO_CONNECTION = "enter a postgres connection string.";
const MISSING_BUN_SQL =
  "the gateway cannot open postgres connections in this runtime. restart it with bun and try again.";

/** Process-wide connection slot for the deliberately local, single-user workbench. */
const runtime = globalThis as typeof globalThis & { __altarSql?: SqlSlot };
const sqlSlot = (runtime.__altarSql ??= { current: null });

/** Exhaustive database dispatcher behind the HTTP boundary. */
export async function handleDbRequest(request: DbRequest): Promise<DbResult<DbRequest>> {
  switch (request.type) {
    case "disconnect":
      return disconnect(request.connection);
    case "catalog":
      return loadCatalog(request.connection);
    case "query":
      return runQuery(
        request.connection,
        request.source,
        clampLimit(request.limit),
        clampOffset(request.offset),
      );
    case "update":
      return updateRowsByPk(request.connection, request.relation, request.updates);
    default:
      return assertNever(request);
  }
}

async function disconnect(connection: string): Promise<{ disconnected: boolean }> {
  const key = connection.trim();
  const current = sqlSlot.current;
  if (!key || current?.key !== key) return { disconnected: false };

  sqlSlot.current = null;
  await closeSqlClient(current.client);
  return { disconnected: true };
}

async function loadCatalog(connection: string): Promise<Catalog> {
  const db = requireConnection(connection);
  const started = performance.now();
  const [databaseRow] = await db.unsafe("select current_database() as database");
  const rows = await db.unsafe(`
    select
      n.nspname as schema,
      c.relname as name,
      case c.relkind
        when 'r' then 'table'
        when 'p' then 'partitioned-table'
        when 'v' then 'view'
        when 'm' then 'materialized-view'
        else 'table'
      end as kind,
      greatest(coalesce(s.n_live_tup, c.reltuples)::bigint, 0) as estimated_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where c.relkind in ('r', 'p', 'v', 'm')
      and n.nspname not like 'pg_temp_%'
      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
    order by n.nspname, c.relname
  `);

  return {
    database: String((databaseRow as Record<string, unknown> | null)?.database ?? "postgres"),
    relations: rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        schema: String(value.schema),
        name: String(value.name),
        kind: String(value.kind) as CatalogRelation["kind"],
        rowCount: rowCount("estimate", value.estimated_rows),
      };
    }),
    durationMs: Math.round(performance.now() - started),
  };
}

async function runQuery(
  connection: string,
  source: QuerySource,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const db = requireConnection(connection);
  const started = performance.now();
  let sql: string;
  let resultSource: QuerySource;
  let readQuery: boolean;
  let rawRows: unknown[];
  let knownColumns: ResultColumn[] | null;
  let updateTarget: UpdateTarget | null;

  if (source.kind === "relation") {
    const columns = await describeRelation(db, source.relation);
    if (columns.length === 0) {
      throw new Error(`No such relation: ${source.relation.schema}.${source.relation.name}`);
    }

    sql = tableSelectSql(source.relation);
    resultSource = source;
    readQuery = true;
    rawRows = await db.unsafe(
      `select ${selectList(columns)} from ${quotePath(source.relation.schema, source.relation.name)}${orderByPrimaryKey(columns)} limit ${limit + 1} offset ${offset}`,
    );
    knownColumns = columns.map((column) => resultColumn(column, source.relation));
    updateTarget = deriveUpdateTarget(source.relation, columns, knownColumns);
  } else {
    sql = normalizeSql(source.text);
    resultSource = { kind: "sql", text: sql };
    readQuery = isReadQuery(sql);
    rawRows = readQuery
      ? await db.unsafe(`select * from (${sql}) as altar_query limit ${limit + 1} offset ${offset}`)
      : await db.unsafe(sql);

    const description = readQuery ? await describeQuery(db, sql, rawRows) : null;
    knownColumns = description?.columns ?? null;
    updateTarget =
      description?.relations.length === 1 && description.targetColumns != null
        ? deriveUpdateTarget(description.relations[0], description.targetColumns, description.columns)
        : null;
  }

  const hasMore = readQuery && rawRows.length > limit;
  if (hasMore) rawRows = rawRows.slice(0, limit);
  const rows = rawRows.map((row) => sanitizeRow(row, knownColumns));
  const columns = inferColumns(rows, rawRows, knownColumns).map((column) => ({
    ...column,
    writable:
      updateTarget != null &&
      column.writable &&
      column.origin != null &&
      sameRelation(column.origin.relation, updateTarget.relation),
  }));

  return {
    source: resultSource,
    sql,
    columns,
    rows,
    updateTarget,
    rowCount: readQuery ? exactRowCountForPage(offset, hasMore, rows.length) : { kind: "exact", value: rows.length },
    limit,
    offset,
    hasMore,
    durationMs: Math.round(performance.now() - started),
  };
}

async function updateRowsByPk(
  connection: string,
  relation: RelationRef,
  updates: RowUpdate[],
): Promise<UpdateResult> {
  const db = requireConnection(connection);
  const columns = await describeRelation(db, relation);
  const columnsByName = new Map(columns.map((column) => [column.name, column]));
  const primaryColumns = columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (primaryColumns.length === 0) throw new Error(`${relation.schema}.${relation.name} has no primary key`);

  let affectedRows = 0;
  await db.begin(async (tx) => {
    for (const update of updates) {
      for (const column of primaryColumns) {
        if (!(column in update.key)) throw new Error(`Missing primary key column: ${column}`);
      }

      const setEntries = Object.entries(update.changes);
      if (setEntries.length === 0) continue;

      for (const [name] of setEntries) {
        const column = columnsByName.get(name);
        if (column == null) throw new Error(`Unknown column: ${name}`);
        if (!column.writable) throw new Error(`Column ${name} is not writable`);
      }

      const setSql = setEntries
        .map(([name], index) => setExpression(columnsByName.get(name), index + 1))
        .join(", ");
      const whereSql = primaryColumns
        .map((name, index) => whereExpression(columnsByName.get(name), setEntries.length + index + 1))
        .join(" and ");
      const values = [
        ...setEntries.map(([name, value]) => normalizeUpdateValue(value, columnsByName.get(name))),
        ...primaryColumns.map((name) => normalizeUpdateValue(update.key[name], columnsByName.get(name))),
      ];

      const result = await tx.unsafe(
        `update ${quotePath(relation.schema, relation.name)} set ${setSql} where ${whereSql} returning 1 as affected_rows`,
        values,
      );
      if (result.length !== 1) {
        throw new Error("Row was not found. The primary key may have changed.");
      }
      affectedRows += result.length;
    }
  });

  return { affectedRows };
}

async function describeRelation(db: SqlClient, relation: RelationRef): Promise<RelationColumn[]> {
  const rows = await db.unsafe(
    `
      select
        a.attname as name,
        format_type(a.atttypid, a.atttypmod) as type_label,
        t.typname,
        t.typcategory,
        a.attndims,
        not a.attnotnull as nullable,
        coalesce(i.indisprimary, false) as primary_key,
        a.attgenerated <> '' as generated,
        a.attidentity <> '' as identity
      from pg_attribute a
      join pg_type t on t.oid = a.atttypid
      left join pg_index i
        on i.indrelid = a.attrelid
       and i.indisprimary
       and a.attnum = any(i.indkey)
      where a.attrelid = to_regclass($1)
        and a.attnum > 0
        and not a.attisdropped
      order by a.attnum
    `,
    [quotePath(relation.schema, relation.name)],
  );

  return rows.map((row) => {
    const value = row as Record<string, unknown>;
    const valueKind = columnKind(
      String(value.typname),
      String(value.typcategory),
      numberOrNull(value.attndims) ?? 0,
    );
    return {
      name: String(value.name),
      sqlType: String(value.type_label),
      valueKind,
      nullable: Boolean(value.nullable),
      primaryKey: Boolean(value.primary_key),
      writable: !Boolean(value.generated) && !Boolean(value.identity) && isWritableKind(valueKind),
    };
  });
}

function resultColumn(column: RelationColumn, relation: RelationRef): ResultColumn {
  return {
    name: column.name,
    sqlType: column.sqlType,
    valueKind: column.valueKind,
    nullable: column.nullable,
    origin: { relation, column: column.name },
    writable: column.writable,
  };
}

function deriveUpdateTarget(
  relation: RelationRef,
  relationColumns: RelationColumn[],
  resultColumns: ResultColumn[],
): UpdateTarget | null {
  const primaryColumns = relationColumns.filter((column) => column.primaryKey);
  if (primaryColumns.length === 0) return null;

  const keyColumns = [];
  for (const primaryColumn of primaryColumns) {
    const matches = resultColumns.filter(
      (column) =>
        column.origin != null &&
        sameRelation(column.origin.relation, relation) &&
        column.origin.column === primaryColumn.name,
    );
    if (matches.length !== 1) return null;
    keyColumns.push({ resultColumn: matches[0].name, relationColumn: primaryColumn.name });
  }

  if (
    !resultColumns.every(
      (column) => column.origin == null || sameRelation(column.origin.relation, relation),
    )
  ) {
    return null;
  }
  return { relation, keyColumns };
}

function exactRowCountForPage(offset: number, hasMore: boolean, visibleRows: number): RowCount {
  return hasMore ? null : { kind: "exact", value: offset + visibleRows };
}

function connect(connection: string): SqlClient | null {
  if (typeof Bun === "undefined") throw new Error(MISSING_BUN_SQL);

  const url = connection.trim();
  if (!url) return null;

  const key = url;
  if (sqlSlot.current?.key === key) return sqlSlot.current.client;
  if (sqlSlot.current != null) void closeSqlClient(sqlSlot.current.client);

  const client = new Bun.SQL(url);
  sqlSlot.current = { key, client };
  return client;
}

async function closeSqlClient(client: SqlClient) {
  if (client.close != null) await client.close();
  else if (client.end != null) await client.end();
}

function requireConnection(connection: string) {
  const db = connect(connection);
  if (db == null) throw new Error(NO_CONNECTION);
  return db;
}

function sanitizeRow(row: unknown, columns: ColumnShape[] | null = null): Row {
  const value = row as Record<string, unknown>;
  const columnsByName = new Map((columns ?? []).map((column) => [column.name, column]));
  const clean: Row = {};
  for (const [key, cell] of Object.entries(value)) clean[key] = sanitizeCell(cell, columnsByName.get(key));
  return clean;
}

function sanitizeCell(value: unknown, column?: ColumnShape): CellValue {
  if (value == null) return null;
  if (isPreviewCell(value)) return value;
  if (column?.valueKind === "json" && typeof value === "object") {
    return sanitizeText(JSON.stringify(value), "json");
  }
  if (typeof value === "string") {
    if (column?.valueKind === "bytes") return value;
    return sanitizeText(value, "text");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    if (column?.valueKind === "bytes") return `\\x${hexBytes(value)}`;
    const bytes = value.byteLength;
    const preview = hexBytes(value.slice(0, BYTE_PREVIEW));
    return {
      kind: "preview",
      format: "bytes",
      bytes,
      text: `\\x${preview}`,
      truncated: bytes > BYTE_PREVIEW,
    };
  }

  const text = JSON.stringify(value);
  const format = Array.isArray(value) ? "array" : typeof value === "object" ? "object" : "json";
  return previewCell(format, text.slice(0, MAX_TEXT), text.length > MAX_TEXT);
}

function sanitizeText(value: string, format: PreviewCell["format"]) {
  if (value.length <= MAX_TEXT) return value;
  return previewCell(format, value.slice(0, MAX_TEXT), true);
}

function hexBytes(value: Uint8Array) {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function previewCell(format: PreviewCell["format"], text: string, truncated: boolean): PreviewCell {
  return { kind: "preview", format, text, truncated };
}

function inferColumns(
  cleanRows: Row[],
  rawRows: unknown[],
  knownColumns: ResultColumn[] | null,
): ResultColumn[] {
  const first = (rawRows[0] ?? cleanRows[0] ?? null) as Record<string, unknown> | null;
  if (first == null) return [];
  const knownColumnsByName = new Map((knownColumns ?? []).map((column) => [column.name, column]));
  return Object.keys(first).map((name) => {
    const knownColumn = knownColumnsByName.get(name);
    if (knownColumn != null) return knownColumn;

    const sample = sampleColumnValue(name, rawRows, cleanRows);
    return inferredColumn(name, sample);
  });
}

async function describeQuery(
  db: SqlClient,
  sqlText: string,
  rawRows: unknown[],
): Promise<QueryDescription | null> {
  const first = (rawRows[0] ?? null) as Record<string, unknown> | null;
  if (first == null || sqlText.includes(";")) return null;

  const names = Object.keys(first);
  const plan = await explainQueryPlan(db, sqlText);
  const origin = plan == null ? null : queryOrigin(plan);
  if (origin == null || origin.output.length !== names.length) return null;

  const relationColumns = new Map<string, Promise<RelationColumn[]>>();
  const columns: ResultColumn[] = [];

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const sample = sampleColumnValue(name, rawRows, []);
    const fallback = inferredColumn(name, sample);
    const source = origin.origins[index];
    if (source == null) {
      columns.push(fallback);
      continue;
    }

    const sourceColumns = await cachedRelationColumns(db, source.relation, relationColumns);
    const sourceColumn = sourceColumns.find((column) => column.name === source.column);
    if (sourceColumn == null) {
      columns.push(fallback);
      continue;
    }

    columns.push({
      name,
      sqlType: sourceColumn.sqlType,
      valueKind: sourceColumn.valueKind,
      nullable: sourceColumn.nullable,
      writable: sourceColumn.writable,
      origin: {
        relation: source.relation,
        column: sourceColumn.name,
      },
    });
  }

  const targetColumns =
    origin.relations.length === 1
      ? await cachedRelationColumns(db, origin.relations[0], relationColumns)
      : null;
  return { columns, relations: origin.relations, targetColumns };
}

async function explainQueryPlan(db: SqlClient, sqlText: string): Promise<PlanNode | null> {
  try {
    const [row] = await db.unsafe(`explain (verbose, format json) ${sqlText}`);
    const document = (row as Record<string, unknown> | null)?.["QUERY PLAN"];
    if (!Array.isArray(document)) return null;
    const entry = document[0] as Record<string, unknown> | null;
    const plan = entry?.Plan;
    return isRecord(plan) ? plan : null;
  } catch {
    return null;
  }
}

async function cachedRelationColumns(
  db: SqlClient,
  relation: RelationRef,
  cache: Map<string, Promise<RelationColumn[]>>,
) {
  const key = relationKey(relation);
  const cached = cache.get(key);
  if (cached != null) return cached;

  const next = describeRelation(db, relation);
  cache.set(key, next);
  return next;
}

function inferredColumn(name: string, sample: unknown): ResultColumn {
  const valueKind = inferredColumnKind(sample);
  return {
    name,
    sqlType: inferredTypeLabel(valueKind),
    valueKind,
    nullable: true,
    writable: false,
    origin: null,
  };
}

function sampleColumnValue(name: string, rawRows: unknown[], cleanRows: Row[]) {
  for (const row of rawRows) {
    const value = (row as Record<string, unknown> | null)?.[name] ?? null;
    if (value != null) return value;
  }
  for (const row of cleanRows) {
    const value = row[name] ?? null;
    if (value != null) return value;
  }
  return null;
}

function normalizeSql(value: string) {
  let sqlText = value.trim();
  if (sqlText.endsWith(";")) sqlText = sqlText.slice(0, -1).trim();
  if (!sqlText) throw new Error("sql is empty");
  return sqlText;
}

function isReadQuery(value: string) {
  return startsWithKeyword(value, "select") || startsWithKeyword(value, "with");
}

function startsWithKeyword(value: string, keyword: string) {
  const prefix = value.slice(0, keyword.length).toLowerCase();
  const next = value[keyword.length] ?? " ";
  return prefix === keyword && (next === "(" || next.trim() === "");
}

function tableSelectSql(relation: RelationRef) {
  return `select * from ${quotePath(relation.schema, relation.name)}`;
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quotePath(schema: string, table: string) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function selectList(columns: RelationColumn[]) {
  return columns.map((column) => selectExpression(column)).join(", ");
}

function selectExpression(column: RelationColumn) {
  const name = quoteIdent(column.name);
  if (column.valueKind === "json") return `${name}::text as ${name}`;
  if (column.valueKind !== "bytes") return name;

  return `case when ${name} is null then null else concat('\\x', encode(${name}, 'hex')) end as ${name}`;
}

function orderByPrimaryKey(columns: RelationColumn[]) {
  const primaryColumns = columns.filter((column) => column.primaryKey);
  if (primaryColumns.length === 0) return "";
  return ` order by ${primaryColumns.map((column) => quoteIdent(column.name)).join(", ")}`;
}

function setExpression(column: RelationColumn | undefined, index: number) {
  if (column == null) throw new Error("Missing column metadata");
  const name = quoteIdent(column.name);
  if (column.valueKind === "bytes") return `${name} = decode($${index}, 'hex')`;
  if (column.valueKind === "json") return `${name} = ($${index}::text)::${jsonTypeName(column)}`;
  return `${name} = $${index}`;
}

function whereExpression(column: RelationColumn | undefined, index: number) {
  if (column == null) throw new Error("Missing column metadata");
  const name = quoteIdent(column.name);
  if (column.valueKind === "bytes") return `${name} = decode($${index}, 'hex')`;
  return `${name} = $${index}`;
}

function clampLimit(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function clampOffset(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function numberOrNull(value: unknown) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowCount(kind: NonNullable<RowCount>["kind"], value: unknown): RowCount {
  const number = numberOrNull(value);
  return number == null ? null : { kind, value: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function relationKey(relation: RelationRef) {
  return `${relation.schema}\0${relation.name}`;
}

function columnKind(typname: string, typcategory: string, dimensions: number): ColumnKind {
  if (dimensions > 0 || typcategory === "A") return "array";
  if (typname === "uuid") return "uuid";
  if (typname === "bytea") return "bytes";
  if (typname === "json" || typname === "jsonb") return "json";
  if (typcategory === "E") return "enum";
  if (typcategory === "B") return "boolean";
  if (typcategory === "D") return "datetime";
  if (typcategory === "N") return "number";
  if (typcategory === "S") return "text";
  return "other";
}

function inferredColumnKind(value: unknown): ColumnKind {
  if (value instanceof Uint8Array) return "bytes";
  if (value instanceof Date) return "datetime";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value != null) return "json";
  return "other";
}

function inferredTypeLabel(kind: ColumnKind) {
  if (kind === "bytes") return "bytea";
  if (kind === "datetime") return "timestamp";
  if (kind === "number") return "number";
  if (kind === "boolean") return "boolean";
  if (kind === "array") return "array";
  return kind === "other" ? "unknown" : kind;
}

function isWritableKind(kind: ColumnKind) {
  return (
    kind === "text" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "datetime" ||
    kind === "uuid" ||
    kind === "bytes" ||
    kind === "json" ||
    kind === "enum"
  );
}

function normalizeUpdateValue(value: ScalarValue, column?: RelationColumn) {
  if (column == null) throw new Error("Missing column metadata");
  if (value == null) return null;
  if (column.valueKind === "bytes") return normalizeByteaInput(value);
  if (column.valueKind === "json") return normalizeJsonInput(value);
  return value;
}

function normalizeByteaInput(value: ScalarValue) {
  const text = String(value).trim();
  const hex = text.startsWith("\\x") || text.startsWith("\\X") ? text.slice(2) : text;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error("bytea expects hex, with optional \\x prefix");
  }
  return hex.toLowerCase();
}

function normalizeJsonInput(value: ScalarValue) {
  const text = String(value).trim();
  try {
    JSON.parse(text);
  } catch {
    throw new Error("json expects valid JSON");
  }
  return text;
}

function jsonTypeName(column: RelationColumn) {
  return column.sqlType === "json" ? "json" : "jsonb";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled database request: ${JSON.stringify(value)}`);
}
