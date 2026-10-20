import { createContext, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js";

type Presentation = {
  element: HTMLElement;
  dismiss: () => void;
  returnFocus: HTMLElement | null;
};

type PresentationScope = {
  host: HTMLElement;
  top: () => Presentation | null;
  push: (presentation: Presentation) => () => void;
};

const Context = createContext<PresentationScope>();

/** Scope a stack of presentations to an app, including keyboard and focus ownership. */
export function Presentations(props: { children: (scope: PresentationScope) => JSX.Element }) {
  const [stack, setStack] = createSignal<Presentation[]>([]);
  const host = document.createElement("div");
  host.className = "presentations";
  const top = () => stack()[stack().length - 1] ?? null;

  /** Capture focus for a mounted surface and return its idempotent, order-independent pop handle. */
  function push(options: Presentation) {
    const focused = document.activeElement;
    const presentation = {
      ...options,
      returnFocus: options.returnFocus ?? (focused instanceof HTMLElement ? focused : null),
    };
    setStack((entries) => [...entries, presentation]);
    // Waiting for the new top layer to lose inert before moving keyboard focus into it.
    queueMicrotask(() => {
      if (top() === presentation) presentation.element.focus({ preventScroll: true });
    });
    return () => {
      if (!stack().includes(presentation)) return;
      const wasTop = top() === presentation;
      // Bypassing removed focus destinations when a lower layer unmounts before its child.
      for (const entry of stack()) {
        if (entry.returnFocus != null && presentation.element.contains(entry.returnFocus)) {
          entry.returnFocus = presentation.returnFocus;
        }
      }
      setStack((entries) => entries.filter((entry) => entry !== presentation));
      if (!wasTop) return;
      // Waiting for inert bindings to settle; removing a lower layer never steals focus.
      const exposed = top();
      queueMicrotask(() => {
        if (top() !== exposed) return;
        const target = presentation.returnFocus;
        if (target?.isConnected && !target.closest("[inert]") && (exposed == null || exposed.element.contains(target))) {
          target.focus({ preventScroll: true });
          return;
        }
        exposed?.element.focus({ preventScroll: true });
      });
    };
  }

  function keydown(event: KeyboardEvent) {
    const presentation = top();
    if (presentation == null || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      presentation.dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = presentation.element;
    const elements = panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]');
    const controls = [...elements].filter((element) => {
      const visible = element.getClientRects();
      const style = getComputedStyle(element);
      return element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]")
        && visible.length > 0 && style.visibility === "visible";
    });
    const focused = document.activeElement;
    const first = controls[0] ?? panel;
    const last = controls[controls.length - 1] ?? panel;
    if (focused === panel || !panel.contains(focused) || (event.shiftKey ? focused === first : focused === last)) {
      event.preventDefault();
      const target = event.shiftKey ? last : first;
      target.focus({ preventScroll: true });
    }
  }

  onMount(() => {
    window.addEventListener("keydown", keydown);
    onCleanup(() => window.removeEventListener("keydown", keydown));
  });
  const scope = { host, top, push };
  return <Context.Provider value={scope}>{props.children(scope)}{host}</Context.Provider>;
}

/** Require the nearest presentation scope, keeping independent app fixtures isolated. */
export function usePresentations() {
  const context = useContext(Context);
  if (context == null) throw new Error("Presentations must enclose this component.");
  return context;
}
