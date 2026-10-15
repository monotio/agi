/** Keep the latest gesture work, applying it at most once per display frame. */
export function frameTask(
  frame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
) {
  let pending: (() => void) | undefined;
  let handle: number | undefined;
  function cancel() {
    if (handle !== undefined) cancelFrame(handle);
    handle = undefined;
    pending = undefined;
  }
  function flush() {
    const task = pending;
    cancel();
    task?.();
  }
  function schedule(task: () => void) {
    pending = task;
    handle ??= frame(flush);
  }
  return { schedule, flush, cancel };
}

/** Publish changes at a bounded rate, including the last change after activity stops. */
export function throttleTask(delay: number) {
  let pending: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = -Infinity;
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  }
  function flush() {
    const task = pending;
    cancel();
    if (task) {
      last = performance.now();
      task();
    }
  }
  function schedule(task: () => void) {
    pending = task;
    const remaining = delay - (performance.now() - last);
    if (remaining <= 0) flush();
    else timer ??= setTimeout(flush, remaining);
  }
  return { schedule, flush, cancel };
}
