/**
 * The world-map model: three sources — an ordered journal of observed room
 * transitions (fact), the authoring world's planned rooms and exits (intent),
 * and constant new.room targets found by decoding each logic (candidates) —
 * merged into one labelled graph. Pure data; presentation and persistence
 * live in the app.
 *
 * Honest labels: an observed edge means the interpreter crossed it; a planned
 * edge is intent, not evidence resources implement it; a static edge is a
 * literal target in a logic that may run in another context. A logic reached
 * through call/call.v is shared — its transitions are recorded but never
 * attributed to the logic's own number. In-degree is not reachability.
 */
import { createRoomFlow, VAR_WRITES } from "./roomFlow.ts";
import { decodeLogicInsns } from "../logic/disassembler.ts";
import type { AgiProfile } from "../runtime/profile.ts";

import { EDGE_SIDES, type EdgeSide, type StaticRoomScan } from "./roomGraph.ts";
export * from "./roomGraph.ts";

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
  options: { readonly targets?: "literal" | "constant"; readonly resolve?: boolean } = {},
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
    let unresolvedPicture = false;
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
        else unresolvedPicture = true;
      } else {
        for (const at of VAR_WRITES[name] ?? []) bound.delete(args[at]!);
      }
    }
    const flow =
      options.resolve === false
        ? {
            targets,
            variableTarget,
            roomEvidence: insns.some((i) =>
              ["load.pic", "draw.pic", "overlay.pic"].includes(i.name ?? ""),
            ),
          }
        : createRoomFlow(new Map([[selfRoom ?? 0, payload]]), profile).scan(
            selfRoom ?? 0,
            selfRoom,
          );
    return {
      targets: options.targets !== "literal" && variableTarget ? flow.targets : targets,
      variableTarget: flow.variableTarget,
      roomEvidence: flow.roomEvidence,
      pictures: [...pictures].sort((a, b) => a - b),
      unresolvedPicture,
      calls: [...calls].sort((a, b) => a - b),
      unresolvedCall,
    };
  } catch {
    return {
      targets: [],
      variableTarget: false,
      pictures: [],
      unresolvedPicture: false,
      calls: [],
      unresolvedCall: false,
    };
  }
}

/**
 * Static candidates for the container: constant destinations and resolved call
 * chains run in each room’s context. LOGIC 0 dispatches the room through v0;
 * helper LOGICs stay shared unless an incoming exit establishes a room.
 */
export function scanContainerExits(
  logics: ReadonlyMap<number, Uint8Array>,
  profile?: AgiProfile,
  options: { readonly main?: boolean; readonly literal?: boolean } = {},
): { scans: Map<number, StaticRoomScan>; shared: Set<number> } {
  const scans = new Map<number, StaticRoomScan>();
  const shared = new Set<number>([0]);
  const flow = options.literal ? undefined : createRoomFlow(logics, profile);
  const rooms = new Set<number>();
  for (const [num, payload] of logics) {
    const scan = scanStaticExits(payload, profile, num, { resolve: false });
    const exits = flow?.scan(num, num === 0 ? undefined : num) ?? scan;
    scans.set(num, { ...scan, ...exits });
    for (const callee of exits.calls) if (callee !== num) shared.add(callee);
    for (const target of exits.targets) if (target.to !== 0) rooms.add(target.to);
  }
  for (const [num, scan] of scans)
    if (num !== 0 && !shared.has(num) && scan.roomEvidence) rooms.add(num);
  // A room can also be called directly. Incoming exits establish its room
  // identity independently of the call that executes its LOGIC.
  for (const room of rooms) shared.delete(room);
  const dispatch =
    options.main &&
    flow?.instructions
      .get(0)
      ?.some(
        (i) =>
          (i.name === "call.v" && i.args?.[0] === 0) ||
          (i.name === "call" && rooms.has(i.args![0]!)),
      );
  for (const [num, scan] of scans) {
    if (!dispatch || !flow) break;
    if (
      shared.has(num) ||
      (!rooms.has(num) &&
        !scan.roomEvidence &&
        !scan.targets.length &&
        !scan.variableTarget &&
        !scan.unresolvedCall)
    )
      continue;
    const contextual = flow.scan(num, num, options.main === true && dispatch);
    scans.set(num, { ...scan, ...contextual });
  }
  return { scans, shared };
}

