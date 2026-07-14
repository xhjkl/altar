export type ScalarValue = null | string | number | boolean;

/** Display-only value that the update endpoint cannot safely round-trip. */
export type PreviewCell = {
  kind: "preview";
  format: "text" | "bytes" | "json" | "array" | "object";
  text: string;
  bytes?: number;
  truncated: boolean;
};

export type CellValue = ScalarValue | PreviewCell;

/** Row fields preserve PostgreSQL output labels. */
export type Row = Record<string, CellValue>;

export type ColumnKind =
  | "text"
  | "number"
  | "boolean"
  | "datetime"
  | "uuid"
  | "bytes"
  | "json"
  | "array"
  | "enum"
  | "other";

export type RowCount =
  | {
      kind: "exact" | "estimate";
      value: number;
    }
  | null;

export type RelationRef = {
  schema: string;
  name: string;
};

/** Relation listed by the PostgreSQL catalog. */
export type CatalogRelation = RelationRef & {
  kind: "table" | "view" | "materialized-view" | "partitioned-table";
  rowCount: RowCount;
};

export type ColumnSource = {
  relation: RelationRef;
  column: string;
};

/** Output field plus any conservatively proven physical origin. */
export type ResultColumn = {
  name: string;
  sqlType: string;
  valueKind: ColumnKind;
  nullable: boolean;
  origin: ColumnSource | null;
  writable: boolean;
};

export type Catalog = {
  database: string;
  relations: CatalogRelation[];
  durationMs: number;
};

/** Distinguishes server-generated relation reads from arbitrary editor SQL. */
export type QuerySource =
  | {
      kind: "sql";
      text: string;
    }
  | {
      kind: "relation";
      relation: RelationRef;
    };

/** Single-relation row identity proven from server-side query provenance. */
export type UpdateTarget = {
  relation: RelationRef;
  keyColumns: {
    resultColumn: string;
    relationColumn: string;
  }[];
};

/** Query page plus the server-proven capability used for row updates. */
export type QueryResult = {
  source: QuerySource;
  sql: string;
  columns: ResultColumn[];
  rows: Row[];
  updateTarget: UpdateTarget | null;
  rowCount: RowCount;
  limit: number;
  offset: number;
  hasMore: boolean;
  durationMs: number;
};

/** Original row identity and replacement values for one update. */
export type RowUpdate = {
  key: Record<string, ScalarValue>;
  changes: Record<string, ScalarValue>;
};

export type UpdateResult = {
  affectedRows: number;
};

type ConnectionScope = {
  connection: string;
};

export type DbRequest = ConnectionScope &
  (
    | {
        type: "disconnect";
      }
    | {
        type: "catalog";
      }
    | {
        type: "query";
        source: QuerySource;
        limit: number;
        offset: number;
      }
    | {
        type: "update";
        relation: RelationRef;
        updates: RowUpdate[];
      }
  );

/** Response payload implied by the request discriminant. */
export type DbResult<R extends DbRequest> =
  R extends { type: "disconnect" }
    ? { disconnected: boolean }
    : R extends { type: "catalog" }
      ? Catalog
      : R extends { type: "query" }
        ? QueryResult
        : R extends { type: "update" }
          ? UpdateResult
          : never;

export type DbResponse<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      error: string;
    };

export function isPreviewCell(value: unknown): value is PreviewCell {
  if (typeof value !== "object" || value == null) return false;
  const cell = value as Record<string, unknown>;
  return (
    cell.kind === "preview" &&
    (cell.format === "text" ||
      cell.format === "bytes" ||
      cell.format === "json" ||
      cell.format === "array" ||
      cell.format === "object") &&
    typeof cell.text === "string" &&
    (cell.bytes == null || typeof cell.bytes === "number") &&
    typeof cell.truncated === "boolean"
  );
}

export function sameRelation(left: RelationRef, right: RelationRef) {
  return left.schema === right.schema && left.name === right.name;
}
