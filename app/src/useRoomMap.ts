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
  type RoomGraph,
  type RoomMapSidecar,
  type RoomObservation,
  type StaticRoomScan,
} from "../../src/agent/roomMap.ts";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import type { AgentSession } from "./agent/agentSession.ts";
import type { AuthoringState } from "../../src/agent/authoringState.ts";
import { gameStorageKey, type BootedGame, type Frame } from "./gameTypes.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";
import { emptyMapSidecar, readMapSidecar, writeMapSidecar } from "./roomMapStore.ts";
import type { RoomTransitionNotice } from "./workerProtocol.ts";

/** Durable journal cap — the sidecar contract bounds at the same number. */
const MAX_JOURNAL = 4096;
/** Observed-frame thumbnails; evicted oldest-first. */
const MAX_THUMBS = 96;
/** Static picture renders; evicted oldest-first. */
const MAX_STATIC_THUMBS = 64;
/** Rooms the journal still expects a landing frame for. */
const MAX_PENDING_THUMBS = 64;

const CELL_W = 200;
const CELL_H = 170;

export interface MapThumbnail {
  readonly pixels: Uint8Array;
  /** "observed" is a live composed frame; "static" is a picture render. */
  readonly kind: "observed" | "static";
}

interface ScannedResources {
  readonly key: string;
  readonly scans: Map<number, StaticRoomScan>;
  readonly shared: Set<number>;
  readonly logic: Set<number>;
  readonly picture: Set<number>;
  readonly files: Record<string, Uint8Array>;
}

export interface RoomMapDeps {
  readonly state: EngineState;
  readonly hook: TextHook;
  readonly getBootedGame: () => BootedGame | null;
  readonly getSession: () => AgentSession | null;
  readonly pauseEngine: () => void;
  readonly resumeEngine: () => void;
  /** Injectable for tests; defaults to browser storage. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}

export interface RoomMap {
  readonly open: Ref<boolean>;
  readonly selected: Ref<number | undefined>;
  readonly journal: RoomObservation[];
  readonly graph: ComputedRef<RoomGraph>;
  readonly currentRoom: ComputedRef<number | null>;
  readonly unsaved: Ref<boolean>;
  /** Load-failure explanation; the map opens empty rather than blocking play. */
  readonly storageError: Ref<string>;
  /** Bumped whenever any thumbnail changes; lets views subscribe once. */
  readonly thumbVersion: Ref<number>;
  /** Bumped whenever a node position changes (drag, nudge, reset). */
  readonly layoutVersion: Ref<number>;
  openMap(): void;
  closeMap(): void;
  select(room: number | undefined): void;
  positionFor(room: number): { x: number; y: number };
  /** Move during a drag: in-memory only; moveNode commits. */
  previewNode(room: number, x: number, y: number): void;
  moveNode(room: number, x: number, y: number): void;
  resetLayout(): void;
  noteFor(room: number): string;
  setNote(room: number, note: string): void;
  thumbnailFor(room: number): MapThumbnail | null;
  observeFrame(frame: Frame): void;
  exportSidecar(): RoomMapSidecar;
  retrySave(): void;
  /** For a non-running game's export: the stored sidecar, or empty. */
  storedSidecar(target: string): RoomMapSidecar;
}

