import { createSignal, Show } from "solid-js";
import { Presentations } from "../presentations";
import Wing from "../wing";

/** Exercise stacked, interrupted, and out-of-order dismissal through the real presentation components. */
export default function PresentationFixture() {
  const [first, setFirst] = createSignal(false);
  const [second, setSecond] = createSignal(false);
  let opener!: HTMLButtonElement;
  let nestedOpener!: HTMLButtonElement;
  return <div class="app"><Presentations>{(presentations) => <>
    <div class="presentation-exercise" inert={presentations.top() != null}>
      <h2>Presentation stack</h2>
      <p>Escape and outside clicks dismiss the top Wing. Tab stays inside it.</p>
      <button ref={opener} onClick={() => setFirst(true)}>Open first Wing</button>
    </div>
    <Show when={first()}><Wing title="First Wing" returnFocus={opener} onClose={() => setFirst(false)}>
      <h2>First Wing</h2>
      <p>Dismiss the second Wing to return focus here.</p>
      <button ref={nestedOpener} onClick={() => setSecond(true)}>Open second Wing</button>
    </Wing></Show>
    <Show when={second()}><Wing title="Second Wing" returnFocus={nestedOpener} onClose={() => setSecond(false)}>
      <h2>Second Wing</h2>
      <p>The first Wing stays inert until this one leaves.</p>
      <button onClick={() => setFirst(false)}>Unmount the lower Wing</button>
      <button onClick={() => { setSecond(false); setFirst(false); }}>Unmount both Wings</button>
    </Wing></Show>
  </>}</Presentations></div>;
}
