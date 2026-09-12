/**
 * The world-map model: three sources — an ordered journal of observed room
 * transitions (fact), the authoring world's planned rooms and exits (intent),
 * and literal new.room targets found by decoding each logic (candidates) —
 * merged into one labelled graph. Pure data; presentation and persistence
 * live in the app.
 *
 * Honest labels: an observed edge means the interpreter crossed it; a planned
 * edge is intent, not evidence resources implement it; a static edge is a
 * literal target in a logic that may run in another context. A logic reached
 * through call/call.v is shared — its transitions are recorded but never
 * attributed to the logic's own number. In-degree is not reachability.
 */
import { decodeLogicActions } from "../logic/disassembler.ts";
import type { AgiProfile } from "../runtime/profile.ts";

export type RoomTransitionCause =
  "boot" | "edge" | "logic" | "restore" | "restart" | "reenter" | "jump";

/** Ego edge codes (v2): which side of the screen ego left through. */
export const EDGE_SIDES = { 1: "top", 2: "right", 3: "bottom", 4: "left" } as const;
export type EdgeSide = (typeof EDGE_SIDES)[keyof typeof EDGE_SIDES];

/** One ordered journal entry — a transition the live worker reported. */
export interface RoomObservation {
  /** Journal order within the session stream that produced it. */
  readonly seq: number;
  /** Boot/session identity; stale sessions must not move the marker. */
  readonly session: number;
  readonly from: number | null;
  readonly to: number;
  readonly cause: RoomTransitionCause;
  /** Cause "edge": the side ego left through. Never a walkable exit. */
  readonly edge?: EdgeSide;
  readonly cycle: number;
  /** Resource revision in play when the transition was observed. */
  readonly resourceSet: string;
  readonly scoreDelta: number;
  /** Inventory item numbers gained/lost since the previous entry. */
  readonly gained: readonly number[];
  readonly lost: readonly number[];
}

export type EdgeProvenance = "observed" | "planned" | "static";

export interface RoomGraphEdge {
  readonly from: number;
  readonly to: number;
  readonly provenance: EdgeProvenance;
  /** Exit name (planned) or edge side (observed) distinguishing same-pair exits. */
  readonly label?: string;
  /** Observed traversal count. */
  readonly count?: number;
}

export interface RoomGraphNode {
  readonly room: number;
  readonly title?: string;
  /** Visited at least once by the journal. */
  readonly observed: boolean;
  readonly visits: number;
  /** The authoring world has a plan entry for this room. */
  readonly planned: boolean;
  /** A logic resource exists for this room. */
  readonly authored: boolean;
  /** A picture resource exists for this room — separate fact from logic. */
  readonly picture: boolean;
  /** A logic in the container names this room as a literal new.room target. */
  readonly staticTarget: boolean;
  /** The room's own logic exits through a computed (variable) target. */
  readonly variableExit: boolean;
  /** Incoming transitions exist but their source room is unresolved. */
  readonly unknownSource: boolean;
}

export interface RoomGraph {
  readonly nodes: readonly RoomGraphNode[];
  readonly edges: readonly RoomGraphEdge[];
}

/** Literal exit scan of one logic: attributed edges plus unresolved context. */
export interface StaticRoomScan {
  /** Literal new.room targets, in code order (duplicates preserved). */
  readonly targets: readonly number[];
  /** new.room.v — the target is computed at runtime; value unknown. */
  readonly variableTarget: boolean;
  /**
   * Picture numbers this logic provably draws or loads: draw.pic/load.pic/
   * overlay.pic/discard.pic all take a variable, so a number is recorded only
   * when the scan's literal binding (below) still holds at the call site.
   */
  readonly pictures: readonly number[];
}

/**
 * Opcodes that clobber a var binding, with the argument positions they write.
 * A var written any other way drops its literal binding — the scan is
 * deliberately conservative, so a missing entry means no claim, not a guess.
 */
const VAR_WRITES: Readonly<Record<string, readonly number[]>> = {
  increment: [0],
  decrement: [0],
  assignn: [0],
  assignv: [0],
  addn: [0],
  addv: [0],
  subn: [0],
  subv: [0],
  muln: [0],
  mulv: [0],
  divn: [0],
  divv: [0],
  lindirectn: [0],
  lindirectv: [0],
  rindirect: [1],
  random: [2],
  "get.posn": [1, 2],
  "get.priority": [1],
  "get.dir": [1],
  "get.room.v": [0],
  "get.num": [1],
  distance: [2],
};

