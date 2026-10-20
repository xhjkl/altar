import { createMemo, createResource, createSignal, Show } from "solid-js";
import { metrics, type Machine } from "./bridge";
import Icon from "./icon";

export default function Vitals(props: { machine: Machine; tick: number; collapsed: boolean }) {
  const [expanded, setExpanded] = createSignal(!props.collapsed);
  const sample = createMemo(() => Math.floor(props.tick / 3) * 3);
  const [value, { refetch }] = createResource(
    () => expanded() && { machine: props.machine.id, tick: sample() },
    ({ machine, tick }) => metrics(machine, tick),
  );
  const current = () => {
    if (value.error) return null;
    const sample = value();
    // Keeping refreshes visible only for the machine that owns the retained sample.
    return sample?.machine === props.machine.id ? sample : null;
  };

  return <aside class="vitals-floater" aria-label="Machine vitals">
    <button class="floater-heading disclosure" classList={{ expanded: expanded() }}
      aria-label={`${expanded() ? "Collapse" : "Expand"} vitals for ${props.machine.name}`}
      aria-expanded={expanded()} aria-controls="vitals-content" onClick={() => setExpanded(!expanded())}
    >
      <Icon name="chevron" size={12} /><span>{props.machine.name}</span>
    </button>
    <div id="vitals-content" class="vitals-content" hidden={!expanded()}>
      <Show when={value.error}><p role="alert">{String(value.error)} <button onClick={() => { void refetch(); }}>Retry</button></p></Show>
      <Show when={current()} fallback={<Show when={value.loading}><p class="floater-status">Loading…</p></Show>}>{(value) => <>
        <Show when={value().lastSample}>{(age) => <p class="floater-status">Last sample · {age()}</p>}</Show>
        <div class="metric"><span>CPU <small>{value().cpuCores} cores</small></span><span>{value().cpu[value().cpu.length - 1]}%</span></div>
        <Sparkline values={value().cpu} />
        <div class="metric">
          <span>Memory <small>of {value().memoryGb} GB</small></span>
          <span>{(value().memory[value().memory.length - 1] * value().memoryGb / 100).toFixed(1)} GB</span>
        </div>
        <Sparkline values={value().memory} />
        <div class="metric"><span>Disk <small>of {value().diskGb} GB</small></span><span>{value().disk}%</span></div>
        <div class="disk-track"><div style={{ width: `${value().disk}%` }} /></div>
        <div class="floater-footer"><span>Uptime</span><span>{value().uptime}</span></div>
      </>}</Show>
    </div>
  </aside>;
}

/** Plot percentages within a four-pixel vertical inset. */
function Sparkline(props: { values: number[] }) {
  const points = createMemo(() => props.values.map((value, index) =>
    `${index * 248 / Math.max(1, props.values.length - 1)},${56 - value * .52}`,
  ).join(" "));
  return <svg class="sparkline" viewBox="0 0 248 60" preserveAspectRatio="none" aria-hidden="true">
    <path class="chart-rule" d="M0 20h248M0 40h248" />
    <polygon points={`0,60 ${points()} 248,60`} /><polyline points={points()} />
  </svg>;
}
