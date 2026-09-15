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
import { decodeLogicInsns } from "../logic/disassembler.ts";
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
  /**
   * The visit's position on the recorded tape — segment id plus the tick its
   * room mark landed at — when the always-on recording covered it. The map's
   * "travel to this visit" jumps the history transport straight here.
   */
  readonly history?: { segment: string; seq: number; tick: number };
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
  /** Visited at least once by the journal or retained discovery. */
  readonly observed: boolean;
  readonly visits: number;
  /** A stored game test names this room — a definition, not a passing run. */
  readonly referenced: boolean;
  /** A stored walkthrough's recorded run reached this room. */
  readonly playtested: boolean;
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
  /** The room's logic calls an unresolved logic; listed exits may be incomplete. */
  readonly unknownCalls: boolean;
}

export interface RoomGraph {
  readonly nodes: readonly RoomGraphNode[];
  readonly edges: readonly RoomGraphEdge[];
}

/**
 * Bounded durable discovery, kept separately from the detailed journal: when
 * the journal is capped its oldest entries are evicted, but the aggregate
 * keeps every visited room and traversable transition ever observed. Jumps
 * are position changes, not traversable edges, and stay out of `edges`.
 */
export interface RoomMapDiscovery {
  /** Visited rooms -> total visit count. */
  readonly rooms: Readonly<Record<string, number>>;
  readonly edges: readonly {
    readonly from: number;
    readonly to: number;
    readonly label?: string;
    readonly count: number;
  }[];
}

/** Literal exit scan of one logic: attributed edges plus unresolved context. */
export interface StaticRoomScan {
  /**
   * Literal new.room targets, in code order (duplicates preserved). `edge` is
   * the screen edge a containing `v2 == code` guard names — the side of the
   * source room the exit leaves through — present only when the guard is an
   * unambiguous top-level `equaln(v2, N)` clause.
   */
  readonly targets: readonly { readonly to: number; readonly edge?: EdgeSide }[];
  /** new.room.v — the target is computed at runtime; value unknown. */
  readonly variableTarget: boolean;
  /**
   * Picture numbers this logic provably draws — draw.pic/overlay.pic only;
   * load.pic/discard.pic move memory and render nothing, so they are not
   * evidence a room displays the picture. A number is recorded only when a
   * literal binding survives to the call site (see scanStaticExits).
   */
  readonly pictures: readonly number[];
  /** Logics this logic provably calls — call literals and resolved call.v. */
  readonly calls: readonly number[];
  /** call.v without a surviving literal binding — the callee set is incomplete. */
  readonly unresolvedCall: boolean;
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
  rindirect: [0], // vars[a0] = vars[vars[a1]] — writes operand 0
  random: [2],
  "get.posn": [1, 2],
  "last.cel": [1],
  "current.cel": [1],
  "current.loop": [1],
  "current.view": [1],
  "number.of.loops": [1],
  "get.priority": [1],
  "get.dir": [1],
  "get.room.v": [1], // vars[a1] = itemLocations[vars[a0]] — writes operand 1
  "get.num": [1],
  distance: [2],
};

const PICTURE_DRAWS: ReadonlySet<string> = new Set(["draw.pic", "overlay.pic"]);

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
/**
 * The screen edge an if-condition pins on v2, if it pins one unambiguously:
 * every top-level `equaln(v2, N)` clause must hold for the then-block, so a
 * single literal N names the departure edge. OR-groups render as one
 * parenthesized clause and cannot match; conflicting clauses void the claim.
 */
function guardEdge(conditionText: string): EdgeSide | undefined {
  let edge: EdgeSide | undefined;
  for (const clause of conditionText.split(" && ")) {
    const m = /^equaln\(v2, (\d+)\)$/.exec(clause);
    if (m === null) continue;
    const side = EDGE_SIDES[Number(m[1]) as keyof typeof EDGE_SIDES];
    if (side === undefined || (edge !== undefined && edge !== side)) return undefined;
    edge = side;
  }
  return edge;
}

