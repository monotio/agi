/**
 * Room Studio's edit commands for the selected item — nudge, duplicate,
 * delete, reorder, colour, label/kind/lock and single points — each one kernel
 * edit and one undo step, and the short notice that says what was refused
 * (with the refused cells flashed on the canvas) or kept.
 */

import { computed, onScopeDispose, shallowRef, type Ref } from "vue";
import type { EditOperation } from "../../../src/studio/editOperations.ts";
import type { PictureItem, PictureItemKind } from "../../../src/studio/pictureDocument.ts";
import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import { freshItemId, type DraftOutcome, type StudioDraft } from "./useStudioDraft.ts";

/** How far Cmd/Ctrl+D offsets a copy, in logical pixels. */
export const DUPLICATE_OFFSET = 4;
/** How long a refusal's cells stay highlighted. */
const FLASH_MS = 1600;
/** How long a notice stays up. */
const NOTICE_MS = 5000;

export interface StudioNotice {
  readonly tone: "warn" | "ok";
  readonly text: string;
}

export interface ItemMetaPatch {
  readonly label?: string;
  readonly kind?: PictureItemKind;
  readonly locked?: boolean;
}

export function useStudioEditing(options: {
  readonly draft: StudioDraft;
  readonly selectedId: Ref<string | undefined>;
  /** Editing is blocked (view only, or a Keep that needs a reload). */
  readonly frozen: () => boolean;
}) {
  const { draft, selectedId } = options;
  const notice = shallowRef<StudioNotice | null>(null);
  const flash = shallowRef<Uint8Array | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => {
    clearTimeout(flashTimer);
    clearTimeout(noticeTimer);
  });

  /** The selected item as the draft holds it, if it is an item (not a group or loose lines). */
  const item = computed<PictureItem | undefined>(() =>
    draft.document.value.items.find((candidate) => candidate.id === selectedId.value),
  );
  /** The selected item, when the creator may edit it now. */
  const editable = computed(() => (options.frozen() ? undefined : item.value));

  function say(next: StudioNotice | null): void {
    clearTimeout(noticeTimer);
    notice.value = next;
    if (next) noticeTimer = setTimeout(() => (notice.value = null), NOTICE_MS);
  }

  /** Show what an edit did: a refusal's reason (and its cells), or nothing. */
  function report(outcome: DraftOutcome): void {
    if (outcome.ok) {
      if (notice.value?.tone === "warn") say(null);
      return;
    }
    const { refusal } = outcome;
    say({ tone: "warn", text: `Not changed: ${refusal.message}` });
    if (refusal.kind !== "lock") return;
    clearTimeout(flashTimer);
    flash.value = refusal.cells;
    flashTimer = setTimeout(() => (flash.value = null), FLASH_MS);
  }

  function run(op: (target: PictureItem) => EditOperation | null, label: string): boolean {
    const target = editable.value;
    if (!target) return false;
    const edit = op(target);
    if (!edit) return false;
    const outcome = draft.apply(edit, `${label} ${target.label}`);
    report(outcome);
    return outcome.ok;
  }

  const nudge = (dx: number, dy: number): boolean =>
    run((target) => ({ type: "moveItem", itemId: target.id, dx, dy }), "Nudge");

  function duplicate(): boolean {
    const target = editable.value;
    if (!target) return false;
    const newId = freshItemId(draft.document.value, target.id);
    const done = run(
      () => ({
        type: "duplicateItem",
        itemId: target.id,
        dx: DUPLICATE_OFFSET,
        dy: DUPLICATE_OFFSET,
        newId,
        newLabel: `${target.label} copy`,
      }),
      "Duplicate",
    );
    if (done) selectedId.value = newId;
    return done;
  }

  function remove(): boolean {
    const done = run((target) => ({ type: "deleteItem", itemId: target.id }), "Delete");
    if (done) selectedId.value = undefined;
    return done;
  }

  /** Move the item back (-1, drawn earlier) or forward (+1, drawn later) in draw order. */
  const reorder = (step: 1 | -1): boolean =>
    run(
      (target) => {
        const items = draft.document.value.items;
        const toIndex = items.indexOf(target) + step;
        return toIndex < 0 || toIndex >= items.length
          ? null
          : { type: "reorderItem", itemId: target.id, toIndex };
      },
      step < 0 ? "Move back" : "Move forward",
    );

  const setColour = (plane: PicturePlane, value: number | null): boolean =>
    run(
      (target) => ({ type: "setItemColor", itemId: target.id, plane, value }),
      plane === "visual" ? "Colour" : "Priority",
    );

  const setMeta = (patch: ItemMetaPatch): boolean =>
    run((target) => ({ type: "setItemMeta", itemId: target.id, ...patch }), "Edit");

  const setPoint = (line: number, pointIndex: number, x: number, y: number): boolean =>
    run(() => ({ type: "setPoint", line, pointIndex, x, y }), "Move point of");

  function history(which: "undo" | "redo"): boolean {
    if (options.frozen()) return false;
    const done = which === "undo" ? draft.undo() : draft.redo();
    if (done) say(null);
    return done;
  }

  return {
    item,
    editable,
    notice,
    flash,
    say,
    report,
    nudge,
    duplicate,
    remove,
    reorder,
    setColour,
    setMeta,
    setPoint,
    undo: () => history("undo"),
    redo: () => history("redo"),
  };
}

export type StudioEditing = ReturnType<typeof useStudioEditing>;
