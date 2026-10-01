/**
 * Sound Studio's workspace controller: the draft authority for `sound:N`
 * documents. Every cue edit is one draft transaction carrying the tagged
 * `agi.sound-document` envelope beside the `music` metadata entry, so undo,
 * recovery and Keep always see a consistent pair. The controller is plain
 * TypeScript — the component supplies reactivity and dialogs; tests drive it
 * headless against the real project storage.
 */
import { openContainer } from "../../../../src/container/container.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { ProjectDraft } from "../../../../src/authoring/projectDraft.ts";
import { inspectProjectReferences } from "../../../../src/authoring/projectReferences.ts";
import type { ProjectId } from "../../../../src/gameIdentity.ts";
import { PROFILES, type ProfileId } from "../../../../src/runtime/profile.ts";
import type { SoundDocument } from "../../../../src/sound/document.ts";
import { createSoundDocument, importSoundDocument } from "../../../../src/sound/document.ts";
import { applySoundPreset, SOUND_PRESETS } from "../../../../src/sound/presets.ts";
import {
  openEditableProject,
  type EditableCandidate,
  type EditableOpenOptions,
  type EditableProject,
} from "../../project/editableProject.ts";
import type { EditableProjectInspection } from "../../project/projectWorkspaceSource.ts";
import {
  firstFreeSoundNum,
  listSoundNums,
  musicMapForSound,
  openSoundContent,
  readMusicMap,
  soundKey,
  tempoForSound,
  writeMusicMap,
  withEventCursorFloor,
  SOUND_MAX_BYTES,
  type MusicMap,
  type SoundSourceKind,
} from "./soundDocuments.ts";

export interface SoundEntry {
  readonly key: string;
  readonly num: number;
  /** How the stored claim presented: envelope, legacy tracks or native bytes. */
  readonly source: SoundSourceKind;
  readonly bytes: number;
  readonly events: number | null;
  readonly extentTicks: number | null;
  readonly opaque: boolean;
  readonly family: string;
  readonly diagnostics: readonly string[];
  readonly tempo: number | null;
  /** Logic documents using this sound in the saved build. */
  readonly usedBy: readonly string[];
  readonly dirty: boolean;
}

interface DraftTx {
  readonly id: { readonly sequence: number };
  readonly label: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The workspace of one open project. Not reactive itself — `subscribe` bumps
 * a listener after every mutation, which the component folds into its own
 * revision counter.
 */
export class SoundStudioWorkspace {
  private ws: EditableProject | null = null;
  /**
   * The open incarnation: every open() and close() bumps it, so a load that
   * resolves after a close or a newer open installs nothing and notifies no
   * one. Callers read the resolved service — null means superseded.
   */
  private incarnation = 0;
  private readonly undoStack: DraftTx[] = [];
  private readonly redoStack: DraftTx[] = [];
  /** Per-key event-id high water: an undo must never reissue a used id. */
  private readonly cursorFloors = new Map<string, number>();
  private listeners = new Set<() => void>();
  private usedByCache: { base: object; map: Readonly<Record<number, readonly string[]>> } | null =
    null;

  /** Subscribe to workspace mutations; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get projectId(): ProjectId | null {
    return this.ws?.projectId ?? null;
  }

  get profileId(): ProfileId | null {
    return this.ws?.profileId ?? null;
  }

  /** The open editable project, or null before open. */
  get project(): EditableProject | null {
    return this.ws;
  }

  get inspection(): EditableProjectInspection | null {
    return this.ws?.inspection ?? null;
  }

  get draft(): ProjectDraft | null {
    return this.ws?.draft ?? null;
  }

  /**
   * Open one stored project. Resolves the installed service, or null when a
   * close or a newer open superseded this attempt — including when the load
   * itself failed late, so a stale rejection cannot report over the current
   * open's own state.
   */
  async open(projectId: ProjectId, options?: EditableOpenOptions): Promise<EditableProject | null> {
    const ticket = ++this.incarnation;
    let ws: EditableProject;
    try {
      ws = await openEditableProject(projectId, options);
    } catch (error) {
      if (ticket !== this.incarnation) return null;
      throw error;
    }
    if (ticket !== this.incarnation) return null;
    this.ws = ws;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.cursorFloors.clear();
    this.usedByCache = null;
    this.notify();
    return ws;
  }

