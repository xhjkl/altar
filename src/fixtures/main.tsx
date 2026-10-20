import { createSignal, For, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import App from "../app";
import type { Scene } from "../bridge";
import PresentationFixture from "./presentations";
import "./fixtures.css";

type FixtureScene = Scene | "presentations";
const scenes: { id: FixtureScene; name: string }[] = [
  { id: "live", name: "Live tail" },
  { id: "paused", name: "Paused tail" },
  { id: "inspect", name: "Event inspector" },
  { id: "sql", name: "SQL workbench" },
  { id: "offline", name: "Offline history" },
  { id: "empty", name: "No matches" },
  { id: "compact", name: "Compact" },
  { id: "presentations", name: "Presentations" },
];

function Fixtures() {
  function readScene() {
    const hash = window.location.hash;
    return scenes.find((scene) => scene.id === hash.slice(1))?.id ?? "live";
  }
  const [scene, setScene] = createSignal<FixtureScene>(readScene());
  const [appearance, setAppearance] = createSignal("light dark");
  const sync = () => setScene(readScene());
  window.addEventListener("hashchange", sync);
  onCleanup(() => window.removeEventListener("hashchange", sync));

  return <div class="fixture-shell" style={{ "color-scheme": appearance() }}>
    <div class="fixture-bar" data-tauri-drag-region>
      <span>Scenes</span>
      <For each={scenes}>{(item) => <button aria-current={scene() === item.id ? "page" : false} onClick={() => { window.location.hash = item.id; }}>{item.name}</button>}</For>
      <select aria-label="Appearance" value={appearance()} onChange={(event) => setAppearance(event.currentTarget.value)}>
        <option value="light dark">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select>
      <a href="/src/fixtures/checks.html">Browser checks</a>
    </div>
    <div class="fixture-stage" classList={{ compact: scene() === "compact" }}>
      <Show keyed when={scene()}>{(scene) => scene === "presentations" ? <PresentationFixture /> : <App scene={scene} />}</Show>
    </div>
  </div>;
}

render(() => <Fixtures />, document.getElementById("root")!);
