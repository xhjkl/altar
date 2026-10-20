import { isTauri } from "@tauri-apps/api/core";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import type { Connection, Machine, Metrics, Selection } from "../bridge";
import App from "../app";
import Vitals from "../vitals";
import Sidebar from "../sidebar";
import PresentationFixture from "./presentations";
import "../app.css";
import "./fixtures.css";

/** Run lifecycle checks against mounted components and real browser layout; IPC is mocked only in the standalone browser. */
function Checks() {
  const [results, setResults] = createSignal<string[]>([]);
  const [running, setRunning] = createSignal(false);
  let stage!: HTMLDivElement;

  function check(name: string, condition: boolean) {
    if (!condition) throw new Error(`${name}; focused: ${document.activeElement?.outerHTML.slice(0, 300)}`);
    setResults((results) => [...results, `Passed: ${name}`]);
  }

  async function settle() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const animations = stage.getAnimations({ subtree: true });
    await Promise.all(animations.map((animation) => animation.finished));
    // Waiting for finish-event callbacks and their focus-restoration microtasks, not only animation promises.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  function button(label: string) {
    const button = [...stage.querySelectorAll("button")].find((button) => button.textContent === label);
    if (button == null) throw new Error(`Missing button: ${label}`);
    return button;
  }

  async function run() {
    setRunning(true);
    setResults([]);
    let dispose = () => {};
    const native = isTauri();
    try {
      const machine: Machine = { id: "grid", name: "A machine with a deliberately long name", connection: "connected", views: [
        { id: "logs", name: "All activity", query: { kind: "logs", filter: "" } },
        { id: "sql", name: "A view with a deliberately long name", query: { kind: "sql", source: "sql", statement: "select 1", run: 0 } },
      ] };
      const [selection, select] = createSignal<Selection>({ machine, view: machine.views[0] });
      dispose = render(() => <div class="app"><Sidebar machines={[machine]} selection={selection()} hidden={false} blocked={false} onSelect={select} onNew={null} /></div>, stage);
      await settle();
      const heading = stage.querySelector<HTMLElement>(".machine-name span")!;
      const labels = [...stage.querySelectorAll<HTMLElement>(".bookmark span")];
      const indicator = stage.querySelector<HTMLElement>(".status-dot")!;
      const chevron = stage.querySelector<HTMLElement>(".machine-group > .disclosure")!;
      const aligned = () => labels.every((label) => Math.abs(label.getBoundingClientRect().left - heading.getBoundingClientRect().left) < .5);
      check("machine and view names share the same grid track", aligned());
      check("connectivity precedes the name and disclosure follows it", indicator.getBoundingClientRect().right < heading.getBoundingClientRect().left && chevron.getBoundingClientRect().left >= heading.getBoundingClientRect().right);
      check("view rows leave the indicator track empty", stage.querySelectorAll(".bookmark svg, .bookmark i").length === 0);
      check("long labels truncate inside the shared tracks", heading.scrollWidth > heading.clientWidth && labels[1].scrollWidth > labels[1].clientWidth);
      button(machine.views[1].name).click();
      check("view selection preserves alignment", selection().view === machine.views[1] && aligned());
      chevron.click();
      check("disclosure collapses its views", stage.querySelector<HTMLElement>(".workbenches")!.hidden === true);
      dispose();

      // Tauri protects its native invoke property; transport mocks run only in the standalone browser.
      if (!native) {
        const saved: Machine[] = [];
        const destinations: (string | null)[] = [];
        let connection!: { resolve: (machine: Machine) => void; reject: (error: string) => void };
        const scans = new Map<string, { resolve: (machine: Machine) => void; reject: (error: string) => void }>();
        mockIPC((command, args) => {
          if (command === "machine_status") return "connected";
          if (command === "workspace") return { localHostname: "Trakktor", machines: [...saved], selection: saved[0] == null ? null : { machine: saved[0].id, view: saved[0].views[0]?.id ?? null }, tick: 0, pausedAt: null, inspect: null };
          if (command === "connect_machine") {
            destinations.push((args as { destination: string | null }).destination);
            return new Promise<Machine>((resolve, reject) => {
              connection = { resolve: (machine) => {
                if (!saved.some((existing) => existing.id === machine.id)) saved.push(machine);
                resolve(machine);
              }, reject };
            });
          }
          if (command === "discover_sql") return new Promise<Machine>((resolve, reject) => scans.set((args as { machine: string }).machine, { resolve, reject }));
          if (command === "render_frame") return { columns: [], rows: [], total: 0, pending: 0, tick: 0,
            window: { rowHeight: 36, offset: 0, scrollTop: 0, totalHeight: 0, tailTop: null } };
          if (command === "metrics") return { machine: (args as { machine: string }).machine, cpu: [10], memory: [10], disk: 10,
            cpuCores: 1, memoryGb: 1, diskGb: 1, uptime: "1h", lastSample: null };
          throw new Error(`Unexpected command: ${command}`);
        });
        dispose = render(() => <App />, stage);
        await settle();
        check("a fresh workspace marks New Machine active and leaves the work area empty", stage.querySelector(".new-machine.active") != null && stage.querySelector("main")?.textContent === "" && stage.querySelector('[role="alert"]') == null);
        const newMachine = button("New Machine");
        check("active New Machine does not steal keyboard focus", document.activeElement !== newMachine);
        newMachine.focus();
        newMachine.click();
        await settle();
        let destination = stage.querySelector<HTMLInputElement>('[name="destination"]')!;
        check("New Machine focuses the SSH destination and traps background interaction", document.activeElement === destination && stage.querySelector("main[inert]") != null);
        check("a blank destination offers the local hostname with Connect enabled", destination.placeholder === "Trakktor" && !destination.required && !button("Connect").disabled && stage.querySelector(".connect-machine label") == null);
        button("Cancel").click();
        await settle();
        check("cancelling returns focus to New Machine", stage.querySelector('[role="dialog"]') == null && document.activeElement === newMachine);
        newMachine.click();
        await settle();
        destination = stage.querySelector<HTMLInputElement>('[name="destination"]')!;
        destination.value = "bad-host";
        destination.dispatchEvent(new Event("input", { bubbles: true }));
        button("Connect").click();
        await settle();
        check("connecting prevents duplicate submissions and dismissal", button("Connecting…").disabled && button("Cancel").disabled && destinations.length === 1);
        connection.reject("Could not resolve hostname bad-host");
        await settle();
        check("a failed SSH connection returns focus to the editable destination and saves no machine", saved.length === 0 && !destination.disabled && document.activeElement === destination && stage.querySelector('[role="alert"]')?.textContent === "Could not resolve hostname bad-host");
        destination.value = " user@server ";
        destination.dispatchEvent(new Event("input", { bubbles: true }));
        button("Connect").click();
        const remote: Machine = { id: "ssh-user@server", name: "server", connection: "connected",
          views: [{ id: "logs", name: "All activity", query: { kind: "logs", filter: "" } }] };
        connection.resolve(remote);
        await settle();
        check("SSH success selects and expands the saved hostname before database discovery finishes", destinations[1] === "user@server" && stage.querySelector('[role="dialog"]') == null && stage.querySelector('[aria-label="Search expression"]') != null && stage.querySelector<HTMLElement>(".workbenches")?.hidden === false);
        scans.get(remote.id)!.resolve(remote);
        await settle();
        button("New Machine").click();
        await settle();
        destination = stage.querySelector<HTMLInputElement>('[name="destination"]')!;
        destination.value = "   ";
        destination.dispatchEvent(new Event("input", { bubbles: true }));
        button("Connect").click();
        const local: Machine = { id: "local", name: "Trakktor", connection: "connected", views: [] };
        connection.resolve(local);
        await settle();
        check("a local machine uses its real hostname and waits for databases without inventing a journal", destinations[2] === null && stage.textContent!.includes("Trakktor") && stage.textContent!.includes("Looking for PostgreSQL") && stage.querySelector('[aria-label="Search expression"]') == null);
        scans.get(local.id)!.reject("Connection interrupted");
        await settle();
        check("database discovery failures schedule an automatic retry", stage.textContent!.includes("Retrying…"));
        await new Promise<void>((resolve) => setTimeout(resolve, 5100));
        scans.get(local.id)!.resolve({ ...local, views: [{ id: "postgres", name: "postgres", query: { kind: "sql", source: "postgres", statement: "select 1", run: 0 } }] });
        await settle();
        check("discovery opens the first database on a machine without logs", stage.querySelector('[aria-label="SQL query"]') != null && button("postgres") != null);
        dispose();
        dispose = render(() => <App />, stage);
        await settle();
        check("reopening a populated workspace lists the saved machines", stage.querySelectorAll(".machine-group").length === 2 && stage.querySelector('[aria-label="Search expression"]') != null);
        dispose();
        clearMocks();

        let onboard!: (machine: Machine) => void;
        let connectivity: Connection = "connected";
        let frames = 0;
        const initial: Machine = { id: "discovery", name: "Trakktor", connection: "connected",
          views: [{ id: "logs", name: "All activity", query: { kind: "logs", filter: "" } }] };
        mockIPC((command) => {
          if (command === "machine_status") return connectivity;
          if (command === "workspace") return { localHostname: "Trakktor", machines: [initial], selection: { machine: initial.id, view: "logs" }, tick: 0, pausedAt: null, inspect: null };
          if (command === "discover_sql") return new Promise<Machine>((resolve) => { onboard = resolve; });
          if (command === "render_frame") {
            frames += 1;
            return { columns: [], rows: [], total: 0, pending: 0, tick: 0,
              window: { rowHeight: 36, offset: 0, scrollTop: 0, totalHeight: 0, tailTop: null } };
          }
          if (command === "metrics") return { machine: initial.id, cpu: [10], memory: [10], disk: 10,
            cpuCores: 1, memoryGb: 1, diskGb: 1, uptime: "1h", lastSample: null };
          throw new Error(`Unexpected command: ${command}`);
        });
        dispose = render(() => <App />, stage);
        await settle();
        check("logs open while database discovery is pending", frames > 0 && stage.querySelector(".bookmark")?.textContent === "All activity");
        const expression = stage.querySelector<HTMLInputElement>('[aria-label="Search expression"]')!;
        expression.value = "unit:api";
        expression.dispatchEvent(new Event("input", { bubbles: true }));
        onboard({ ...initial, views: [...initial.views, { id: "postgres", name: "discovered database",
          query: { kind: "sql", source: "postgres", statement: "select 1", run: 0 } }] });
        await settle();
        check("discovered databases join the sidebar without resetting the query", button("discovered database") != null && stage.querySelector('[aria-label="Search expression"]') === expression && expression.value === "unit:api");
        button("discovered database").click();
        await settle();
        check("discovered database opens a SQL workbench", stage.querySelector('[aria-label="SQL query"]') != null);
        const statement = stage.querySelector<HTMLInputElement>('[aria-label="SQL query"]')!;
        statement.value = "select 'draft'";
        statement.dispatchEvent(new Event("input", { bubbles: true }));
        connectivity = "reconnecting";
        await new Promise<void>((resolve) => setTimeout(resolve, 3100));
        check("a broken connection changes the sidebar and path while preserving the SQL draft", stage.querySelector('[aria-label="Reconnecting"]') != null && stage.querySelector(".connection-label")?.textContent === "Reconnecting…" && stage.querySelector('[aria-label="SQL query"]') === statement && statement.value === "select 'draft'");
        connectivity = "connected";
        await new Promise<void>((resolve) => setTimeout(resolve, 3100));
        check("connection polling recovers automatically without replacing the workbench", stage.querySelector('[aria-label="Connected"]') != null && stage.querySelector(".connection-label") == null && stage.querySelector('[aria-label="SQL query"]') === statement && statement.value === "select 'draft'");
        dispose();
        clearMocks();

        const pending: { machine: string; resolve: (value: Metrics) => void }[] = [];
        mockIPC((command, args) => {
          if (command !== "metrics") throw new Error(`Unexpected command: ${command}`);
          return new Promise<Metrics>((resolve) => pending.push({ machine: (args as { machine: string }).machine, resolve }));
        });
        const machine = (id: string): Machine => ({ id, name: id, connection: "connected", views: [] });
        const [selected, select] = createSignal(machine("first"));
        const [tick, setTick] = createSignal(0);
        function respond(machine: string, cpu: number) {
          const index = pending.findIndex((request) => request.machine === machine);
          if (index < 0) throw new Error(`Missing metrics request for ${machine}`);
          const [request] = pending.splice(index, 1);
          request.resolve({ machine, cpu: [0, cpu], memory: [0, 100], disk: 42,
            cpuCores: 8, memoryGb: 32, diskGb: 512, uptime: "3h", lastSample: null });
        }
        dispose = render(() => <Vitals machine={selected()} tick={tick()} collapsed={false} />, stage);
        respond("first", 20);
        await settle();
        check("initial machine sample renders", stage.textContent!.includes("20%"));
        setTick(3);
        await settle();
        check("same-machine refresh retains its sample", stage.textContent!.includes("20%"));
        respond("first", 30);
        await settle();
        select(machine("second"));
        await settle();
        check("machine change hides the old sample immediately", !stage.querySelector(".metric") && stage.textContent!.includes("Loading"));
        select(machine("first"));
        respond("second", 100);
        await settle();
        check("late reply from abandoned machine stays hidden", stage.textContent!.includes("30%") && !stage.textContent!.includes("100%"));
        respond("first", 100);
        await settle();
        check("capacity and uptime come from the sample", ["8 cores", "32 GB", "512 GB", "3h"].every((text) => stage.textContent!.includes(text)));
        const points = [...stage.querySelectorAll("polyline")].flatMap((line) => line.getAttribute("points")!.split(" "));
        check("0% and 100% stay inside the chart", points.every((point) => {
          const y = Number(point.split(",")[1]);
          return y >= 4 && y <= 56;
        }));
        dispose();
        clearMocks();
      } else {
        setResults(["Skipped: mocked metrics transport (run this page in a standalone browser)."]);
      }

      dispose = render(() => <PresentationFixture />, stage);
      const opener = button("Open first Wing");
      opener.focus();
      opener.click();
      await settle();
      const first = stage.querySelector<HTMLElement>('[role="dialog"]')!;
      check("Wing owns focus on entry", document.activeElement === first);
      const nestedOpener = button("Open second Wing");
      nestedOpener.focus();
      nestedOpener.click();
      await settle();
      const second = stage.querySelector<HTMLElement>('[aria-label="Second Wing"]')!;
      check("nested Wing makes its predecessor inert", first.closest("[inert]") != null && document.activeElement === second);
      const content = second.querySelector<HTMLElement>(".wing-content")!;
      const last = button("Unmount both Wings");
      const excluded = document.createElement("button");
      excluded.tabIndex = -2;
      second.append(excluded);
      const hidden = document.createElement("button");
      hidden.style.visibility = "hidden";
      second.append(hidden);
      last.focus();
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      check("Tab wraps past hidden and negative-tabindex controls", document.activeElement === content);
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
      check("Shift-Tab wraps to the last usable control", document.activeElement === last);
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle();
      check("Escape dismisses only the top Wing and restores focus", stage.querySelectorAll('[role="dialog"]').length === 1 && document.activeElement === nestedOpener);
      nestedOpener.click();
      await settle();
      button("Unmount the lower Wing").click();
      await settle();
      const remaining = stage.querySelector<HTMLElement>('[role="dialog"]')!;
      check("out-of-order removal keeps the top presentation", remaining.getAttribute("aria-label") === "Second Wing");
      remaining.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle();
      check("focus bypasses the removed lower Wing", document.activeElement === opener);
      opener.click();
      // Dismissing during entrance; reverse animation must still release presentation ownership.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      stage.querySelector<HTMLButtonElement>(".wing-backdrop")!.click();
      await settle();
      check("interrupted entrance dismisses and restores focus", !stage.querySelector('[role="dialog"]') && document.activeElement === opener);
      setResults((results) => [...results, "All applicable browser checks passed."]);
    } catch (cause) {
      setResults((results) => [...results, `Failed: ${String(cause)}`]);
    } finally {
      dispose();
      if (!native) clearMocks();
      setRunning(false);
    }
  }

  return <div class="fixture-shell">
    <div class="fixture-bar"><button disabled={running()} onClick={() => { void run(); }}>Run browser checks</button></div>
    <div class="fixture-stage" style={{ position: "relative" }}>
      <ol aria-live="polite"><For each={results()}>{(result) => <li>{result}</li>}</For></ol>
      <div ref={stage} style={{ position: "absolute", inset: 0 }} />
    </div>
  </div>;
}

render(() => <Checks />, document.getElementById("root")!);
