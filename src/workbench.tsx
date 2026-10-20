import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { inspectRow, updateCell, type Field, type Query, type Selection } from "./bridge";
import Icon from "./icon";
import { usePresentations } from "./presentations";
import Stream from "./stream";
import Wing from "./wing";

/** Own a machine view's query session; changing the navigation selection mounts a fresh session. */
export default function Workbench(props: {
  selection: Selection;
  tick: number;
  initialPausedAt: number | null;
  initialInspect: number | null;
}) {
  const { machine, view } = props.selection;
  const presentations = usePresentations();
  const [query, setQuery] = createSignal<Query>(view.query);
  // Retaining unsubmitted SQL separately; log edits apply directly to the canonical query.
  const [draft, setDraft] = createSignal(view.query.kind === "sql" ? view.query.statement : "");
  const [inspection, setInspection] = createSignal<{ id: number; returnFocus: HTMLElement | null } | null>(
    props.initialInspect == null ? null : { id: props.initialInspect, returnFocus: null },
  );
  // Counting edits that changed rows behind the current frame.
  const [revision, setRevision] = createSignal(0);
  const sql = view.query.kind === "sql";
  const expression = () => {
    const value = query();
    return value.kind === "sql" ? draft() : value.filter;
  };
  let search!: HTMLInputElement;

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (presentations.top() != null || !(event.metaKey || event.ctrlKey) || event.key !== "k") return;
      event.preventDefault();
      search.focus({ preventScroll: true });
      search.select();
    };
    window.addEventListener("keydown", keydown);
    onCleanup(() => window.removeEventListener("keydown", keydown));
  });

  return <>
    <Stream machine={machine.id} query={query()} tick={props.tick} live={!sql && machine.online} revision={revision()}
      initialPausedAt={props.initialPausedAt} selected={inspection()?.id ?? null} label={sql ? "Query rows" : "Log events"}
      onInspect={(id, returnFocus) => setInspection({ id, returnFocus })}
      empty={<><Icon name="search" size={24} /><h2>{sql ? "No rows" : "No matching events"}</h2><p>{sql ? "Type a statement and press Enter." : "Try a different expression."}</p><Show when={!sql}><button onClick={() => setQuery({ kind: "logs", filter: "" })}>Clear search</button></Show></>}
    >
      <form class="pathbar" aria-label="Workbench path" data-tauri-drag-region onSubmit={(event) => {
        event.preventDefault();
        const current = query();
        if (current.kind === "sql") setQuery({ ...current, statement: draft(), run: current.run + 1 });
        else setQuery({ ...current });
      }}>
        <span class="slash" data-tauri-drag-region>/</span>
        <span class="path-machine" data-tauri-drag-region>{machine.name}</span>
        <span class="slash" data-tauri-drag-region>/</span>
        <input ref={search} aria-label={sql ? "SQL query" : "Search expression"} placeholder={sql ? "select …" : "*"} spellcheck={false} value={expression()} onInput={(event) => {
          const expression = event.currentTarget.value;
          if (sql) setDraft(expression);
          else setQuery({ kind: "logs", filter: expression });
        }} />
        <Show when={sql} fallback={<kbd data-tauri-drag-region>⌘ K</kbd>}><button class="run-button" type="submit" aria-label="Run query"><Icon name="play" size={12} />Run</button></Show>
      </form>
    </Stream>
    <Show keyed when={inspection()}>{(selection) =>
      <Inspection machine={machine.id} query={query()} id={selection.id} returnFocus={selection.returnFocus}
        onClose={() => setInspection(null)} onEdited={() => setRevision((revision) => revision + 1)} />
    }</Show>
  </>;
}

/** Load inspection inside its presentation, so dismissal also ends ownership of the request. */
function Inspection(props: { machine: string; query: Query; id: number; returnFocus: HTMLElement | null; onClose: () => void; onEdited: () => void }) {
  const [detail, { refetch, mutate }] = createResource(() => inspectRow(props.machine, props.query, props.id));
  return <Wing title={props.query.kind === "sql" ? "Row inspector" : "Journal entry"} onClose={props.onClose} returnFocus={props.returnFocus}>
    <Show when={detail.error}><p role="alert">{String(detail.error)} <button onClick={() => { void refetch(); }}>Retry</button></p></Show>
    <Show when={!detail.error && detail()} fallback={<Show when={detail.loading}><p>Loading…</p></Show>}>{(entry) => <>
      <h2 data-tone={entry().tone}>{entry().title}</h2>
      <Fields fields={entry().fields} save={async (field, value) => {
        const next = await updateCell(props.machine, props.query, props.id, field, value);
        mutate(next);
        props.onEdited();
      }} />
      <Show when={entry().trace.length > 0}><section class="trace" aria-label="Trace waterfall">
        <div class="trace-title"><h3>Trace waterfall</h3><span>{entry().trace.length} spans</span></div>
        <For each={entry().trace}>{(span) => <div class="trace-row"><span>{span.name}</span><div class="trace-track"><i style={{ "margin-left": `${span.start}%`, width: `${span.width}%` }} /></div><span>{span.duration}</span></div>}</For>
      </section></Show>
    </>}</Show>
  </Wing>;
}

/** List fields; a writable one opens into an editor whose Apply addresses the row by its key. */
function Fields(props: { fields: Field[]; save: (field: string, value: string | null) => Promise<void> }) {
  const [editing, setEditing] = createSignal<string | null>(null);
  return <dl><For each={props.fields}>{(field) => <div>
    <dt>{field.name}<Show when={field.kind}><small>{field.kind}</small></Show></dt>
    <dd>
      <Show when={field.writable} fallback={<Value value={field.value} />}>
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

function CellEditor(props: { field: Field; onDone: () => void; save: (field: string, value: string | null) => Promise<void> }) {
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  let input!: HTMLTextAreaElement;
  onMount(() => {
    input.focus({ preventScroll: true });
    input.select();
  });

  async function apply(value: string | null) {
    if (busy()) return;
    if (value === props.field.value) {
      props.onDone();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await props.save(props.field.name, value);
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
