import { onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { usePresentations } from "./presentations";

/** Present a focused surface above inert app content, with an outside-click dismissal strip. */
export default function Wing(props: { title: string; onClose: () => void; returnFocus: HTMLElement | null; dismissible?: boolean; children: JSX.Element }) {
  const presentations = usePresentations();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let panel!: HTMLElement;
  let backdrop!: HTMLButtonElement;
  let animations: Animation[] = [];
  let closing = false;

  onMount(() => {
    const pop = presentations.push({
      element: panel, dismiss: close, returnFocus: props.returnFocus,
    });
    onCleanup(pop);
    if (motion.matches) return;
    const options = { duration: 180, easing: "cubic-bezier(.2, .7, .2, 1)", fill: "both" as const };
    const entrance = panel.animate([{ transform: "translateX(32px)", opacity: 0 }, { transform: "none", opacity: 1 }], options);
    const shade = backdrop.animate([{ opacity: 0 }, { opacity: 1 }], options);
    animations = [entrance, shade];
    entrance.onfinish = () => { if (closing) props.onClose(); };
  });
  onCleanup(() => {
    for (const animation of animations) animation.cancel();
  });

  function close() {
    if (closing || props.dismissible === false) return;
    closing = true;
    if (motion.matches || animations.length === 0) {
      props.onClose();
      return;
    }
    // Reversing from the current position; keeping the background inert until the Wing leaves.
    for (const animation of animations) animation.reverse();
  }

  return <Portal mount={presentations.host}><div class="wing-layer" inert={presentations.top()?.element !== panel}>
    <button class="wing-backdrop" ref={backdrop} tabIndex={-1} aria-label={`Dismiss ${props.title}`} onClick={close} onWheel={(event) => event.preventDefault()} />
    <section class="wing" ref={panel} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1}>
      <div class="wing-content" tabIndex={0} role="region" aria-label={`${props.title} content`}>{props.children}</div>
    </section>
  </div></Portal>;
}
