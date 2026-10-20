import { createEffect, createSignal, For } from "solid-js";
import type { Machine, Selection } from "./bridge";
import Icon from "./icon";

export default function Sidebar(props: {
  machines: Machine[];
  selection: Selection | null;
  hidden: boolean;
  blocked: boolean;
  onSelect: (selection: Selection) => void;
  onNew: (() => void) | null;
}) {
  return <aside id="machines-sidebar" class="sidebar" aria-label="Machines and workbenches" inert={props.hidden || props.blocked}>
    <div class="sidebar-label" data-tauri-drag-region>Machines</div>
    <nav class="machine-list" aria-label="Machines">
      <button class="new-machine" classList={{ active: props.machines.length === 0 }} disabled={props.onNew == null} onClick={() => props.onNew?.()}><Icon name="plus" size={16} /><span>New Machine</span></button>
      <For each={props.machines}>{(machine) => {
        const [expanded, setExpanded] = createSignal(props.selection?.machine === machine);
        createEffect(() => {
          if (props.selection?.machine === machine) setExpanded(true);
        });
        return <section class="machine-group">
          <button class="machine-name disclosure" aria-label={`${expanded() ? "Collapse" : "Expand"} ${machine.name}`} aria-expanded={expanded()} aria-controls={`views-${machine.id}`} onClick={() => setExpanded(!expanded())}>
            <i class="status-dot" classList={{ reconnecting: machine.connection !== "connected" }} aria-label={machine.connection === "connected" ? "Connected" : machine.connection === "connecting" ? "Connecting" : "Reconnecting"} title={machine.connection === "connected" ? "Connected" : machine.connection === "connecting" ? "Connecting…" : "Reconnecting…"} />
            <span>{machine.name}</span>
            <Icon name="chevron" size={12} />
          </button>
          <div id={`views-${machine.id}`} class="workbenches" hidden={!expanded()}>
            <For each={machine.views}>{(view) => {
              const active = () => props.selection?.machine === machine && props.selection.view === view;
              return <button class="bookmark" aria-current={active() ? "page" : false} onClick={() => props.onSelect({ machine, view })}>
                <span>{view.name}</span>
              </button>;
            }}</For>
          </div>
        </section>;
      }}</For>
    </nav>
  </aside>;
}
