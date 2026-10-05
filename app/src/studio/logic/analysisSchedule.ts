/** Batch typing at a 120 ms pause, with a 600 ms cap for sustained edits. */
export function createAnalysisSchedule(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let since: number | undefined;
  let pending: Promise<void> | undefined;
  let settle: (() => void) | undefined;
  let disposed = false;
  function schedule(): void {
    if (disposed) return;
    since ??= Date.now();
    pending ??= new Promise((resolve) => {
      settle = resolve;
    });
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = undefined;
        since = undefined;
        pending = undefined;
        settle?.();
        settle = undefined;
        run();
      },
      Math.min(120, Math.max(0, 600 - (Date.now() - since))),
    );
  }
  function settled(): Promise<void> {
    return pending ?? Promise.resolve();
  }
  function dispose(): void {
    disposed = true;
    clearTimeout(timer);
    settle?.();
    pending = undefined;
    settle = undefined;
  }
  return { schedule, settled, dispose };
}
