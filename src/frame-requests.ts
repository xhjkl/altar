import type { Frame, FrameRequest } from "./bridge";

type FrameSink = {
  read: () => FrameRequest;
  render: (request: FrameRequest) => Promise<Frame>;
  accept: (frame: Frame, request: FrameRequest) => void;
  reject: (cause: unknown) => void;
};

/** Coalesce refreshes without starving a slow projection. Invalidations discard obsolete query or viewport replies. */
export function createFrameRequests(sink: FrameSink, clock = {
  request: (callback: () => void) => requestAnimationFrame(callback),
  cancel: (id: number) => cancelAnimationFrame(id),
}) {
  let animation: number | null = null;
  let running = false;
  let disposed = false;
  let generation = 0;
  let dirty = false;

  function refresh() {
    if (disposed) return;
    dirty = true;
    if (running || animation != null) return;
    animation = clock.request(() => {
      animation = null;
      void run();
    });
  }

  async function run() {
    const requested = generation;
    dirty = false;
    running = true;
    try {
      const request = sink.read();
      const frame = await sink.render(request);
      if (disposed || requested !== generation) return;
      sink.accept(frame, request);
    } catch (cause) {
      if (!disposed && requested === generation) sink.reject(cause);
    } finally {
      running = false;
      if (dirty) refresh();
    }
  }

  return {
    refresh,
    invalidate() {
      generation += 1;
      refresh();
    },
    dispose() {
      disposed = true;
      if (animation != null) clock.cancel(animation);
    },
  };
}
