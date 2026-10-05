/** Pure map model for observed, planned and static candidate routes. */
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

type EdgeProvenance = "observed" | "planned" | "static";

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
  /** A LOGIC names this room as a constant new.room target. */
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
 * The experience the graph is drawn for:
 * "create" is the authoring surface — plan intent and resource/coverage
 * status are shown beside the facts. "play" is the classic-play surface —
 * only discovered places and crossings the journal actually observed;
 * planned rooms, declared-but-uncrossed exits and technical status stay
 * in creator details. The filter only hides disclosures; it never rewrites
 * the facts the graph was merged from.
 */
export type MapExperience = "play" | "create";

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

/** Static exit scan: attributed candidates plus unresolved context. */
export interface StaticRoomScan {
  /**
   * Known constant room targets. `edge` is
   * the screen edge a containing `v2 == code` guard names — the side of the
   * source room the exit leaves through — present only when the guard is an
   * unambiguous top-level `equaln(v2, N)` clause.
   */
  readonly targets: readonly { readonly to: number; readonly edge?: EdgeSide }[];
  /** Loads or draws a picture, or sets up ego under the room-entry flag. */
  readonly roomEvidence?: boolean;
  /** At least one new.room.v destination remains unknown. */
  readonly variableTarget: boolean;
  /**
   * Picture numbers this logic provably draws — draw.pic/overlay.pic only;
   * load.pic/discard.pic move memory and render nothing, so they are not
   * evidence a room displays the picture. A number is recorded only when a
   * literal binding survives to the call site (see scanStaticExits).
   */
  readonly pictures: readonly number[];
  /**
   * A draw.pic/overlay.pic whose number has no surviving literal binding: the
   * picture is chosen at runtime, so `pictures` may not name every one drawn.
   */
  readonly unresolvedPicture: boolean;
  /** Logics this logic provably calls — call literals and resolved call.v. */
  readonly calls: readonly number[];
  /** call.v without a surviving literal binding — the callee set is incomplete. */
  readonly unresolvedCall: boolean;
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
  /** "create" adds plan intent and technical status. Omitting the option is
   * the safe "play" view — a caller that does not ask never discloses. */
  readonly experience?: MapExperience;
}): RoomGraph {
  const play = input.experience !== "create";
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
    // In the play experience the plan names a discovered place but marks
    // nothing: a visited room may carry its title while every plan claim
    // (the node itself, its declared exits) stays out of the picture.
    const n = nodes.get(from);
    if (play) {
      if (n?.observed) n.title = room.title;
      continue;
    }
    node(from).planned = true;
    node(from).title = room.title;
    for (const [label, to] of Object.entries(room.exits)) {
      node(to);
      planned.push({ from, to, provenance: "planned", label });
    }
  }

  const staticEdges: RoomGraphEdge[] = [];
  for (const [num, scan] of play ? [] : (input.scans ?? new Map()).entries()) {
    if (input.shared?.has(num) === true) {
      // The logic runs under an unresolved caller: its targets exist but
      // attributing the exits to this logic's number would invent a route.
      for (const t of scan.targets) {
        node(t.to).staticTarget = true;
        node(t.to).unknownSource = true;
      }
      continue;
    }
    if (scan.roomEvidence) node(num);
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
  for (const num of play ? [] : (input.resources?.logic ?? [])) {
    const n = nodes.get(num);
    if (n) n.authored = true;
  }
  for (const num of play ? [] : (input.resources?.picture ?? [])) {
    const n = nodes.get(num);
    if (n) n.picture = true;
  }

  // Coverage marks only what its evidence proves: `playtested` rooms are
  // checkpoints a recorded run reached; `referenced` rooms are named by a
  // stored test definition. Nodes without other evidence stay absent, and no
  // edge is claimed — neither artifact records actual transitions.
  for (const room of play ? [] : (input.coverage?.playtested ?? [])) {
    const n = nodes.get(room);
    if (n) n.playtested = true;
  }
  for (const room of play ? [] : (input.coverage?.referenced ?? [])) {
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
