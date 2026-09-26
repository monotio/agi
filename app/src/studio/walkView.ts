/**
 * Room Studio's Walk view as pure data: the room's doors (door boxes and
 * edge exits, from the annotated rules and the compiled exits), their
 * labels and two-sided status in plain words, where an edge click or a
 * door puts a test walk's start, what stopped a walk, and the words for
 * each engine outcome. No Vue and no DOM; useStudioWalk.ts drives these.
 *
 * A door comes from one of two places. An annotated rule the kernel reads
 * (src/studio/rules/ruleModel.ts) is editable: where it leads, its flag,
 * its box and the art it follows. Every other exit the room's logic
 * compiles (ruleUsage.ts roomExitContracts) is native: a read-only arrow
 * on its edge, or a listed transition without geometry, changed as text.
 */

import type { EdgeSide } from "../../../src/agent/roomMap.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { RouteOutcome, RouteTestResult } from "../../../src/studio/route.ts";
import type { LogicRuleFragment } from "../../../src/studio/rules/logicDocument.ts";
import type { FlagRef, RuleBox, RuleModel } from "../../../src/studio/rules/ruleModel.ts";
import type { ExitContract } from "../../../src/studio/rules/ruleUsage.ts";
import { standVerdict, type WalkableInput } from "../../../src/studio/walkable.ts";
import type { Point } from "../../../src/studio/shapes.ts";

export type { EdgeSide };

/** One exit as the Walk view shows it. */
export interface WalkDoor {
  /** The rule id for an annotated rule; `native-<n>` for a compiled exit without one. */
  readonly id: string;
  /** "box": a door box on the floor; "edge": an exit through a screen edge; "other": a command or script. */
  readonly shape: "box" | "edge" | "other";
  readonly edge: EdgeSide | null;
  /** The box as stored in the logic, for a door box. */
  readonly box: RuleBox | null;
  readonly destination: number;
  readonly requiresFlag: FlagRef | null;
  /** The rule's label; a native exit's plain description. */
  readonly label: string;
  /** The picture item the box follows. */
  readonly item: string | null;
  /** The kernel can edit it: an annotated rule in one of its canonical shapes. */
  readonly editable: boolean;
  /** Only the world plan declares it: nothing compiled leads there yet. */
  readonly planned: boolean;
  /** 1-based line of the rule (or null) for "Edit as text…". */
  readonly line: number | null;
  /** Its two-sided contract, when the room's logic or plan has one. */
  readonly contract: ExitContract | null;
}

export const EDGE_NAMES: Readonly<Record<EdgeSide, string>> = {
  top: "north",
  right: "east",
  bottom: "south",
  left: "west",
};

/**
 * The room's doors: annotated exit rules first (editable when the kernel
 * reads them), then every compiled or planned exit no rule accounts for.
 */
export function walkDoors(
  rules: readonly { readonly rule: LogicRuleFragment; readonly model: RuleModel | "native" }[],
  contracts: readonly ExitContract[],
): WalkDoor[] {
  const doors: WalkDoor[] = [];
  for (const { rule, model } of rules) {
    if (rule.kind !== "exit") continue;
    const contract = contracts.find((c) => c.rule === rule.id) ?? null;
    if (model === "native" || model.kind !== "exit") {
      doors.push({
        id: rule.id,
        shape: "other",
        edge: contract?.edge ?? null,
        box: null,
        destination: contract?.destination ?? 0,
        requiresFlag: null,
        label: rule.label,
        item: rule.item,
        editable: false,
        planned: false,
        line: rule.openLine,
        contract,
      });
      continue;
    }
    doors.push({
      id: rule.id,
      shape: model.edge === null ? "box" : "edge",
      edge: model.edge,
      box: model.edge === null ? model.box : null,
      destination: model.destination,
      requiresFlag: model.requiresFlag,
      label: rule.label,
      item: rule.item,
      editable: true,
      planned: false,
      line: rule.openLine,
      contract,
    });
  }
  let n = 0;
  for (const contract of contracts) {
    if (contract.rule !== null) continue;
    // A native rule's exit is listed with its rule above.
    if (doors.some((door) => !door.editable && door.contract === contract)) continue;
    n++;
    const where = contract.edge ? `the ${EDGE_NAMES[contract.edge]} edge` : "a command or script";
    doors.push({
      id: `native-${n}`,
      shape: contract.edge ? "edge" : "other",
      edge: contract.edge,
      box: null,
      destination: contract.destination,
      requiresFlag: null,
      label: contract.compiled ? `Leaves by ${where}` : `Planned exit by ${where}`,
      item: null,
      editable: false,
      planned: !contract.compiled,
      line: null,
      contract,
    });
  }
  return doors;
}

