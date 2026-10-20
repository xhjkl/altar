import { createContext, type Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type Scene = "live" | "paused" | "inspect" | "sql" | "offline" | "empty" | "compact";
/** Initial content stored in a view; SQL execution has a separate command. */
export type Query = { kind: "logs"; filter: string } | { kind: "sql"; source: string; statement: string };
/** Lookup-only content; an SQL result cannot execute its statement again. */
export type Content = { kind: "logs"; filter: string } | { kind: "sql"; source: string; result: number };
export type View = { id: string; name: string; query: Query };
export type Connection = "connecting" | "connected" | "reconnecting";
export type Machine = { id: string; name: string; connection: Connection; views: View[] };
/** View IDs are local to their machine. */
export type Selection = { machine: Machine; view: View | null };
export type Workspace = {
  localHostname: string;
  machines: Machine[];
  selection: { machine: string; view: string | null } | null;
};
export type Column = { name: string } & (
  | { kind: "time" | "unit" | "severity" | "message" | "duration" }
  | { kind: "value"; characters: number }
);
export type Row = { id: number; cells: string[]; tone: string };
export type Frame = {
  notice: string | null;
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
/** A physical edit address is independent of result aliases and nullable SQL values. */
export type SqlField = { name: string; value: string | null; kind: string | null; edit: number | null };
export type SqlDetail = { title: string; fields: SqlField[] };
export type Detail =
  | { kind: "journal"; title: string; tone: string; fields: { name: string; value: string }[] }
  | ({ kind: "sql" } & SqlDetail);
/** Browser-owned layout measurements; Rust materializes the bounded row range. */
export type FrameRequest = {
  machine: string;
  query: Content;
  pausedAt: number | null;
  /** A null top requests alignment with the padded tail; a number preserves manual scrolling. */
  viewport: {
    top: number | null; height: number; insetTop: number;
    rowHeight: number; paddingTop: number; paddingBottom: number; overscan: number;
  };
};

// Keeping wire names and response types at the IPC boundary.
export const workspace = () => invoke<Workspace>("workspace");
export const fixtureWorkspace = (scene: Scene) => invoke<Workspace>("fixture_workspace", { scene });
export const connectMachine = (destination: string | null) => invoke<Machine>("connect_machine", { destination });
export const machineStatus = (machine: string) => invoke<Connection>("machine_status", { machine });
export const discoverSql = (machine: string) => invoke<Machine>("discover_sql", { machine });
export const updateCell = (machine: string, source: string, result: number, id: number, column: number, value: string | null) =>
  invoke<SqlDetail>("update_cell", { edit: { machine, source, result, id, column, value } });

export const liveBackend = {
  renderFrame: (request: FrameRequest) => invoke<Frame>("render_frame", { request }),
  inspectRow: (machine: string, query: Content, id: number) => invoke<Detail>("inspect_row", { machine, query, id }),
  metrics: (machine: string) => invoke<Metrics>("metrics", { machine }),
  submitSql: (machine: string, source: string, statement: string, submission: string) => invoke<number>("submit_sql", { machine, source, statement, submission }),
};

/** Select sample transport for one mounted workspace, independently of live sessions or other windows. */
export function fixtureBackend(tick: Accessor<number>): typeof liveBackend {
  return {
    renderFrame: (request) => invoke<Frame>("fixture_frame", { request, tick: tick() }),
    inspectRow: (machine, query, id) => invoke<Detail>("fixture_inspect", { machine, query, id }),
    metrics: (machine) => invoke<Metrics>("fixture_metrics", { machine, tick: tick() }),
    submitSql: async () => 1,
  };
}

export const Backend = createContext(liveBackend);
