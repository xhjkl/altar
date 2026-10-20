import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Backend, liveBackend, fixtureBackend, fixtureWorkspace, connectMachine, discoverSql, machineStatus, workspace, type Machine, type Scene, type Selection, type Workspace } from "./bridge";
import Icon from "./icon";
import { Presentations } from "./presentations";
import Sidebar from "./sidebar";
import Vitals from "./vitals";
import Workbench from "./workbench";
import Wing from "./wing";
import "./app.css";

export default function App(props: { scene?: Scene }) {
  const [data, { refetch }] = createResource(() => props.scene == null ? workspace() : fixtureWorkspace(props.scene));
  return <Show when={!data.error && data()} fallback={
    <div class="empty-state"><Show when={data.error} fallback={<p>Opening workspace…</p>}>
      <h2>Couldn’t open your machines</h2>
      <p role="alert">{String(data.error)}</p><button onClick={() => { void refetch(); }}>Retry</button>
    </Show></div>
  }>{(data) => <Shell workspace={data()} scene={props.scene ?? null} />}</Show>;
}

/** Own navigation and the fixture clock; each selected view owns its own workbench session. */
function Shell(props: { workspace: Workspace; scene: Scene | null }) {
  const { machines, selection: initial } = props.workspace;
  const live = props.scene == null;
  const initialTick = props.scene === "paused" ? 18 : 0;
  const pausedAt = props.scene === "paused" || props.scene === "inspect" ? 0 : null;
  const inspect = props.scene === "inspect" ? 6 : null;
  const [state, setState] = createStore({ machines });
  const machine = state.machines.find((machine) => machine.id === initial?.machine);
  const initialSelection = machine == null ? null : { machine, view: machine.views.find((view) => view.id === initial?.view) ?? null };
  // Keeping the mounted query session when the active navigation entry is selected again.
  const [selection, setSelection] = createSignal<Selection | null>(initialSelection, {
    equals: (a, b) => a?.machine === b?.machine && a?.view === b?.view,
  });
  const [sidebar, setSidebar] = createSignal(true);
  const [connecting, setConnecting] = createSignal<HTMLElement | null>(null);
  const [tick, setTick] = createSignal(initialTick);

  const [discovered, { refetch }] = createResource(() => live && selection()?.machine.id, discoverSql);
  const statusTick = createMemo(() => Math.floor(tick() / 2));
  const machineIds = createMemo(() => state.machines.map((machine) => machine.id));
  const [status] = createResource(() => live && machineIds().length > 0 && {
    machines: machineIds(), tick: statusTick(),
  }, ({ machines }) => Promise.all(machines.map(async (machine) => {
    const connection = await machineStatus(machine);
    return { machine, connection };
  })));
  createEffect(() => {
    if (status.error) return;
    const current = status();
    if (current == null) return;
    for (const { machine, connection } of current) {
      setState("machines", (existing) => existing.id === machine, "connection", connection);
    }
  });
  createEffect(() => {
    if (!live || !discovered.error || discovered.loading) return;
    const timer = window.setTimeout(() => { void refetch(); }, 5000);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    if (discovered.error) return;
    const machine = discovered();
    if (machine == null) return;
    // Reconciling IDs preserves the selected workbench while discovered views arrive.
    const connection = state.machines.find((existing) => existing.id === machine.id)?.connection ?? machine.connection;
    setState("machines", (existing) => existing.id === machine.id, reconcile({ ...machine, connection }));
    const selected = selection();
    if (selected?.machine.id !== machine.id || selected.view != null) return;
    const view = selected.machine.views[0];
    if (view != null) setSelection({ machine: selected.machine, view });
  });

  onMount(() => {
    const timer = window.setInterval(() => {
      if (live || selection()?.machine.connection === "connected") setTick((tick) => tick + 1);
    }, 1500);
    onCleanup(() => clearInterval(timer));
  });

  function openConnection() {
    const focused = document.activeElement;
    setConnecting(focused instanceof HTMLElement ? focused : document.body);
  }

  function connected(machine: Machine) {
    if (state.machines.some((existing) => existing.id === machine.id)) {
      setState("machines", (existing) => existing.id === machine.id, reconcile(machine));
    } else {
      setState("machines", (machines) => [...machines, machine]);
    }
    const saved = state.machines.find((existing) => existing.id === machine.id)!;
    setSelection({ machine: saved, view: saved.views[0] ?? null });
    setSidebar(true);
    setConnecting(null);
  }

  return <div class="app" classList={{ "sidebar-hidden": !sidebar() }}>
    <Backend.Provider value={live ? liveBackend : fixtureBackend(tick)}><Presentations>{(presentations) => <>
      <button class="sidebar-toggle icon-button" inert={presentations.top() != null}
        aria-label={sidebar() ? "Hide sidebar" : "Show sidebar"} aria-expanded={sidebar()} aria-controls="machines-sidebar"
        onClick={() => setSidebar(!sidebar())}
      ><Icon name="panel" /></button>
      <Sidebar machines={state.machines} selection={selection()} hidden={!sidebar()} blocked={presentations.top() != null}
        onSelect={(next) => {
          const previous = selection()?.machine.id;
          setSelection(next);
          if (live && next.machine.id === previous) void refetch();
        }} onNew={live ? openConnection : null}
      />
      <main class="workspace" inert={presentations.top() != null}>
        <Show keyed when={selection()}>{(selected) => <>
          <Show keyed when={selected.view} fallback={
            <div class="empty-state welcome">
              <h2>{selected.machine.name}</h2>
              <Show when={!discovered.loading} fallback={<p role="status">Looking for PostgreSQL databases…</p>}>
                <Show when={discovered.error} fallback={<p>No PostgreSQL databases found on this machine.</p>}>
                  <p role="alert">{String(discovered.error)}</p>
                  <small role="status">Retrying…</small>
                </Show>
              </Show>
            </div>
          }>{(view) => <Workbench selection={{ machine: selected.machine, view }} tick={tick()}
            initialPausedAt={selected === initialSelection ? pausedAt : null}
            initialInspect={selected === initialSelection ? inspect : null}
          />}</Show>
          <Vitals machine={selected.machine} tick={tick()} collapsed={props.scene === "compact"} />
        </>}</Show>
      </main>
      <Show when={connecting()}>{(opener) =>
        <NewMachine localHostname={props.workspace.localHostname} returnFocus={opener()} onClose={() => setConnecting(null)} onConnected={connected} />
      }</Show>
    </>}</Presentations></Backend.Provider>
  </div>;
}

