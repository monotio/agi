/**
 * Room Studio's working draft: the picture text being edited, its undo
 * history, the compiled result and the last check, all against the text and
 * resource revision last kept (or opened). Every edit goes through the kernel
 * (applyEdit), then the lens locks (studioLocks.ts); a refused edit changes
 * nothing and says why. A drag is one gesture: `move` previews each frame's
 * candidate from the text the gesture started on, and `end` records one undo
 * step or snaps back.
 */

import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import {
  begin,
  cancel,
  commit,
  createHistory,
  record,
  redo as redoStep,
  undo as undoStep,
  type EditHistory,
} from "../../../src/studio/editHistory.ts";
import { applyEdit, type EditOperation } from "../../../src/studio/editOperations.ts";
import { compileEditDocument, type CompiledDocument } from "../../../src/studio/editValidation.ts";
import {
  parsePictureDocument,
  pictureItemAtLine,
  PICTURE_ITEM_ID,
  serializePictureDocument,
  type PictureDocument,
} from "../../../src/studio/pictureDocument.ts";
import {
  checkStudioEdit,
  violationCells,
  type LensUnlocks,
  type StudioCheck,
} from "./studioLocks.ts";
import type { StudioLens } from "./studioView.ts";

/** What the draft starts from: the text Studio opened on and its revision. */
export interface DraftBase {
  readonly source: string;
  /** The booted resource revision; undefined when the picture cannot be kept. */
  readonly revision: ResourceRevision | undefined;
}

export interface StudioDraftOptions {
  readonly base: MaybeRefOrGetter<DraftBase>;
  readonly profile: MaybeRefOrGetter<AgiProfile>;
  readonly lens: MaybeRefOrGetter<StudioLens>;
  readonly unlocks: MaybeRefOrGetter<LensUnlocks>;
}

/** Why an edit did not happen. */
export type DraftRefusal =
  | { readonly kind: "kernel"; readonly message: string }
  | {
      readonly kind: "lock";
      readonly message: string;
      readonly check: StudioCheck;
      /** The cells that broke a rule, for the canvas flash. */
      readonly cells: Uint8Array;
    };

/** A candidate the draft accepted: the edited document, compiled. */
export interface DraftCandidate {
  readonly source: string;
  readonly document: PictureDocument;
  readonly compiled: CompiledDocument;
}

export type DraftOutcome =
  { readonly ok: true } | { readonly ok: false; readonly refusal: DraftRefusal };

/** An id not used in `document`, derived from `base` ("bench-copy", "bench-copy-2"). */
export function freshItemId(document: PictureDocument, base: string): string {
  const stem = `${base.slice(0, 24)}-copy`.replace(/^[^a-z]+/, "item-");
  const used = new Set(document.items.map((item) => item.id));
  for (let n = 1; ; n++) {
    const id = n === 1 ? stem : `${stem}-${n}`;
    if (!used.has(id) && PICTURE_ITEM_ID.test(id)) return id;
  }
}

/** The items an operation edits: their footprints are the cells it may change. */
export function editedItems(document: PictureDocument, op: EditOperation): string[] {
  switch (op.type) {
    case "setPoint": {
      const item = pictureItemAtLine(document, op.line);
      return item ? [item.id] : [];
    }
    case "duplicateItem":
      return [op.itemId, op.newId];
    case "insertShape":
    case "insertFill":
    case "insertPlot":
      return [op.id];
    default:
      return [op.itemId];
  }
}

