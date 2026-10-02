/** Bounded debounce, serialized writes and exact retry of an acknowledged live capture. */
export function createProjectAutosave<Capture, Receipt>(input: {
  readonly current: () => boolean;
  readonly write: (capture: Capture) => Promise<Receipt>;
  readonly saved: (receipt: Receipt, capture: Capture) => void;
  readonly conflict: (error: unknown) => boolean;
  readonly changed?: () => void;
  readonly debounceMs?: number;
  readonly maximumMs?: number;
}) {
  let pending: Capture | undefined;
  let failed: Capture | undefined;
  let active: Promise<void> | null = null;
  let writing: Capture | undefined;
  let disposed = false;
  let stopped = false;
  let state: "saved" | "pending" | "saving" | "failed" | "conflict" = "saved";
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let maximum: ReturnType<typeof setTimeout> | undefined;
  const current = () => !disposed && input.current();
  function notify(next: typeof state) {
    state = next;
    input.changed?.();
  }
  function clearTimers() {
    clearTimeout(debounce);
    clearTimeout(maximum);
    debounce = maximum = undefined;
  }
  async function drain(): Promise<void> {
    clearTimers();
    while (current() && !stopped && (failed !== undefined || pending !== undefined)) {
      const capture = failed ?? pending!;
      if (failed === undefined) pending = undefined;
      writing = capture;
      notify("saving");
      try {
        const receipt = await input.write(capture);
        if (!current() || stopped) return;
        input.saved(receipt, capture);
        failed = undefined;
        writing = undefined;
      } catch (error) {
        if (!current() || stopped) return;
        failed = capture;
        writing = undefined;
        stopped = input.conflict(error);
        notify(stopped ? "conflict" : "failed");
        return;
      }
    }
    if (current() && !stopped) notify("saved");
  }
  function flush(): Promise<void> {
    if (!current() || stopped) return Promise.resolve();
    if (active !== null) return active;
    active = drain().finally(() => {
      active = null;
    });
    return active;
  }
  function enqueue(capture: Capture) {
    if (!current() || stopped) return;
    pending = capture;
    if (failed !== undefined) return;
    notify(active === null ? "pending" : "saving");
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void flush();
    }, input.debounceMs ?? 500);
    maximum ??= setTimeout(() => {
      void flush();
    }, input.maximumMs ?? 2000);
  }
  return {
    enqueue,
    stop() {
      stopped = true;
      clearTimers();
      notify("conflict");
    },
    flush,
    retry: flush,
    status: () => ({
      state,
      message:
        state === "failed"
          ? "Could not save. Retry"
          : state === "conflict"
            ? "Changed in another tab. Reopen this game."
            : "",
    }),
    captures: () =>
      [writing ?? failed, pending].filter((capture): capture is Capture => capture !== undefined),
    dispose() {
      disposed = true;
      clearTimers();
      pending = undefined;
      failed = undefined;
    },
  };
}