function NewMachine(props: { localHostname: string; returnFocus: HTMLElement; onClose: () => void; onConnected: (machine: Machine) => void }) {
  const [destination, setDestination] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  let input!: HTMLInputElement;

  async function connect(destination: string | null) {
    if (busy()) return;
    setBusy(true);
    setProblem(null);
    try {
      const machine = await connectMachine(destination);
      props.onConnected(machine);
    } catch (cause) {
      setProblem(String(cause));
      setBusy(false);
      input.focus();
    }
  }

  return <Wing title="New Machine" returnFocus={props.returnFocus} onClose={props.onClose} dismissible={!busy()}>
    <form class="connect-machine" aria-label="Connect a machine" aria-busy={busy()} onSubmit={(event) => {
      event.preventDefault();
      const address = destination().trim();
      void connect(address || null);
    }}>
      <h2>New Machine</h2>
      <input ref={input} name="destination" aria-label="SSH destination" autofocus autocomplete="off" spellcheck={false}
        placeholder={props.localHostname} value={destination()} disabled={busy()}
        onInput={(event) => { setDestination(event.currentTarget.value); setProblem(null); }}
      />
      <Show when={problem()}><p class="connection-error" role="alert">{problem()}</p></Show>
      <div class="connection-actions">
        <button class="run-button" type="submit" disabled={busy()}>{busy() ? "Connecting…" : "Connect"}</button>
        <button type="button" disabled={busy()} onClick={props.onClose}>Cancel</button>
      </div>
    </form>
  </Wing>;
}
