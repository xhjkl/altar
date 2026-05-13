import type {
  Catalog,
  CellValue,
  ColumnKind,
  ColumnInfo,
  DbRequest,
  DbResponse,
  PatchResult,
  PreviewCell,
  RelationInfo,
  RelationRef,
  ResultSet,
  RowCount,
  RowPatch,
  ScalarValue,
} from "~/lib/protocol";

type DbEvent = {
  request: Request;
};

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
type QueryColumnSource = { relation: RelationRef; column: string };
type PlanAlias = { relation: RelationRef };
type PlanNode = Record<string, unknown>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_TEXT = 8_000;
const BYTE_PREVIEW = 64;
const NO_CONNECTION = "enter a postgres connection string.";
const MISSING_BUN_SQL =
  "the gateway cannot open postgres connections in this runtime. restart it with bun and try again.";

const runtime = self as typeof self & { __altarSql?: SqlSlot };
const sqlSlot = (runtime.__altarSql ??= { current: null });

export async function POST(event: DbEvent) {
  try {
    const body = (await event.request.json()) as DbRequest;
    const result = await handle(body);
    return json({ ok: true, result });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown database error",
      },
      500,
    );
  }
}

async function handle(request: DbRequest) {
  if (request.type === "disconnect") return disconnect(request.connection);
  if (request.type === "catalog") return loadCatalog(request.connection);
  if (request.type === "query") {
    return runQuery(
      request.connection,
      request.sql,
      clampLimit(request.limit),
      clampOffset(request.offset),
      request.patchTarget ?? null,
    );
  }
  return updateRowsByPk(request.connection, request.relation, request.patches);
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
  const db = connect(connection);
  if (db == null) return { database: null, relations: [], notice: NO_CONNECTION };

  try {
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
          kind: String(value.kind) as RelationInfo["kind"],
          rowCount: rowCount("estimate", value.estimated_rows),
        };
      }),
      notice: `metadata in ${Math.round(performance.now() - started)}ms`,
    };
  } catch (error) {
    return {
      database: null,
      relations: [],
      notice: `could not reach postgres: ${messageOf(error)}`,
    };
  }
}

async function runQuery(
  connection: string,
  sqlText: string,
  limit: number,
  offset: number,
  patchTarget: RelationRef | null,
): Promise<ResultSet> {
  const db = requireConnection(connection);
  const sqlTextTrimmed = normalizeSql(sqlText);
  const readQuery = isReadQuery(sqlTextTrimmed);

  const started = performance.now();
  const patchColumns = patchTarget == null ? null : await describeRelation(db, patchTarget);
  if (patchTarget != null && patchColumns?.length === 0) {
    throw new Error(`No such relation: ${patchTarget.schema}.${patchTarget.name}`);
  }

  const rows =
    patchTarget != null && sqlTextTrimmed === tableSelectSql(patchTarget)
      ? await db.unsafe(
          `select ${selectList(patchColumns ?? [])} from ${quotePath(patchTarget.schema, patchTarget.name)}${orderByPrimaryKey(patchColumns ?? [])} limit ${limit} offset ${offset}`,
        )
      : readQuery
        ? await db.unsafe(`select * from (${sqlTextTrimmed}) as altar_query limit ${limit} offset ${offset}`)
        : await db.unsafe(sqlTextTrimmed);
  const queryColumns =
    readQuery && !(patchTarget != null && sqlTextTrimmed === tableSelectSql(patchTarget))
      ? await describeQueryColumns(db, sqlTextTrimmed, rows)
      : null;
  const knownColumns = queryColumns ?? patchColumns;
  const cleanRows = rows.map((row) => sanitizeRow(row, knownColumns));
  const resultPatchTarget =
    patchTarget != null && (readQuery || returnedRowsHavePrimaryKey(cleanRows, patchColumns)) ? patchTarget : null;
  return {
    sql: sqlTextTrimmed,
    patchTarget: resultPatchTarget,
    columns:
      patchTarget != null && sqlTextTrimmed === tableSelectSql(patchTarget)
        ? (patchColumns ?? [])
        : inferColumns(cleanRows, rows, queryColumns ?? (resultPatchTarget == null ? null : patchColumns)),
    records: cleanRows,
    totalRows: readQuery
      ? exactRowCountForPage(offset, limit, cleanRows.length)
      : { kind: "exact", value: cleanRows.length },
    limit,
    offset,
    durationMs: Math.round(performance.now() - started),
    notice: null,
  };
}

