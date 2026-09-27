/**
 * Exits as two-sided contracts. For one room, every exit its logic compiles
 * (a literal new.room found by the room map's static scan, with the screen
 * edge its `equaln(v2, N)` guard names, or no edge for a door, command or
 * scripted transition) and every exit the world plan declares, each with:
 *
 *   - status: "planned" (world plan only), "compiled" (the room's logic, or a
 *     logic it calls by number, reaches the destination) or "tested" (compiled,
 *     and a stored game test or a recorded route covers it);
 *   - the way back: the edges through which the destination's logic returns
 *     to this room, and whether one of them is the opposite edge;
 *   - the arrival: where ego stands on entering the destination from here —
 *     the position(o0, x, y) its init block selects for this origin (an
 *     `equaln(v1, N)` guard or its else branch picks by previous room), or
 *     else the interpreter's own edge placement (spec room switch: leaving by
 *     the right puts ego at x 0, by the left at the right edge, by the top at
 *     y 167, by the bottom at y 37), or ego keeps its position after a
 *     command transition.
 *
 * Evidence is labelled honestly: a stored test covers A→B when it starts in A
 * and expects to end in B (a definition, not a passing run; it does not say
 * which of several A→B exits it takes); a route observation covers an exit
 * only when the interpreter reported that crossing, through that edge.
 */
import type { AuthoringState } from "../../agent/authoringState.ts";
import type { GameTest } from "../../agent/gameTests.ts";
import {
  DIRECTION_NAMES,
  scanContainerExits,
  type EdgeSide,
  type RoomObservation,
  type StaticRoomScan,
} from "../../agent/roomMap.ts";
import { decodeLogicInsns, type DecodedInsn } from "../../logic/disassembler.ts";
import type { AgiProfile } from "../../runtime/profile.ts";
import type { LogicRuleFragment } from "./logicDocument.ts";
import type { RuleModel } from "./ruleModel.ts";

type ExitArrival =
  /** The destination's init block positions ego; `conditional` when another guard may skip it. */
  | {
      readonly source: "logic";
      readonly x: number;
      readonly y: number;
      readonly conditional: boolean;
    }
  /** position.v: the destination computes the spot at runtime. */
  | { readonly source: "computed" }
  /** No position(o0): the interpreter puts ego on this side of the destination. */
  | { readonly source: "edge"; readonly side: EdgeSide }
  /** No position(o0) and no edge: ego keeps its coordinates. */
  | { readonly source: "kept" }
  /** The destination has no logic yet. */
  | { readonly source: "missing" };

export interface ExitContract {
  /** The edge ego leaves through; null for a door, command or scripted transition. */
  readonly edge: EdgeSide | null;
  readonly destination: number;
  readonly status: "planned" | "compiled" | "tested";
  /** The world plan declares this exit. */
  readonly planned: boolean;
  /** The room's logic reaches the destination. */
  readonly compiled: boolean;
  /** What covers it: `test "<name>"` or `route`. */
  readonly testedBy: readonly string[];
  /** The annotated rule that writes this exit, when there is one. */
  readonly rule: string | null;
  /** Edges (null: command or scripted) through which the destination returns here. */
  readonly wayBack: readonly (EdgeSide | null)[];
  readonly twoSided: boolean;
  /** An edge exit whose way back uses the opposite edge. */
  readonly reciprocal: boolean;
  readonly arrival: ExitArrival;
}

const OPPOSITE_EDGE: Readonly<Record<EdgeSide, EdgeSide>> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/** Literal targets of a logic and every logic it calls by number. */
function reachableTargets(
  room: number,
  scans: ReadonlyMap<number, StaticRoomScan>,
): { to: number; edge: EdgeSide | null }[] {
  const out: { to: number; edge: EdgeSide | null }[] = [];
  const seen = new Set<number>();
  const queue = [room];
  while (queue.length > 0) {
    const num = queue.shift()!;
    if (seen.has(num)) continue;
    seen.add(num);
    const scan = scans.get(num);
    if (!scan) continue;
    for (const target of scan.targets) {
      const edge = target.edge ?? null;
      if (!out.some((t) => t.to === target.to && t.edge === edge))
        out.push({ to: target.to, edge });
    }
    queue.push(...scan.calls);
  }
  return out;
}