  /** Forget the open project and cancel every outstanding open. */
  close(): void {
    this.incarnation++;
    this.ws = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.cursorFloors.clear();
    this.usedByCache = null;
    this.notify();
  }

  dirtyKeys(): readonly string[] {
    return this.ws?.draft.dirtyKeys() ?? [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Labels for the undo/redo buttons, oldest to newest. */
  undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /** Which LOGIC documents reference each sound in the saved build. */
  private usedByMap(): Readonly<Record<number, readonly string[]>> {
    const ws = this.ws;
    if (ws === null) return {};
    const data = ws.storedData();
    if (this.usedByCache !== null && this.usedByCache.base === data.files) {
      return this.usedByCache.map;
    }
    const map: Record<number, readonly string[]> = {};
    try {
      const profile = PROFILES[ws.profileId];
      const container = openContainer(new Map(Object.entries(data.files)), { profile });
      const capture = ws.draft.capture();
      const bindingsText = capture.read("bindings")?.content;
      const bindings = typeof bindingsText === "string" ? readBindingsDocument(bindingsText) : {};
      const result = inspectProjectReferences({ container, profile, bindings });
      for (const reference of result.references) {
        const target = reference.target;
        if (!("num" in target) || target.kind !== "sound") continue;
        const list = map[target.num] ?? [];
        const from =
          reference.document === "bindings" ? `binding ${reference.command}` : reference.document;
        if (!list.includes(from)) map[target.num] = [...list, from];
      }
    } catch {
      // An unreadable kept image reports no usage rather than guessing.
    }
    this.usedByCache = { base: data.files, map };
    return map;
  }

  private musicMap(): MusicMap {
    const capture = this.ws?.draft.capture();
    if (capture === undefined) return {};
    return readMusicMap(capture.read("music")?.content);
  }

  /**
   * The current draft sound entries in resource order, with their opened
   * documents' shape. A document that fails to open still lists, flagged by
   * `openError`, so nothing in the draft is silently hidden.
   */
  entries(): readonly (SoundEntry | { key: string; num: number; openError: string })[] {
    const ws = this.ws;
    if (ws === null) return [];
    const capture = ws.draft.capture();
    const dirty = new Set(ws.draft.dirtyKeys());
    const music = this.musicMap();
    const usedBy = this.usedByMap();
    return listSoundNums(capture.keys)
      .map((num) => {
        const key = soundKey(num);
        const content = capture.read(key)?.content ?? null;
        if (content === null) return null;
        try {
          const opened = openSoundContent(key, content, ws.profileId);
          const doc = opened.document;
          const tracks = doc.tracks();
          return {
            key,
            num,
            source: opened.source,
            bytes: doc.encode().length,
            events: tracks === null ? null : tracks.reduce((sum, lane) => sum + lane.length, 0),
            extentTicks: doc.extentTicks(),
            opaque: doc.representation === "opaque",
            family: doc.family,
            diagnostics: doc.diagnostics,
            tempo: tempoForSound(music, num),
            usedBy: usedBy[num] ?? [],
            dirty: dirty.has(key),
          } satisfies SoundEntry;
        } catch (error) {
          return { key, num, openError: reasonOf(error) };
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  /** Open one draft sound's document, honoring the id-cursor floor. */
  documentFor(num: number): { document: SoundDocument; source: SoundSourceKind } | null {
    const ws = this.ws;
    if (ws === null) return null;
    const content = ws.draft.capture().read(soundKey(num))?.content;
    if (content === undefined || content === null) return null;
    const opened = openSoundContent(soundKey(num), content, ws.profileId);
    const document = withEventCursorFloor(
      opened.document,
      this.cursorFloors.get(soundKey(num)) ?? 0,
    );
    return { document, source: opened.source };
  }

  /**
   * Write one sound's document (and its music entry) in a single draft
   * transaction. The text is the tagged envelope — the only `sound:N` source
   * form that preserves event ids — compiled byte-exact by the project codec.
   */
  private writeSound(
    num: number,
    document: SoundDocument,
    label: string,
    extra: readonly { key: string; content: string | Uint8Array | null }[] = [],
  ): void {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    const key = soundKey(num);
    const envelope = document.serialize();
    const payload = document.encode();
    const current = this.musicMap();
    const music = musicMapForSound(current, num, payload, tempoForSound(current, num));
    const base = ws.draft.capture();
    const proposal = ws.draft.propose(base, label, [
      { key, content: JSON.stringify(envelope) },
      { key: "music", content: writeMusicMap(music) },
      ...extra,
    ]);
    const applied = ws.draft.apply(proposal);
    this.undoStack.push(applied);
    this.redoStack.length = 0;
    const floor = Math.max(envelope.nextEventId, this.cursorFloors.get(key) ?? 0);
    this.cursorFloors.set(key, floor);
    this.notify();
  }

  /**
   * Run one cue edit: open the draft document, apply `edit`, and store the
   * result under one transaction. The opener's error (a malformed draft doc)
   * surfaces to the caller unchanged.
   */
  editCue(
    num: number,
    label: string,
    edit: (document: SoundDocument) => SoundDocument,
  ): SoundDocument {
    const opened = this.documentFor(num);
    if (opened === null) throw new Error(`Sound ${num} is not in this project's draft.`);
    const next = edit(opened.document);
    if (next === opened.document) return next;
    this.writeSound(num, next, label);
    return next;
  }

  /** Create a cue at the lowest free number; optional preset seeds it. */
  createCue(presetId: string | null = null): number {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    const num = firstFreeSoundNum(ws.draft.capture().keys);
    if (num === null) throw new Error("This project already uses every SOUND number.");
    let document = createSoundDocument({ profileId: ws.profileId });
    let label = `Create Sound ${num}`;
    if (presetId !== null) {
      document = applySoundPreset(document, presetId);
      const preset = SOUND_PRESETS.find((entry) => entry.id === presetId);
      label = `Create Sound ${num} (${preset?.name ?? presetId})`;
    }
    this.writeSound(num, document, label);
    return num;
  }

  /** Copy a cue's events onto the lowest free number with fresh event ids. */
  duplicateCue(num: number): number {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    const opened = this.documentFor(num);
    if (opened === null) throw new Error(`Sound ${num} is not in this project's draft.`);
    const target = firstFreeSoundNum(ws.draft.capture().keys);
    if (target === null) throw new Error("This project already uses every SOUND number.");
    const tracks = opened.document.tracks();
    let document: SoundDocument;
    if (tracks === null) {
      // An opaque cue duplicates as retained bytes: import keeps it opaque.
      document = importSoundDocument(opened.document.encode(), { profileId: ws.profileId });
    } else {
      // The copy's allocator starts above the source's cursor so no duplicated
      // event shares an id with the cue it was copied from.
      document = withEventCursorFloor(
        createSoundDocument({ profileId: ws.profileId }),
        opened.document.serialize().nextEventId,
      );
      for (let lane = 0; lane < tracks.length; lane++) {
        for (const event of tracks[lane]!) {
          document = document.insertEvent(lane, document.tracks()![lane]!.length, {
            ticks: event.durationTicks,
            data: event.data,
          });
        }
      }
    }
    this.writeSound(target, document, `Duplicate Sound ${num} to Sound ${target}`);
    return target;
  }

  /**
   * Replace or create a cue from a native `.snd`/`.bin` payload. The owned-byte
   * bound is enforced before any document work; an oversized file is refused
   * synchronously with its size named.
   */
  importCue(num: number, payload: Uint8Array): void {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    if (!(payload instanceof Uint8Array)) throw new Error("An imported sound must be raw bytes.");
    if (payload.length > SOUND_MAX_BYTES)
      throw new Error(
        `That file is ${payload.length} bytes; a native SOUND resource holds at most ${SOUND_MAX_BYTES}.`,
      );
    const opened = openSoundContent(soundKey(num), payload, ws.profileId);
    this.writeSound(num, opened.document, `Import Sound ${num}`);
  }

  /**
   * Delete a cue: one draft transaction removes the cue document and its
   * music entry together. The removal is an ordinary draft change — Undo
   * restores it and the Keep review names the removed native resource
   * before it commits. Returns a staging failure's reason, or null once the
   * removal is staged.
   */
  removeCue(num: number): string | null {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    const key = soundKey(num);
    const capture = ws.draft.capture();
    if (capture.read(key)?.content === undefined) return null;
    const music = this.musicMap();
    const nextMusic = { ...music };
    delete nextMusic[String(num)];
    try {
      const proposal = ws.draft.propose(capture, `Remove Sound ${num}`, [
        { key, content: null },
        { key: "music", content: writeMusicMap(nextMusic) },
      ]);
      const applied = ws.draft.apply(proposal);
      this.undoStack.push(applied);
      this.redoStack.length = 0;
      this.notify();
      return null;
    } catch (error) {
      return reasonOf(error);
    }
  }

  /** The cue tempo the inspector edits; a music-document-only transaction. */
  setTempo(num: number, tempo: number): void {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    if (!Number.isInteger(tempo) || tempo < 20 || tempo > 600)
      throw new Error("Tempo must be an integer in 20..600 BPM.");
    const music = this.musicMap();
    const existing = music[String(num)];
    if (existing === undefined) throw new Error(`Sound ${num} has no authored tempo yet.`);
    const next: MusicMap = { ...music, [String(num)]: { ...existing, tempo } };
    const base = ws.draft.capture();
    const proposal = ws.draft.propose(base, `Set Sound ${num} tempo to ${tempo} BPM`, [
      { key: "music", content: writeMusicMap(next) },
    ]);
    const applied = ws.draft.apply(proposal);
    this.undoStack.push(applied);
    this.redoStack.length = 0;
    this.notify();
  }

  undo(): void {
    const ws = this.ws;
    const applied = this.undoStack.pop();
    if (ws === null || applied === undefined) return;
    ws.draft.undo(applied.id);
    this.redoStack.push(applied);
    this.notify();
  }

  redo(): void {
    const ws = this.ws;
    const applied = this.redoStack.pop();
    if (ws === null || applied === undefined) return;
    ws.draft.redo(applied.id);
    this.undoStack.push(applied);
    this.notify();
  }

  /** Build a reviewable candidate over the chosen dirty roots. */
  buildSelected(keys: readonly string[]): EditableCandidate {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    return ws.buildSelected(keys);
  }

  /**
   * The explicit Keep action. When the issued candidate removes kept
   * resources, the review forwards the candidate's own removal list — the
   * service rechecks it exactly, so a forged list can neither widen nor
   * shrink what gets removed.
   */
  async keepCandidate(candidate: EditableCandidate) {
    const ws = this.ws;
    if (ws === null) throw new Error("No project is open.");
    const review =
      candidate.removedResources.length > 0
        ? { reviewedRemovals: candidate.removedResources }
        : undefined;
    const result = await ws.keepCandidate(candidate, review);
    this.noteKept(ws);
    return result;
  }

  /**
   * Derived-state invalidation after a keep admitted on the given service.
   * A component may keep through a review's issuing service while a switch
   * raced it; only a still-current service touches this workspace's state.
   */
  noteKept(service: EditableProject): void {
    if (this.ws !== service) return;
    this.usedByCache = null;
    this.notify();
  }

  /** The exact native payload of a draft sound, for export or preview. */
  nativePayload(num: number): Uint8Array | null {
    const opened = this.documentFor(num);
    return opened === null ? null : opened.document.encode();
  }
}
