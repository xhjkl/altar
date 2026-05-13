import type { APIEvent } from "@solidjs/start/server";
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

type SqlClient = {
  unsafe: (sql: string, values?: unknown[]) => Promise<unknown[]>;
  close?: () => Promise<void> | void;
  end?: () => Promise<void> | void;
};

declare const Bun: {
  SQL: new (url?: string) => SqlClient;
  sql: SqlClient;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_TEXT = 8_000;
const BYTE_PREVIEW = 64;
const NO_CONNECTION = "Enter a Postgres URL to connect.";
const MISSING_BUN_SQL =
  "The gateway cannot open Postgres connections in this runtime. Restart it with Bun and try again.";

let sql: { key: string; client: SqlClient } | null = null;

export async function POST(event: APIEvent) {
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
  if (!key || sql?.key !== key) return { disconnected: false };

  const client = sql.client;
  sql = null;
  if (client.close != null) await client.close();
  else if (client.end != null) await client.end();
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
      notice: "Could not reach Postgres. Check the URL, tunnel, and database process.",
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
          `select ${selectList(patchColumns ?? [])} from ${quotePath(patchTarget.schema, patchTarget.name)} limit ${limit} offset ${offset}`,
        )
      : readQuery
        ? await db.unsafe(`select * from (${sqlTextTrimmed}) as altar_query limit ${limit} offset ${offset}`)
        : await db.unsafe(sqlTextTrimmed);
  const cleanRows = rows.map(sanitizeRow);
  const resultPatchTarget =
    patchTarget != null && (readQuery || returnedRowsHavePrimaryKey(cleanRows, patchColumns)) ? patchTarget : null;
  return {
    sql: sqlTextTrimmed,
    patchTarget: resultPatchTarget,
    columns:
      patchTarget != null && sqlTextTrimmed === tableSelectSql(patchTarget)
        ? (patchColumns ?? [])
        : inferColumns(cleanRows, rows, resultPatchTarget == null ? null : patchColumns),
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
  await db.unsafe("begin");
  try {
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
        .map((name, index) => `${quoteIdent(name)} = $${setEntries.length + index + 1}`)
        .join(" and ");
      const values = [
        ...setEntries.map(([name, value]) => normalizePatchValue(value, columnsByName.get(name))),
        ...primaryColumns.map((name) => normalizePatchValue(patch.where[name], columnsByName.get(name))),
      ];

      const result = await db.unsafe(
        `update ${quotePath(relation.schema, relation.name)} set ${setSql} where ${whereSql} returning 1 as affected_rows`,
        values,
      );
      if (result.length !== 1) {
        throw new Error("Row was not found. The primary key may have changed.");
      }
      affectedRows += result.length;
    }
    await db.unsafe("commit");
  } catch (error) {
    await db.unsafe("rollback").catch(() => null);
    throw error;
  }

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
  if (sql?.key === key) return sql.client;

  const client = new Bun.SQL(url);
  sql = { key, client };
  return client;
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

function sanitizeRow(row: unknown): Record<string, CellValue> {
  const value = row as Record<string, unknown>;
  const clean: Record<string, CellValue> = {};
  for (const [key, cell] of Object.entries(value)) clean[key] = sanitizeCell(cell);
  return clean;
}

function sanitizeCell(value: unknown): CellValue {
  if (value == null) return null;
  if (isPreviewCell(value)) return value;
  if (typeof value === "string") {
    if (value.length <= MAX_TEXT) return value;
    return previewCell("text", value.slice(0, MAX_TEXT), true);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    const bytes = value.byteLength;
    const preview = Array.from(value.slice(0, BYTE_PREVIEW))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
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
  patchColumns: ColumnInfo[] | null,
): ColumnInfo[] {
  const first = (rawRows[0] ?? cleanRows[0] ?? null) as Record<string, unknown> | null;
  if (first == null) return [];
  const patchColumnsByName = new Map((patchColumns ?? []).map((column) => [column.name, column]));
  return Object.keys(first).map((name) => {
    const patchColumn = patchColumnsByName.get(name);
    if (patchColumn != null) return patchColumn;

    const sample = sampleColumnValue(name, rawRows, cleanRows);
    const kind = inferredColumnKind(sample);
    return {
      name,
      typeLabel: inferredTypeLabel(kind),
      kind,
      nullable: true,
      primaryKey: false,
      patchable: false,
    };
  });
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
  if (!sqlText) throw new Error("SQL is empty");
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
  if (column.kind !== "bytes") return name;

  return `case when ${name} is null then null else json_build_object('kind', 'preview', 'format', 'bytes', 'bytes', octet_length(${name}), 'text', concat('\\x', encode(substring(${name} from 1 for ${BYTE_PREVIEW}), 'hex')), 'truncated', octet_length(${name}) > ${BYTE_PREVIEW}) end as ${name}`;
}

function setExpression(column: ColumnInfo | undefined, index: number) {
  if (column == null) throw new Error("Missing column metadata");
  const name = quoteIdent(column.name);
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

function columnKind(typname: string, typcategory: string, dimensions: number): ColumnKind {
  if (dimensions > 0 || typcategory === "A") return "array";
  if (typname === "uuid") return "uuid";
  if (typname === "bytea") return "bytes";
  if (typname === "json" || typname === "jsonb") return "json";
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
  return kind === "text" || kind === "number" || kind === "boolean" || kind === "datetime" || kind === "uuid";
}

function normalizePatchValue(value: ScalarValue, column?: ColumnInfo) {
  if (column == null) throw new Error("Missing column metadata");
  return value;
}
