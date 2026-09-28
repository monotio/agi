/**
 * Room Studio's edit commands for the selection — nudge, duplicate, delete,
 * reorder, colour, label/kind/lock and single points (moved or added) for
 * one item; nudge, duplicate, delete, priority and "Make one item" for
 * several — each one kernel edit (a batch for several items) and one undo
 * step, and the short notice that says what was refused (with the refused
 * cells flashed on the canvas) or kept. Draw order moves one item at a time.
 */

import { computed, onScopeDispose, shallowRef, type Ref } from "vue";
import type { EditOperation } from "../../../src/studio/editOperations.ts";
import {
  itemRun,
  type PictureItem,
  type PictureItemKind,
} from "../../../src/studio/pictureDocument.ts";
import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import { freshItemId, itemIdFor, type DraftOutcome, type StudioDraft } from "./useStudioDraft.ts";
import { useStudioNotice } from "./useStudioNotice.ts";

/** How far Cmd/Ctrl+D offsets a copy, in logical pixels. */
const DUPLICATE_OFFSET = 4;
/** How long a refusal's cells stay highlighted. */
const FLASH_MS = 1600;

export interface ItemMetaPatch {
  readonly label?: string;
  readonly kind?: PictureItemKind;
  readonly locked?: boolean;
}

export function useStudioEditing(options: {
  readonly draft: StudioDraft;
  readonly selectedId: Ref<string | undefined>;
  /** The items the selection covers, in draw order; the selected item alone when absent. */
  readonly itemIds?: () => readonly string[];
  /** Select exactly these items (the copies after a Duplicate, the new item after Make one). */
  readonly selectItems?: (ids: readonly string[]) => void;
  /** Editing is blocked (view only, or a Keep that needs a reload). */
  readonly frozen: () => boolean;
  /** Edits wait (an AI request or its proposal is open); undo and redo still run. */
  readonly paused?: () => boolean;
}) {
  const { draft, selectedId } = options;
  const { notice, say, hold } = useStudioNotice();
  const flash = shallowRef<Uint8Array | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => clearTimeout(flashTimer));
  const select = (ids: readonly string[]): void => {
    if (options.selectItems) options.selectItems(ids);
    else selectedId.value = ids.length === 1 ? ids[0] : undefined;
  };

  /** The selected item as the draft holds it, if it is an item (not a group or loose lines). */
  const item = computed<PictureItem | undefined>(() =>
    draft.document.value.items.find((candidate) => candidate.id === selectedId.value),
  );
  /** The selected item, when the creator may edit it now. */
  const blocked = (): boolean => options.frozen() || (options.paused?.() ?? false);
  const editable = computed(() => (blocked() ? undefined : item.value));
  /** Every item the selection covers, as the draft holds them, in draw order. */
  const targets = computed<PictureItem[]>(() => {
    const ids = options.itemIds?.() ?? (item.value ? [item.value.id] : []);
    return draft.document.value.items.filter((candidate) => ids.includes(candidate.id));
  });
  /** Two items or more are selected: the edits apply to all of them as one. */
  const several = computed(() => targets.value.length > 1);
  /** The selected items, when the creator may edit them now. */
  const editableItems = computed(() => (blocked() ? [] : targets.value));

  /** Show what an edit did: a refusal's reason (and its cells), or nothing. */
  function report(outcome: DraftOutcome): void {
    if (outcome.ok) {
      if (notice.value?.tone === "warn") say(null);
      return;
    }
    const { refusal } = outcome;
    say({ tone: "warn", text: refusal.message, detail: refusal.detail });
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

  /** One batch over every selected item, one undo step: "Nudge 3 items". */
  function runAll(op: (target: PictureItem) => EditOperation, verb: string): boolean {
    const list = editableItems.value;
    if (list.length === 0) return false;
    const outcome = draft.apply(list.map(op), `${verb} ${list.length} items`);
    report(outcome);
    return outcome.ok;
  }

  const nudge = (dx: number, dy: number): boolean =>
    several.value
      ? runAll((target) => ({ type: "moveItem", itemId: target.id, dx, dy }), "Nudge")
      : run((target) => ({ type: "moveItem", itemId: target.id, dx, dy }), "Nudge");

  function duplicate(): boolean {
    const list = several.value ? editableItems.value : editable.value ? [editable.value] : [];
    if (list.length === 0) return false;
    const document = draft.document.value;
    const taken = new Set<string>();
    const ops = list.map((target): EditOperation => {
      let newId = freshItemId(document, target.id);
      for (let n = 2; taken.has(newId); n++) newId = `${freshItemId(document, target.id)}-${n}`;
      taken.add(newId);
      return {
        type: "duplicateItem",
        itemId: target.id,
        dx: DUPLICATE_OFFSET,
        dy: DUPLICATE_OFFSET,
        newId,
        newLabel: `${target.label} copy`,
      };
    });
    const label = several.value ? `Duplicate ${list.length} items` : `Duplicate ${list[0]!.label}`;
    const outcome = draft.apply(several.value ? ops : ops[0]!, label);
    report(outcome);
    if (outcome.ok) select(ops.map((op) => (op.type === "duplicateItem" ? op.newId : "")));
    return outcome.ok;
  }

  function remove(): boolean {
    const done = several.value
      ? runAll((target) => ({ type: "deleteItem", itemId: target.id }), "Delete")
      : run((target) => ({ type: "deleteItem", itemId: target.id }), "Delete");
    if (done) select([]);
    return done;
  }

  /** Move the item back (-1, drawn earlier) or forward (+1, drawn later) in draw order. */
  function reorder(step: 1 | -1): boolean {
    if (several.value) {
      say({ tone: "warn", text: "Draw order changes one item at a time: select just one." });
      return false;
    }
    return run(
      (target) => {
        const items = draft.document.value.items;
        const toIndex = items.indexOf(target) + step;
        return toIndex < 0 || toIndex >= items.length
          ? null
          : { type: "reorderItem", itemId: target.id, toIndex };
      },
      step < 0 ? "Move back" : "Move forward",
    );
  }

  const setColour = (plane: PicturePlane, value: number | null): boolean =>
    several.value
      ? runAll(
          (target) => ({ type: "setItemColor", itemId: target.id, plane, value }),
          plane === "visual" ? "Colour" : "Priority",
        )
      : run(
          (target) => ({ type: "setItemColor", itemId: target.id, plane, value }),
          plane === "visual" ? "Colour" : "Priority",
        );

  /** The items between the selected ones that "Make one item" would need too, in draw order. */
  const between = computed(() =>
    itemRun(
      draft.document.value,
      targets.value.map((t) => t.id),
    ),
  );

  /**
   * "Make one item": the selected neighbours become one item named `label`,
   * with the same bytes. Refused (with a notice) for items that are not
   * neighbours in the draw order.
   */
  function combine(label: string): boolean {
    const list = editableItems.value;
    if (list.length < 2) return false;
    const name = label.trim() || "Group";
    const ids = list.map((target) => target.id);
    const id = itemIdFor(draft.document.value, name, ids);
    const outcome = draft.apply(
      { type: "combineItems", itemIds: ids, id, label: name },
      `Make one item ${name}`,
    );
    report(outcome);
    if (outcome.ok) select([id]);
    return outcome.ok;
  }

  const setMeta = (patch: ItemMetaPatch): boolean =>
    run((target) => ({ type: "setItemMeta", itemId: target.id, ...patch }), "Edit");

  const setPoint = (line: number, pointIndex: number, x: number, y: number): boolean =>
    run(() => ({ type: "setPoint", line, pointIndex, x, y }), "Move point of");

  const insertPoint = (line: number, pointIndex: number, x: number, y: number): boolean =>
    run(
      (target) => ({ type: "insertPoint", itemId: target.id, line, pointIndex, x, y }),
      "Add point to",
    );

  function history(which: "undo" | "redo"): boolean {
    if (options.frozen()) return false;
    const done = which === "undo" ? draft.undo() : draft.redo();
    if (done) say(null);
    return done;
  }

  return {
    item,
    editable,
    targets,
    several,
    editableItems,
    between,
    notice,
    flash,
    say,
    hold,
    report,
    nudge,
    duplicate,
    remove,
    reorder,
    setColour,
    combine,
    setMeta,
    setPoint,
    insertPoint,
    undo: () => history("undo"),
    redo: () => history("redo"),
  };
}

export type StudioEditing = ReturnType<typeof useStudioEditing>;
