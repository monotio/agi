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
 * The Keep moves the undo history into the new frame the same way, so an
 * undo past it puts a door back where it was.
 */

import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { BindingKind } from "../../../src/agent/authoringState.ts";
import { assembleAuthoredLogic } from "../../../src/agent/agentState.ts";
import { parseLogicResource } from "../../../src/logic/resource.ts";
import type { PictureDocument } from "../../../src/studio/pictureDocument.ts";
import { parseLogicDocument, type LogicDocument } from "../../../src/studio/rules/logicDocument.ts";
import {
  followedItem,
  followPictureEdit,
  itemTranslation,
} from "../../../src/studio/rules/ruleBinding.ts";
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

/**
 * The undo and redo steps, both ending nearest the present, and how many
 * steps a Keep has dropped from their far ends (the oldest undo steps, the
 * farthest redo steps). One value, so the shared undo order sees a drop and
 * the shorter stacks in one change (useUndoOrder `dropped`).
 */
interface LogicStacks {
  readonly past: readonly LogicState[];
  readonly future: readonly LogicState[];
  readonly dropped: { readonly past: number; readonly future: number };
}

export interface RoomLogicDraftOptions {
  /** The editable logic, or null when the room's logic is native or absent. */
  readonly base: MaybeRefOrGetter<LogicDraftBase | null>;
  /** What an edit assembles against: dictionary, profile and the game's bindings. */
  readonly session: () => RuleSession | null;
}

export type LogicOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** A door that followed art the picture no longer has: its label and the art's. */
export interface Unfollowed {
  readonly door: string;
  readonly art: string;
}

/** What a Keep says about doors that stopped following art. */
export function unfollowedText(doors: readonly Unfollowed[]): string {
  const [one] = doors;
  if (!one) return "";
  if (doors.length === 1) return `${one.door} stays put now: ${one.art} is gone from the picture.`;
  return `${doors.length} doors stay put now: the art they followed is gone (${doors
    .map(({ door, art }) => `${door}: ${art}`)
    .join(", ")}).`;
}

