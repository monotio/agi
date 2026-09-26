/**
 * The room's LOGIC as Room Studio's Walk view edits it: the annotated
 * source (`// @rule` door and edge exit fragments), its assembled bytes and
 * the flag names its edits reserved, with an undo history, against the text
 * last kept (or opened). Every edit is one kernel rule edit
 * (src/studio/rules/ruleEdit.ts applyRuleEdit), which proves the whole
 * logic still assembles; a refused edit changes nothing and says why.
 * Native logic the kernel cannot read is never edited here.
 *
 * Door boxes are stored in the frame of the picture as last kept: a box that
 * follows a picture item shows moved by that item's unkept translation, and
 * the Keep moves it for real (followPictureEdit), so the picture and logic
 * land together. `toStored` and `toShown` convert between the two frames.
 */

import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { BindingKind } from "../../../src/agent/authoringState.ts";
import { assembleAuthoredLogic } from "../../../src/agent/tools.ts";
import type { PictureDocument } from "../../../src/studio/pictureDocument.ts";
import { parseLogicDocument, type LogicDocument } from "../../../src/studio/rules/logicDocument.ts";
import { followPictureEdit, itemTranslation } from "../../../src/studio/rules/ruleBinding.ts";
import {
  applyRuleEdit,
  type RuleEditOp,
  type RuleSession,
} from "../../../src/studio/rules/ruleEdit.ts";
import { readRules, type RuleBox } from "../../../src/studio/rules/ruleModel.ts";

export type Bindings = Readonly<Record<string, { kind: BindingKind; num: number }>>;

/** The logic Studio opened on (or last kept): its annotated text and bytes. */
export interface LogicDraftBase {
  readonly source: string;
  readonly bytes: Uint8Array;
}

interface LogicState extends LogicDraftBase {
  readonly label: string;
}

export interface RoomLogicDraftOptions {
  /** The editable logic, or null when the room's logic is native or absent. */
  readonly base: MaybeRefOrGetter<LogicDraftBase | null>;
  /** What an edit assembles against: dictionary, profile and the game's bindings. */
  readonly session: () => RuleSession | null;
}