const PICTURE_USES: ReadonlySet<string> = new Set([
  "load.pic",
  "draw.pic",
  "overlay.pic",
  "discard.pic",
]);

/**
 * Literal room targets in one logic's bytecode. new.room's operand is a
 * resource number, not necessarily a room — but by AGI convention room N is
 * logic N, so the literal is a candidate, labelled as such downstream.
 * Decoding failures (truncated or hostile payloads) yield an empty scan —
 * the map degrades, it does not refuse.
 *
 * Picture use is tracked through straight-line var bindings: assignn binds a
 * literal, assignv propagates one, and every other var-writing opcode in
 * VAR_WRITES clears it. When `selfRoom` names the room this logic serves,
 * v0 — the interpreter's current-room variable — starts bound to it, which
 * is the AGI convention `load.pic(v0); draw.pic(v0)` relies on. Conditional
 * bindings still count: the result is a candidate, never an asserted use.
 */
export function scanStaticExits(
  payload: Uint8Array,
  profile?: AgiProfile,
  selfRoom?: number,
): StaticRoomScan {
  try {
    const targets: number[] = [];
    const pictures = new Set<number>();
    const bound = new Map<number, number>();

    if (selfRoom !== undefined) bound.set(0, selfRoom);
    let variableTarget = false;
    for (const action of decodeLogicActions(payload, profile !== undefined ? { profile } : {})) {
      if (action.name === "new.room") targets.push(action.args[0]!);
      else if (action.name === "new.room.v") variableTarget = true;
      else if (action.name === "assignn") bound.set(action.args[0]!, action.args[1]!);
      else if (action.name === "assignv") {
        const value = bound.get(action.args[1]!);
        if (value === undefined) bound.delete(action.args[0]!);
        else bound.set(action.args[0]!, value);
      } else if (PICTURE_USES.has(action.name)) {
        const pic = bound.get(action.args[0]!);
        if (pic !== undefined) pictures.add(pic);
      }
      for (const at of VAR_WRITES[action.name] ?? [])
        if (action.name !== "assignn" && action.name !== "assignv") bound.delete(action.args[at]!);
    }
    return { targets, variableTarget, pictures: [...pictures].sort((a, b) => a - b) };
  } catch {
    return { targets: [], variableTarget: false, pictures: [] };
  }
}

/**
 * Static candidates for the whole container: which logics are reachable only
 * through call/call.v (shared — their transitions belong to an unresolved
 * caller) and which literal exits each logic names.
 */
export function scanContainerExits(
  logics: ReadonlyMap<number, Uint8Array>,
  profile?: AgiProfile,
): { scans: Map<number, StaticRoomScan>; shared: Set<number> } {
  const scans = new Map<number, StaticRoomScan>();
  const shared = new Set<number>();
  for (const [num, payload] of logics) {
    // selfRoom seeds the v0 convention; consumers must still check `shared`
    // before attributing a picture use — a shared logic's v0 is its caller's.
    scans.set(num, scanStaticExits(payload, profile, num));
    try {
      for (const action of decodeLogicActions(payload, profile !== undefined ? { profile } : {}))
        if (action.name === "call") shared.add(action.args[0]!);
    } catch {
      /* the scan above already yielded empty for this payload */
    }
  }
  return { scans, shared };
}