export function scanStaticExits(
  payload: Uint8Array,
  profile?: AgiProfile,
  selfRoom?: number,
): StaticRoomScan {
  try {
    const insns = decodeLogicInsns(payload, profile !== undefined ? { profile } : {});

    // Conditional regions: an if's then-block runs end..target, and every
    // goto spans min(end,target)..max(end,target) — a forward goto's region is
    // the else-block it skips, a backward goto's region is its loop body.
    // A binding made inside a region holds only until the region ends: on the
    // path that skipped or exited it, the var kept its previous value. A var
    // written anywhere inside a region is ambiguous after it ends too — the
    // earlier binding may or may not have been overwritten — so bindings to
    // that var expire at the region's end as well.
    const regions: { start: number; end: number; writes: Set<number>; edge?: EdgeSide }[] = [];
    for (const insn of insns) {
      let start = -1,
        end = -1;
      let edge: EdgeSide | undefined;
      if (insn.kind === "if") {
        start = insn.end;
        end = insn.target;
        edge = guardEdge(insn.text ?? "");
      } else if (insn.kind === "goto" && insn.target !== insn.end) {
        start = Math.min(insn.end, insn.target);
        end = Math.max(insn.end, insn.target);
      }
      if (start < 0) continue;
      const writes = new Set<number>();
      for (const inner of insns) {
        if (inner.at < start || inner.at >= end || inner.name === undefined) continue;
        if (
          inner.name === "call" ||
          inner.name === "call.v" ||
          inner.name === "lindirectn" ||
          inner.name === "lindirectv"
        ) {
          // A call or computed-address write inside the region can hit any
          // var — mark all ambiguous.
          for (let v = 0; v < 256; v++) writes.add(v);
        } else if (inner.name === "assignn" || inner.name === "assignv")
          writes.add(inner.args?.[0] ?? -1);
        else for (const at of VAR_WRITES[inner.name] ?? []) writes.add(inner.args?.[at] ?? -1);
      }
      regions.push(edge === undefined ? { start, end, writes } : { start, end, writes, edge });
    }
    const scopeEnd = (at: number): number => {
      let end = Number.POSITIVE_INFINITY;
      for (const r of regions) if (at >= r.start && at < r.end && r.end < end) end = r.end;
      return end;
    };

    const targets: { to: number; edge?: EdgeSide }[] = [];
    const pictures = new Set<number>();
    const calls = new Set<number>();
    const bound = new Map<number, { value: number; scopeEnd: number }>();
    let variableTarget = false;
    let unresolvedCall = false;

    if (selfRoom !== undefined)
      bound.set(0, { value: selfRoom, scopeEnd: Number.POSITIVE_INFINITY });

    for (const insn of insns) {
      if (insn.kind !== "action" || insn.name === undefined) continue;
      for (const [v, b] of bound) if (b.scopeEnd <= insn.at) bound.delete(v);
      for (const r of regions) if (r.end <= insn.at) for (const v of r.writes) bound.delete(v);
      const name = insn.name;
      const args = insn.args ?? [];
      if (name === "new.room") {
        // The innermost if-region with a v2 guard names the edge this exit
        // leaves through — both nested guards hold, so the tighter one wins.
        let edge: EdgeSide | undefined;
        let span = Number.POSITIVE_INFINITY;
        for (const r of regions) {
          if (insn.at < r.start || insn.at >= r.end || r.edge === undefined) continue;
          if (r.end - r.start < span) {
            span = r.end - r.start;
            edge = r.edge;
          }
        }
        targets.push(edge === undefined ? { to: args[0]! } : { to: args[0]!, edge });
      } else if (name === "new.room.v") variableTarget = true;
      else if (name === "assignn")
        bound.set(args[0]!, { value: args[1]!, scopeEnd: scopeEnd(insn.at) });
      else if (name === "assignv") {
        const value = bound.get(args[1]!);
        if (value === undefined) bound.delete(args[0]!);
        else bound.set(args[0]!, { value: value.value, scopeEnd: scopeEnd(insn.at) });
      } else if (name === "call" || name === "call.v") {
        const target = name === "call" ? args[0]! : bound.get(args[0]!)?.value;
        if (target === undefined) unresolvedCall = true;
        else calls.add(target);
        // The callee can write any var — every binding is unknown afterwards.
        bound.clear();
      } else if (name === "lindirectn" || name === "lindirectv") {
        // vars[vars[x]] = … writes through a computed address: any var may go.
        bound.clear();
      } else if (PICTURE_DRAWS.has(name)) {
        const pic = bound.get(args[0]!);
        if (pic !== undefined) pictures.add(pic.value);
      } else {
        for (const at of VAR_WRITES[name] ?? []) bound.delete(args[at]!);
      }
    }
    return {
      targets,
      variableTarget,
      pictures: [...pictures].sort((a, b) => a - b),
      calls: [...calls].sort((a, b) => a - b),
      unresolvedCall,
    };
  } catch {
    return { targets: [], variableTarget: false, pictures: [], calls: [], unresolvedCall: false };
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
  // Logic 0 runs in every room's context and every called logic runs in its
  // caller's: neither's transitions belong to its own number.
  const shared = new Set<number>([0]);
  for (const [num, payload] of logics) {
    // selfRoom seeds the v0 convention; consumers must still check `shared`
    // before attributing a picture use — a shared logic's v0 is its caller's.
    scans.set(num, scanStaticExits(payload, profile, num));
  }
  for (const scan of scans.values()) for (const callee of scan.calls) shared.add(callee);
  return { scans, shared };
}

/** Merge the three sources without collapsing distinct exits between a pair. */
export function mergeRoomGraph(input: {
  readonly journal: readonly RoomObservation[];
  /** Durable discovery aggregate; survives journal eviction. */
  readonly discovered?: RoomMapDiscovery;
  /**
   * Coverage evidence, limited to what the stored data proves: `playtested`
   * rooms are checkpoints a recorded walkthrough run actually reached;
   * `referenced` rooms are merely named by a stored test definition — no run
   * result is stored, so definitions assert intent, never a pass. Neither
   * source records per-room transitions, so no edge coverage is claimed.
   */
  readonly coverage?: {
    readonly playtested?: ReadonlySet<number>;
    readonly referenced?: ReadonlySet<number>;
  };
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
      referenced: boolean;
      playtested: boolean;
      planned: boolean;
      authored: boolean;
      picture: boolean;
      staticTarget: boolean;
      variableExit: boolean;
      unknownSource: boolean;
      unknownCalls: boolean;
    }
  >();
  const node = (room: number) => {
    let n = nodes.get(room);
    if (!n) {
      n = {
        observed: false,
        visits: 0,
        referenced: false,
        playtested: false,
        planned: false,
        authored: false,
        picture: false,
        staticTarget: false,
        variableExit: false,
        unknownSource: false,
        unknownCalls: false,
      };
      nodes.set(room, n);
    }
    return n;
  };

  // Walkable observations become edges keyed by (from, to, edge side); a
  // restore, restart, re-entry or jump is journal fact but never a walkable
  // exit. The discovery aggregate already counts every traversal the journal
  // records, so the two are merged with max — never summed.
  const observed = new Map<string, { from: number; to: number; label?: string; count: number }>();
  const putObserved = (from: number, to: number, label: string | undefined, count: number) => {
    const key = `${from}->${to}:${label ?? ""}`;
    const existing = observed.get(key);
    if (existing) existing.count = Math.max(existing.count, count);
    else observed.set(key, { from, to, ...(label !== undefined ? { label } : {}), count });
  };
  for (const e of input.discovered?.edges ?? []) putObserved(e.from, e.to, e.label, e.count);
  const discoveredRooms = input.discovered?.rooms ?? {};
  const journalVisits = new Map<number, number>();
  const journalEdgeCounts = new Map<string, number>();
  for (const entry of input.journal) {
    journalVisits.set(entry.to, (journalVisits.get(entry.to) ?? 0) + 1);
    node(entry.to).observed = true;
    if (entry.from !== null) node(entry.from).observed = true;
    if (entry.from === null || !["edge", "logic"].includes(entry.cause)) continue;
    const label = entry.cause === "edge" && entry.edge ? entry.edge : undefined;
    const key = `${entry.from}->${entry.to}:${label ?? ""}`;
    const count = (journalEdgeCounts.get(key) ?? 0) + 1;
    journalEdgeCounts.set(key, count);
    putObserved(entry.from, entry.to, label, count);
  }
  for (const [room, visits] of Object.entries(discoveredRooms)) {
    const n = node(Number(room));
    n.observed = true;
    n.visits = Math.max(n.visits, visits);
  }
  for (const [room, visits] of journalVisits) {
    const n = node(room);
    n.observed = true;
    n.visits = Math.max(n.visits, visits);
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
    if (input.shared?.has(num) === true) {
      // The logic runs under an unresolved caller: its targets exist but
      // attributing the exits to this logic's number would invent a route.
      for (const t of scan.targets) {
        node(t.to).staticTarget = true;
        node(t.to).unknownSource = true;
      }
      continue;
    }
    if (scan.variableTarget) node(num).variableExit = true;
    if (scan.unresolvedCall) node(num).unknownCalls = true;
    for (const t of scan.targets) {
      node(t.to).staticTarget = true;
      node(num);
      // The v2 guard on the new.room names the source room's departure edge —
      // an exit "left" means the target lies left of this room.
      staticEdges.push(
        t.edge === undefined
          ? { from: num, to: t.to, provenance: "static" }
          : { from: num, to: t.to, provenance: "static", label: t.edge },
      );
    }
  }

  // A resource is not room evidence: the flags annotate rooms the journal,
  // plan or static scan already established, and never invent nodes.
  for (const num of input.resources?.logic ?? []) {
    const n = nodes.get(num);
    if (n) n.authored = true;
  }
  for (const num of input.resources?.picture ?? []) {
    const n = nodes.get(num);
    if (n) n.picture = true;
  }

  // Coverage marks only what its evidence proves: `playtested` rooms are
  // checkpoints a recorded run reached; `referenced` rooms are named by a
  // stored test definition. Nodes without other evidence stay absent, and no
  // edge is claimed — neither artifact records actual transitions.
  for (const room of input.coverage?.playtested ?? []) {
    const n = nodes.get(room);
    if (n) n.playtested = true;
  }
  for (const room of input.coverage?.referenced ?? []) {
    const n = nodes.get(room);
    if (n) n.referenced = true;
  }

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
  /**
   * Bounded discovery aggregate: visited rooms and traversable edges ever
   * observed. Outlives journal eviction — the journal holds recent detail,
   * this holds the durable facts.
   */
  discovered: { rooms: Record<string, number>; edges: RoomMapDiscovery["edges"][number][] };
  /** Manually positioned nodes, keyed by room number. */
  layout: Record<string, { x: number; y: number }>;
  /** Per-room UI notes; separate from the canonical authoring plan. */
  notes: Record<string, string>;
  /**
   * Per-edge UI notes keyed `from->to:label` (label "" when the edge has
   * none) — the same identity mergeRoomGraph uses. Player intent provenance
   * for later authoring; never a plan field and never a resource claim.
   */
  edgeNotes: Record<string, string>;
}

const MAX_JOURNAL_ENTRIES = 4096;
const MAX_DISCOVERED_ROOMS = 256;
// The full discovery domain: 256×256 directed pairs × 5 label variants.
const MAX_DISCOVERED_EDGES = 256 * 256 * 5;
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
  const sidecar: RoomMapSidecar = {
    journal: [],
    discovered: { rooms: {}, edges: [] },
    layout: {},
    notes: {},
    edgeNotes: {},
  };

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
    const hist = e["history"];
    if (hist !== undefined) {
      if (!hist || typeof hist !== "object" || Array.isArray(hist))
        throw new Error("Invalid journal history position.");
      const hp = hist as Record<string, unknown>;
      if (typeof hp["segment"] !== "string" || hp["segment"].length > 64)
        throw new Error("Invalid journal history segment.");
      if (!Number.isInteger(hp["seq"]) || (hp["seq"] as number) < 0)
        throw new Error("Invalid journal history sequence.");
      if (!Number.isInteger(hp["tick"]) || (hp["tick"] as number) < 0)
        throw new Error("Invalid journal history tick.");
    }
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
      ...(hist !== undefined
        ? {
            history: {
              segment: (hist as Record<string, unknown>)["segment"] as string,
              seq: (hist as Record<string, unknown>)["seq"] as number,
              tick: (hist as Record<string, unknown>)["tick"] as number,
            },
          }
        : {}),
    });
  }

  const discovered = raw["discovered"];
  if (discovered !== undefined) {
    if (!discovered || typeof discovered !== "object" || Array.isArray(discovered))
      throw new Error("Invalid map discovery data.");
    const d = discovered as Record<string, unknown>;
    const rooms = d["rooms"] ?? {};
    if (!rooms || typeof rooms !== "object" || Array.isArray(rooms))
      throw new Error("Invalid map discovery rooms.");
    const roomEntries = Object.entries(rooms);
    if (roomEntries.length > MAX_DISCOVERED_ROOMS)
      throw new Error("Map discovery has too many rooms.");
    for (const [num, count] of roomEntries) {
      if (!/^\d+$/.test(num)) throw new Error("Invalid discovery room.");
      roomNum(Number(num), "discovery room");
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 1_000_000)
        throw new Error("Invalid discovery visit count.");
      sidecar.discovered.rooms[num] = count as number;
    }
    const edges = d["edges"] ?? [];
    if (!Array.isArray(edges) || edges.length > MAX_DISCOVERED_EDGES)
      throw new Error("Map discovery has too many edges.");
    const seenEdges = new Set<string>();
    for (const edge of edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge))
        throw new Error("Invalid discovery edge.");
      const e = edge as Record<string, unknown>;
      const from = roomNum(e["from"], "discovery edge source");
      const to = roomNum(e["to"], "discovery edge target");
      const label = e["label"];
      if (label !== undefined && (typeof label !== "string" || label.length > 64))
        throw new Error("Invalid discovery edge label.");
      if (!Number.isInteger(e["count"]) || (e["count"] as number) < 1)
        throw new Error("Invalid discovery edge count.");
      const identity = `${from}->${to}:${label ?? ""}`;
      if (seenEdges.has(identity)) throw new Error("Duplicate discovery edge.");
      seenEdges.add(identity);
      sidecar.discovered.edges.push({
        from,
        to,
        ...(label !== undefined ? { label: label as string } : {}),
        count: e["count"] as number,
      });
    }
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

  const edgeNotes = raw["edgeNotes"];
  if (edgeNotes !== undefined) {
    if (!edgeNotes || typeof edgeNotes !== "object" || Array.isArray(edgeNotes))
      throw new Error("Invalid map edge notes.");
    const entries = Object.entries(edgeNotes);
    if (entries.length > MAX_NOTES) throw new Error("Map has too many notes.");
    for (const [key, note] of entries) {
      const m = /^(\d+)->(\d+):(.{0,64})$/.exec(key);
      if (!m) throw new Error("Invalid edge note key.");
      roomNum(Number(m[1]), "edge note source");
      roomNum(Number(m[2]), "edge note target");
      if (typeof note !== "string" || note.length > MAX_NOTE_CHARS)
        throw new Error("Invalid map note.");
      sidecar.edgeNotes[key] = note;
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
    discovered: sidecar.discovered,
    layout: sidecar.layout,
    notes: sidecar.notes,
    edgeNotes: sidecar.edgeNotes,
  };
}