/** One exit the world plan declares: from --name--> to. */
interface PlanConnection {
  readonly from: number;
  readonly name: string;
  readonly to: number;
}

export interface ConnectionReport {
  /** A compiled new.room transition provably reaches the declared target. */
  readonly verified: PlanConnection[];
  /** The source room's logic exists but no reachable transition does. */
  readonly missing: PlanConnection[];
  /** The source room is not compiled yet; the exit is intent, not a defect. */
  readonly pending: PlanConnection[];
  /** A computed target or unresolved call leaves the claim undecidable. */
  readonly unverifiable: (PlanConnection & { readonly reason: string })[];
  /**
   * The destination is reachable, but the declared direction word and every
   * compiled edge guard for the transition disagree — the exit leaves
   * through a different side than the plan promised.
   */
  readonly mismatched: (PlanConnection & {
    readonly declared: EdgeSide;
    readonly compiled: EdgeSide;
  })[];
}

/** Direction words a plan exit name can pin to a screen edge. Only exact
 * words canonicalize — "east door" is a name, not a direction claim. */
export const DIRECTION_NAMES: Readonly<Record<string, EdgeSide>> = {
  top: "top",
  up: "top",
  north: "top",
  bottom: "bottom",
  down: "bottom",
  south: "bottom",
  right: "right",
  east: "right",
  left: "left",
  west: "left",
};

/**
 * Check declared plan exits against compiled bytecode:
 * an exit is verified when a literal new.room to its destination is reachable
 * from the source room's logic — directly, or through the resolved call chain
 * (a shared door/portal logic legitimately carries the transition). A room
 * with no logic is pending, not missing: the plan may lead the build.
 * Variable targets and unresolved calls are reported, never guessed at.
 * When the declared name is a direction word and the compiled transition's
 * edge guard names a different side, the exit reports as mismatched.
 */
export function verifyPlanConnections(
  logics: ReadonlyMap<number, Uint8Array>,
  plan: Readonly<
    Record<string, { title: string; description: string; exits: Record<string, number> }>
  >,
  profile?: AgiProfile,
): ConnectionReport {
  const { scans } = scanContainerExits(logics, profile);

  const verified: PlanConnection[] = [];
  const missing: PlanConnection[] = [];
  const pending: PlanConnection[] = [];
  const unverifiable: (PlanConnection & { reason: string })[] = [];
  const mismatched: (PlanConnection & { declared: EdgeSide; compiled: EdgeSide })[] = [];

  for (const [num, room] of Object.entries(plan)) {
    const from = Number(num);
    const scan = scans.get(from);
    for (const [name, to] of Object.entries(room.exits)) {
      const connection = { from, name, to };
      if (!scan) {
        pending.push(connection);
        continue;
      }
      const targets = new Set(scan.targets.map((target) => target.to));
      const reachedEdges = new Set(
        scan.targets
          .filter((target) => target.to === to && target.edge !== undefined)
          .map((target) => target.edge!),
      );
      const undecidable = scan.variableTarget || scan.unresolvedCall;
      const declared = DIRECTION_NAMES[name.toLowerCase()];
      if (declared !== undefined && reachedEdges.size > 0 && !reachedEdges.has(declared)) {
        mismatched.push({ ...connection, declared, compiled: [...reachedEdges][0]! });
      } else if (targets.has(to)) verified.push(connection);
      else if (undecidable)
        unverifiable.push({
          ...connection,
          reason: "the room's logic reaches a computed target or unresolved call",
        });
      else missing.push(connection);
    }
  }
  return { verified, missing, pending, unverifiable, mismatched };
}

export { serializeMapSidecar, validateMapSidecar } from "./roomSidecar.ts";