export function useStudioDraft(options: StudioDraftOptions) {
  const profile = (): AgiProfile => toValue(options.profile);
  const initial = toValue(options.base);
  /** The text and revision the game holds: the last Keep, or what Studio opened. */
  const kept = shallowRef<DraftBase>(initial);
  const history = shallowRef<EditHistory>(createHistory(initial.source));
  /** The accepted candidate of the open gesture; null shows the draft itself. */
  const preview = shallowRef<DraftCandidate | null>(null);
  /** The last refusal; cleared by the next accepted edit. */
  const refusal = shallowRef<DraftRefusal | null>(null);
  /** The last candidate's check. */
  const validation = shallowRef<StudioCheck | null>(null);

  const source = computed(() => history.value.current);
  const document = computed(() => parsePictureDocument(source.value).document);
  const compiled = computed(() => compileEditDocument(document.value, profile()));
  const dirty = computed(() => source.value !== kept.value.source);
  /** Undo steps since the last Keep that still differ from it. */
  const changes = computed(() => (dirty.value ? Math.max(1, history.value.past.length) : 0));
  const gesturing = computed(() => history.value.gesture !== undefined);
  const canUndo = computed(() => !gesturing.value && history.value.past.length > 0);
  const canRedo = computed(() => !gesturing.value && history.value.future.length > 0);

  function reset(base: DraftBase): void {
    kept.value = base;
    history.value = createHistory(base.source);
    preview.value = null;
    refusal.value = null;
    validation.value = null;
  }
  watch(
    () => toValue(options.base),
    (base, old) => {
      if (base.source !== old.source || base.revision !== old.revision) reset(base);
    },
  );

  /** Run `op` on the draft: the kernel, then the locks. Nothing is recorded. */
  function evaluate(op: EditOperation): DraftCandidate | DraftRefusal {
    const result = applyEdit(document.value, op, { profile: profile() });
    if ("error" in result) return { kind: "kernel", message: result.error };
    const after = compileEditDocument(result.document, profile());
    const edited = [
      ...new Set([...editedItems(document.value, op), ...editedItems(result.document, op)]),
    ];
    const check = checkStudioEdit(
      compiled.value,
      after,
      edited,
      toValue(options.lens),
      toValue(options.unlocks),
    );
    validation.value = check;
    if (!check.ok)
      return {
        kind: "lock",
        message: check.violations.map((violation) => violation.message).join(" "),
        check,
        cells: violationCells(check),
      };
    return {
      source: serializePictureDocument(result.document),
      document: result.document,
      compiled: after,
    };
  }

  const refused = (candidate: DraftCandidate | DraftRefusal): candidate is DraftRefusal =>
    "kind" in candidate;

  function refuse(reason: DraftRefusal): DraftOutcome {
    refusal.value = reason;
    return { ok: false, refusal: reason };
  }

  /** One edit, one undo step. */
  function apply(op: EditOperation, label: string): DraftOutcome {
    if (gesturing.value) return refuse({ kind: "kernel", message: "Finish the drag first." });
    const candidate = evaluate(op);
    if (refused(candidate)) return refuse(candidate);
    const recorded = record(history.value, label, source.value, candidate.source);
    if (!recorded.ok) return refuse({ kind: "kernel", message: recorded.reason });
    history.value = recorded.history;
    refusal.value = null;
    return { ok: true };
  }

  /** Open a gesture (a drag); its edits undo as one step. */
  function beginGesture(label: string): void {
    history.value = begin(history.value, label);
    preview.value = null;
  }

  /** Preview `op` from the gesture's start; a refusal snaps the preview back. */
  function moveGesture(op: EditOperation): DraftOutcome {
    const candidate = evaluate(op);
    if (refused(candidate)) {
      preview.value = null;
      return refuse(candidate);
    }
    preview.value = candidate;
    refusal.value = null;
    return { ok: true };
  }

  /** Close the gesture with `op`: one undo step, or back to where it started. */
  function endGesture(op: EditOperation | null, label: string): DraftOutcome {
    if (!gesturing.value) return { ok: true };
    const candidate = op === null ? null : evaluate(op);
    preview.value = null;
    if (candidate === null || refused(candidate)) {
      const back = cancel(history.value, source.value);
      if (back.ok) history.value = back.history;
      return candidate === null ? { ok: true } : refuse(candidate);
    }
    const recorded = record(history.value, label, source.value, candidate.source);
    history.value = commit(recorded.ok ? recorded.history : history.value);
    refusal.value = null;
    return { ok: true };
  }

  /** Abandon the gesture (pointer cancel, Escape): nothing changes. */
  function cancelGesture(): void {
    endGesture(null, "");
  }

  function step(which: "undo" | "redo"): boolean {
    const result = (which === "undo" ? undoStep : redoStep)(history.value, source.value);
    if (!result.ok) return false;
    history.value = result.history;
    refusal.value = null;
    return true;
  }

  /** The game now holds the draft at `revision`: it is the new base, with a fresh history. */
  function markKept(revision: ResourceRevision): void {
    reset({ source: source.value, revision });
  }

  /** Throw the changes away: back to the last kept text. */
  function discard(): void {
    reset(kept.value);
  }

  return {
    kept,
    history,
    source,
    document,
    compiled,
    preview,
    refusal,
    validation,
    dirty,
    changes,
    gesturing,
    canUndo,
    canRedo,
    apply,
    evaluate,
    beginGesture,
    moveGesture,
    endGesture,
    cancelGesture,
    undo: () => step("undo"),
    redo: () => step("redo"),
    markKept,
    discard,
    reset,
  };
}

export type StudioDraft = ReturnType<typeof useStudioDraft>;