export type LogicOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function useRoomLogicDraft(options: RoomLogicDraftOptions) {
  const initial = toValue(options.base);
  const kept = shallowRef<LogicDraftBase | null>(initial);
  const current = shallowRef<LogicState | null>(initial && { ...initial, label: "" });
  const past = shallowRef<readonly LogicState[]>([]);
  const future = shallowRef<readonly LogicState[]>([]);
  /** Flag names this Studio reserved (kept or not); a Keep stores them with the logic. */
  const reserved = shallowRef<Bindings>({});
  /** How many undo steps the history held when the logic was last kept (or opened). */
  const keptDepth = shallowRef(0);

  watch(
    () => toValue(options.base),
    (base, old) => {
      if (base?.source === old?.source) return;
      kept.value = base;
      current.value = base && { ...base, label: "" };
      past.value = [];
      future.value = [];
      keptDepth.value = 0;
    },
  );

  const editable = computed(() => current.value !== null);
  const source = computed(() => current.value?.source ?? "");
  const bytes = computed(() => current.value?.bytes ?? null);
  const dirty = computed(() => current.value?.source !== kept.value?.source);
  const changes = computed(() =>
    dirty.value ? Math.max(1, Math.abs(past.value.length - keptDepth.value)) : 0,
  );
  const document = computed<LogicDocument>(() => parseLogicDocument(source.value).document);

  /** The session edits assemble against: the game's bindings plus the ones reserved here. */
  function session(): RuleSession | null {
    const base = options.session();
    if (!base) return null;
    return {
      ...base,
      authoring: { ...base.authoring, bindings: { ...base.authoring.bindings, ...reserved.value } },
    };
  }

  /** Every annotated rule with its model; message numbers resolve through the assembled logic. */
  const rules = computed(() => {
    const at = session();
    if (!at || !current.value) return [];
    let messages: readonly (string | null)[];
    try {
      messages = assembleAuthoredLogic(at, source.value).messages;
    } catch {
      messages = [];
    }
    return readRules(document.value, { messages, bindings: at.authoring.bindings });
  });

  /** One rule edit, one undo step. */
  function apply(op: RuleEditOp, label: string): LogicOutcome {
    const at = session();
    const state = current.value;
    if (!at || !state) return { ok: false, error: "This room's logic can't be edited here." };
    const result = applyRuleEdit(document.value, op, at);
    if (!result.ok) return result;
    if (Object.keys(result.newBindings).length > 0)
      reserved.value = { ...reserved.value, ...result.newBindings };
    past.value = [...past.value, state];
    future.value = [];
    current.value = { source: result.source, bytes: result.bytes, label };
    return { ok: true };
  }

  function step(which: "undo" | "redo"): boolean {
    const from = which === "undo" ? past.value : future.value;
    const to = from.at(-1);
    if (!to || !current.value) return false;
    if (which === "undo") {
      past.value = from.slice(0, -1);
      future.value = [...future.value, current.value];
    } else {
      future.value = from.slice(0, -1);
      past.value = [...past.value, current.value];
    }
    current.value = to;
    return true;
  }

  /**
   * The logic a Keep writes for a picture going from `before` to `after`:
   * every door box that follows a moved item moves with it. A bound rule
   * that cannot follow (native, or pushed off the picture) refuses the
   * whole Keep.
   */
  function forKeep(
    before: PictureDocument,
    after: PictureDocument,
  ): { ok: true; source: string; bytes: Uint8Array; newBindings: Bindings } | LogicOutcome {
    const at = session();
    const state = current.value;
    if (!at || !state) return { ok: false, error: "This room's logic can't be edited here." };
    const followed = followPictureEdit(document.value, before, after, at);
    if (!followed.ok) return followed;
    return {
      ok: true,
      source: followed.source,
      bytes: followed.bytes,
      newBindings: reserved.value,
    };
  }

  /** The game now holds `logic`: it is the new base; the history stays. */
  function markKept(logic: LogicDraftBase): void {
    kept.value = logic;
    current.value = { ...logic, label: current.value?.label ?? "" };
    keptDepth.value = past.value.length;
  }

  /** Back to the last kept logic. */
  function discard(): void {
    current.value = kept.value && { ...kept.value, label: "" };
    past.value = [];
    future.value = [];
    keptDepth.value = 0;
  }

  return {
    kept,
    editable,
    source,
    bytes,
    document,
    rules,
    dirty,
    changes,
    reserved,
    session,
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    past: computed(() => past.value.length),
    future: computed(() => future.value.length),
    apply,
    undo: () => step("undo"),
    redo: () => step("redo"),
    forKeep,
    markKept,
    discard,
  };
}

export type RoomLogicDraft = ReturnType<typeof useRoomLogicDraft>;

/**
 * A stored door box as the Walk view shows it: moved by its item's unkept
 * translation from the kept picture to the one on screen.
 */
export function toShown(
  box: RuleBox,
  item: string | null,
  kept: PictureDocument,
  shown: PictureDocument,
): RuleBox {
  const move = item === null ? null : itemTranslation(kept, shown, item);
  if (!move || (move.dx === 0 && move.dy === 0)) return box;
  return { x1: box.x1 + move.dx, y1: box.y1 + move.dy, x2: box.x2 + move.dx, y2: box.y2 + move.dy };
}

/** A box placed on screen, stored in the kept picture's frame (toShown's inverse). */
export function toStored(
  box: RuleBox,
  item: string | null,
  kept: PictureDocument,
  shown: PictureDocument,
): RuleBox {
  const move = item === null ? null : itemTranslation(kept, shown, item);
  if (!move || (move.dx === 0 && move.dy === 0)) return box;
  return { x1: box.x1 - move.dx, y1: box.y1 - move.dy, x2: box.x2 - move.dx, y2: box.y2 - move.dy };
}
