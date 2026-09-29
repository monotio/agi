/**
 * Room Studio's edit commands for the selection: nudge, duplicate, delete,
 * reorder, colour, label/kind/lock, single points (moved or added) and
 * Ungroup for one item; nudge, duplicate, delete, priority and Group for
 * several. Each is one kernel edit (a batch for several items) and one undo
 * step, and the short notice that says what was refused (with the refused
 * cells flashed on the canvas), or what else changed: another item's fill
 * that pours differently, which the edit's own undo step takes back. Draw
 * order moves one item at a time. A group takes the id of a member a door
 * follows, so the door follows the group (src/studio/rules/ruleBinding.ts
 * followedItem).
 */

import { computed, onScopeDispose, shallowRef, type Ref } from "vue";
import { limitMove, type EditOperation } from "../../../src/studio/editOperations.ts";
import {
  groupPart,
  itemRun,
  type PictureItem,
  type PictureItemKind,
} from "../../../src/studio/pictureDocument.ts";
import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import { followedItem } from "../../../src/studio/rules/ruleBinding.ts";
import { carriedPlanes, type StudioCheck } from "./studioLocks.ts";
import { sideEffectLine } from "../../../src/studio/sideEffects.ts";
import { keyLabel } from "../ui/keyLabel.ts";
import { edgeRefusal, movedWith, sideEffectNote } from "./studioMessages.ts";
import type { StudioLens } from "./studioView.ts";
import { freshItemId, itemIdFor, type DraftOutcome, type StudioDraft } from "./useStudioDraft.ts";
import { useStudioNotice, type NoticeAction, type StudioNotice } from "./useStudioNotice.ts";

