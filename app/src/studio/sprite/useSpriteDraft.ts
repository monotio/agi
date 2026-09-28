/**
 * Sprite Studio's working draft: the VIEW document being edited
 * (src/view/spriteDocument.ts), its undo history over encoded
 * payloads (spriteHistory.ts), and the bytes and resource revision last kept
 * (or opened). Every edit goes through the kernel (`applySpriteEdit`), then
 * `validateSpriteEdit` with the loops the edit targets, so an accidental
 * change to any other loop is refused; a refused edit changes nothing and
 * says why. A stroke or drag is one gesture: `move` previews each candidate
 * from the document the gesture started on, and `end` records one undo step
 * or snaps back. Keep rebases the draft but keeps its history. An untouched
 * draft holds the opened bytes themselves, so closing it writes nothing.
 */

import { computed, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { ResourceRevision } from "../../../../src/gameIdentity.ts";
import {
  assistRefusalText,
  checkCandidate,
  type ViewAssistScope,
} from "../../../../src/studio/assistScope.ts";
import {
  openSprite,
  samePixels,
  withPayload,
  type SpriteDocument,
  type SpriteProfile,
} from "../../../../src/view/spriteDocument.ts";
import {
  begin,
  cancelSpriteGesture,
  commit,
  createSpriteHistory,
  recordSpriteEdit,
  redoSprite,
  undoSprite,
} from "../../../../src/studio/sprite/spriteHistory.ts";
import {
  applySpriteEdit,
  type SpriteEdit,
} from "../../../../src/studio/sprite/spriteOperations.ts";
import {
  validateSpriteEdit,
  type SpriteValidation,
} from "../../../../src/studio/sprite/spriteValidation.ts";
import type { EditHistory } from "../../../../src/studio/editHistory.ts";
import { changeCount } from "../useStudioDraft.ts";
import { plainSpriteRefusal, validationRefusal } from "./spriteMessages.ts";

/** What the draft starts from: the VIEW bytes Studio opened on and their revision. */
export interface SpriteDraftBase {
  readonly bytes: Uint8Array;
  /** The booted resource revision; undefined when the view cannot be kept. */
  readonly revision: ResourceRevision | undefined;
}

/** Why an edit did not happen: `message` in plain words, `detail` the technical account. */
export interface SpriteRefusal {
  readonly message: string;
  readonly detail?: string | undefined;
  /** The validation that refused it, when it was the loop check. */
  readonly check?: SpriteValidation | undefined;
}

export type SpriteOutcome =
  | {
      readonly ok: true;
      /** Loops split from a shared data block by this edit (copy-on-write). */
      readonly isolated: readonly number[];
    }
  | { readonly ok: false; readonly refusal: SpriteRefusal };

/** An edit and the loops it may change (validateSpriteEdit's `targetLoops`). */
export interface SpriteChange {
  readonly op: SpriteEdit;
  /** The loops the edit targets; undefined skips the target check (loop insertions and removals renumber loops). */
  readonly targets: readonly number[] | undefined;
}

type Candidate = { readonly document: SpriteDocument; readonly isolated: readonly number[] };

export function useSpriteDraft(options: {
  readonly base: MaybeRefOrGetter<SpriteDraftBase>;
  readonly profile: MaybeRefOrGetter<SpriteProfile>;
}) {
  const initial = toValue(options.base);
  /** The bytes and revision the game holds: the last Keep, or what Studio opened. */
  const kept = shallowRef<SpriteDraftBase>(initial);
  const document = shallowRef<SpriteDocument>(openSprite(initial.bytes, toValue(options.profile)));
  const history = shallowRef<EditHistory>(createSpriteHistory(document.value));
  /** The accepted candidate of the open gesture; null shows the document itself. */
  const preview = shallowRef<SpriteDocument | null>(null);
  /** The document the open gesture started from. */
  let gestureBase: SpriteDocument | null = null;
  /** The last refusal; cleared by the next accepted edit. */
  const refusal = shallowRef<SpriteRefusal | null>(null);
  /** Loops the last accepted edit split from a shared block. */
  const isolated = shallowRef<readonly number[]>([]);
  /** How many undo steps the history held when the draft was last kept (or opened). */
  const keptDepth = shallowRef(0);

  /** What the canvas and previews show: the gesture's preview, else the document. */
  const shown = computed(() => preview.value ?? document.value);
  const bytes = computed(() => document.value.payload);
  const dirty = computed(() => !samePixels(document.value.payload, kept.value.bytes));
  const changes = computed(() =>
    dirty.value ? Math.max(1, Math.abs(history.value.past.length - keptDepth.value)) : 0,
  );
  const gesturing = computed(() => history.value.gesture !== undefined);
  const canUndo = computed(() => !gesturing.value && history.value.past.length > 0);
  const canRedo = computed(() => !gesturing.value && history.value.future.length > 0);

  function reset(base: SpriteDraftBase): void {
    kept.value = base;
    document.value = openSprite(base.bytes, toValue(options.profile));
    history.value = createSpriteHistory(document.value);
    keptDepth.value = 0;
    preview.value = null;
    gestureBase = null;
    refusal.value = null;
    isolated.value = [];
  }
  watch(
    () => toValue(options.base),
    (base, old) => {
      if (base.bytes !== old.bytes || base.revision !== old.revision) reset(base);
    },
  );

  /** Run the edit on `from`: the kernel, then the loop check. Nothing is recorded. */
  function evaluate(from: SpriteDocument, change: SpriteChange): Candidate | SpriteRefusal {
    const result = applySpriteEdit(from, change.op);
    if ("error" in result)
      return { message: plainSpriteRefusal(result.error), detail: result.error };
    const check = validateSpriteEdit(
      from,
      result.document,
      change.targets ? { targetLoops: change.targets } : {},
    );
    if (!check.ok)
      return {
        message: validationRefusal(check),
        detail: check.violations.map((violation) => violation.message).join("\n"),
        check,
      };
    return result;
  }
  const refused = (candidate: Candidate | SpriteRefusal): candidate is SpriteRefusal =>
    "message" in candidate;

  function refuse(reason: SpriteRefusal): SpriteOutcome {
    refusal.value = reason;
    return { ok: false, refusal: reason };
  }

  function accept(candidate: Candidate): SpriteOutcome {
    refusal.value = null;
    isolated.value = candidate.isolated;
    return { ok: true, isolated: candidate.isolated };
  }

  /** One edit, one undo step. */
  function apply(change: SpriteChange, label: string): SpriteOutcome {
    return applyAll([change], label);
  }

  /**
   * Edits in order as one undo step (a cel moved to another loop is a copy
   * and a delete): each runs on the last one's result through the kernel and
   * its own loop check, and a refusal of any changes nothing.
   */
  function applyAll(changes: readonly SpriteChange[], label: string): SpriteOutcome {
    if (gesturing.value) return refuse({ message: "Finish the stroke first." });
    let next = document.value;
    const split = new Set<number>();
    for (const change of changes) {
      const candidate = evaluate(next, change);
      if (refused(candidate)) return refuse(candidate);
      next = candidate.document;
      for (const loop of candidate.isolated) split.add(loop);
    }
    const candidate = { document: next, isolated: [...split].sort((a, b) => a - b) };
    if (next === document.value) return accept(candidate);
    const recorded = recordSpriteEdit(history.value, label, document.value, next);
    if (!recorded.ok)
      return refuse({ message: "The view changed outside Studio.", detail: recorded.reason });
    history.value = recorded.history;
    document.value = next;
    return accept(candidate);
  }

  /**
   * Adopt an accepted AI candidate's VIEW bytes as one undo step. The
   * candidate passed its scope (assistScope.ts) when it was proposed; it
   * must still pass it against the draft now, and the loop check a manual
   * edit of the targeted loops passes (validateSpriteEdit): both verdicts
   * must agree, or nothing changes.
   */
  function adopt(payload: Uint8Array, label: string, scope: ViewAssistScope): SpriteOutcome {
    if (gesturing.value) return refuse({ message: "Finish the stroke first." });
    let next: SpriteDocument;
    try {
      next = withPayload(document.value, payload);
    } catch (error) {
      return refuse({ message: "The proposal doesn't decode any more.", detail: String(error) });
    }
    const scoped = checkCandidate(document.value, next, scope);
    if (!scoped.ok)
      return refuse({
        message: "The proposal no longer fits its scope. Ask again.",
        detail: assistRefusalText(scoped),
      });
    const targets = [...new Set(scope.targetCels.map(({ loop }) => loop))];
    const check = validateSpriteEdit(document.value, next, { targetLoops: targets });
    if (!check.ok)
      return refuse({
        message: validationRefusal(check),
        detail: check.violations.map((violation) => violation.message).join("\n"),
        check,
      });
    const recorded = recordSpriteEdit(history.value, label, document.value, next);
    if (!recorded.ok)
      return refuse({
        message: "The view changed while the AI worked. Ask again.",
        detail: recorded.reason,
      });
    history.value = recorded.history;
    document.value = next;
    return accept({ document: next, isolated: [] });
  }

  /** Open a gesture (a stroke or drag); its edits undo as one step. */
  function beginGesture(label: string): void {
    history.value = begin(history.value, label);
    gestureBase = document.value;
    preview.value = null;
  }

  /** Preview the change from the gesture's start; a refusal snaps the preview back. */
  function moveGesture(change: SpriteChange): SpriteOutcome {
    if (!gestureBase) return { ok: true, isolated: [] };
    const candidate = evaluate(gestureBase, change);
    if (refused(candidate)) {
      preview.value = null;
      return refuse(candidate);
    }
    preview.value = candidate.document;
    refusal.value = null;
    return { ok: true, isolated: candidate.isolated };
  }

  /** Close the gesture with `change`: one undo step, or back to where it started. */
  function endGesture(change: SpriteChange | null, label: string): SpriteOutcome {
    const start = gestureBase;
    gestureBase = null;
    preview.value = null;
    if (!gesturing.value || !start) return { ok: true, isolated: [] };
    const candidate = change === null ? null : evaluate(start, change);
    if (candidate === null || refused(candidate)) {
      const back = cancelSpriteGesture(history.value, document.value);
      if (back.ok) history.value = back.history;
      return candidate === null ? { ok: true, isolated: [] } : refuse(candidate);
    }
    const recorded = recordSpriteEdit(history.value, label, start, candidate.document);
    history.value = commit(recorded.ok ? recorded.history : history.value);
    if (recorded.ok) document.value = candidate.document;
    return accept(candidate);
  }

  /** Abandon the gesture (pointer cancel, Escape): nothing changes. */
  function cancelGesture(): void {
    endGesture(null, "");
  }

  function step(which: "undo" | "redo"): boolean {
    const result = (which === "undo" ? undoSprite : redoSprite)(history.value, document.value);
    if (!result.ok) return false;
    history.value = result.history;
    document.value = result.document;
    refusal.value = null;
    isolated.value = [];
    return true;
  }

  /**
   * The game now holds the draft at `revision`: it is the new base. The undo
   * history stays, so undoing past a Keep is an unkept change like any other.
   */
  function markKept(revision: ResourceRevision): void {
    kept.value = { bytes: document.value.payload, revision };
    keptDepth.value = history.value.past.length;
    refusal.value = null;
  }

  /** Throw the changes away: back to the last kept bytes. */
  function discard(): void {
    reset(kept.value);
  }

  return {
    kept,
    document,
    history,
    preview,
    shown,
    bytes,
    refusal,
    isolated,
    dirty,
    changes,
    gesturing,
    canUndo,
    canRedo,
    evaluate: (change: SpriteChange) => evaluate(document.value, change),
    apply,
    applyAll,
    adopt,
    beginGesture,
    moveGesture,
    endGesture,
    cancelGesture,
    undo: () => step("undo"),
    redo: () => step("redo"),
    markKept,
    discard,
    reset,
    /** The Keep log's words for the changes: "1 change", "3 changes". */
    reason: () => changeCount(changes.value, false),
  };
}

export type SpriteDraft = ReturnType<typeof useSpriteDraft>;

/** Development and test builds: the draft's VIEW bytes on `window.__AGI_SPRITE__` for browser tests. */
export function exposeSpriteDraft(draft: SpriteDraft): void {
  if (!import.meta.env?.DEV) return;
  const hook = { bytes: () => draft.bytes.value.slice() };
  window.__AGI_SPRITE__ = hook;
  onScopeDispose(() => {
    if (window.__AGI_SPRITE__ === hook) delete window.__AGI_SPRITE__;
  });
}
