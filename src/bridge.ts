import { invoke } from "@tauri-apps/api/core";

export type Scene = "live" | "paused" | "trace" | "sql" | "offline" | "empty" | "compact";
/** Content independent of navigation; an SQL run changes only on explicit submission. */
export type Query = { kind: "logs"; filter: string } | { kind: "sql"; source: string; statement: string; run: number };
export type View = { id: string; name: string; query: Query };
export type Machine = { id: string; name: string; online: boolean; views: View[] };
/** View IDs are local to their machine. */
export type Selection = { machine: Machine; view: View };
export type Workspace = {
  machines: Machine[];
  selection: { machine: string; view: string };
  tick: number;
  pausedAt: number | null;
  inspect: number | null;
};
export type Column = { name: string } & (
  | { kind: "time" | "unit" | "severity" | "message" | "duration" }
  | { kind: "value"; characters: number }
);
export type Row = { id: number; cells: string[]; tone: string };
export type Frame = {
  columns: Column[];
  rows: Row[];
  total: number;
  pending: number;
  /** The collection sequence the frame reflects; pausing freezes later requests at it. */
  tick: number;
  window: {
    rowHeight: number;
    offset: number;
    scrollTop: number;
    totalHeight: number;
    /** Top of the last row, excluding the trailing breather; null only for empty results. */
    tailTop: number | null;
  };
};
/** Machine-owned sample; nonempty histories run oldest to newest, from 0 to 100 percent. */
export type Metrics = {
  machine: string;
  cpu: number[];
  memory: number[];
  disk: number;
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
  uptime: string;
  lastSample: string | null;
};
/** A writable field belongs to a row the backend can address by primary key. */
export type Field = { name: string; value: string | null; writable: boolean; kind: string | null };
export type Detail = {
  title: string;
  tone: string;
  fields: Field[];
  trace: { name: string; duration: string; start: number; width: number }[];
};
/** Browser-owned layout measurements; Rust materializes the bounded row range. */
export type FrameRequest = {
  machine: string;
  query: Query;
  tick: number;
  pausedAt: number | null;
  /** A null top requests alignment with the padded tail; a number preserves manual scrolling. */
  viewport: {
    top: number | null; height: number; insetTop: number;
    rowHeight: number; paddingTop: number; paddingBottom: number; overscan: number;
  };
};

// Keeping wire names and response types at the IPC boundary.
export const workspace = (scene: Scene | null) => invoke<Workspace>("workspace", { scene });
export const discoverSql = (machine: string) => invoke<Machine>("discover_sql", { machine });
export const renderFrame = (request: FrameRequest) => invoke<Frame>("render_frame", { request });
export const inspectRow = (machine: string, query: Query, id: number) => invoke<Detail>("inspect_row", { machine, query, id });
export const updateCell = (machine: string, query: Query, id: number, field: string, value: string | null) =>
  invoke<Detail>("update_cell", { edit: { machine, query, id, field, value } });
export const metrics = (machine: string, tick: number) => invoke<Metrics>("metrics", { machine, tick });
