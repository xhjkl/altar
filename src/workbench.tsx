import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, useContext, type JSX } from "solid-js";
import { Backend, updateCell, type Content, type Machine, type Query, type SqlField, type View } from "./bridge";
import Icon from "./icon";
import { usePresentations } from "./presentations";
import Stream from "./stream";
import Wing from "./wing";

/** Give logs and SQL their own controls and state while sharing bounded row rendering. */
export default function Workbench(props: {
  selection: { machine: Machine; view: View };
  tick: number;
  initialPausedAt: number | null;
  initialInspect: number | null;
}) {
  const { machine, view } = props.selection;
  if (view.query.kind === "sql") return <SqlWorkbench machine={machine} query={view.query} tick={props.tick} />;
  return <LogWorkbench machine={machine} filter={view.query.filter} tick={props.tick}
    initialPausedAt={props.initialPausedAt} initialInspect={props.initialInspect} />;
}

function LogWorkbench(props: { machine: Machine; filter: string; tick: number; initialPausedAt: number | null; initialInspect: number | null }) {
  const [query, setQuery] = createSignal({ kind: "logs" as const, filter: props.filter });
  function search(filter: string) {
    setQuery({ kind: "logs", filter });
  }
  return <Rows machine={props.machine} query={query()} tick={props.tick} initialPausedAt={props.initialPausedAt}
    initialInspect={props.initialInspect} label="Log events"
    empty={<><Icon name="search" size={24} /><h2>No matching events</h2><button onClick={() => search("")}>Clear search</button></>}
  >
    <QueryBar machine={props.machine} value={query().filter} label="Search expression" placeholder="*" onInput={search} onSubmit={() => search(query().filter)}>
      <kbd data-tauri-drag-region>⌘ K</kbd>
    </QueryBar>
  </Rows>;
}

function SqlWorkbench(props: { machine: Machine; query: Extract<Query, { kind: "sql" }>; tick: number }) {
  const backend = useContext(Backend);
  const [draft, setDraft] = createSignal(props.query.statement);
  // Opening a view is an explicit first submission; lookups only receive the returned handle.
  const initialSubmission = crypto.randomUUID();
  const [submission, setSubmission] = createSignal({ id: initialSubmission, statement: props.query.statement });
  const [result, { refetch }] = createResource(submission, ({ id, statement }) =>
    backend.submitSql(props.machine.id, props.query.source, statement, id));
  const query = createMemo<Content | null>(() => {
    if (result.error) return null;
    const id = result();
    return id == null ? null : { kind: "sql", source: props.query.source, result: id };
  });
  function run() {
    if (result.loading) return;
    const id = crypto.randomUUID();
    setSubmission({ id, statement: draft() });
  }
  return <>
    <Rows machine={props.machine} query={query()} tick={props.tick} initialPausedAt={null} initialInspect={null}
      label="Query rows" empty={<><Icon name="search" size={24} /><h2>No rows</h2></>}
    >
      <QueryBar machine={props.machine} value={draft()} label="SQL query" placeholder="select …" onInput={setDraft} onSubmit={run}>
        <button class="run-button" type="submit" aria-label="Run query" disabled={result.loading}>
          <Icon name="play" size={12} />{result.loading ? "Running…" : "Run"}
        </button>
      </QueryBar>
    </Rows>
    <Show when={result.loading && query() == null}><div class="empty-state"><p>Running…</p></div></Show>
    <Show when={result.error}><div class="error-banner" role="alert">
      {String(result.error)}<button onClick={() => { void refetch(); }}>Retry</button>
    </div></Show>
  </>;
}

function QueryBar(props: { machine: Machine; value: string; label: string; placeholder: string; onInput: (value: string) => void; onSubmit: () => void; children: JSX.Element }) {
  const presentations = usePresentations();
  let input!: HTMLInputElement;
  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (presentations.top() != null || !(event.metaKey || event.ctrlKey) || event.key !== "k") return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      input.select();
    };
    window.addEventListener("keydown", keydown);
    onCleanup(() => window.removeEventListener("keydown", keydown));
  });
  return <form class="pathbar" aria-label="Workbench path" data-tauri-drag-region onSubmit={(event) => {
    event.preventDefault();
    props.onSubmit();
  }}>
    <span class="slash" data-tauri-drag-region>/</span>
    <span class="path-machine" data-tauri-drag-region>{props.machine.name}</span>
    <Show when={props.machine.connection !== "connected"}>
      <small class="connection-label" role="status">{props.machine.connection === "connecting" ? "Connecting…" : "Reconnecting…"}</small>
    </Show>
    <span class="slash" data-tauri-drag-region>/</span>
    <input ref={input} aria-label={props.label} placeholder={props.placeholder} spellcheck={false}
      value={props.value} onInput={(event) => props.onInput(event.currentTarget.value)} />
    {props.children}
  </form>;
}

