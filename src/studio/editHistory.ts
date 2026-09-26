/**
 * Room Studio undo/redo over picture source snapshots. Pure: every function
 * returns a new history. A `begin`/`commit` gesture (a whole drag) becomes
 * one step; undo and redo refuse, rather than overwrite, a document whose
 * text is no longer the snapshot the history expects.
 */

/** A snapshot to return to, named by the edit that left it. */
export interface HistoryStep {
  readonly label: string;
  readonly source: string;
}

export interface EditHistory {
  /** Oldest first; undo returns to the last one. */
  readonly past: readonly HistoryStep[];
  /** Nearest first; redo returns to the first one. */
  readonly future: readonly HistoryStep[];
  /** The text the document holds as far as the history knows. */
  readonly current: string;
  /** An open gesture: its label and the text it started from. */
  readonly gesture?: HistoryStep;
  /** The most steps `past` keeps; older ones are dropped. */
  readonly depth: number;
}

export type HistoryResult =
  | { readonly ok: true; readonly history: EditHistory; readonly source: string }
  | { readonly ok: false; readonly reason: string };

export const DEFAULT_HISTORY_DEPTH = 200;

export function createHistory(source: string, depth = DEFAULT_HISTORY_DEPTH): EditHistory {
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError(`depth must be >= 1`);
  return { past: [], future: [], current: source, depth };
}

function push(history: EditHistory, step: HistoryStep, current: string): EditHistory {
  const past = [...history.past, step].slice(-history.depth);
  return { past, future: [], current, depth: history.depth };
}

const stale = (history: EditHistory, actual: string, action: string): HistoryResult | null =>
  actual === history.current
    ? null
    : {
        ok: false,
        reason: `the picture changed outside the edit history; ${action} would overwrite that change`,
      };

/**
 * Record an edit from `before` to `after`. Inside a gesture it only advances
 * `current`; otherwise it adds one undo step and clears redo. Refused when
 * `before` is not the text the history expects.
 */
export function record(
  history: EditHistory,
  label: string,
  before: string,
  after: string,
): HistoryResult {
  const refusal = stale(history, before, "recording this edit");
  if (refusal) return refusal;
  if (after === before) return { ok: true, history, source: after };
  if (history.gesture) return { ok: true, history: { ...history, current: after }, source: after };
  return { ok: true, history: push(history, { label, source: before }, after), source: after };
}

/** Open a gesture whose edits undo as one step; an open gesture is committed first. */
export function begin(history: EditHistory, label: string): EditHistory {
  const base = commit(history);
  return { ...base, gesture: { label, source: base.current } };
}

/** Close the open gesture: one step when it changed the text, none otherwise. */
export function commit(history: EditHistory): EditHistory {
  const { gesture } = history;
  if (!gesture) return history;
  if (gesture.source === history.current) {
    return {
      past: history.past,
      future: history.future,
      current: history.current,
      depth: history.depth,
    };
  }
  return push(history, gesture, history.current);
}

/** Step back. `actual` is the document's text now; it must equal `current`. */
export function undo(history: EditHistory, actual: string): HistoryResult {
  if (history.gesture) return { ok: false, reason: "an edit is in progress; commit it first" };
  const refusal = stale(history, actual, "undo");
  if (refusal) return refusal;
  const step = history.past[history.past.length - 1];
  if (!step) return { ok: false, reason: "nothing to undo" };
  return {
    ok: true,
    history: {
      past: history.past.slice(0, -1),
      future: [{ label: step.label, source: history.current }, ...history.future],
      current: step.source,
      depth: history.depth,
    },
    source: step.source,
  };
}

/** Step forward again. `actual` is the document's text now; it must equal `current`. */
export function redo(history: EditHistory, actual: string): HistoryResult {
  if (history.gesture) return { ok: false, reason: "an edit is in progress; commit it first" };
  const refusal = stale(history, actual, "redo");
  if (refusal) return refusal;
  const [step, ...future] = history.future;
  if (!step) return { ok: false, reason: "nothing to redo" };
  return {
    ok: true,
    history: {
      past: [...history.past, { label: step.label, source: history.current }].slice(-history.depth),
      future,
      current: step.source,
      depth: history.depth,
    },
    source: step.source,
  };
}

/** Abandon the open gesture (an aborted drag): back to the text it started from. */
export function cancel(history: EditHistory, actual: string): HistoryResult {
  const { gesture } = history;
  if (!gesture) return { ok: false, reason: "no edit is in progress" };
  const refusal = stale(history, actual, "cancelling");
  if (refusal) return refusal;
  const { past, future, depth } = history;
  return {
    ok: true,
    history: { past, future, current: gesture.source, depth },
    source: gesture.source,
  };
}
