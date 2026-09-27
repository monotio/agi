/**
 * One undo order over several histories: Room Studio's picture draft and
 * its room logic draft each keep their own undo stack, and Cmd+Z undoes
 * whichever changed last. Each history reports how many undo and redo steps
 * it holds; every new step is stamped as the lengths change, so undo takes
 * the newest past step of any history and redo the step undone last. Undo
 * and redo must go through this composable, which is how it tells them from
 * new edits.
 */

import { watch } from "vue";

export interface OrderedHistory {
  /** Undo steps held. */
  readonly past: () => number;
  /** Redo steps held. */
  readonly future: () => number;
  readonly undo: () => boolean;
  readonly redo: () => boolean;
}

export function useUndoOrder(histories: readonly OrderedHistory[]) {
  let clock = 0;
  const stamps = histories.map((history) => ({
    past: Array.from({ length: history.past() }, () => ++clock),
    future: [] as number[],
  }));
  /** The history an undo or redo is running on, while it runs. */
  let acting: { index: number; redo: boolean } | null = null;

  histories.forEach((history, index) => {
    const own = stamps[index]!;
    watch(
      () => [history.past(), history.future()] as const,
      ([past, future]) => {
        if (acting?.index === index) {
          // An undo or redo moves the stamps it made with the steps.
          const [from, to] = acting.redo ? [own.future, own.past] : [own.past, own.future];
          while ((acting.redo ? own.past.length < past : own.past.length > past) && from.length > 0)
            to.push(from.pop()!);
        }
        // A new edit (or a reset): a fresh stamp per new step, and the redo stamps it cleared go.
        if (own.past.length > past) own.past.length = past;
        while (own.past.length < past) own.past.push(++clock);
        if (own.future.length > future) own.future.splice(0, own.future.length - future);
        while (own.future.length < future) own.future.unshift(++clock);
      },
      { flush: "sync" },
    );
  });

  function run(pick: number, redo: boolean): boolean {
    if (pick < 0) return false;
    acting = { index: pick, redo };
    try {
      return redo ? histories[pick]!.redo() : histories[pick]!.undo();
    } finally {
      acting = null;
    }
  }

  /** Undo the newest step of any history; false when none has one. */
  function undo(): boolean {
    let pick = -1;
    stamps.forEach((own, index) => {
      const top = own.past.at(-1);
      if (top !== undefined && (pick < 0 || top > stamps[pick]!.past.at(-1)!)) pick = index;
    });
    return run(pick, false);
  }

  /** Redo the step undone last. */
  function redo(): boolean {
    let pick = -1;
    stamps.forEach((own, index) => {
      const top = own.future.at(-1);
      if (top !== undefined && (pick < 0 || top < stamps[pick]!.future.at(-1)!)) pick = index;
    });
    return run(pick, true);
  }

  return { undo, redo };
}