/** "→ Sprite Lab", or "→ Room 3" for an untitled room. */
export function destinationLabel(
  destination: number,
  rooms: readonly { readonly room: number; readonly title: string }[],
): string {
  const title = rooms.find((room) => room.room === destination)?.title;
  return `→ ${title ? title : `Room ${destination}`}`;
}

/** The two-sided status in plain words: the way back, and whether a test covers it. */
export function doorStatus(
  door: Pick<WalkDoor, "contract" | "destination">,
  walked: ReadonlySet<number>,
): { wayBack: string; tested: string; testedOk: boolean } {
  const contract = door.contract;
  const testedOk = contract?.status === "tested" || walked.has(door.destination);
  const tested = testedOk
    ? `Tested ✓ ${walked.has(door.destination) ? "(test walk)" : `(${contract!.testedBy.join(", ")})`}`
    : "Not tested yet";
  if (!contract || !contract.compiled)
    return { wayBack: "Not in the room's logic until you Keep", tested, testedOk };
  if (contract.wayBack.length === 0) return { wayBack: "One-way", tested, testedOk };
  const via = contract.wayBack
    .map((edge) => (edge === null ? "a door or command" : `the ${EDGE_NAMES[edge]} edge`))
    .filter((text, i, all) => all.indexOf(text) === i)
    .join(" or ");
  return { wayBack: `Way back: yes, via ${via}`, tested, testedOk };
}

/**
 * Where an edge arrow sits: the middle of its edge, in picture cells, and
 * the direction it points (out of the room).
 */
export function edgeAnchor(edge: EdgeSide, horizon: number): Point {
  switch (edge) {
    case "top":
      return { x: SCREEN_WIDTH / 2, y: Math.max(0, horizon) };
    case "bottom":
      return { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT - 1 };
    case "left":
      return { x: 0, y: Math.round((Math.max(0, horizon) + SCREEN_HEIGHT) / 2) };
    case "right":
      return { x: SCREEN_WIDTH - 1, y: Math.round((Math.max(0, horizon) + SCREEN_HEIGHT) / 2) };
  }
}

/**
 * The edge a click at `cell` names: the nearest one on screen (AGI pixels
 * are twice as wide as tall, so a column counts double), measuring the top
 * from the horizon.
 */
export function edgeAt(cell: Point, horizon: number): EdgeSide {
  const distances: [EdgeSide, number][] = [
    ["left", cell.x * 2],
    ["right", (SCREEN_WIDTH - 1 - cell.x) * 2],
    ["top", Math.max(0, cell.y - Math.max(0, horizon))],
    ["bottom", SCREEN_HEIGHT - 1 - cell.y],
  ];
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
}

/** The standable cell nearest `at` (screen distance), within `radius` rows; null when none. */
export function nearestStandable(mask: Uint8Array, at: Point, radius = 48): Point | null {
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = at.y + dy;
    if (y < 0 || y >= SCREEN_HEIGHT) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = at.x + dx;
      if (x < 0 || x >= SCREEN_WIDTH || mask[y * SCREEN_WIDTH + x] !== 1) continue;
      const distance = (dx * 2) ** 2 + dy ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * Where the player enters this room through `door`: the arrival spot the
 * destination's way back names (its init block's position(o0) for this
 * origin), or the interpreter's edge placement on the door's own side. The
 * spot is moved to the nearest cell the walkable estimate accepts, so a
 * test walk starts somewhere ego can stand.
 */
