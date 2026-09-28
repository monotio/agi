/**
 * Room Studio's working draft: the picture text being edited, its undo
 * history, the compiled result and the last check, all against the text and
 * resource revision last kept (or opened). Every edit goes through the kernel
 * (applyEdits), then the lens locks (studioLocks.ts); a refused edit changes
 * nothing and says why. An edit is one operation or a batch (a
 * multi-selection's move, copy or delete): a batch is checked as one edit of
 * all its items and recorded as one undo step, or refused whole. A drag is one gesture: `move` previews each frame's
 * candidate from the text the gesture started on, and `end` records one undo
 * step or snaps back. Keep rebases the draft but keeps its history. A draft
 * whose compiled bytes equal the kept ones differs only in its notes (labels,
 * kinds, locks, annotations): Keep then saves the text without a patch.
 */

import { computed, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { PictureEdit } from "../project/resourceCommit.ts";
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
import {
  assistRefusalText,
  checkCandidate,
  type PictureAssistScope,
} from "../../../src/studio/assistScope.ts";
import { applyEdits, type EditOperation } from "../../../src/studio/editOperations.ts";
import { compileEditDocument, type CompiledDocument } from "../../../src/studio/editValidation.ts";
import {
  parsePictureDocument,
  pictureItemAtLine,
  PICTURE_ITEM_ID,
  serializePictureDocument,
  type PictureDocument,
} from "../../../src/studio/pictureDocument.ts";
import { kernelDetail, plainKernelRefusal } from "./studioMessages.ts";
import {
  checkStudioEdit,
  refusalText,
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

/** Why an edit did not happen: `message` in plain words, `detail` the technical account. */
export type DraftRefusal =
  | { readonly kind: "kernel"; readonly message: string; readonly detail?: string }
  | {
      readonly kind: "lock";
      readonly message: string;
      readonly detail: string;
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

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The draft's unkept changes for a label: "1 change", "2 changes", "1 note change". */
export function changeCount(changes: number, notesOnly: boolean): string {
  return `${changes} ${notesOnly ? "note " : ""}${changes === 1 ? "change" : "changes"}`;
}

/** An id not used in `document`, derived from `base` ("bench-copy", "bench-copy-2"). */
export function freshItemId(document: PictureDocument, base: string): string {
  const stem = `${base.slice(0, 24)}-copy`.replace(/^[^a-z]+/, "item-");
  const used = new Set(document.items.map((item) => item.id));
  for (let n = 1; ; n++) {
    const id = n === 1 ? stem : `${stem}-${n}`;
    if (!used.has(id) && PICTURE_ITEM_ID.test(id)) return id;
  }
}

/**
 * An id for an item named `label` ("Red box" → "red-box"): unused in
 * `document`, or one of `members` (the items it replaces), else numbered.
 */
export function itemIdFor(
  document: PictureDocument,
  label: string,
  members: readonly string[] = [],
): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 28);
  const stem = slug === "" ? "item" : slug;
  const used = new Set(
    document.items.flatMap((item) => (members.includes(item.id) ? [] : item.id)),
  );
  for (let n = 1; ; n++) {
    const id = n === 1 ? stem : `${stem}-${n}`;
    if (!used.has(id) && PICTURE_ITEM_ID.test(id)) return id;
  }
}

/** One operation or a batch applied as one edit. */
export type DraftEdit = EditOperation | readonly EditOperation[];

const batchOf = (edit: DraftEdit): readonly EditOperation[] =>
  Array.isArray(edit) ? edit : [edit as EditOperation];

/** The items an operation (or a batch) edits: their footprints are the cells it may change. */
export function editedItems(document: PictureDocument, edit: DraftEdit): string[] {
  if (Array.isArray(edit))
    return [...new Set(edit.flatMap((op: EditOperation) => editedItems(document, op)))];
  const op = edit as EditOperation;
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
    case "combineItems":
      return [...op.itemIds, op.id];
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
  /** How many undo steps the history held when the draft was last kept (or opened). */
  const keptDepth = shallowRef(0);
  /** Undo or redo steps between the draft and the last Keep, while they differ. */
  const changes = computed(() =>
    dirty.value ? Math.max(1, Math.abs(history.value.past.length - keptDepth.value)) : 0,
  );
  /** The kept text's compiled bytes, compiled once per kept text and profile. */
  let keptBytes: { source: string; profile: AgiProfile; bytes: Uint8Array } | undefined;
  function baseBytes(): Uint8Array {
    const { source: text } = kept.value;
    if (keptBytes?.source !== text || keptBytes.profile !== profile()) {
      const bytes = compileEditDocument(parsePictureDocument(text).document, profile()).bytes;
      keptBytes = { source: text, profile: profile(), bytes };
    }
    return keptBytes.bytes;
  }
  /** The draft differs from the kept text only where the picture's bytes do not show it. */
  const notesOnly = computed(() => dirty.value && sameBytes(compiled.value.bytes, baseBytes()));
  const gesturing = computed(() => history.value.gesture !== undefined);
  const canUndo = computed(() => !gesturing.value && history.value.past.length > 0);
  const canRedo = computed(() => !gesturing.value && history.value.future.length > 0);

  function reset(base: DraftBase): void {
    kept.value = base;
    history.value = createHistory(base.source);
    keptDepth.value = 0;
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

  /** Run `op` (or a batch) on the draft: the kernel, then the locks. Nothing is recorded. */
  function evaluate(op: DraftEdit): DraftCandidate | DraftRefusal {
    const result = applyEdits(document.value, batchOf(op), { profile: profile() });
    if ("error" in result)
      return {
        kind: "kernel",
        message: plainKernelRefusal(batchOf(op)[0]!, result.error),
        detail: kernelDetail(result.error, document.value),
      };
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
        ...refusalText(check),
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

  /** One edit (or batch), one undo step. */
  function apply(op: DraftEdit, label: string): DraftOutcome {
    if (gesturing.value) return refuse({ kind: "kernel", message: "Finish the drag first." });
    const candidate = evaluate(op);
    if (refused(candidate)) return refuse(candidate);
    const recorded = record(history.value, label, source.value, candidate.source);
    if (!recorded.ok)
      return refuse({
        kind: "kernel",
        message: plainKernelRefusal(batchOf(op)[0]!, recorded.reason),
        detail: kernelDetail(recorded.reason, document.value),
      });
    history.value = recorded.history;
    refusal.value = null;
    return { ok: true };
  }

  /**
   * Adopt an accepted AI candidate's whole text as one undo step. The
   * candidate passed its scope (assistScope.ts) when it was proposed; it
   * must still pass it against the draft now, and the locks a manual edit
   * passes under the lens and unlocks it was asked with (checkStudioEdit,
   * with the targets and the items it creates as the edited items): both
   * verdicts must agree, or nothing changes.
   */
  function adopt(next: string, label: string, scope: PictureAssistScope): DraftOutcome {
    if (gesturing.value) return refuse({ kind: "kernel", message: "Finish the drag first." });
    const parsed = parsePictureDocument(next);
    let after: CompiledDocument;
    try {
      after = compileEditDocument(parsed.document, profile());
    } catch (error) {
      return refuse({
        kind: "kernel",
        message: "The proposal doesn't compile any more.",
        detail: String(error),
      });
    }
    const scoped = checkCandidate(compiled.value, after, scope);
    if (!scoped.ok)
      return refuse({
        kind: "kernel",
        message: "The proposal now reaches outside its scope. Ask again.",
        detail: assistRefusalText(scoped),
      });
    const known = new Set(document.value.items.map((item) => item.id));
    const created = parsed.document.items.flatMap((item) => (known.has(item.id) ? [] : [item.id]));
    const check = checkStudioEdit(
      compiled.value,
      after,
      [...scope.targetIds, ...created],
      scope.lens,
      scope.unlocks,
    );
    validation.value = check;
    if (!check.ok)
      return refuse({ kind: "lock", ...refusalText(check), check, cells: violationCells(check) });
    const recorded = record(history.value, label, source.value, next);
    if (!recorded.ok)
      return refuse({
        kind: "kernel",
        message: "The picture changed while the AI worked. Ask again.",
        detail: recorded.reason,
      });
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
  function moveGesture(op: DraftEdit): DraftOutcome {
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
  function endGesture(op: DraftEdit | null, label: string): DraftOutcome {
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

  /**
   * The game now holds the draft at `revision`: it is the new base. The undo
   * history stays, so undoing past a Keep is an unkept change like any other.
   */
  function markKept(revision: ResourceRevision): void {
    keptBytes = { source: source.value, profile: profile(), bytes: compiled.value.bytes };
    kept.value = { source: source.value, revision };
    keptDepth.value = history.value.past.length;
    refusal.value = null;
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
    notesOnly,
    gesturing,
    canUndo,
    canRedo,
    apply,
    adopt,
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

/** The Keep request for the draft as it stands: its bytes and the text that compiles to them. */
export function draftPictureEdit(
  draft: StudioDraft,
  pictureNumber: number,
  baseRevision: ResourceRevision,
): PictureEdit {
  return {
    pictureNumber,
    bytes: draft.compiled.value.bytes,
    source: draft.source.value,
    baseRevision,
    reason: changeCount(draft.changes.value, draft.notesOnly.value),
  };
}

/** Development and test builds: the draft's bytes and text on `window.__AGI_STUDIO__` for browser tests. */
export function exposeStudioDraft(draft: StudioDraft, logic?: () => string): void {
  if (!import.meta.env?.DEV) return;
  const hook = {
    bytes: () => draft.compiled.value.bytes.slice(),
    source: () => draft.source.value,
    ...(logic ? { logic } : {}),
  };
  window.__AGI_STUDIO__ = hook;
  onScopeDispose(() => {
    if (window.__AGI_STUDIO__ === hook) delete window.__AGI_STUDIO__;
  });
}
