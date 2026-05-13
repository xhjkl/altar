export type ScalarValue = null | string | number | boolean;

export type PreviewCell = {
  // Preview cells are display-only. They may be truncated, encoded, or derived
  // from values the patch endpoint cannot safely round-trip.
  kind: "preview";
  format: "text" | "bytes" | "json" | "array" | "object";
  text: string;
  bytes?: number;
  truncated: boolean;
};

export type CellValue = ScalarValue | PreviewCell;

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

export type RelationInfo = RelationRef & {
  kind: "table" | "view" | "materialized-view" | "partitioned-table";
  rowCount: RowCount;
};

export type ColumnSource = {
  relation: RelationRef;
  column: string;
};

export type ColumnInfo = {
  name: string;
  typeLabel: string;
  kind: ColumnKind;
  nullable: boolean;
  primaryKey: boolean;
  patchable: boolean;
  source: ColumnSource | null;
};

export type Catalog = {
  database: string | null;
  relations: RelationInfo[];
  notice: string | null;
};

export type ResultSet = {
  sql: string;
  // A result is patchable only when this is non-null. The SQL editor may show
  // any SELECT result, but patches are always applied to this base relation by
  // the original primary key values.
  patchTarget: RelationRef | null;
  columns: ColumnInfo[];
  records: Record<string, CellValue>[];
  totalRows: RowCount;
  limit: number;
  offset: number;
  durationMs: number;
  notice: string | null;
};

export type RowPatch = {
  // `where` is the row identity as originally fetched. `set` may include
  // primary-key columns, so PK edits become:
  // update table set id = $new where id = $old.
  where: Record<string, ScalarValue>;
  set: Record<string, ScalarValue>;
};

export type PatchResult = {
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
        sql: string;
        limit: number;
        offset: number;
        patchTarget?: RelationRef | null;
      }
    | {
        type: "patch";
        relation: RelationRef;
        patches: RowPatch[];
      }
  );

export type DbResponse<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      error: string;
    };
