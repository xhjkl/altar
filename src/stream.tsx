import { createEffect, createMemo, createSignal, useContext, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Backend, type Frame, type Content } from "./bridge";
import { createFrameRequests } from "./frame-requests";
import Icon from "./icon";

/** Render a bounded Rust frame. Scrolling, breathers, and tail following are independent of row content. */
export default function Stream(props: {
  machine: string;
  query: Content;
  tick: number;
  live: boolean;
  /** Bumped when rows changed behind the frame, such as after a cell edit. */
  revision: number;
  initialPausedAt: number | null;
  selected: number | null;
  label: string;
  onInspect: (id: number, viewport: HTMLElement) => void;
  empty: JSX.Element;
  children: JSX.Element;
}) {
  const backend = useContext(Backend);
  const [state, setState] = createStore<{ frame: Frame | null }>({ frame: null });
  const [pausedAt, setPausedAt] = createSignal(props.initialPausedAt);
  const [error, setError] = createSignal<string | null>(null);
  const following = () => props.live && pausedAt() == null;
  const [compact, setCompact] = createSignal(false);
  const columns = createMemo(() => (state.frame?.columns ?? []).map((column, index) => ({ ...column, index }))
    .filter((column) => !compact() || (column.kind !== "unit" && column.kind !== "duration")));
  const tracks = createMemo(() => columns().map((column) => column.kind === "value"
    ? `minmax(${column.characters}ch, ${column.characters}fr)` : `var(--column-${column.kind})`).join(" ") || "1fr");
  const minWidth = createMemo(() => {
    const values = columns().filter((column) => column.kind === "value");
    if (values.length === 0) return "100%";
    const characters = values.reduce((sum, column) => sum + column.characters, 0);
    return `calc(${characters}ch + ${values.length - 1} * var(--column-gap) + 2 * var(--table-padding))`;
  });
  const [scrollLeft, setScrollLeft] = createSignal(0);
  let viewport!: HTMLDivElement;
  let chrome!: HTMLDivElement;
  let displayedTick = props.tick;
  let expectedTop = 0;
  let revealTail = following();

  const requests = createFrameRequests({
    read() {
      const style = getComputedStyle(viewport);
      setCompact(style.getPropertyValue("--compact-columns").trim() === "1");
      const bounds = {
        top: revealTail ? null : viewport.scrollTop,
        height: viewport.clientHeight, insetTop: chrome.offsetHeight,
        rowHeight: Number.parseFloat(style.getPropertyValue("--row-height")),
        paddingTop: Number.parseFloat(style.getPropertyValue("--padding-top")),
        paddingBottom: Number.parseFloat(style.getPropertyValue("--padding-bottom")),
        overscan: 3,
      };
      // Consuming tail intent at dispatch; a tick arriving during IPC can request the next tail.
      revealTail = false;
      return {
        machine: props.machine, query: props.query,
        pausedAt: props.live ? pausedAt() : null, viewport: bounds,
      };
    },
    render: backend.renderFrame,
    accept(frame, request) {
      // Reconciling one canonical frame; stable row IDs retain their DOM nodes as the window moves.
      setState("frame", reconcile(frame, { key: "id" }));
      setError(null);
      displayedTick = request.pausedAt ?? frame.tick;
      expectedTop = frame.window.scrollTop;
      // Preserving native gestures; only a tail request or Rust's clamping moves the viewport.
      if (request.viewport.top == null || expectedTop !== request.viewport.top) viewport.scrollTop = expectedTop;
    },
    reject: (cause) => setError(String(cause)),
  });

  function pause() {
    if (!following()) return;
    setPausedAt(displayedTick);
  }

  function follow() {
    setPausedAt(null);
    revealTail = true;
    viewport.focus({ preventScroll: true });
    requests.invalidate();
  }

  function scroll() {
    setScrollLeft(viewport.scrollLeft);
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const top = viewport.scrollTop;
    // Ignoring browser clamping after layout changes; only navigation pauses the tail.
    if (Math.abs(top - Math.min(expectedTop, maxTop)) < 1) return;
    revealTail = false;
    const window = state.frame?.window;
    const tailVisible = window?.tailTop != null
      && top + viewport.clientHeight > window.tailTop
      && top + chrome.offsetHeight < window.tailTop + window.rowHeight;
    if (props.live && tailVisible) setPausedAt(null);
    else pause();
    requests.invalidate();
  }

  createEffect(on(() => props.query, () => {
    setState("frame", null);
    setError(null);
    displayedTick = props.tick;
    expectedTop = 0;
    viewport.scrollTop = 0;
    revealTail = following();
    requests.invalidate();
  }));
  createEffect(on(() => props.tick, () => {
    if (!props.live) return;
    revealTail = following();
    requests.refresh();
  }));
  createEffect(on(() => props.revision, () => requests.invalidate(), { defer: true }));
  onMount(() => {
    const observer = new ResizeObserver(() => { revealTail = following(); requests.invalidate(); });
    observer.observe(viewport);
    observer.observe(chrome);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(requests.dispose);

  return <>
    <div class="top-chrome" ref={chrome}>
      <header class="topbar" data-tauri-drag-region>{props.children}</header>
      <div class="column-head" style={{ "grid-template-columns": tracks(), "--min-width": minWidth(), transform: `translateX(${-scrollLeft()}px)` }}>
        <For each={columns()}>{(column) => <span>{column.name}</span>}</For>
      </div>
    </div>
    <div class="viewport" ref={viewport} tabIndex={0} aria-label={props.label} onScroll={scroll}
      onKeyDown={(event) => {
        if (event.key !== "End" || !props.live) return;
        event.preventDefault();
        follow();
      }}
    >
      <div class="scroll-space" style={{ height: `${state.frame?.window.totalHeight ?? 0}px` }}>
        <div class="rendered-rows" style={{
          transform: `translateY(${state.frame?.window.offset ?? 0}px)`,
          "--columns": tracks(),
          "--min-width": minWidth(),
        }}>
          <For each={state.frame?.rows}>{(row) =>
            <button class="data-row" data-tone={row.tone}
              aria-pressed={props.selected === row.id} aria-label={`Inspect ${columns().map((column) => row.cells[column.index]).join(" · ")}`}
              onClick={() => {
                pause();
                props.onInspect(row.id, viewport);
                requests.invalidate();
              }}
            >
              <For each={columns()}>{(column) => <span data-kind={column.kind}>
                {column.kind === "severity" ? "●" : row.cells[column.index]}
              </span>}</For>
            </button>
          }</For>
        </div>
      </div>
      <Show when={state.frame?.total === 0}><div class="empty-state">{props.empty}</div></Show>
      <Show when={state.frame == null && error() == null}><div class="empty-state"><p>Loading…</p></div></Show>
    </div>
    <Show when={props.live && !following()}>
      <button class="tail-floater" aria-label={`${state.frame?.pending ?? 0} more. Follow live`} onClick={follow}>
        <span>+{(state.frame?.pending ?? 0).toLocaleString()}</span><Icon name="down" size={16} />
      </button>
    </Show>
    <Show when={state.frame?.notice}><div class="error-banner" role="status">{state.frame?.notice}</div></Show>
    <Show when={error()}><div class="error-banner" role="alert">{error()}<button onClick={requests.refresh}>Retry</button></div></Show>
  </>;
}