/** How far Cmd/Ctrl+D offsets a copy, in logical pixels. */
const DUPLICATE_OFFSET = 4;
/** How long a refusal's cells stay highlighted. */
const FLASH_MS = 1600;
/** The undo key, as the side-effect note names it. */
const UNDO = keyLabel("Mod+Z");

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
  /** Select exactly these items: the copies after Duplicate, the group, or its parts after Ungroup. */
  readonly selectItems?: (ids: readonly string[]) => void;
  /** Editing is blocked (view only, or a Keep that needs a reload). */
  readonly frozen: () => boolean;
  /** Edits wait (an AI request or its proposal is open); undo and redo still run. */
  readonly paused?: () => boolean;
  /** The step a lock refusal offers: Unlock for now, or Allow depth. */
  readonly offer?: (check: StudioCheck) => NoticeAction | undefined;
  /** Doors that follow a picture item: their label and the item's id. */
  readonly doors?: () => readonly { readonly item: string; readonly label: string }[];
  /** The lens, for what a move carried that it does not show. */
  readonly lens?: () => StudioLens;
}) {
  const { draft, selectedId } = options;
  const { notice, say, dismiss } = useStudioNotice();
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

  /** The last side-effect note shown; the next edit clears it. */
  let spilled: StudioNotice | null = null;

  /**
   * Show what an edit did: a refusal's reason (and its cells), what else it
   * changed (its side effects on other items), or nothing.
   */
  function report(outcome: DraftOutcome): void {
    if (outcome.ok) {
      if (outcome.sideEffects) {
        spilled = {
          tone: "ok",
          text: sideEffectNote(outcome.sideEffects, UNDO),
          detail: sideEffectLine(outcome.sideEffects),
        };
        say(spilled);
      } else if (notice.value?.tone === "warn" || notice.value === spilled) say(null);
      return;
    }
    const { refusal } = outcome;
    const action = refusal.kind === "lock" ? options.offer?.(refusal.check) : undefined;
    say({ tone: "warn", text: refusal.message, detail: refusal.detail, action });
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

  /** Nudge the selection by dx,dy, stopping at the picture's edge (limitMove). */
  function nudge(dx: number, dy: number): boolean {
    const ids = several.value
      ? editableItems.value.map((target) => target.id)
      : editable.value
        ? [editable.value.id]
        : [];
    if (ids.length === 0) return false;
    const limit = limitMove(draft.document.value, ids, dx, dy);
    const stop = limit.stops[0];
    if (stop && limit.dx === 0 && limit.dy === 0) {
      const refusal = edgeRefusal(draft.document.value, stop, dx, dy);
      report({ ok: false, refusal: { kind: "kernel", ...refusal } });
      return false;
    }
    const move = (target: PictureItem): EditOperation => ({
      type: "moveItem",
      itemId: target.id,
      dx: limit.dx,
      dy: limit.dy,
    });
    const done = several.value ? runAll(move, "Nudge") : run(move, "Nudge");
    if (done) carried(ids);
    return done;
  }

  /** After items `ids` moved: say which planes the lens hides they took along, if any. */
  function carried(ids: readonly string[]): void {
    const lens = options.lens?.();
    if (!lens) return;
    const items = draft.document.value.items.filter((candidate) => ids.includes(candidate.id));
    const what = items.length === 1 ? items[0]!.label : `${items.length} items`;
    const text = movedWith(what, items.length > 1, carriedPlanes(draft.compiled.value, ids, lens));
    if (!text) return;
    // A move that also changed other items keeps saying so.
    const also = notice.value !== null && notice.value === spilled ? spilled : null;
    const next: StudioNotice = also
      ? { ...also, text: `${text} ${also.text}` }
      : { tone: "ok", text };
    if (also) spilled = next;
    say(next);
  }

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

  /** The items between the selected ones that Group would need too, in draw order. */
  const between = computed(() =>
    itemRun(
      draft.document.value,
      targets.value.map((t) => t.id),
    ),
  );

  /**
   * Group: the selected neighbours become one item named `label`, with the
   * same bytes. Refused (with a notice) for items that are not neighbours in
   * the draw order.
   */
  function combine(label: string): boolean {
    const list = editableItems.value;
    if (list.length < 2) return false;
    const name = label.trim() || "Group";
    const ids = list.map((target) => target.id);
    const followed = new Set(options.doors?.().map((door) => door.item));
    const id =
      ids.find((member) => followed.has(member)) ?? itemIdFor(draft.document.value, name, ids);
    const outcome = draft.apply(
      { type: "combineItems", itemIds: ids, id, label: name },
      `Group ${name}`,
    );
    report(outcome);
    if (outcome.ok) select([id]);
    return outcome.ok;
  }

  /** The selected item was grouped here: its members' own items wait inside it. */
  const grouped = computed(() => {
    const target = item.value;
    if (!target) return false;
    const lines = draft.document.value.lines.slice(target.openLine, target.closeLine - 1);
    return lines.some((line) => groupPart(line) !== undefined);
  });

  /**
   * Ungroup: the selected item becomes separate items again, its members as
   * they were grouped or one per drawing element, with the same bytes; they
   * are selected after.
   */
  function ungroup(): boolean {
    const target = editable.value;
    if (!target || several.value) return false;
    const was = draft.document.value;
    const before = new Set(was.items.map((entry) => entry.id));
    const outcome = draft.apply(
      { type: "ungroupItem", itemId: target.id },
      `Ungroup ${target.label}`,
    );
    report(outcome);
    if (!outcome.ok) return false;
    const document = draft.document.value;
    const inside = document.items.filter(
      (entry) => !before.has(entry.id) || entry.id === target.id,
    );
    select(inside.map((entry) => entry.id));
    // Split into drawing elements, a member a door followed has no id any more.
    for (const door of options.doors?.() ?? []) {
      const art = followedItem(was, door.item);
      if (!art || followedItem(document, door.item)) continue;
      say({
        tone: "warn",
        text: `${door.label} stays put now: Ungroup split ${art.label} into drawing elements.`,
      });
      break;
    }
    return true;
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
    carried,
    flash,
    say,
    dismiss,
    report,
    nudge,
    duplicate,
    remove,
    reorder,
    setColour,
    combine,
    grouped,
    ungroup,
    setMeta,
    setPoint,
    insertPoint,
    undo: () => history("undo"),
    redo: () => history("redo"),
  };
}

export type StudioEditing = ReturnType<typeof useStudioEditing>;