/** Own one result's inspection; changing content invalidates the inspector rather than reusing its row ordinal. */
function Rows(props: { machine: Machine; query: Content | null; tick: number; initialPausedAt: number | null; initialInspect: number | null; label: string; empty: JSX.Element; children: JSX.Element }) {
  const backend = useContext(Backend);
  const [inspection, setInspection] = createSignal<{ id: number; returnFocus: HTMLElement | null } | null>(
    props.initialInspect == null ? null : { id: props.initialInspect, returnFocus: null },
  );
  const [revision, setRevision] = createSignal(0);
  createEffect(on(() => props.query, () => setInspection(null), { defer: true }));
  return <>
    <Show when={props.query} fallback={
      <div class="top-chrome"><header class="topbar" data-tauri-drag-region>{props.children}</header></div>
    }>{(query) => <Stream machine={props.machine.id} query={query()} tick={props.tick} live={query().kind === "logs"}
      revision={revision()} initialPausedAt={props.initialPausedAt} selected={inspection()?.id ?? null} label={props.label}
      onInspect={(id, returnFocus) => setInspection({ id, returnFocus })} empty={props.empty}
    >{props.children}</Stream>}</Show>
    <Show keyed when={inspection()}>{(selection) => {
      const query = props.query;
      if (query == null) return null;
      const [detail, { refetch, mutate }] = createResource(() => backend.inspectRow(props.machine.id, query, selection.id));
      return <Wing title={query.kind === "sql" ? "Row inspector" : "Journal entry"} onClose={() => setInspection(null)} returnFocus={selection.returnFocus}>
        <Show when={detail.error}><p role="alert">{String(detail.error)} <button onClick={() => { void refetch(); }}>Retry</button></p></Show>
        <Show keyed when={!detail.error && detail()} fallback={<Show when={detail.loading}><p>Loading…</p></Show>}>{(entry) => {
          if (entry.kind === "journal") return <>
            <h2 data-tone={entry.tone}>{entry.title}</h2>
            <dl><For each={entry.fields}>{(field) => <div><dt>{field.name}</dt><dd>{field.value}</dd></div>}</For></dl>
          </>;
          if (query.kind !== "sql") return <p role="alert">Unexpected inspector response.</p>;
          return <>
            <h2>{entry.title}</h2>
            <Fields fields={entry.fields} save={async (column, value) => {
              try {
                const next = await updateCell(props.machine.id, query.source, query.result, selection.id, column, value);
                mutate({ kind: "sql", ...next });
              } finally {
                // A disconnect can hide a committed write; the snapshot must show its invalidation either way.
                setRevision((revision) => revision + 1);
              }
            }} />
          </>;
        }}</Show>
      </Wing>;
    }}</Show>
  </>;
}

/** Keep SQL nullability, datatype, and edit authority independent. */
function Fields(props: { fields: SqlField[]; save: (column: number, value: string | null) => Promise<void> }) {
  const [editing, setEditing] = createSignal<string | null>(null);
  return <dl><For each={props.fields}>{(field) => <div>
    <dt>{field.name}<Show when={field.kind}><small>{field.kind}</small></Show></dt>
    <dd>
      <Show when={field.edit != null} fallback={<Value value={field.value} />}>
        <Show when={editing() === field.name} fallback={
          <button class="cell" aria-label={`Edit ${field.name}`} onClick={() => setEditing(field.name)}><Value value={field.value} /></button>
        }>
          <CellEditor field={field} onDone={() => setEditing(null)} save={props.save} />
        </Show>
      </Show>
    </dd>
  </div>}</For></dl>;
}

/** Distinguish SQL NULL from an empty string in both field previews. */
function Value(props: { value: string | null }) {
  return <Show when={props.value != null} fallback={<i class="null">NULL</i>}>{props.value}</Show>;
}

function CellEditor(props: { field: SqlField; onDone: () => void; save: (column: number, value: string | null) => Promise<void> }) {
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  let input!: HTMLTextAreaElement;
  onMount(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
  async function apply(value: string | null) {
    if (busy() || props.field.edit == null) return;
    if (value === props.field.value) {
      props.onDone();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await props.save(props.field.edit, value);
      props.onDone();
    } catch (cause) {
      setProblem(String(cause));
      setBusy(false);
    }
  }
  return <form class="cell-editor" onSubmit={(event) => { event.preventDefault(); void apply(input.value); }}>
    <textarea ref={input} aria-label={`${props.field.name} value`} value={props.field.value ?? ""} placeholder={props.field.value == null ? "NULL" : undefined}
      spellcheck={false} disabled={busy()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onDone();
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void apply(event.currentTarget.value);
        }
      }} />
    <div class="cell-actions">
      <button type="submit" class="run-button" disabled={busy()}>{busy() ? "Saving…" : "Apply"}</button>
      <button type="button" disabled={busy() || props.field.value == null} onClick={() => { void apply(null); }}>Set NULL</button>
      <button type="button" disabled={busy()} onClick={props.onDone}>Cancel</button>
      <Show when={problem()}><span role="alert">{problem()}</span></Show>
    </div>
  </form>;
}