async function updateRowsByPk(
  connection: string,
  relation: RelationRef,
  patches: RowPatch[],
): Promise<PatchResult> {
  const db = requireConnection(connection);
  const columns = await describeRelation(db, relation);
  const columnsByName = new Map(columns.map((column) => [column.name, column]));
  const primaryColumns = columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (primaryColumns.length === 0) throw new Error(`${relation.schema}.${relation.name} has no primary key`);

  let affectedRows = 0;
  await db.begin(async (tx) => {
    for (const patch of patches) {
      for (const column of primaryColumns) {
        if (!(column in patch.where)) throw new Error(`Missing primary key column: ${column}`);
      }

      const setEntries = Object.entries(patch.set);
      if (setEntries.length === 0) continue;

      for (const [name] of setEntries) {
        const column = columnsByName.get(name);
        if (column == null) throw new Error(`Unknown column: ${name}`);
        if (!column.patchable) throw new Error(`Column ${name} is not patchable`);
      }

      const setSql = setEntries
        .map(([name], index) => setExpression(columnsByName.get(name), index + 1))
        .join(", ");
      const whereSql = primaryColumns
        .map((name, index) => whereExpression(columnsByName.get(name), setEntries.length + index + 1))
        .join(" and ");
      const values = [
        ...setEntries.map(([name, value]) => normalizePatchValue(value, columnsByName.get(name))),
        ...primaryColumns.map((name) => normalizePatchValue(patch.where[name], columnsByName.get(name))),
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

async function describeRelation(db: SqlClient, relation: RelationRef): Promise<ColumnInfo[]> {
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
    const kind = columnKind(
      String(value.typname),
      String(value.typcategory),
      numberOrNull(value.attndims) ?? 0,
    );
    return {
      name: String(value.name),
      typeLabel: String(value.type_label),
      kind,
      nullable: Boolean(value.nullable),
      primaryKey: Boolean(value.primary_key),
      patchable: !Boolean(value.generated) && !Boolean(value.identity) && isPatchableKind(kind),
      source: { relation, column: String(value.name) },
    };
  });
}

function exactRowCountForPage(offset: number, limit: number, visibleRows: number): RowCount {
  if (offset === 0 && visibleRows === 0) return { kind: "exact", value: 0 };
  if (visibleRows > 0 && visibleRows < limit) return { kind: "exact", value: offset + visibleRows };
  return null;
}

function returnedRowsHavePrimaryKey(rows: Record<string, CellValue>[], columns: ColumnInfo[] | null) {
  if (rows.length === 0 || columns == null) return false;
  const primaryColumns = columns.filter((column) => column.primaryKey);
  if (primaryColumns.length === 0) return false;

  return rows.every((row) =>
    primaryColumns.every((column) => {
      const value = row[column.name];
      return value != null && !isPreviewCell(value);
    }),
  );
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

function json<T>(body: DbResponse<T>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function sanitizeRow(row: unknown, columns: ColumnInfo[] | null = null): Record<string, CellValue> {
  const value = row as Record<string, unknown>;
  const columnsByName = new Map((columns ?? []).map((column) => [column.name, column]));
  const clean: Record<string, CellValue> = {};
  for (const [key, cell] of Object.entries(value)) clean[key] = sanitizeCell(cell, columnsByName.get(key));
  return clean;
}

function sanitizeCell(value: unknown, column?: ColumnInfo): CellValue {
  if (value == null) return null;
  if (isPreviewCell(value)) return value;
  if (column?.kind === "json" && typeof value === "object") {
    return sanitizeText(JSON.stringify(value), "json");
  }
  if (typeof value === "string") {
    if (column?.kind === "bytes") return value;
    return sanitizeText(value, "text");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    if (column?.kind === "bytes") return `\\x${hexBytes(value)}`;
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

function isPreviewCell(value: unknown): value is PreviewCell {
  if (typeof value !== "object" || value == null) return false;
  const cell = value as Record<string, unknown>;
  return (
    cell.kind === "preview" &&
    typeof cell.format === "string" &&
    typeof cell.text === "string" &&
    typeof cell.truncated === "boolean"
  );
}

function inferColumns(
  cleanRows: Record<string, CellValue>[],
  rawRows: unknown[],
  knownColumns: ColumnInfo[] | null,
): ColumnInfo[] {
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

async function describeQueryColumns(
  db: SqlClient,
  sqlText: string,
  rawRows: unknown[],
): Promise<ColumnInfo[] | null> {
  const first = (rawRows[0] ?? null) as Record<string, unknown> | null;
  if (first == null || sqlText.includes(";")) return null;

  const names = Object.keys(first);
  const plan = await explainQueryPlan(db, sqlText);
  const output = plan == null ? null : planOutput(plan);
  if (output == null || output.length !== names.length) return null;

  const aliases = collectPlanAliases(plan);
  const relationColumns = new Map<string, Promise<Map<string, ColumnInfo>>>();
  const columns: ColumnInfo[] = [];

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const sample = sampleColumnValue(name, rawRows, []);
    const fallback = inferredColumn(name, sample);
    const source = sourceForOutput(output[index], aliases);
    if (source == null) {
      columns.push(fallback);
      continue;
    }

    const sourceColumns = await relationColumnsByName(db, source.relation, relationColumns);
    const sourceColumn = sourceColumns.get(source.column);
    if (sourceColumn == null) {
      columns.push(fallback);
      continue;
    }

    columns.push({
      ...sourceColumn,
      name,
      source: {
        relation: source.relation,
        column: sourceColumn.name,
      },
    });
  }

  return columns;
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

function planOutput(plan: PlanNode) {
  const output = plan.Output;
  return Array.isArray(output) && output.every((value) => typeof value === "string")
    ? (output as string[])
    : null;
}

function collectPlanAliases(plan: PlanNode, aliases = new Map<string, PlanAlias>()) {
  const relation = plan["Relation Name"];
  const schema = plan.Schema;
  const alias = plan.Alias;
  if (typeof relation === "string" && typeof schema === "string") {
    const source = { relation: { schema, name: relation } };
    aliases.set(relation, source);
    if (typeof alias === "string") aliases.set(alias, source);
  }

  const children = plan.Plans;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isRecord(child)) collectPlanAliases(child, aliases);
    }
  }

  return aliases;
}

function sourceForOutput(value: string, aliases: Map<string, PlanAlias>): QueryColumnSource | null {
  const path = parseIdentifierPath(value);
  if (path == null) return null;

  const column = path[path.length - 1];
  if (path.length === 1) {
    const relation = solePlanRelation(aliases);
    return relation == null ? null : { relation, column };
  }

  for (let index = path.length - 2; index >= 0; index -= 1) {
    const alias = aliases.get(path[index]);
    if (alias != null) return { relation: alias.relation, column };
  }

  return null;
}

function solePlanRelation(aliases: Map<string, PlanAlias>): RelationRef | null {
  const relations = new Map<string, RelationRef>();
  for (const alias of aliases.values()) relations.set(relationKey(alias.relation), alias.relation);
  if (relations.size !== 1) return null;
  return relations.values().next().value ?? null;
}

function parseIdentifierPath(value: string) {
  const path: string[] = [];
  let index = 0;

  while (index < value.length) {
    if (value[index] === '"') {
      let text = "";
      index += 1;
      while (index < value.length) {
        if (value[index] === '"' && value[index + 1] === '"') {
          text += '"';
          index += 2;
        } else if (value[index] === '"') {
          index += 1;
          break;
        } else {
          text += value[index];
          index += 1;
        }
      }
      if (!text) return null;
      path.push(text);
    } else {
      const start = index;
      while (index < value.length && /[\p{L}0-9_$]/u.test(value[index])) index += 1;
      if (start === index) return null;
      path.push(value.slice(start, index));
    }

    if (index === value.length) break;
    if (value[index] !== ".") return null;
    index += 1;
  }

  return path;
}

async function relationColumnsByName(
  db: SqlClient,
  relation: RelationRef,
  cache: Map<string, Promise<Map<string, ColumnInfo>>>,
) {
  const key = relationKey(relation);
  const cached = cache.get(key);
  if (cached != null) return cached;

  const next = describeRelation(db, relation).then((columns) => new Map(columns.map((column) => [column.name, column])));
  cache.set(key, next);
  return next;
}

function inferredColumn(name: string, sample: unknown): ColumnInfo {
  const kind = inferredColumnKind(sample);
  return {
    name,
    typeLabel: inferredTypeLabel(kind),
    kind,
    nullable: true,
    primaryKey: false,
    patchable: false,
    source: null,
  };
}

function sampleColumnValue(name: string, rawRows: unknown[], cleanRows: Record<string, CellValue>[]) {
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

function selectList(columns: ColumnInfo[]) {
  return columns.map((column) => selectExpression(column)).join(", ");
}

function selectExpression(column: ColumnInfo) {
  const name = quoteIdent(column.name);
  if (column.kind === "json") return `${name}::text as ${name}`;
  if (column.kind !== "bytes") return name;

  return `case when ${name} is null then null else concat('\\x', encode(${name}, 'hex')) end as ${name}`;
}

function orderByPrimaryKey(columns: ColumnInfo[]) {
  const primaryColumns = columns.filter((column) => column.primaryKey);
  if (primaryColumns.length === 0) return "";
  return ` order by ${primaryColumns.map((column) => quoteIdent(column.name)).join(", ")}`;
}

function setExpression(column: ColumnInfo | undefined, index: number) {
  if (column == null) throw new Error("Missing column metadata");
  const name = quoteIdent(column.name);
  if (column.kind === "bytes") return `${name} = decode($${index}, 'hex')`;
  if (column.kind === "json") return `${name} = ($${index}::text)::${jsonTypeName(column)}`;
  return `${name} = $${index}`;
}

function whereExpression(column: ColumnInfo | undefined, index: number) {
  if (column == null) throw new Error("Missing column metadata");
  const name = quoteIdent(column.name);
  if (column.kind === "bytes") return `${name} = decode($${index}, 'hex')`;
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

function isPatchableKind(kind: ColumnKind) {
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

function normalizePatchValue(value: ScalarValue, column?: ColumnInfo) {
  if (column == null) throw new Error("Missing column metadata");
  if (value == null) return null;
  if (column.kind === "bytes") return normalizeByteaInput(value);
  if (column.kind === "json") return normalizeJsonInput(value);
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

function jsonTypeName(column: ColumnInfo) {
  return column.typeLabel === "json" ? "json" : "jsonb";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "unknown database error";
}
