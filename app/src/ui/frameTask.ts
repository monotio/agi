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
  function reset() {
    cancel();
    last = -Infinity;
  }
  return { schedule, flush, cancel, reset };
}

/** Own one captured pointer and its queued frame until release, capture loss or handle removal. */
export function pointerFrame(
  abandoned: () => void,
  frame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
) {
  const task = frameTask(frame, cancelFrame);
  let owner: { pointer: number; target: Element } | undefined;
  function owns(event: PointerEvent) {
    return owner?.pointer === event.pointerId;
  }
  function clear() {
    const previous = owner;
    owner = undefined;
    if (previous?.target.hasPointerCapture(previous.pointer))
      previous.target.releasePointerCapture(previous.pointer);
  }
  function begin(event: PointerEvent) {
    if (owner) return false;
    owner = { pointer: event.pointerId, target: event.currentTarget as Element };
    owner.target.setPointerCapture(owner.pointer);
    return true;
  }
  function schedule(event: PointerEvent, work: () => void) {
    if (owns(event)) task.schedule(work);
  }
  function finish(event: PointerEvent) {
    if (!owns(event)) return false;
    task.flush();
    clear();
    return true;
  }
  function cancel(event?: PointerEvent) {
    if (event && !owns(event)) return;
    task.cancel();
    if (!owner) return;
    clear();
    abandoned();
  }
  return { begin, owns, schedule, finish, cancel };
}