/** Merge the three sources without collapsing distinct exits between a pair. */
export function mergeRoomGraph(input: {
  readonly journal: readonly RoomObservation[];
  readonly plan?: Readonly<
    Record<string, { title: string; description: string; exits: Record<string, number> }>
  >;
  readonly scans?: ReadonlyMap<number, StaticRoomScan>;
  /** Logic numbers reachable only through call/call.v — shared context. */
  readonly shared?: ReadonlySet<number>;
  readonly resources?: {
    readonly logic: ReadonlySet<number>;
    readonly picture: ReadonlySet<number>;
  };
}): RoomGraph {
  const nodes = new Map<
    number,
    {
      title?: string;
      observed: boolean;
      visits: number;
      planned: boolean;
      authored: boolean;
      picture: boolean;
      staticTarget: boolean;
      variableExit: boolean;
      unknownSource: boolean;
    }
  >();
  const node = (room: number) => {
    let n = nodes.get(room);
    if (!n) {
      n = {
        observed: false,
        visits: 0,
        planned: false,
        authored: false,
        picture: false,
        staticTarget: false,
        variableExit: false,
        unknownSource: false,
      };
      nodes.set(room, n);
    }
    return n;
  };

  // Walkable observations become edges keyed by (from, to, edge side); a
  // restore, restart or re-entry is journal fact but never a walkable exit.
  const observed = new Map<string, { from: number; to: number; label?: string; count: number }>();
  for (const entry of input.journal) {
    node(entry.to).observed = true;
    node(entry.to).visits++;
    if (entry.from !== null) node(entry.from).observed = true;
    if (entry.from === null || !["edge", "logic", "jump"].includes(entry.cause)) continue;
    const label = entry.cause === "edge" && entry.edge ? entry.edge : undefined;
    const key = `${entry.from}->${entry.to}:${label ?? ""}`;
    const existing = observed.get(key);
    if (existing) existing.count++;
    else
      observed.set(key, { from: entry.from, to: entry.to, ...(label ? { label } : {}), count: 1 });
  }

  const planned: RoomGraphEdge[] = [];
  for (const [num, room] of Object.entries(input.plan ?? {})) {
    const from = Number(num);
    node(from).planned = true;
    node(from).title = room.title;
    for (const [label, to] of Object.entries(room.exits)) {
      node(to);
      planned.push({ from, to, provenance: "planned", label });
    }
  }

  const staticEdges: RoomGraphEdge[] = [];
  for (const [num, scan] of input.scans ?? []) {
    const shared = input.shared?.has(num) === true;
    if (scan.variableTarget) node(num).variableExit = true;
    for (const to of scan.targets) {
      node(to).staticTarget = true;
      if (shared) {
        // The logic runs under an unresolved caller: the target exists but
        // attributing the exit to this logic's number would invent a route.
        node(to).unknownSource = true;
      } else {
        node(num);
        staticEdges.push({ from: num, to, provenance: "static" });
      }
    }
  }

  for (const num of input.resources?.logic ?? []) node(num).authored = true;
  for (const num of input.resources?.picture ?? []) node(num).picture = true;

  const ordered = [...nodes.entries()].sort((a, b) => a[0] - b[0]);
  return {
    nodes: ordered.map(([room, n]) => ({ room, ...n })),
    edges: [
      ...[...observed.values()].map((e) => ({
        from: e.from,
        to: e.to,
        provenance: "observed" as const,
        ...(e.label !== undefined ? { label: e.label } : {}),
        count: e.count,
      })),
      ...planned,
      ...staticEdges,
    ],
  };
}

/** The persisted sidecar: journal + UI layout, versioned and bounded. */
export interface RoomMapSidecar {
  journal: RoomObservation[];
  /** Manually positioned nodes, keyed by room number. */
  layout: Record<string, { x: number; y: number }>;
  /** Per-room UI notes; separate from the canonical authoring plan. */
  notes: Record<string, string>;
}

const MAX_JOURNAL_ENTRIES = 4096;
const MAX_LAYOUT_NODES = 512;
const MAX_NOTES = 512;
const MAX_NOTE_CHARS = 4000;
const CAUSES: readonly RoomTransitionCause[] = [
  "boot",
  "edge",
  "logic",
  "restore",
  "restart",
  "reenter",
  "jump",
];
const SIDES: readonly string[] = ["top", "right", "bottom", "left"];

function roomNum(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)
    throw new Error(`Invalid ${label}: expected a room number 0..255.`);
  return value as number;
}

function numList(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error(`Invalid ${label}: expected at most 256 item numbers.`);
  return value.map((v) => roomNum(v, label));
}

/**
 * Validate a parsed MAP.JSON body. A missing sidecar is an empty map;
 * malformed or unsupported data is rejected so the caller can explain a
 * reset or reimport. No old-version readers.
 */