export function useRoomLogicDraft(options: RoomLogicDraftOptions) {
  const initial = toValue(options.base);
  const kept = shallowRef<LogicDraftBase | null>(initial);
  const current = shallowRef<LogicState | null>(initial && { ...initial, label: "" });
  const stacks = shallowRef<LogicStacks>({ past: [], future: [], dropped: { past: 0, future: 0 } });
  /** Replace the stacks; the drop count carries over. */
  const setStacks = (past: readonly LogicState[], future: readonly LogicState[]): void => {
    stacks.value = { past, future, dropped: stacks.value.dropped };
  };
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
      setStacks([], []);
      keptDepth.value = 0;
    },
  );

  const editable = computed(() => current.value !== null);
  const source = computed(() => current.value?.source ?? "");
  const bytes = computed(() => current.value?.bytes ?? null);
  const dirty = computed(() => current.value?.source !== kept.value?.source);
  const changes = computed(() =>
    dirty.value ? Math.max(1, Math.abs(stacks.value.past.length - keptDepth.value)) : 0,
  );
  const parsed = computed(() => parseLogicDocument(source.value));
  const document = computed<LogicDocument>(() => parsed.value.document);
  /**
   * Annotation problems in the source as it stands (duplicated, nested or
   * unterminated rules hide or stretch rule spans); applyRuleEdit refuses
   * every edit while one stands.
   */
  const diagnostics = computed(() => parsed.value.diagnostics);

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
    if (!at || !state) return { ok: false, error: "This room's logic is read-only here." };
    const result = applyRuleEdit(document.value, op, at);
    if (!result.ok) return result;
    if (Object.keys(result.newBindings).length > 0)
      reserved.value = { ...reserved.value, ...result.newBindings };
    setStacks([...stacks.value.past, state], []);
    current.value = { source: result.source, bytes: result.bytes, label };
    return { ok: true };
  }

  function step(which: "undo" | "redo"): boolean {
    const { past, future } = stacks.value;
    const from = which === "undo" ? past : future;
    const to = from.at(-1);
    if (!to || !current.value) return false;
    if (which === "undo") setStacks(from.slice(0, -1), [...future, current.value]);
    else setStacks([...past, current.value], from.slice(0, -1));
    current.value = to;
    return true;
  }

  /**
   * The logic a Keep writes for a picture going from `before` to `after`:
   * every door box that follows a moved item moves with it, and a door whose
   * item is gone from the picture stops following it (`unfollowed` names
   * them). A bound rule that cannot follow (native, or pushed off the
   * picture) refuses the whole Keep.
   */
  function forKeep(
    before: PictureDocument,
    after: PictureDocument,
  ):
    | {
        ok: true;
        source: string;
        bytes: Uint8Array;
        newBindings: Bindings;
        unfollowed: readonly Unfollowed[];
      }
    | LogicOutcome {
    const at = session();
    const state = current.value;
    if (!at || !state) return { ok: false, error: "This room's logic is read-only here." };
    const followed = followPictureEdit(document.value, before, after, at);
    if (!followed.ok) return followed;
    let { document: doc, source, bytes } = followed;
    const unfollowed: Unfollowed[] = [];
    for (const { rule, item } of followed.detached) {
      if (followedItem(after, item) !== null) continue;
      const messages = parseLogicResource(bytes).messages;
      const entry = readRules(doc, { messages, bindings: at.authoring.bindings }).find(
        (candidate) => candidate.rule.id === rule,
      );
      if (!entry || entry.model === "native") continue;
      const result = applyRuleEdit(
        doc,
        { op: "updateRule", id: rule, model: entry.model, item: null },
        at,
      );
      if (!result.ok) return result;
      ({ document: doc, source, bytes } = result);
      unfollowed.push({ door: entry.rule.label, art: followedItem(before, item)?.label ?? item });
    }
    return { ok: true, source, bytes, newBindings: reserved.value, unfollowed };
  }

  /**
   * `state` moved into the frame of the picture kept as `after` (it was
   * stored against `before`) by the follow the Keep made; null when the
   * follow refuses it (a box pushed off the picture).
   */
  function rebased(
    state: LogicState,
    frames: { before: PictureDocument; after: PictureDocument },
    at: RuleSession,
  ): LogicState | null {
    const followed = followPictureEdit(
      parseLogicDocument(state.source).document,
      frames.before,
      frames.after,
      at,
    );
    if (!followed.ok) return null;
    return followed.source === state.source
      ? state
      : { source: followed.source, bytes: followed.bytes, label: state.label };
  }

  /**
   * The game now holds `logic`: it is the new base; the history stays.
   * `frames`: the picture this Keep went from and to. Every undo and redo
   * step moves into the new frame by the same follow; a step that cannot
   * follow is dropped with every step beyond it, since the history would
   * otherwise skip over it.
   */
  function markKept(
    logic: LogicDraftBase,
    frames?: { before: PictureDocument; after: PictureDocument },
  ): void {
    kept.value = logic;
    current.value = { source: logic.source, bytes: logic.bytes, label: current.value?.label ?? "" };
    const at = frames && session();
    if (frames && at) {
      const carry = (steps: readonly LogicState[]): LogicState[] => {
        const out: LogicState[] = [];
        // Both stacks end nearest the present: a step that cannot follow ends the history there.
        for (const state of [...steps].reverse()) {
          const next = rebased(state, frames, at);
          if (!next) break;
          out.unshift(next);
        }
        return out;
      };
      const { past, future, dropped } = stacks.value;
      const keptPast = carry(past);
      const keptFuture = carry(future);
      stacks.value = {
        past: keptPast,
        future: keptFuture,
        dropped: {
          past: dropped.past + past.length - keptPast.length,
          future: dropped.future + future.length - keptFuture.length,
        },
      };
    }
    keptDepth.value = stacks.value.past.length;
  }

  /** Back to the last kept logic. */
  function discard(): void {
    current.value = kept.value && { ...kept.value, label: "" };
    setStacks([], []);
    keptDepth.value = 0;
  }

  return {
    kept,
    editable,
    source,
    bytes,
    document,
    diagnostics,
    rules,
    dirty,
    changes,
    reserved,
    session,
    canUndo: computed(() => stacks.value.past.length > 0),
    canRedo: computed(() => stacks.value.future.length > 0),
    past: computed(() => stacks.value.past.length),
    future: computed(() => stacks.value.future.length),
    /** Steps a Keep dropped from the far ends so far (useUndoOrder `dropped`). */
    dropped: computed(() => stacks.value.dropped),
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
