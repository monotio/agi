/**
 * One undo order over several histories: Room Studio's picture draft and
 * its room logic draft each keep their own undo stack, and Cmd+Z undoes
 * whichever changed last. Each history reports how many undo and redo steps
 * it holds; every new step gets a stamp from one clock, so undo takes the
 * newest past step of any history and redo the step undone last. Undo and
 * redo must go through this composable, which is how it tells them from new
 * edits. A history that drops steps outside undo and redo (a Keep that
 * cannot carry old steps over, a depth cap) reports them in `dropped`, and
 * exactly their stamps go with them.
 *
 * Stamps follow a history's net change, never its intermediate states: a
 * history that changes its counts in several synchronous assignments ends
 * with the same stamps as one that changes them at once. A change is read
 * once that history is done changing: when another history changes, or
 * when undo or redo runs.
 */

import { watch } from "vue";

export interface OrderedHistory {
  /** Undo steps held. */
  readonly past: () => number;
  /** Redo steps held. */
  readonly future: () => number;
  readonly undo: () => boolean;
  readonly redo: () => boolean;
  /**
   * Steps dropped so far from the far ends, outside undo and redo: the oldest
   * undo steps and the farthest redo steps. The counts only grow (a reset may
   * start them over).
   */
  readonly dropped?: () => { readonly past: number; readonly future: number };
}

interface Counts {
  readonly past: number;
  readonly future: number;
  readonly dropped: { readonly past: number; readonly future: number };
}

const NONE = { past: 0, future: 0 };

export function useUndoOrder(histories: readonly OrderedHistory[]) {
  let clock = 0;
  const read = (history: OrderedHistory): Counts => ({
    past: history.past(),
    future: history.future(),
    dropped: history.dropped?.() ?? NONE,
  });
  /** The counts each history's stamps were last brought up to. */
  const seen = histories.map(read);
  const stamps = histories.map((history) => ({
    past: Array.from({ length: history.past() }, () => ++clock),
    future: [] as number[],
  }));
  /** The history that changed since its stamps were last brought up to date. */
  let pending: number | null = null;
  /** An undo or redo is running: its history is brought up to date after it. */
  let acting = false;

  /** Bring one history's stamps up to its counts; `moved`: an undo or redo just ran on it. */
  function settle(index: number, moved?: "undo" | "redo"): void {
    const own = stamps[index]!;
    const was = seen[index]!;
    const now = read(histories[index]!);
    // Dropped steps take their own stamps: the oldest undo, the farthest redo.
    own.past.splice(0, Math.max(0, now.dropped.past - was.dropped.past));
    own.future.splice(0, Math.max(0, now.dropped.future - was.dropped.future));
    if (moved) {
      // An undo or redo moves the stamps it made with the steps.
      const [from, to] = moved === "redo" ? [own.future, own.past] : [own.past, own.future];
      while (
        (moved === "redo" ? own.past.length < now.past : own.past.length > now.past) &&
        from.length > 0
      )
        to.push(from.pop()!);
    }
    // A new edit (or a reset): a fresh stamp per new step, and the redo stamps it cleared go.
    if (own.past.length > now.past) own.past.length = now.past;
    while (own.past.length < now.past) own.past.push(++clock);
    if (own.future.length > now.future) own.future.splice(0, own.future.length - now.future);
    while (own.future.length < now.future) own.future.unshift(++clock);
    seen[index] = now;
  }

  function settlePending(): void {
    if (pending !== null) settle(pending);
    pending = null;
  }

  histories.forEach((history, index) => {
    watch(
      () => [history.past(), history.future(), history.dropped?.() ?? NONE] as const,
      () => {
        if (acting || pending === index) return;
        // Another history is done changing: its steps come before this one's.
        settlePending();
        pending = index;
      },
      { flush: "sync" },
    );
  });

  function run(pick: number, redo: boolean): boolean {
    if (pick < 0) return false;
    acting = true;
    try {
      return redo ? histories[pick]!.redo() : histories[pick]!.undo();
    } finally {
      acting = false;
      settle(pick, redo ? "redo" : "undo");
    }
  }

  /** The history whose top stamp `better` prefers, on the undo or redo side; -1 for none. */
  function pickBy(side: "past" | "future", better: (a: number, b: number) => boolean): number {
    settlePending();
    let pick = -1;
    stamps.forEach((own, index) => {
      const top = own[side].at(-1);
      if (top !== undefined && (pick < 0 || better(top, stamps[pick]![side].at(-1)!))) pick = index;
    });
    return pick;
  }

  /** Undo the newest step of any history; false when none has one. */
  const undo = (): boolean =>
    run(
      pickBy("past", (a, b) => a > b),
      false,
    );

  /** Redo the step undone last. */
  const redo = (): boolean =>
    run(
      pickBy("future", (a, b) => a < b),
      true,
    );

  return { undo, redo };
}