/** Where ego stands after entering `payload`'s room from room `from`. */
function arrival(
  payload: Uint8Array | undefined,
  from: number,
  edge: EdgeSide | null,
  profile: AgiProfile | undefined,
): ExitArrival {
  if (!payload) return { source: "missing" };
  let insns: readonly DecodedInsn[];
  try {
    insns = decodeLogicInsns(payload, profile ? { profile } : {});
  } catch {
    insns = [];
  }
  // Then-regions of every if, plus the else-region a trailing forward goto skips.
  const regions: { start: number; end: number; clauses: string[]; otherwise: boolean }[] = [];
  for (const insn of insns) {
    if (insn.kind !== "if") continue;
    const clauses = (insn.text ?? "").split(" && ");
    regions.push({ start: insn.end, end: insn.target, clauses, otherwise: false });
    const last = insns.find((x) => x.end === insn.target && x.at >= insn.end);
    if (last?.kind === "goto" && last.target > insn.target)
      regions.push({ start: insn.target, end: last.target, clauses, otherwise: true });
  }
  let chosen: ExitArrival | null = null;
  for (const insn of insns) {
    if (insn.kind !== "action" || (insn.name !== "position" && insn.name !== "position.v"))
      continue;
    if (insn.args?.[0] !== 0) continue;
    let init = false;
    let applies = true;
    let conditional = false;
    for (const region of regions) {
      if (insn.at < region.start || insn.at >= region.end) continue;
      const room = (clause: string) => /^equaln\(v1, (\d+)\)$/.exec(clause)?.[1];
      if (!region.otherwise) {
        for (const clause of region.clauses) {
          if (clause === "isset(f5)") init = true;
          else if (room(clause) !== undefined) applies &&= Number(room(clause)) === from;
          else conditional = true;
        }
      } else if (region.clauses.length === 1 && room(region.clauses[0]!) !== undefined) {
        applies &&= Number(room(region.clauses[0]!)) !== from;
      } else conditional = true;
    }
    if (!init || !applies) continue;
    chosen =
      insn.name === "position.v"
        ? { source: "computed" }
        : { source: "logic", x: insn.args[1]!, y: insn.args[2]!, conditional };
  }
  if (chosen) return chosen;
  return edge === null ? { source: "kept" } : { source: "edge", side: OPPOSITE_EDGE[edge] };
}

/** The exit contracts of one room, compiled exits first in code order, then plan-only exits. */
export function roomExitContracts(input: {
  readonly room: number;
  /** Every logic resource of the game, by number. */
  readonly logics: ReadonlyMap<number, Uint8Array>;
  readonly profile?: AgiProfile;
  readonly plan?: AuthoringState["world"]["rooms"];
  readonly tests?: readonly GameTest[];
  /** Transitions a recorded route run reported. */
  readonly observed?: readonly RoomObservation[];
  /** The room's annotated rules (readRules), to name the rule behind an exit. */
  readonly rules?: readonly {
    readonly rule: LogicRuleFragment;
    readonly model: RuleModel | "native";
  }[];
}): ExitContract[] {
  const { room, logics, profile } = input;
  const { scans } = scanContainerExits(logics, profile);
  const compiled = logics.has(room) ? reachableTargets(room, scans) : [];
  const planEntries = Object.entries(input.plan?.[String(room)]?.exits ?? {}).map(([name, to]) => ({
    to,
    edge: DIRECTION_NAMES[name.toLowerCase()] ?? null,
    used: false,
  }));
  const exits: { to: number; edge: EdgeSide | null; planned: boolean; compiled: boolean }[] = [];
  for (const target of compiled) {
    let planned = false;
    for (const entry of planEntries) {
      if (
        entry.to === target.to &&
        (entry.edge === null || target.edge === null || entry.edge === target.edge)
      ) {
        entry.used = true;
        planned = true;
      }
    }
    exits.push({ ...target, planned, compiled: true });
  }
  for (const entry of planEntries)
    if (!entry.used) exits.push({ to: entry.to, edge: entry.edge, planned: true, compiled: false });

  return exits.map(({ to, edge, planned, compiled: isCompiled }) => {
    const testedBy: string[] = [];
    if (isCompiled) {
      for (const test of input.tests ?? [])
        if (test.room === room && test.expect?.["room"] === to)
          testedBy.push(`test ${JSON.stringify(test.name)}`);
      const crossed = (input.observed ?? []).some(
        (o) =>
          o.from === room &&
          o.to === to &&
          (edge === null ? o.cause === "logic" : o.cause === "edge" && o.edge === edge),
      );
      if (crossed) testedBy.push("route");
    }
    const wayBack = logics.has(to)
      ? reachableTargets(to, scans)
          .filter((t) => t.to === room)
          .map((t) => t.edge)
      : [];
    // An edge exit rule names its edge; a door exit rule is an edgeless transition.
    const rule =
      input.rules?.find(
        ({ model }) =>
          model !== "native" &&
          model.kind === "exit" &&
          model.edge === edge &&
          model.destination === to,
      )?.rule.id ?? null;
    return {
      edge,
      destination: to,
      status: !isCompiled ? "planned" : testedBy.length > 0 ? "tested" : "compiled",
      planned,
      compiled: isCompiled,
      testedBy,
      rule,
      wayBack,
      twoSided: wayBack.length > 0,
      reciprocal: edge !== null && wayBack.includes(OPPOSITE_EDGE[edge]),
      arrival: arrival(logics.get(to), room, edge, profile),
    };
  });
}