export function entrySpot(
  door: Pick<WalkDoor, "edge" | "box">,
  back: ExitContract | null,
  mask: Uint8Array,
  horizon: number,
): Point | null {
  const arrival = back?.arrival;
  if (arrival?.source === "logic") return nearestStandable(mask, arrival);
  // The interpreter places ego on the side it came in by (spec room switch).
  const side: EdgeSide | null = arrival?.source === "edge" ? arrival.side : (door.edge ?? null);
  if (side) {
    const anchor = edgeAnchor(side, horizon);
    const inset = {
      top: { x: 0, y: 2 },
      bottom: { x: 0, y: -2 },
      left: { x: 1, y: 0 },
      right: { x: -8, y: 0 },
    }[side];
    return nearestStandable(mask, { x: anchor.x + inset.x, y: anchor.y + inset.y });
  }
  if (door.box) {
    const { x1, x2, y2 } = door.box;
    // In front of the box: just below it, where a player steps out.
    return nearestStandable(mask, { x: Math.round((x1 + x2) / 2), y: Math.min(167, y2 + 3) });
  }
  return null;
}

/**
 * The control cell that stopped a walk: from the engine's end spot, the next
 * step toward the goal (diagonal, then each axis alone), whose footprint the
 * engine refuses; the first barrier (or conditional barrier, or water gate)
 * cell of that footprint. Null when no step toward the goal is refused.
 */
export function refusedCell(input: WalkableInput, end: Point, goal: Point): Point | null {
  const sx = Math.sign(goal.x - end.x);
  const sy = Math.sign(goal.y - end.y);
  const steps: Point[] = [
    { x: end.x + sx, y: end.y + sy },
    { x: end.x + sx, y: end.y },
    { x: end.x, y: end.y + sy },
  ].filter(
    (step, i, all) =>
      (step.x !== end.x || step.y !== end.y) &&
      all.findIndex((other) => other.x === step.x && other.y === step.y) === i,
  );
  for (const step of steps) {
    const verdict = standVerdict(input, step.x, step.y);
    if (verdict === "ok" || verdict === "bounds" || verdict === "horizon") continue;
    if (verdict === "barrier" || verdict === "conditional")
      for (let dx = 0; dx < input.egoWidth; dx++) {
        const x = step.x + dx;
        const value = input.priority[step.y * SCREEN_WIDTH + x];
        if (value === 0 || (verdict === "conditional" && value === 1)) return { x, y: step.y };
      }
    return step;
  }
  return null;
}

/** What a test walk did, in the result card's words. */
export function outcomeTitle(
  result: Pick<RouteTestResult, "outcome" | "room">,
  blockedBy: string | null,
  rooms: readonly { readonly room: number; readonly title: string }[],
): string {
  const words: Record<RouteOutcome, () => string> = {
    reached: () => "Reached",
    blocked: () => `Blocked at ${blockedBy ?? "a barrier"}`,
    room_changed: () => {
      const title = rooms.find((room) => room.room === result.room)?.title;
      return `Went to room ${result.room}${title ? ` (${title})` : ""}`;
    },
    modal: () => "A message stopped the walk",
    no_control: () => "The game took over the player's movement",
    budget: () => "The walk ran out of time",
    start_blocked: () => "The start is not a spot the player can stand on",
    failed: () => "The walk did not run",
  };
  return words[result.outcome]();
}

/**
 * The result card's place line: where ego ended, in which room when it left
 * this one. A start the engine refused never ran, and the engine put ego at
 * the room's own entry instead: the card names the start that was asked for.
 */
export function resultPlace(
  from: Point,
  result: Pick<RouteTestResult, "outcome" | "end" | "room">,
  room: number,
): { readonly term: string; readonly text: string } {
  if (result.outcome === "start_blocked")
    return { term: "Asked start", text: `${from.x},${from.y}` };
  const elsewhere = result.room !== room ? ` in room ${result.room}` : "";
  return { term: "Ended at", text: `${result.end.x},${result.end.y}${elsewhere}` };
}

/** A result card tone: reached is good news, a room change is news, the rest a warning. */
export function outcomeTone(outcome: RouteOutcome): "ok" | "info" | "warn" {
  return outcome === "reached" ? "ok" : outcome === "room_changed" ? "info" : "warn";
}

/** A fresh rule id: `base-1`, `base-2`, … the first one no rule uses. */
export function freshRuleId(taken: readonly string[], base: string): string {
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}
