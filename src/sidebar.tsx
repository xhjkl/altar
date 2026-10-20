import { createSignal, For } from "solid-js";
import type { Machine, Selection, View } from "./bridge";
import Icon from "./icon";

export default function Sidebar(props: {
  machines: Machine[];
  selection: Selection;
  hidden: boolean;
  blocked: boolean;
  onSelect: (selection: Selection) => void;
}) {
  return <aside id="machines-sidebar" class="sidebar" aria-label="Machines and workbenches" inert={props.hidden || props.blocked}>
    <div class="sidebar-label" data-tauri-drag-region>Machines</div>
    <nav class="machine-list" aria-label="Machines">
      <For each={props.machines}>{(machine) => {
        const [expanded, setExpanded] = createSignal(props.selection.machine === machine);
        function select(view: View) {
          setExpanded(true);
          props.onSelect({ machine, view });
        }
        return <section class="machine-group">
          <button class="machine-name" onClick={() => {
            const first = machine.views[0];
            if (first != null) select(first);
          }}>
            <i class="status-dot" classList={{ offline: !machine.online }} aria-label={machine.online ? "Connected" : "Offline"} />
            <span>{machine.name}</span>
          </button>
          <button class="disclosure icon-button" classList={{ expanded: expanded() }} aria-label={`${expanded() ? "Collapse" : "Expand"} ${machine.name}`} aria-expanded={expanded()} aria-controls={`views-${machine.id}`} onClick={() => setExpanded(!expanded())}>
            <Icon name="chevron" size={12} />
          </button>
          <div id={`views-${machine.id}`} class="workbenches" hidden={!expanded()}>
            <For each={machine.views}>{(view) => {
              const active = () => props.selection.machine === machine && props.selection.view === view;
              return <button class="bookmark" classList={{ active: active() }} aria-current={active() ? "page" : false} onClick={() => select(view)}>
                <span>{view.name}</span>
              </button>;
            }}</For>
          </div>
        </section>;
      }}</For>
    </nav>
  </aside>;
}
