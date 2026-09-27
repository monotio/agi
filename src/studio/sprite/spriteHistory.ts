/**
 * Sprite Studio undo/redo: the Room Studio edit history (editHistory.ts) over
 * snapshots of the encoded VIEW payload, one character per byte. Snapshots
 * compare by value, so a history refuses to undo over a document that
 * changed outside it; gestures (`begin`/`commit`) make a drag one step.
 */
import {
  cancel,
  createHistory,
  DEFAULT_HISTORY_DEPTH,
  record,
  redo,
  undo,
  type EditHistory,
  type HistoryResult,
} from "../editHistory.ts";
import { withPayload, type SpriteDocument } from "./spriteDocument.ts";

export { begin, commit } from "../editHistory.ts";

export type SpriteHistoryResult =
  | { readonly ok: true; readonly history: EditHistory; readonly document: SpriteDocument }
  | { readonly ok: false; readonly reason: string };

/** The document's encoded payload as a string snapshot, one character per byte. */
function spriteSnapshot(document: SpriteDocument): string {
  let out = "";
  for (let i = 0; i < document.payload.length; i += 4096)
    out += String.fromCharCode(...document.payload.subarray(i, i + 4096));
  return out;
}

function restore(document: SpriteDocument, snapshot: string): SpriteDocument {
  const payload = new Uint8Array(snapshot.length);
  for (let i = 0; i < snapshot.length; i++) payload[i] = snapshot.charCodeAt(i);
  return withPayload(document, payload);
}

export function createSpriteHistory(
  document: SpriteDocument,
  depth = DEFAULT_HISTORY_DEPTH,
): EditHistory {
  return createHistory(spriteSnapshot(document), depth, "sprite");
}

/** Record the edit that turned `before` into `after` (inside a gesture: extend it). */
export function recordSpriteEdit(
  history: EditHistory,
  label: string,
  before: SpriteDocument,
  after: SpriteDocument,
): HistoryResult {
  return record(history, label, spriteSnapshot(before), spriteSnapshot(after));
}

function restored(document: SpriteDocument, result: HistoryResult): SpriteHistoryResult {
  return result.ok
    ? { ok: true, history: result.history, document: restore(document, result.source) }
    : result;
}

/** Step back from `document`, which must be the history's current state. */
export function undoSprite(history: EditHistory, document: SpriteDocument): SpriteHistoryResult {
  return restored(document, undo(history, spriteSnapshot(document)));
}

/** Step forward again from `document`, which must be the history's current state. */
export function redoSprite(history: EditHistory, document: SpriteDocument): SpriteHistoryResult {
  return restored(document, redo(history, spriteSnapshot(document)));
}

/** Abandon the open gesture: back to the document it started from. */
export function cancelSpriteGesture(
  history: EditHistory,
  document: SpriteDocument,
): SpriteHistoryResult {
  return restored(document, cancel(history, spriteSnapshot(document)));
}
