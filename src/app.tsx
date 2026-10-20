import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { discoverSql, workspace, type Scene, type Selection, type Workspace } from "./bridge";
import Icon from "./icon";
import { Presentations } from "./presentations";
import Sidebar from "./sidebar";
import Vitals from "./vitals";
import Workbench from "./workbench";
import "./app.css";

export default function App(props: { scene?: Scene }) {
  const [data, { refetch }] = createResource(() => workspace(props.scene ?? null));
  return <Show when={!data.error && data()} fallback={
    <div class="empty-state"><Show when={data.error} fallback={<p>Opening workspace…</p>}>
      <p role="alert">{String(data.error)}</p><button onClick={() => { void refetch(); }}>Retry</button>
    </Show></div>
  }>{(data) => <Shell workspace={data()} live={props.scene == null} compact={props.scene === "compact"} />}</Show>;
}

/** Own navigation and the fixture clock; each selected view owns its own workbench session. */
function Shell(props: { workspace: Workspace; live: boolean; compact: boolean }) {
  const { machines, selection: initial, tick: initialTick, pausedAt, inspect } = props.workspace;
  const [state, setState] = createStore({ machines });
  const machine = state.machines.find((machine) => machine.id === initial.machine);
  const view = machine?.views.find((view) => view.id === initial.view);
  if (machine == null || view == null) throw new Error("The initial workbench must belong to a machine.");
  const initialSelection = { machine, view };
  // Keeping the mounted query session when the active navigation entry is selected again.
  const [selection, setSelection] = createSignal<Selection>(initialSelection, {
    equals: (a, b) => a.machine === b.machine && a.view === b.view,
  });
  const [sidebar, setSidebar] = createSignal(true);
  const [tick, setTick] = createSignal(initialTick);

  const [discovered] = createResource(() => props.live && selection().machine.id, discoverSql);
  createEffect(() => {
    if (discovered.error) return;
    const machine = discovered();
    if (machine == null) return;
    // Reconciling IDs preserves the selected workbench while discovered views arrive.
    setState("machines", (existing) => existing.id === machine.id, reconcile(machine));
  });

  onMount(() => {
    const timer = window.setInterval(() => {
      if (selection().machine.online) setTick((tick) => tick + 1);
    }, 1500);
    onCleanup(() => clearInterval(timer));
  });

  return <div class="app" classList={{ "sidebar-hidden": !sidebar() }}>
    <Presentations>{(presentations) => <>
      <button class="sidebar-toggle icon-button" inert={presentations.top() != null}
        aria-label={sidebar() ? "Hide sidebar" : "Show sidebar"} aria-expanded={sidebar()} aria-controls="machines-sidebar"
        onClick={() => setSidebar(!sidebar())}
      ><Icon name="panel" /></button>
      <Sidebar machines={state.machines} selection={selection()} hidden={!sidebar()} blocked={presentations.top() != null}
        onSelect={setSelection}
      />
      <main class="workspace" inert={presentations.top() != null}>
        <Show keyed when={selection()}>{(selected) =>
          <Workbench selection={selected} tick={tick()}
            initialPausedAt={selected === initialSelection ? pausedAt : null}
            initialInspect={selected === initialSelection ? inspect : null}
          />
        }</Show>
        <Vitals machine={selection().machine} tick={tick()} collapsed={props.compact} />
      </main>
    </>}</Presentations>
  </div>;
}