export function validateMapSidecar(value: unknown): RoomMapSidecar {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid map data: expected an object.");
  const raw = value as Record<string, unknown>;
  if (raw["format"] !== "monotio.agi.map" || raw["version"] !== 1)
    throw new Error("Unsupported map data version.");
  const sidecar: RoomMapSidecar = { journal: [], layout: {}, notes: {} };

  const journal = raw["journal"] ?? [];
  if (!Array.isArray(journal) || journal.length > MAX_JOURNAL_ENTRIES)
    throw new Error("Invalid map journal: too many entries.");
  const seen = new Set<string>();
  for (const entry of journal) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid map journal entry.");
    const e = entry as Record<string, unknown>;
    if (!Number.isInteger(e["seq"]) || (e["seq"] as number) < 0)
      throw new Error("Invalid journal sequence.");
    if (!Number.isInteger(e["session"]) || (e["session"] as number) < 0)
      throw new Error("Invalid journal session.");
    const identity = `${e["session"]}:${e["seq"]}`;
    if (seen.has(identity)) throw new Error("Duplicate journal entry.");
    seen.add(identity);
    const from = e["from"] === null ? null : roomNum(e["from"], "journal source");
    const to = roomNum(e["to"], "journal target");
    const cause = e["cause"];
    if (!CAUSES.includes(cause as RoomTransitionCause)) throw new Error("Invalid journal cause.");
    const edge = e["edge"];
    if (edge !== undefined && !SIDES.includes(edge as string))
      throw new Error("Invalid journal edge side.");
    if (!Number.isInteger(e["cycle"]) || (e["cycle"] as number) < 0)
      throw new Error("Invalid journal cycle.");
    if (typeof e["resourceSet"] !== "string" || e["resourceSet"].length > 128)
      throw new Error("Invalid journal resource revision.");
    sidecar.journal.push({
      seq: e["seq"] as number,
      session: e["session"] as number,
      from,
      to,
      cause: cause as RoomTransitionCause,
      ...(edge !== undefined ? { edge: edge as EdgeSide } : {}),
      cycle: e["cycle"] as number,
      resourceSet: e["resourceSet"],
      scoreDelta: Number.isInteger(e["scoreDelta"]) ? (e["scoreDelta"] as number) : 0,
      gained: numList(e["gained"] ?? [], "gained items"),
      lost: numList(e["lost"] ?? [], "lost items"),
    });
  }

  const layout = raw["layout"];
  if (layout !== undefined) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout))
      throw new Error("Invalid map layout.");
    const entries = Object.entries(layout);
    if (entries.length > MAX_LAYOUT_NODES) throw new Error("Map layout has too many nodes.");
    for (const [num, pos] of entries) {
      roomNum(Number(num), "layout room");
      if (!/^\d+$/.test(num)) throw new Error("Invalid layout room.");
      if (
        !pos ||
        typeof pos !== "object" ||
        !Number.isFinite((pos as { x: unknown }).x) ||
        !Number.isFinite((pos as { y: unknown }).y)
      )
        throw new Error("Invalid layout position.");
      const p = pos as { x: number; y: number };
      if (Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) throw new Error("Invalid layout position.");
      sidecar.layout[num] = { x: p.x, y: p.y };
    }
  }

  const notes = raw["notes"];
  if (notes !== undefined) {
    if (!notes || typeof notes !== "object" || Array.isArray(notes))
      throw new Error("Invalid map notes.");
    const entries = Object.entries(notes);
    if (entries.length > MAX_NOTES) throw new Error("Map has too many notes.");
    for (const [num, note] of entries) {
      if (!/^\d+$/.test(num)) throw new Error("Invalid note room.");
      roomNum(Number(num), "note room");
      if (typeof note !== "string" || note.length > MAX_NOTE_CHARS)
        throw new Error("Invalid map note.");
      sidecar.notes[num] = note;
    }
  }
  return sidecar;
}

/** Serialize the sidecar for the project record and the MAP.JSON entry. */
export function serializeMapSidecar(sidecar: RoomMapSidecar): Record<string, unknown> {
  return {
    format: "monotio.agi.map",
    version: 1,
    journal: sidecar.journal,
    layout: sidecar.layout,
    notes: sidecar.notes,
  };
}
