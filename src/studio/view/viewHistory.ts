/**
 * VIEW editor undo/redo: the PICTURE editor edit history (editHistory.ts) over
 * snapshots of the encoded VIEW payload, one character per byte. Snapshots
 * compare by value, so a history refuses to undo over a document that
 * changed outside it; gestures (`begin`/`commit`) make a drag one step.
 */
import {
  cancel,
  createHistory,
  DEFAULT_HISTORY_PRIORITY,
  record,
  redo,
  undo,
  type EditHistory,
  type HistoryResult,
} from "../editHistory.ts";
import { withPayload, type ViewDocument } from "../../view/viewDocument.ts";

export { begin, commit } from "../editHistory.ts";

export type ViewHistoryResult =
  | { readonly ok: true; readonly history: EditHistory; readonly document: ViewDocument }
  | { readonly ok: false; readonly reason: string };

/** The document's encoded payload as a string snapshot, one character per byte. */
function viewSnapshot(document: ViewDocument): string {
  let out = "";
  for (let i = 0; i < document.payload.length; i += 4096)
    out += String.fromCharCode(...document.payload.subarray(i, i + 4096));
  return out;
}

function restore(document: ViewDocument, snapshot: string): ViewDocument {
  const payload = new Uint8Array(snapshot.length);
  for (let i = 0; i < snapshot.length; i++) payload[i] = snapshot.charCodeAt(i);
  return withPayload(document, payload);
}

export function createViewHistory(
  document: ViewDocument,
  priority = DEFAULT_HISTORY_PRIORITY,
): EditHistory {
  return createHistory(viewSnapshot(document), priority, "view");
}

/** Record the edit that turned `before` into `after` (inside a gesture: extend it). */
export function recordViewEdit(
  history: EditHistory,
  label: string,
  before: ViewDocument,
  after: ViewDocument,
): HistoryResult {
  return record(history, label, viewSnapshot(before), viewSnapshot(after));
}

function restored(document: ViewDocument, result: HistoryResult): ViewHistoryResult {
  return result.ok
    ? { ok: true, history: result.history, document: restore(document, result.source) }
    : result;
}

/** Step back from `document`, which must be the history's current state. */
export function undoView(history: EditHistory, document: ViewDocument): ViewHistoryResult {
  return restored(document, undo(history, viewSnapshot(document)));
}

/** Step forward again from `document`, which must be the history's current state. */
export function redoView(history: EditHistory, document: ViewDocument): ViewHistoryResult {
  return restored(document, redo(history, viewSnapshot(document)));
}

/** Abandon the open gesture: back to the document it started from. */
export function cancelViewGesture(history: EditHistory, document: ViewDocument): ViewHistoryResult {
  return restored(document, cancel(history, viewSnapshot(document)));
}
