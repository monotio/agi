/**
 * The world map's view model: merges the durable room journal (observed
 * facts), the authoring world's planned exits (intent) and the static scan
 * of the booted resources (candidates) into one labelled graph. The merge
 * itself is pure (src/agent/roomMap.ts); this composable owns the session
 * bookkeeping, the bounded thumbnail cache, deterministic layout and the
 * sidecar's storage lifecycle.
 *
 * Identity rules: a journal entry belongs to the boot session it arrived in
 * and to the resource revision in play (boot revision + patch generation).
 * A thumbnail binds only to a frame whose (patchGeneration, cycle) matches a
 * current-session entry — never "the next frame", so a stale or replayed
 * frame cannot repaint a room. Static picture renders appear only where a
 * literal picture use was scanned, and are labelled static.
 */
import { computed, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import {
  mergeRoomGraph,
  scanContainerExits,
  type MapExperience,
  type RoomGraph,
  type RoomMapSidecar,
  type RoomObservation,
  type StaticRoomScan,
} from "../../src/agent/roomMap.ts";
import {
  createWorldDraft,
  draftAddExit,
  draftEdit,
  draftRemoveExit,
  draftRemoveRoom,
  draftRenameRoom,
  draftSetBrief,
  lowestFreeRoom,
  worldRevision,
  type WorldDraft,
  type WorldPlan,
} from "../../src/agent/worldPlan.ts";
import { parseGameTests } from "../../src/agent/gameTests.ts";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { detectProfile, type AgiProfile } from "../../src/runtime/profile.ts";
import { getOrExtractCheckpoints, loadWalkthrough, resolveWalkthrough } from "./walkthrough.ts";
import type { AgentSession } from "./agent/agentSession.ts";
import type { AuthoringState } from "../../src/agent/authoringState.ts";
import { gameStorageKey, type BootedGame, type Frame } from "./gameTypes.ts";
import type { ResourceRevision } from "../../src/gameIdentity.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";
import { emptyMapSidecar, readMapSidecar, writeMapSidecar } from "./roomMapStore.ts";
import { studioPictureSource, type StudioPictureSource } from "./world/studioSource.ts";
import type { RoomTransitionNotice } from "./workerProtocol.ts";

/** Durable journal cap — the sidecar contract bounds at the same number. The
 * detailed journal keeps the newest entries; visited rooms and traversable
 * edges also roll into the bounded discovery aggregate, so eviction loses
 * detail, never discovery. */
const MAX_JOURNAL = 4096;
// The discovery domain is finite: 256 source rooms × 256 targets × 5 label
// variants (four screen edges + none). The aggregate retains every distinct
// traversable edge a game can express — the bound exists for corrupt input,
// not as a policy that silently drops real observations.
const MAX_DISCOVERED_EDGES = 256 * 256 * 5;
/** Observed-frame thumbnails; evicted oldest-first. */
const MAX_THUMBS = 96;
/** Static picture renders; evicted oldest-first. Sized so a full game of
 * picture-bearing rooms stays cached — nodes render one image each. */
const MAX_STATIC_THUMBS = 256;
/** Rooms the journal still expects a landing frame for. */
const MAX_PENDING_THUMBS = 64;

const CELL_W = 220;
const CELL_H = 190;

/**
 * One displayed plan field: `draft` is the user's text, `base` the plan value
 * the draft last agreed with — the per-field compare-and-set expectation.
 * When the plan moved under a dirty draft, `conflict` holds the plan's
 * current text; the draft stays untouched for explicit reconciliation.
 */
export interface PlanFieldEdit {
  draft: string;
  base: string;
  conflict: string | null;
}

/** The detail pane's edit session for one room's plan entry. */
export interface PlanRoomEdit {
  room: number;
  title: PlanFieldEdit;
  brief: PlanFieldEdit;
}

export interface MapThumbnail {
  readonly pixels: Uint8Array;
  /** "observed" is a live composed frame; "static" is a picture render. */
  readonly kind: "observed" | "static";
}

export interface ScannedResources {
  readonly key: string;
  readonly scans: Map<number, StaticRoomScan>;
  readonly shared: Set<number>;
  readonly logic: Set<number>;
  readonly picture: Set<number>;
  readonly files: Record<string, Uint8Array>;
  /** The interpreter the game boots under; null when nothing was scanned. */
  readonly profile: AgiProfile | null;
  /** Rooms stored game tests name — a definition reference, not a pass. */
  readonly testCoverage: { referenced: Set<number>; tests: number };
}

/**
 * The stored-test facts a TESTS.JSON actually supports: `room`, `until.room`
 * and `expect.room` name rooms a test *intends* to exercise. No run result is
 * stored, so a definition is a reference, never a pass — and consecutive room
 * names do not prove a direct transition, so no edge coverage is claimed.
 */
function storedTestCoverage(
  files: Record<string, Uint8Array>,
  profile: AgiProfile | undefined,
): { referenced: Set<number>; tests: number } {
  const referenced = new Set<number>();
  let doc;
  try {
    doc = parseGameTests(files["TESTS.JSON"], profile);
  } catch {
    return { referenced, tests: 0 };
  }
  for (const test of doc.tests) {
    referenced.add(test.room);
    for (const step of test.steps) {
      const until = step["until"];
      if (until && typeof until === "object" && !Array.isArray(until)) {
        const room = (until as Record<string, unknown>)["room"];
        if (typeof room === "number") referenced.add(room);
      }
    }
    const expectRoom = test.expect?.["room"];
    if (typeof expectRoom === "number") referenced.add(expectRoom);
  }
  return { referenced, tests: doc.tests.length };
}

export interface RoomMapDeps {
  readonly state: EngineState;
  readonly hook: TextHook;
  readonly getBootedGame: () => BootedGame | null;
  readonly getSession: () => AgentSession | null;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  /** The map pauses the walkthrough driver as well as the cycle timer. */
  readonly pauseWalkthrough: () => void;
  readonly resumeWalkthrough: () => void;
  /** Injectable for tests; defaults to browser storage. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  /** A map edit committed to the live session world — the owner persists it
   *  and reports whether the write became durable (void counts as written). */
  readonly onWorldEdited?: (() => boolean | void | Promise<boolean | void>) | undefined;
  /** "Build this room": author one planned room against the named inbound edge. */
  readonly buildRoomFromMap?:
    ((room: number, from: number, notes: string[], exitName?: string) => Promise<void>) | undefined;
}

export interface RoomMap {
  readonly open: Ref<boolean>;
  readonly selected: Ref<number | undefined>;
  readonly journal: RoomObservation[];
  readonly graph: ComputedRef<RoomGraph>;
  /**
   * Which experience the map is drawn for. "play"
   * shows only discovered places and observed crossings; "create" adds plan
   * intent and technical status. The opening caller chooses; play surfaces
   * never get the plan.
   */
  readonly experience: Ref<MapExperience>;
  readonly currentRoom: ComputedRef<number | null>;
  readonly unsaved: Ref<boolean>;
  /** Load-failure explanation; the map opens empty rather than blocking play. */
  readonly storageError: Ref<string>;
  /** Bumped whenever any thumbnail changes; lets views subscribe once. */
  readonly thumbVersion: Ref<number>;
  /** Bumped whenever a node position changes (drag, nudge, reset). */
  readonly layoutVersion: Ref<number>;
  openMap(options?: { experience?: MapExperience }): void;
  closeMap(): void;
  select(room: number | undefined): void;
  positionFor(room: number): { x: number; y: number };
  /** Move during a drag: in-memory only; moveNode commits. */
  previewNode(room: number, x: number, y: number): void;
  moveNode(room: number, x: number, y: number): void;
  resetLayout(): void;
  noteFor(room: number): string;
  setNote(room: number, note: string): void;
  edgeNoteFor(from: number, to: number, label?: string): string;
  setEdgeNote(from: number, to: number, label: string | undefined, note: string): void;
  /** Player intent for a room — its note plus the notes on its edges. */
  noteIntentFor(room: number): string[];
  thumbnailFor(room: number): MapThumbnail | null;
  /** The static scan of the booted resources (files, logic scans, pictures, stored tests). */
  readonly resources: ComputedRef<ScannedResources>;
  /** Room Studio's input for one picture of the booted game, or null without it. */
  /** One picture's Studio input and the booted revision it was read at. */
  studioSource(
    picture: number,
  ): (StudioPictureSource & { readonly baseRevision: ResourceRevision }) | null;
  observeFrame(frame: Frame): void;
  exportSidecar(): RoomMapSidecar;
  retrySave(): void;
  /** For a non-running game's export: the stored sidecar, or empty. */
  storedSidecar(target: string): RoomMapSidecar;
  // ---- the map as the plan surface ----------------------------------------
  /** The last plan edit's refusal, or "". */
  readonly planError: Ref<string>;
  /** The session world's revision is newer than the last durable write. */
  readonly planDirty: ComputedRef<boolean>;
  /** Why the last plan write failed, or "". */
  readonly planSaveError: Ref<string>;
  /** Persist the in-memory plan again after a refused write. */
  retryPlanSave(): Promise<void>;
  /** Room a map-triggered build is authoring, if any. */
  readonly buildingRoom: Ref<number | undefined>;
  setBuilding(room: number | undefined): void;
  /** Author one planned room's resources just-in-time from the map. */
  buildPlannedRoom(room: number): Promise<void>;
  /** The session carries an editable world plan, whatever the map's experience. */
  readonly planAvailable: ComputedRef<boolean>;
  /** The live session's world plan exists to edit — and this is a creator map. */
  readonly canPlan: ComputedRef<boolean>;
  /** The plan entry for a room in the session world, or null. */
  plannedEntry(room: number): WorldPlan["rooms"][string] | null;
  /** Open a field-edit session for a room's plan entry — null when not planned. */
  beginPlanEdit(room: number): PlanRoomEdit | null;
  /** Follow a plan update under an open session: clean fields refresh, dirty ones flag. */
  syncPlanEdit(edit: PlanRoomEdit): void;
  /**
   * Commit a displayed field with per-field compare-and-set. Returns null on
   * commit, "conflict" when the plan moved under a dirty draft (the field's
   * `conflict` then holds the plan's text), or a refusal message.
   */
  commitPlanField(edit: PlanRoomEdit | null, field: "title" | "brief"): string | null;
  /** Reconcile a flagged field — keep the user's text or take the plan's. */
  resolvePlanField(
    edit: PlanRoomEdit | null,
    field: "title" | "brief",
    keep: "mine" | "plan",
  ): string | null;
  renamePlannedRoom(room: number, title: string): string | null;
  setPlannedBrief(room: number, brief: string): string | null;
  addPlannedRoom(
    fromRoom: number | null,
    title: string,
    brief: string,
    exitName: string,
  ): { room?: number; error?: string };
  removePlannedRoom(room: number): string | null;
  addPlannedExit(from: number, name: string, to: number): string | null;
  removePlannedExit(from: number, name: string): string | null;
}

export function useRoomMap(deps: RoomMapDeps): RoomMap {
  const { state, hook } = deps;
  const storage = deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);

  const open = ref(false);
  const selected = ref<number>();
  // The safe default: a caller that names no experience gets the discovered
  // view — creator intent is always an explicit ask.
  const experience = ref<MapExperience>("play");
  const unsaved = ref(false);
  const storageError = ref("");
  const thumbVersion = ref(0);
  const layoutVersion = ref(0);
  const planError = ref("");
  const buildingRoom = ref<number>();
  /** Bumped when a map edit changes the plan — the graph re-merges intent. */
  const planVersion = ref(0);
  /**
   * Plan-save ordering: each persist takes a ticket; only the newest write's
   * outcome updates the flag, so a late ack for an older write can never
   * label newer content saved — or hide a newer failure. Successful writes
   * report their revision into state.planDurableRev (every authoring-state
   * save does); this path only fills that in when the channel did not.
   */
  let planWriteTicket = 0;
  const planSaveError = ref("");
  /**
   * The revision storage last handed this session to the map. Captured when
   * the session object first appears — before any edit — so a world whose
   * durable rev is unreported still starts clean instead of seeding itself.
   */
  let planBaselineSession: AgentSession | null = null;
  let planBaselineRev = "";

  function planRevisionNow(): string | null {
    const session = deps.getSession();
    const rooms = session?.state.authoring.world;
    if (!rooms) {
      planBaselineSession = null;
      planBaselineRev = "";
      return null;
    }
    if (session !== planBaselineSession) {
      planBaselineSession = session;
      planBaselineRev = worldRevision(rooms);
    }
    return worldRevision(rooms);
  }

  // The baseline is captured eagerly — session attach bumps worldTick — so a
  // first call arriving mid-edit never seeds the baseline to edited content.
  watch(
    () => state.worldTick,
    () => {
      void planRevisionNow();
    },
    { immediate: true },
  );

  /**
   * The edited-vs-durable comparison: the durable channel wins while it has
   * a report; before the first one, the session's opening revision stands
   * in — it is what storage handed us.
   */
  const planDirty = computed<boolean>(() => {
    void planVersion.value;
    void state.worldTick;
    void state.planDurableRev;
    const rev = planRevisionNow();
    if (rev === null) return false;
    const durable = state.planDurableRev || planBaselineRev;
    return rev !== durable;
  });

  /** Persist the plan the map just edited; durable only tracks acked writes. */
  async function persistPlan(): Promise<void> {
    const rev = planRevisionNow();
    const durableAtIssue = state.planDurableRev;
    const ticket = ++planWriteTicket;
    const ok = (await deps.onWorldEdited?.()) ?? true;
    if (ticket !== planWriteTicket) return; // a newer write owns the verdict
    if (!ok) {
      planSaveError.value =
        "The plan could not be saved — edits are kept in memory; Retry writes them again.";
      return;
    }
    planSaveError.value = "";
    // persistSessionState reports this write itself; fill in only when the
    // channel stayed silent and no newer durable report landed mid-flight.
    if (rev !== null && state.planDurableRev === durableAtIssue) state.planDurableRev = rev;
  }

  async function retryPlanSave(): Promise<void> {
    await persistPlan();
  }
  /** The live session carries an editable world plan (authored games only). */
  const planAvailable = computed(() => plannedRooms() !== undefined);
  const canPlan = computed(() => experience.value === "create" && planAvailable.value);

  /** The durable journal — survives reboots and reloads of the same game. */
  const journal = reactive<RoomObservation[]>([]);
  /**
   * Bounded aggregate of every room ever visited and every traversable edge
   * ever crossed. Unlike the capped journal this is lossless: eviction removes
   * detail (cycles, deltas) but never the fact that a room was visited.
   */
  const discovered = {
    rooms: new Map<number, number>(),
    edges: new Map<string, { from: number; to: number; label?: string; count: number }>(),
  };
  const layout = reactive<Record<string, { x: number; y: number }>>({});
  const notes = reactive<Record<string, string>>({});
  const edgeNotes = reactive<Record<string, string>>({});

  /** The storage target the loaded map belongs to; "" while nothing is loaded. */
  let loadedKey = "";
  /** Boot counter: persisted entries' max session + 1 each time the game boots. */
  let session = 0;
  /** The booted resource revision this session's entries bind to. */
  let revision = "";
  /** Paused by the map only if the walkthrough driver was playing when it opened. */
  let walkthroughPauseOwned = false;
  /** Walkthrough coverage loaded for this storage target ("" = not loaded). */
  let coverageKey = "";
  const walkthroughCoverage = ref<{
    playtested: Set<number>;
  }>();

  /** Observed thumbnails by room; insertion order is the eviction order. */
  const thumbs = new Map<number, MapThumbnail>();
  /** Pending thumbnail binds: "patchGeneration:cycle" → room (last wins). */
  const pendingThumbs = new Map<string, number>();
  /** Rendered picture thumbs by room; cleared when the scan revision moves. */
  const staticThumbs = new Map<number, MapThumbnail>();
  /** Auto-assigned positions (in-memory only; manual moves persist). */
  const autoPositions = new Map<number, { x: number; y: number }>();
  let isolatedCursor = 0;
  let scanned: ScannedResources | null = null;

  /** The merged static scan of the booted resources — once per revision. */
  function scanResources(): ScannedResources {
    const game = deps.getBootedGame();
    if (!game)
      return {
        key: "",
        scans: new Map(),
        shared: new Set(),
        logic: new Set(),
        picture: new Set(),
        files: {},
        profile: null,
        testCoverage: { referenced: new Set(), tests: 0 },
      };
    // The player's interpreter override, if any, is part of what was scanned.
    const override = game.authoredGame?.library?.profile;
    const key = `${game.revision}:${override ?? ""}`;
    if (scanned && scanned.key === key && scanned.files === game.files) return scanned;
    const logicPayloads = new Map<number, Uint8Array>();
    const picture = new Set<number>();
    try {
      const container = openContainer(new Map(Object.entries(game.files)));
      for (let num = 0; num < 256; num++) {
        const payload = container.getResource("logic", num);
        if (payload) logicPayloads.set(num, payload);
        if (container.getResource("picture", num)) picture.add(num);
      }
    } catch {
      // A container that cannot enumerate degrades to journal+plan only.
      scanned = {
        key,
        scans: new Map(),
        shared: new Set(),
        logic: new Set(),
        picture,
        files: game.files,
        profile: null,
        testCoverage: storedTestCoverage(game.files, undefined),
      };
      return scanned;
    }
    const profile = detectProfile(new Map(Object.entries(game.files)), override);
    const { scans, shared } = scanContainerExits(logicPayloads, profile);
    scanned = {
      key,
      scans,
      shared,
      logic: new Set(logicPayloads.keys()),
      picture,
      files: game.files,
      profile,
      testCoverage: storedTestCoverage(game.files, profile),
    };
    staticThumbs.clear();
    return scanned;
  }

  /**
   * world.rooms intent the graph shows: the live authoring session's world —
   * absent for imports, which have no plan to show.
   */
  function plannedRooms(): AuthoringState["world"]["rooms"] | undefined {
    void planVersion.value;
    // Agent-side commits (turn adoptions, session installs) signal through
    // worldTick — a plan-only change produces no patchTick.
    void state.worldTick;
    const snapshot = deps.getSession()?.getAuthoringState() as
      { authoring?: AuthoringState } | undefined;
    return snapshot?.authoring?.world?.rooms;
  }

  /** Convert a worker notice into a durable journal entry. */
  function toObservation(notice: RoomTransitionNotice): RoomObservation {
    // The booted revision moves with every patch; stamp the entry with the
    // revision in play now, not the one captured when the game loaded.
    const current = deps.getBootedGame()?.revision ?? revision;
    return {
      seq: notice.seq,
      session,
      from: notice.from,
      to: notice.to,
      cause: notice.cause,
      ...(notice.edge !== undefined ? { edge: notice.edge } : {}),
      cycle: notice.cycle,
      resourceSet: `${current}@${notice.patchGeneration}`,
      scoreDelta: notice.scoreDelta,
      gained: notice.gained,
      lost: notice.lost,
      ...(notice.history !== undefined ? { history: notice.history } : {}),
    };
  }

  /** Roll an observation into the discovery aggregate — the lossless record. */
  function noteDiscovery(entry: RoomObservation): void {
    discovered.rooms.set(entry.to, (discovered.rooms.get(entry.to) ?? 0) + 1);
    if (entry.from === null || (entry.cause !== "edge" && entry.cause !== "logic")) return;
    const key = `${entry.from}->${entry.to}:${entry.edge ?? ""}`;
    const existing = discovered.edges.get(key);
    if (existing) existing.count++;
    else if (discovered.edges.size < MAX_DISCOVERED_EDGES)
      discovered.edges.set(key, {
        from: entry.from,
        to: entry.to,
        ...(entry.edge !== undefined ? { label: entry.edge } : {}),
        count: 1,
      });
  }

  /** Drain the link's raw notices into the durable journal. */
  function drainJournal(): void {
    const pending = state.roomJournal;
    if (pending.length === 0) return;
    const notices = pending.splice(0, pending.length);
    for (const notice of notices) {
      const entry = toObservation(notice);
      journal.push(entry);
      if (journal.length > MAX_JOURNAL) journal.splice(0, journal.length - MAX_JOURNAL);
      noteDiscovery(entry);
      // Expect a landing frame at this identity; last same-cycle entry wins
      // because the frame shows the final room of that cycle.
      pendingThumbs.set(`${notice.patchGeneration}:${notice.cycle}`, notice.to);
      if (pendingThumbs.size > MAX_PENDING_THUMBS)
        pendingThumbs.delete(pendingThumbs.keys().next().value!);
    }
    persist();
  }

  /** Serialize the current in-memory map; storage may still refuse it. */
  function exportSidecar(): RoomMapSidecar {
    return {
      journal: [...journal],
      discovered: {
        rooms: Object.fromEntries(discovered.rooms),
        edges: [...discovered.edges.values()],
      },
      layout: { ...layout },
      notes: { ...notes },
      edgeNotes: { ...edgeNotes },
    };
  }

  /**
   * A refused map write retries quietly in the background a bounded number
   * of times — the unsaved note is a status, not a player task (R10).
   */
  let unsavedRetries = 0;
  let unsavedTimer: ReturnType<typeof setTimeout> | undefined;

  function persist(): void {
    if (!loadedKey || !storage) return;
    if (writeMapSidecar(storage, loadedKey, exportSidecar())) {
      unsaved.value = false;
      unsavedRetries = 0;
      return;
    }
    unsaved.value = true;
    scheduleSaveRetry();
  }

  function retrySave(): void {
    if (!loadedKey || !storage) return;
    if (writeMapSidecar(storage, loadedKey, exportSidecar())) {
      unsaved.value = false;
      unsavedRetries = 0;
    }
  }

  function scheduleSaveRetry(): void {
    if (unsavedTimer !== undefined || unsavedRetries >= 3) return;
    unsavedTimer = setTimeout(() => {
      unsavedTimer = undefined;
      if (!unsaved.value) return;
      unsavedRetries++;
      retrySave();
      if (unsaved.value) scheduleSaveRetry();
    }, 4000);
  }

  function storedSidecar(target: string): RoomMapSidecar {
    if (target === loadedKey) return exportSidecar();
    if (!storage) return emptyMapSidecar();
    try {
      return readMapSidecar(storage, target);
    } catch {
      return emptyMapSidecar();
    }
  }

  /** Load (or reset) the map for the game now in the slot. */
  function loadFor(game: BootedGame | null): void {
    const key = game ? gameStorageKey(game) : "";
    if (key === loadedKey) {
      // Same game rebooting: drain the old session's last notices, then keep
      // discovery and start a new session — a stale frame can never bind.
      drainJournal();
      persist();
      session = journal.reduce((max, e) => Math.max(max, e.session), 0) + 1;
      revision = game?.revision ?? "";
      pendingThumbs.clear();
      return;
    }
    drainJournal();
    if (loadedKey) persist();
    loadedKey = key;
    resetMapMemory();
    revision = game?.revision ?? "";
    if (key && storage) loadStoredSidecar(key);
    session = journal.reduce((max, e) => Math.max(max, e.session), 0) + 1;
  }

  /** Clear every per-game collection — loadFor, unload and review share it. */
  function resetMapMemory(): void {
    journal.splice(0, journal.length);
    discovered.rooms.clear();
    discovered.edges.clear();
    walkthroughCoverage.value = undefined;
    coverageKey = "";
    for (const k of Object.keys(layout)) delete layout[k];
    for (const k of Object.keys(notes)) delete notes[k];
    for (const k of Object.keys(edgeNotes)) delete edgeNotes[k];
    thumbs.clear();
    staticThumbs.clear();
    pendingThumbs.clear();
    autoPositions.clear();
    isolatedCursor = 0;
    scanned = null;
    selected.value = undefined;
    planError.value = "";
    planSaveError.value = "";
    unsaved.value = false;
    unsavedRetries = 0;
    if (unsavedTimer !== undefined) {
      clearTimeout(unsavedTimer);
      unsavedTimer = undefined;
    }
    storageError.value = "";
  }

  /** Read the stored sidecar into memory; a read failure is reported, not fatal. */
  function loadStoredSidecar(key: string): void {
    if (!storage) return;
    try {
      const stored = readMapSidecar(storage, key);
      journal.push(...stored.journal);
      for (const [num, count] of Object.entries(stored.discovered.rooms))
        discovered.rooms.set(Number(num), count);
      for (const e of stored.discovered.edges)
        discovered.edges.set(`${e.from}->${e.to}:${e.label ?? ""}`, {
          from: e.from,
          to: e.to,
          ...(e.label !== undefined ? { label: e.label } : {}),
          count: e.count,
        });
      Object.assign(layout, stored.layout);
      Object.assign(notes, stored.notes);
      Object.assign(edgeNotes, stored.edgeNotes);
    } catch (error) {
      storageError.value = error instanceof Error ? error.message : String(error);
    }
  }

  /** The game left the slot: persist, then release the in-memory map. */
  function unload(): void {
    drainJournal();
    if (loadedKey) persist();
    loadedKey = "";
    state.roomJournal.splice(0, state.roomJournal.length);
    resetMapMemory();
    session = 0;
    revision = "";
    open.value = false;
    buildingRoom.value = undefined;
    walkthroughPauseOwned = false;
  }

  watch(
    () => state.phase,
    (phase) => {
      if (phase === "running") loadFor(deps.getBootedGame());
      else if (phase === "idle" || phase === "error") unload();
    },
  );
  watch(() => state.roomJournal.length, drainJournal);

  /**
   * The current room is live position, not history: a replay seek or Take
   * control moves the engine without journal entries, so the durable record
   * is only the fallback once nothing is running.
   */
  const currentRoom = computed<number | null>(() => {
    void state.walkthrough.tick;
    if (state.walkthrough.active) {
      const room =
        typeof window === "undefined" ? undefined : window.__AGI_REPLAY__?.latest?.state.room;
      if (typeof room === "number") return room;
    }
    if (state.phase === "running") return hook.room;
    return journal[journal.length - 1]?.to ?? null;
  });

  const graph = computed<RoomGraph>(() => {
    // Subscribe to the journal's length, the patch tick (a patch changes both
    // the booted files and the authoring world), and the scan key.
    void journal.length;
    void state.patchTick;
    const scan = scanResources();
    const plan = plannedRooms();
    const wt = walkthroughCoverage.value;
    return mergeRoomGraph({
      journal,
      discovered: {
        rooms: Object.fromEntries(discovered.rooms),
        edges: [...discovered.edges.values()],
      },
      coverage: {
        playtested: wt?.playtested ?? new Set<number>(),
        referenced: scan.testCoverage.referenced,
      },
      ...(plan !== undefined ? { plan } : {}),
      scans: scan.scans,
      shared: scan.shared,
      resources: { logic: scan.logic, picture: scan.picture },
      experience: experience.value,
    });
  });

  // ---- deterministic layout -------------------------------------------------

  /** Occupied cell test against every assigned position. */
  function collides(x: number, y: number): boolean {
    for (const pos of Object.values(layout))
      if (Math.abs(pos.x - x) < CELL_W && Math.abs(pos.y - y) < CELL_H) return true;
    for (const pos of autoPositions.values())
      if (Math.abs(pos.x - x) < CELL_W && Math.abs(pos.y - y) < CELL_H) return true;
    return false;
  }

  /** First free cell on the spiral around (cx, cy); deterministic ring order. */
  function freeCell(cx: number, cy: number): { x: number; y: number } {
    for (let ring = 0; ring < 32; ring++) {
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = cx + dx * CELL_W;
          const y = cy + dy * CELL_H;
          if (!collides(x, y)) return { x, y };
        }
    }
    return { x: cx + 32 * CELL_W, y: cy };
  }

  /** Direction of travel an edge label encodes. Observed edges carry the
   * source room's exit edge ("right" = the target lies off its right edge);
   * planned edges carry authored exit names ("east" = the target lies east).
   * Screen space grows downward, so top/north/up is negative y. */
  const EDGE_VECTORS: Record<string, { dx: number; dy: number }> = {
    top: { dx: 0, dy: -1 },
    north: { dx: 0, dy: -1 },
    up: { dx: 0, dy: -1 },
    bottom: { dx: 0, dy: 1 },
    south: { dx: 0, dy: 1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    west: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
    east: { dx: 1, dy: 0 },
  };

  function positionFor(room: number): { x: number; y: number } {
    const manual = layout[String(room)];
    if (manual) return manual;
    const auto = autoPositions.get(room);
    if (auto) return auto;
    // Anchor relative to a connected neighbour already placed. A directional
    // edge wins over an unnamed one: "walked off the left edge into room 2"
    // means room 2 belongs left of the source, not wherever the spiral lands.
    let directed: { x: number; y: number } | null = null;
    let adjacent: { x: number; y: number } | null = null;
    for (const edge of graph.value.edges) {
      const outbound = edge.from === room;
      const inbound = edge.to === room;
      if (!outbound && !inbound) continue;
      const placed =
        layout[String(outbound ? edge.to : edge.from)] ??
        autoPositions.get(outbound ? edge.to : edge.from);
      if (!placed) continue;
      if (!adjacent) adjacent = { x: placed.x + CELL_W, y: placed.y };
      const v = edge.label ? EDGE_VECTORS[edge.label] : undefined;
      if (v && !directed) {
        directed = outbound
          ? { x: placed.x - v.dx * CELL_W, y: placed.y - v.dy * CELL_H }
          : { x: placed.x + v.dx * CELL_W, y: placed.y + v.dy * CELL_H };
      }
    }
    const origin = directed ?? adjacent ?? { x: 0, y: isolatedCursor++ * CELL_H * 3 };
    const pos = freeCell(origin.x, origin.y);
    autoPositions.set(room, pos);
    return pos;
  }

  function previewNode(room: number, x: number, y: number): void {
    autoPositions.set(room, { x, y });
    layoutVersion.value++;
  }

  function moveNode(room: number, x: number, y: number): void {
    layout[String(room)] = { x, y };
    autoPositions.delete(room);
    layoutVersion.value++;
    persist();
  }

  function resetLayout(): void {
    for (const k of Object.keys(layout)) delete layout[k];
    autoPositions.clear();
    isolatedCursor = 0;
    layoutVersion.value++;
    persist();
  }

  // ---- notes -----------------------------------------------------------------

  function noteFor(room: number): string {
    return notes[String(room)] ?? "";
  }

  function setNote(room: number, note: string): void {
    const key = String(room);
    if (note) notes[key] = note.slice(0, 4000);
    else delete notes[key];
    persist();
  }

  /** Edge-note identity matches the sidecar: `from->to:label` ("" for none). */
  function edgeNoteKey(from: number, to: number, label?: string): string {
    return `${from}->${to}:${label ?? ""}`;
  }

  function edgeNoteFor(from: number, to: number, label?: string): string {
    return edgeNotes[edgeNoteKey(from, to, label)] ?? "";
  }

  function setEdgeNote(from: number, to: number, label: string | undefined, note: string): void {
    const key = edgeNoteKey(from, to, label);
    if (note) edgeNotes[key] = note.slice(0, 400);
    else delete edgeNotes[key];
    persist();
  }

  /**
   * What the player pinned on the map for a room: its own note first, then a
   * bounded list of the edge notes touching it, each labelled by direction so
   * an authoring prompt can tell entrance intent from exit intent.
   */
  function noteIntentFor(room: number): string[] {
    const out: string[] = [];
    const own = notes[String(room)];
    if (own) out.push(own.slice(0, 400));
    for (const [key, note] of Object.entries(edgeNotes)) {
      const match = /^(\d+)->(\d+):(.*)$/.exec(key);
      if (!match) continue;
      const [, a, b, label] = match;
      const via = label ? ` "${label}"` : "";
      if (Number(b) === room) out.push(`exit from room ${a}${via}: ${note.slice(0, 400)}`);
      else if (Number(a) === room) out.push(`exit to room ${b}${via}: ${note.slice(0, 400)}`);
      if (out.length >= 16) break;
    }
    return out;
  }

  // ---- thumbnails -------------------------------------------------------------

  /**
   * Bind a presented frame to the room it shows. The frame's identity
   * (patchGeneration, cycle) must match a pending current-session entry —
   * anything else is ignored, so a frame can never land on the wrong room.
   */
  function observeFrame(frame: Frame): void {
    if (frame.patchGeneration === undefined || frame.cycle === undefined) return;
    const key = `${frame.patchGeneration}:${frame.cycle}`;
    const room = pendingThumbs.get(key);
    if (room === undefined) return;
    pendingThumbs.delete(key);
    thumbs.delete(room);
    thumbs.set(room, {
      pixels: frame.visual.slice(),
      kind: "observed",
    });
    if (thumbs.size > MAX_THUMBS) thumbs.delete(thumbs.keys().next().value!);
    thumbVersion.value++;
  }

  /**
   * Pure read — never renders. Static renders happen in prepareStaticThumbs:
   * a render inside a read bumps thumbVersion, which invalidates the very
   * computed that asked, and a capped cache would then thrash per node on
   * every read of a pictured map.
   */
  function thumbnailFor(room: number): MapThumbnail | null {
    void thumbVersion.value;
    return thumbs.get(room) ?? staticThumbs.get(room) ?? null;
  }

  const resources = computed(() => {
    void state.patchTick;
    void state.phase;
    return scanResources();
  });

  /**
   * Render the static-picture thumbs the current graph needs and does not yet
   * have — one container and profile per pass, one version bump at the end.
   * Runs on each graph revision; a warm cache reduces it to a cheap scan.
   */
  function prepareStaticThumbs(): void {
    const scan = scanResources();
    const missing: [number, number][] = [];
    for (const n of graph.value.nodes) {
      if (thumbs.has(n.room) || staticThumbs.has(n.room)) continue;
      if (scan.shared.has(n.room)) continue;
      const pic = scan.scans.get(n.room)?.pictures.find((p) => scan.picture.has(p));
      if (pic !== undefined) missing.push([n.room, pic]);
    }
    if (missing.length === 0) return;
    const files = new Map(Object.entries(scan.files));
    const container = openContainer(files);
    const profile = scan.profile ?? detectProfile(files);
    let produced = false;
    for (const [room, pic] of missing) {
      try {
        const payload = container.getResource("picture", pic);
        if (!payload) continue;
        const surface = createPictureSurface();
        renderPicture(payload, surface, { profile });
        staticThumbs.set(room, { pixels: surface.visual.slice(), kind: "static" });
        if (staticThumbs.size > MAX_STATIC_THUMBS)
          staticThumbs.delete(staticThumbs.keys().next().value!);
        produced = true;
      } catch {
        /* an undrawable picture leaves the node faceless */
      }
    }
    if (produced) thumbVersion.value++;
  }
  watch(graph, () => {
    // Evidence can improve for an already-placed room (a labeled edge arrives
    // after the fallback anchored it): recompute auto positions against the
    // current graph. Manual layout entries are unaffected.
    autoPositions.clear();
    isolatedCursor = 0;
    layoutVersion.value++;
    prepareStaticThumbs();
  });

  // ---- open/close ---------------------------------------------------------------

  /**
   * The walkthrough artifact's checkpoint rooms — playtested facts for this
   * game's graph. Checkpoints are sparse waypoints: the run may have passed
   * through unrecorded rooms between them, so no direct-transition coverage
   * is claimed. Loaded once per storage target; resolved against the game's
   * own edition (hasWalkthrough filters).
   */
  async function loadCoverage(): Promise<void> {
    const game = deps.getBootedGame();
    const alias = game?.revision ? resolveWalkthrough(game.revision) : null;
    const key = `${loadedKey}:${alias ?? ""}`;
    if (!game?.installed || !alias || coverageKey === key) return;
    coverageKey = key;
    try {
      const artifact = await loadWalkthrough(alias);
      if (coverageKey !== key) return;
      const playtested = new Set<number>();
      for (const cp of getOrExtractCheckpoints(artifact)) playtested.add(cp.room);
      walkthroughCoverage.value = { playtested };
    } catch {
      /* no readable walkthrough — the map shows the rest */
    }
  }

  function openMap(options?: { experience?: MapExperience }): void {
    if (open.value || state.phase !== "running") return;
    experience.value = options?.experience ?? "play";
    drainJournal();
    // The map holds a pause over the active execution mode: the live cycle
    // timer and, during a walkthrough, the replay driver that keeps it moving.
    deps.pauseEngine("map");
    walkthroughPauseOwned = state.walkthrough.status === "playing";
    if (walkthroughPauseOwned) deps.pauseWalkthrough();
    void loadCoverage();
    open.value = true;
  }

  /** First agentLog index of the in-flight map build's turn. */
  let buildFeedStart = 0;
  /** Set when a mid-build close surfaced the build through the bubble. */
  let buildBubble = false;

  function closeMap(): void {
    if (!open.value) return;
    open.value = false;
    // Release the map's hold — the pause lifts only when no other owner
    // (the remix bubble, the history transport) is still holding one. A room
    // build in flight keeps its own "mapBuild" hold, so closing the map
    // mid-build cannot resume play into a half-authored room; its progress
    // moves to the assistant bubble so the work stays visible.
    deps.resumeEngine("map");
    if (walkthroughPauseOwned && state.walkthrough.status === "paused") deps.resumeWalkthrough();
    walkthroughPauseOwned = false;
    if (buildingRoom.value !== undefined) {
      buildBubble = true;
      const feedStartSeq = state.agentLog[buildFeedStart]?.seq;
      state.powerUp = {
        mode: "room",
        messages: deps.getSession()?.getMessages() ?? [],
        open: true,
        needsConfig: false,
        busy: true,
        feedStart: buildFeedStart,
        ...(feedStartSeq !== undefined ? { feedStartSeq } : {}),
        reply: "",
        room: buildingRoom.value,
        error: "",
      };
    }
  }

  function select(room: number | undefined): void {
    selected.value = room;
  }

  // ---- the map as the plan surface -----------------------------------------
  //
  // The live world map is also the planning surface: edits fork the session's
  // world at its current revision and commit through the revision check — a
  // conflict refuses rather than overwriting a concurrent agent turn.

  function setBuilding(room: number | undefined): void {
    buildingRoom.value = room;
  }

  /**
   * Extend the running game from a map node: author one planned room's
   * resources through the same room turn just-in-time authoring uses, against
   * the planned inbound edge when the plan names one. The map stays open —
   * the patch lands on the paused live game.
   */
  async function buildPlannedRoom(room: number): Promise<void> {
    if (experience.value !== "create" || buildingRoom.value !== undefined || !deps.buildRoomFromMap)
      return;
    const entry = plannedEntry(room);
    if (!entry) {
      planError.value = `Room ${room} is not in the plan.`;
      return;
    }
    let from: number | null = null;
    let exitName: string | undefined;
    const rooms = deps.getSession()?.state.authoring.world.rooms ?? {};
    for (const [num, candidate] of Object.entries(rooms)) {
      const named = Object.entries(candidate.exits).find(([, to]) => to === room);
      if (named) {
        from = Number(num);
        exitName = named[0];
        break;
      }
    }
    from ??= currentRoom.value ?? 1;
    buildingRoom.value = room;
    buildFeedStart = state.agentLog.length;
    planError.value = "";
    try {
      await deps.buildRoomFromMap(room, from, noteIntentFor(room), exitName);
    } catch (error) {
      planError.value = String(error);
    } finally {
      buildingRoom.value = undefined;
      if (buildBubble && state.powerUp.mode === "room" && state.powerUp.room === room) {
        // The bubble stood in for the closed map's progress: settle it —
        // a landed build hands control back; a failed one keeps its error.
        state.powerUp.busy = false;
        if (planError.value) state.powerUp.error = planError.value;
        else state.powerUp.open = false;
      }
      buildBubble = false;
    }
  }

  /**
   * Apply a draft mutation through the shared validator. Edits fork the
   * session world and commit only while its revision is still the draft's
   * base — a moved world is a conflict, not a silent overwrite. A rejected
   * mutation leaves the target untouched.
   */
  function editWorld(mutate: (draft: WorldDraft) => string | null): string | null {
    if (experience.value !== "create")
      return "Plan editing is a creator action — open the map's plan surface.";
    const session = deps.getSession();
    if (!session) return "This game has no authoring plan to edit.";
    const draft = createWorldDraft(session.state.authoring.world);
    const error = mutate(draft);
    if (error) return error;
    const result = session.commitPlanDraft(draft);
    if (result.status === "busy")
      return "The agent is mid-turn — the map accepts edits again when it finishes.";
    if (result.status === "conflict")
      return "The plan changed while you were editing — close and reopen the map.";
    if (result.status === "invalid") return result.error;
    planVersion.value++;
    void persistPlan();
    return null;
  }

  /** Run an edit and publish its refusal for the detail pane. */
  function planOp(run: () => string | null): string | null {
    const error = run();
    planError.value = error ?? "";
    return error;
  }

  function plannedEntry(room: number): WorldPlan["rooms"][string] | null {
    if (experience.value !== "create") return null;
    return plannedRooms()?.[String(room)] ?? null;
  }

  function renamePlannedRoom(room: number, title: string): string | null {
    return planOp(() => editWorld((draft) => draftRenameRoom(draft, room, title)));
  }

  function setPlannedBrief(room: number, brief: string): string | null {
    return planOp(() => editWorld((draft) => draftSetBrief(draft, room, brief)));
  }

  /**
   * A new planned node plus — when the source is in the plan — the named exit
   * that reaches it, as one validated edit. The number is the lowest free one
   * that no built resource, observation or plan entry already claims.
   */
  function addPlannedRoom(
    fromRoom: number | null,
    title: string,
    brief: string,
    exitName: string,
  ): { room?: number; error?: string } {
    if (!title.trim()) {
      planError.value = "A room needs a title";
      return { error: planError.value };
    }
    let created: number | undefined;
    const error = planOp(() =>
      editWorld((draft) => {
        const scan = scanResources();
        const taken = new Set<number>([...scan.logic, ...discovered.rooms.keys()]);
        for (const entry of journal) taken.add(entry.to);
        const num = lowestFreeRoom(draft.world.rooms, (n) => taken.has(n));
        if (num === undefined) return "No free room numbers remain.";
        const name = exitName.trim() || "passage";
        const editError = draftEdit(draft, (world) => {
          world.rooms[String(num)] = {
            title: title.trim(),
            description: brief.trim(),
            exits: {},
          };
          const from = fromRoom === null ? undefined : world.rooms[String(fromRoom)];
          if (from) from.exits[name] = num;
        });
        if (!editError) created = num;
        return editError;
      }),
    );
    return created !== undefined
      ? { room: created }
      : { error: error ?? "The room could not be added." };
  }

  /**
   * Drop a planned room. Built rooms and rooms the journal has visited are
   * refused: deleting either would claim a fact off the record. The draft op
   * prunes the exits that pointed at the room.
   */
  function removePlannedRoom(room: number): string | null {
    return planOp(() => {
      const scan = scanResources();
      if (scan.logic.has(room) || scan.picture.has(room))
        return `Room ${room} is already built — its resources stay; change it in Remix instead.`;
      if (
        discovered.rooms.has(room) ||
        journal.some((entry) => entry.to === room || entry.from === room)
      )
        return `Room ${room} is on the record — the map keeps visited rooms.`;
      return editWorld((draft) => draftRemoveRoom(draft, room));
    });
  }

  function addPlannedExit(from: number, name: string, to: number): string | null {
    return planOp(() => editWorld((draft) => draftAddExit(draft, from, name, to)));
  }

  function removePlannedExit(from: number, name: string): string | null {
    return planOp(() => editWorld((draft) => draftRemoveExit(draft, from, name)));
  }

  // ---- displayed field edits ---------------------------------------------
  //
  // A form's base is captured when the edit session opens (room selected),
  // not when a field saves. Each commit compares the field's live plan value
  // against that base — a plan update under an open form flags a conflict
  // and keeps the user's text for an explicit keep/revert choice, never a
  // silent overwrite. Clean fields simply follow the plan. A busy turn still
  // refuses through commitPlanDraft; these bases catch the turn that
  // completed while the form stayed open.

  function planFieldValue(room: number, field: "title" | "brief"): string | null {
    const entry = plannedEntry(room);
    return entry ? (field === "title" ? entry.title : entry.description) : null;
  }

  function beginPlanEdit(room: number): PlanRoomEdit | null {
    const entry = plannedEntry(room);
    if (!entry) return null;
    return {
      room,
      title: { draft: entry.title, base: entry.title, conflict: null },
      brief: { draft: entry.description, base: entry.description, conflict: null },
    };
  }

  function syncPlanEdit(edit: PlanRoomEdit): void {
    const entry = plannedEntry(edit.room);
    if (!entry) return;
    for (const field of ["title", "brief"] as const) {
      const f = edit[field];
      const current = field === "title" ? entry.title : entry.description;
      if (current === f.base) {
        // Back at the CAS anchor — any earlier flag is stale.
        f.conflict = null;
        continue;
      }
      if (f.draft === f.base || f.draft === current) {
        // Clean — or the plan converged to the user's text: follow it.
        f.draft = current;
        f.base = current;
        f.conflict = null;
      } else {
        // Dirty under a moved plan: flag with the plan's current text and
        // keep the base anchored so the commit CAS still refuses.
        f.conflict = current;
      }
    }
  }

  /**
   * The shared write for a field: the live value must still be `expect` —
   * the base for a plain commit, the flagged value for an explicit
   * overwrite. A mismatch flags `conflict` and writes nothing.
   */
  function writePlanField(
    edit: PlanRoomEdit,
    field: "title" | "brief",
    expect: string,
  ): string | null {
    const current = planFieldValue(edit.room, field);
    if (current === null) return planOp(() => `Room ${edit.room} is no longer in the plan.`);
    if (current !== expect) {
      edit[field].conflict = current;
      return "conflict";
    }
    const error = planOp(() =>
      editWorld((draft) =>
        field === "title"
          ? draftRenameRoom(draft, edit.room, edit[field].draft)
          : draftSetBrief(draft, edit.room, edit[field].draft),
      ),
    );
    if (error === null) {
      edit[field].base = edit[field].draft;
      edit[field].conflict = null;
    }
    return error;
  }

  function commitPlanField(edit: PlanRoomEdit | null, field: "title" | "brief"): string | null {
    if (!edit) return null;
    const f = edit[field];
    const current = planFieldValue(edit.room, field);
    if (f.draft === current) {
      // Nothing to write — including the plan converging to the draft.
      if (current !== null) {
        f.base = current;
        f.conflict = null;
      }
      return null;
    }
    if (field === "title" && !f.draft.trim()) return null; // an emptied blur is not an edit
    return writePlanField(edit, field, f.base);
  }

  function resolvePlanField(
    edit: PlanRoomEdit | null,
    field: "title" | "brief",
    keep: "mine" | "plan",
  ): string | null {
    if (!edit) return null;
    const f = edit[field];
    if (f.conflict === null) return null;
    if (keep === "plan") {
      const current = planFieldValue(edit.room, field);
      f.draft = current ?? f.conflict;
      f.base = f.draft;
      f.conflict = null;
      return null;
    }
    // Explicit overwrite — still CAS against the value the user saw flagged.
    return writePlanField(edit, field, f.conflict);
  }

  return {
    open,
    selected,
    journal,
    graph,
    experience,
    currentRoom,
    unsaved,
    storageError,
    thumbVersion,
    layoutVersion,
    openMap,
    closeMap,
    select,
    positionFor,
    previewNode,
    moveNode,
    resetLayout,
    noteFor,
    setNote,
    edgeNoteFor,
    setEdgeNote,
    noteIntentFor,
    thumbnailFor,
    resources,
    studioSource: (picture) => {
      // The scan and the revision must describe the same booted files.
      const game = deps.getBootedGame();
      const scanned = scanResources();
      if (!game || scanned.files !== game.files) return null;
      const source = studioPictureSource(scanned, picture, deps.getSession()?.state);
      return source && { ...source, baseRevision: game.revision };
    },
    observeFrame,
    exportSidecar,
    retrySave,
    storedSidecar,
    planError,
    planDirty,
    planSaveError,
    retryPlanSave,
    buildingRoom,
    planAvailable,
    canPlan,
    setBuilding,
    buildPlannedRoom,
    plannedEntry,
    beginPlanEdit,
    syncPlanEdit,
    commitPlanField,
    resolvePlanField,
    renamePlannedRoom,
    setPlannedBrief,
    addPlannedRoom,
    removePlannedRoom,
    addPlannedExit,
    removePlannedExit,
  };
}

export type { RoomMapSidecar };