export function useRoomMap(deps: RoomMapDeps): RoomMap {
  const { state, hook } = deps;
  const storage = deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);

  const open = ref(false);
  const selected = ref<number>();
  const unsaved = ref(false);
  const storageError = ref("");
  const thumbVersion = ref(0);
  const layoutVersion = ref(0);

  /** The durable journal — survives reboots and reloads of the same game. */
  const journal = reactive<RoomObservation[]>([]);
  const layout = reactive<Record<string, { x: number; y: number }>>({});
  const notes = reactive<Record<string, string>>({});

  /** The storage target the loaded map belongs to; "" while nothing is loaded. */
  let loadedKey = "";
  /** Boot counter: persisted entries' max session + 1 each time the game boots. */
  let session = 0;
  /** The booted resource revision this session's entries bind to. */
  let revision = "";
  /** The game was already paused when the map opened — the map owns no resume. */
  let pauseOwned = false;

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
      };
    const key = game.revision;
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
      };
      return scanned;
    }
    const profile = detectProfile(new Map(Object.entries(game.files)));
    const { scans, shared } = scanContainerExits(logicPayloads, profile);
    scanned = {
      key,
      scans,
      shared,
      logic: new Set(logicPayloads.keys()),
      picture,
      files: game.files,
    };
    staticThumbs.clear();
    return scanned;
  }

  /** world.rooms intent from the authoring session — absent for imports. */
  function plannedRooms(): AuthoringState["world"]["rooms"] | undefined {
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
    };
  }

  /** Drain the link's raw notices into the durable journal. */
  function drainJournal(): void {
    const pending = state.roomJournal;
    if (pending.length === 0) return;
    const notices = pending.splice(0, pending.length);
    for (const notice of notices) {
      journal.push(toObservation(notice));
      if (journal.length > MAX_JOURNAL) journal.splice(0, journal.length - MAX_JOURNAL);
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
      layout: { ...layout },
      notes: { ...notes },
    };
  }

  function persist(): void {
    if (!loadedKey || !storage) return;
    if (!writeMapSidecar(storage, loadedKey, exportSidecar())) unsaved.value = true;
  }

  function retrySave(): void {
    if (!loadedKey || !storage) return;
    if (writeMapSidecar(storage, loadedKey, exportSidecar())) unsaved.value = false;
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
    journal.splice(0, journal.length);
    for (const k of Object.keys(layout)) delete layout[k];
    for (const k of Object.keys(notes)) delete notes[k];
    thumbs.clear();
    staticThumbs.clear();
    pendingThumbs.clear();
    autoPositions.clear();
    isolatedCursor = 0;
    scanned = null;
    selected.value = undefined;
    unsaved.value = false;
    storageError.value = "";
    revision = game?.revision ?? "";
    if (key && storage) {
      try {
        const stored = readMapSidecar(storage, key);
        journal.push(...stored.journal);
        Object.assign(layout, stored.layout);
        Object.assign(notes, stored.notes);
      } catch (error) {
        storageError.value = error instanceof Error ? error.message : String(error);
      }
    }
    session = journal.reduce((max, e) => Math.max(max, e.session), 0) + 1;
  }

  /** The game left the slot: persist, then release the in-memory map. */
  function unload(): void {
    drainJournal();
    if (loadedKey) persist();
    loadedKey = "";
    state.roomJournal.splice(0, state.roomJournal.length);
    journal.splice(0, journal.length);
    for (const k of Object.keys(layout)) delete layout[k];
    for (const k of Object.keys(notes)) delete notes[k];
    thumbs.clear();
    staticThumbs.clear();
    pendingThumbs.clear();
    autoPositions.clear();
    isolatedCursor = 0;
    scanned = null;
    selected.value = undefined;
    session = 0;
    revision = "";
    open.value = false;
    pauseOwned = false;
  }

  watch(
    () => state.phase,
    (phase) => {
      if (phase === "running") loadFor(deps.getBootedGame());
      else if (phase === "idle" || phase === "error") unload();
    },
  );
  watch(() => state.roomJournal.length, drainJournal);

  /** The current room: the newest observation's target, else the live hook. */
  const currentRoom = computed<number | null>(() => {
    const last = journal[journal.length - 1];
    if (last) return last.to;
    return state.phase === "running" ? hook.room : null;
  });

  const graph = computed<RoomGraph>(() => {
    // Subscribe to the journal's length, the patch tick (a patch changes both
    // the booted files and the authoring world), and the scan key.
    void journal.length;
    void state.patchTick;
    const scan = scanResources();
    const plan = plannedRooms();
    return mergeRoomGraph({
      journal,
      ...(plan !== undefined ? { plan } : {}),
      scans: scan.scans,
      shared: scan.shared,
      resources: { logic: scan.logic, picture: scan.picture },
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

  function positionFor(room: number): { x: number; y: number } {
    const manual = layout[String(room)];
    if (manual) return manual;
    const auto = autoPositions.get(room);
    if (auto) return auto;
    // Anchor beside the cheapest connected neighbour already placed; a node
    // with no placed neighbour starts its own component column.
    let anchor: { x: number; y: number } | null = null;
    for (const edge of graph.value.edges) {
      const other = edge.from === room ? edge.to : edge.to === room ? edge.from : null;
      if (other === null) continue;
      const placed = layout[String(other)] ?? autoPositions.get(other);
      if (placed) {
        anchor = placed;
        break;
      }
    }
    const origin = anchor ?? { x: 0, y: isolatedCursor++ * CELL_H * 3 };
    const pos = freeCell(origin.x + CELL_W, origin.y);
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

  function thumbnailFor(room: number): MapThumbnail | null {
    void thumbVersion.value;
    const observed = thumbs.get(room);
    if (observed) return observed;
    const cached = staticThumbs.get(room);
    if (cached) return cached;
    const scan = scanResources();
    if (scan.shared.has(room)) return null;
    const roomScan = scan.scans.get(room);
    if (!roomScan) return null;
    for (const pic of roomScan.pictures) {
      if (!scan.picture.has(pic)) continue;
      try {
        const container = openContainer(new Map(Object.entries(scan.files)));
        const payload = container.getResource("picture", pic);
        if (!payload) continue;
        const surface = createPictureSurface();
        renderPicture(payload, surface, {
          profile: detectProfile(new Map(Object.entries(scan.files))),
        });
        const thumb: MapThumbnail = { pixels: surface.visual.slice(), kind: "static" };
        staticThumbs.delete(room);
        staticThumbs.set(room, thumb);
        if (staticThumbs.size > MAX_STATIC_THUMBS)
          staticThumbs.delete(staticThumbs.keys().next().value!);
        thumbVersion.value++;
        return thumb;
      } catch {
        return null;
      }
    }
    return null;
  }

  // ---- open/close ---------------------------------------------------------------

  function openMap(): void {
    if (open.value || state.phase !== "running") return;
    drainJournal();
    pauseOwned = !state.paused;
    if (pauseOwned) deps.pauseEngine();
    open.value = true;
  }

  function closeMap(): void {
    if (!open.value) return;
    open.value = false;
    // Restore the pause the map created — unless another owner (the remix
    // bubble) is still holding one.
    if (pauseOwned && state.paused && !state.powerUp.open) deps.resumeEngine();
    pauseOwned = false;
  }

  function select(room: number | undefined): void {
    selected.value = room;
  }

  return {
    open,
    selected,
    journal,
    graph,
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
    thumbnailFor,
    observeFrame,
    exportSidecar,
    retrySave,
    storedSidecar,
  };
}

export type { RoomMapSidecar };
