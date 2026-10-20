import { expect, test } from "bun:test";
import { createFrameRequests } from "../src/frame-requests";
import type { Frame, FrameRequest } from "../src/bridge";

function harness(latency = 2000) {
  let now = 0;
  let nextId = 0;
  let active = 0;
  let peak = 0;
  const events = new Map<number, { at: number; run: () => void }>();
  const after = (delay: number, run: () => void) => {
    const id = ++nextId;
    events.set(id, { at: now + delay, run });
    return id;
  };
  const input: FrameRequest = {
    machine: "production", query: { kind: "logs", filter: "" }, tick: 0, pausedAt: null,
    viewport: { top: null, height: 600, insetTop: 88, rowHeight: 36, paddingTop: 72, paddingBottom: 108, overscan: 3 },
  };
  const completed: FrameRequest[] = [];
  const accepted: FrameRequest[] = [];
  const errors: unknown[] = [];
  let failure: Error | null = null;
  const controller = createFrameRequests({
    read: () => structuredClone(input),
    render: (request) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve, reject) => after(latency, () => {
        active -= 1;
        completed.push(request);
        if (failure != null) { reject(failure); return; }
        resolve({ columns: [], rows: [], total: 0, pending: 0, tick: request.tick,
          window: { rowHeight: 36, offset: 0, scrollTop: request.viewport.top ?? 100, totalHeight: 700, tailTop: null },
        } satisfies Frame);
      }));
    },
    accept: (_, request) => accepted.push(request),
    reject: (cause) => errors.push(cause),
  }, {
    request: (callback) => after(16, callback),
    cancel: (id) => { events.delete(id); },
  });
  return {
    input, controller, completed, accepted, errors,
    peak: () => peak,
    fail: (cause: Error | null) => { failure = cause; },
    async until(end: number) {
      while (events.size > 0) {
        const [id, event] = [...events].sort((a, b) => a[1].at - b[1].at)[0];
        if (event.at > end) break;
        now = event.at;
        events.delete(id);
        event.run();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

test("slow frames keep displaying under a faster refresh clock", async () => {
  for (const latency of [100, 2000]) {
    const h = harness(latency);
    h.controller.refresh();
    for (let time = 1500; time <= 9000; time += 1500) {
      await h.until(time);
      h.input.tick += 1;
      h.controller.refresh();
    }
    await h.until(10_000);
    console.log(`${latency}ms transport: ${h.accepted.length}/${h.completed.length} frames displayed, peak concurrency ${h.peak()}`);
    expect(h.accepted.length).toBe(latency === 100 ? 7 : 4);
    expect(h.peak()).toBe(1);
    h.controller.dispose();
  }
});

test("a replaced query discards both stale results and stale errors", async () => {
  for (const fail of [false, true]) {
    const h = harness();
    h.controller.refresh();
    await h.until(100);
    h.input.query = { kind: "sql", source: "orders", statement: "SELECT * FROM orders", run: 0 };
    h.controller.invalidate();
    if (fail) h.fail(new Error("old query failed"));
    await h.until(2100);
    expect(h.accepted).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    h.fail(null);
    await h.until(4100);
    expect(h.accepted.map((request) => request.query.kind)).toEqual(["sql"]);
    expect(h.peak()).toBe(1);
    h.controller.dispose();
  }
});

test("scroll, resize, and follow changes supersede obsolete viewport results", async () => {
  const h = harness();
  h.controller.refresh();
  await h.until(100);
  h.input.viewport.top = 720;
  h.input.viewport.height = 400;
  h.controller.invalidate();
  await h.until(2100);
  expect(h.accepted).toHaveLength(0);
  await h.until(4100);
  expect(h.accepted[0].viewport).toEqual(h.input.viewport);
  h.input.viewport.top = null;
  h.controller.invalidate();
  await h.until(6200);
  expect(h.accepted.at(-1)?.viewport.top).toBeNull();
  h.controller.dispose();
});

test("refresh bursts coalesce and read the latest input at dispatch", async () => {
  const h = harness();
  for (let tick = 0; tick < 50; tick += 1) {
    h.input.tick = tick;
    h.controller.refresh();
  }
  await h.until(2100);
  expect(h.completed.map((request) => request.tick)).toEqual([49]);
  expect(h.accepted).toHaveLength(1);
  h.controller.dispose();
});

test("disposal cancels queued work and suppresses in-flight results and errors", async () => {
  for (const time of [0, 100]) {
    for (const fail of [false, true]) {
      const h = harness();
      if (fail) h.fail(new Error("disposed"));
      h.controller.refresh();
      await h.until(time);
      h.controller.refresh();
      h.controller.dispose();
      h.controller.refresh();
      await h.until(10_000);
      expect(h.completed).toHaveLength(time === 0 ? 0 : 1);
      expect(h.accepted).toHaveLength(0);
      expect(h.errors).toHaveLength(0);
    }
  }
});

test("a failed request can be retried without a second request in flight", async () => {
  const h = harness();
  h.fail(new Error("transport failed"));
  h.controller.refresh();
  await h.until(2100);
  expect(h.errors).toHaveLength(1);
  h.fail(null);
  h.controller.refresh();
  await h.until(4200);
  expect(h.accepted).toHaveLength(1);
  expect(h.peak()).toBe(1);
  h.controller.dispose();
});
