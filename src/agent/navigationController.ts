import type { Engine } from "../runtime/engine.ts";
import { decodeSave } from "../runtime/persistence.ts";
import { fnv1a32 } from "../runtime/hash.ts";
import { DIRECTION_KEYS, directionForDelta } from "./gameTestSteps.ts";
import {
  planWalk,
  validateWalk,
  validateTarget,
  type Plan,
  type PlanOptions,
  type Target,
} from "./navigation.ts";

export type NavigationGoal =
  | { kind: "position"; target: Target; planned?: boolean }
  | { kind: "waypoints"; points: readonly { x: number; y: number }[] }
  | { kind: "exit"; direction: number; room: number; planned?: boolean };
export type NavigationStatus =
  | "reached"
  | "blocked"
  | "unreachable_under_current_model"
  | "needs_input"
  | "movement_control_unavailable"
  | "unexpected_transition"
  | "hazard_detected"
  | "budget_exhausted"
  | "cancelled"
  | "satisfied";
export interface NavigationBudgets {
  hostPolls: number;
  logicCycles: number;
  movementUpdates: number;
  /** Replacement searches after the initial plan. */
  replans: number;
  wallMs: number;
}
export interface NavigationOptions {
  budgets?: Partial<NavigationBudgets>;
  planOptions?: PlanOptions;
  /** Host heading already queued for the next input phase, across goal boundaries. */
  pendingDirection?: number;
  /** Monotonic host clock. Without a clock wall time is not measured. */
  now?: () => number;
  cancelled?: () => boolean;
  /**
   * A goal the caller can observe directly ("the door has opened", "the item
   * is carried"): once it holds, the walk finishes as `satisfied` even if the
   * position target is not reached.
   */
  until?: () => boolean;
  hazard?: () => string | null;
  stallUpdates?: number;
}
export interface NavigationOutcome {
  status: NavigationStatus;
  reason: string;
  room: number;
  x: number;
  y: number;
  inputEnabled: boolean;
  movementControlEnabled: boolean;
  completedWaypoints: number;
  counters: NavigationBudgets;
}
export class NavigationError extends Error {
  readonly outcome: NavigationOutcome;
  constructor(outcome: NavigationOutcome) {
    super(
      `Navigation ${outcome.status}: ${outcome.reason} at room ${outcome.room} (${outcome.x},${outcome.y})`,
    );
    this.name = "NavigationError";
    this.outcome = outcome;
  }
}
export interface NavigationDecision {
  /** A semantic heading to enqueue once through the host's ordinary key input. */
  direction: number | null;
  /** Raw AGI navigation key, including a toggle that cancels a queued heading. */
  key: number | null;
  outcome: NavigationOutcome | null;
}

/**
 * Incremental closed-loop movement. Call after every host poll; this controller
 * never advances time, answers prompts, or writes engine variables/objects.
 * Terminal outcomes describe the observed position; their stop input still needs
 * the host's next ordinary input phase. Frozen tapes replay inputs independently.
 */
export class NavigationController {
  readonly engine: Engine;
  readonly goal: NavigationGoal;
  readonly options: NavigationOptions;
  readonly budgets: NavigationBudgets;
  lastPlan: Plan | null = null;
  completedWaypoints = 0;
  private readonly startRoom: number;
  private readonly startTime: number;
  private readonly stallLimit: number;
  private startPolls: number | null = null;
  private startCycles = 0;
  private previousCycles = 0;
  private previousMovement: number;
  private previousPosition: string;
  private pendingDirection: number | null = null;
  private inputKey: number | null = null;
  private stall = 0;
  private positions: string[] = [];
  private modelKey: string | null = null;
  private geometryKey: string | null = null;
  private points: readonly { x: number; y: number }[] = [];
  private pointIndex = 0;
  private exitCrossing = false;
  private result: NavigationOutcome | null = null;
  private counters: NavigationBudgets = {
    hostPolls: 0,
    logicCycles: 0,
    movementUpdates: 0,
    replans: 0,
    wallMs: 0,
  };

  constructor(engine: Engine, goal: NavigationGoal, options: NavigationOptions = {}) {
    this.engine = engine;
    this.goal = goal;
    this.options = options;
    if (
      options.pendingDirection !== undefined &&
      (!Number.isInteger(options.pendingDirection) ||
        options.pendingDirection < 0 ||
        options.pendingDirection > 8)
    )
      throw new RangeError("pendingDirection must be an integer 0..8.");
    this.pendingDirection = options.pendingDirection ?? null;
    this.startRoom = engine.vars[0]!;
    this.startTime = options.now?.() ?? 0;
    this.previousMovement = engine.movementUpdateCount;
    const ego = engine.screenObjects[0]!;
    this.previousPosition = `${ego.x},${ego.y}`;
    this.stallLimit = options.stallUpdates ?? 8;
    if (!Number.isInteger(this.stallLimit) || this.stallLimit < 2)
      throw new RangeError("stallUpdates must be an integer of at least 2.");
    this.budgets = {
      hostPolls: 1200,
      logicCycles: 1200,
      movementUpdates: 600,
      replans: 8,
      wallMs: options.now ? 30_000 : Infinity,
      ...options.budgets,
    };
    for (const [name, value] of Object.entries(options.budgets ?? {})) {
      if (!Number.isFinite(value) || value < 0 || (name !== "wallMs" && !Number.isInteger(value)))
        throw new RangeError(
          `Navigation budget ${name} must be a nonnegative ${name === "wallMs" ? "number" : "integer"}.`,
        );
    }
    if (options.budgets?.wallMs !== undefined && !options.now)
      throw new RangeError("A wallMs budget requires an injected monotonic clock.");
    if (goal.kind === "position") validateTarget(goal.target);
    else if (goal.kind === "waypoints") {
      for (const point of goal.points)
        validateTarget({ x0: point.x, x1: point.x, y0: point.y, y1: point.y });
      this.points = goal.points;
    } else if (
      !Number.isInteger(goal.direction) ||
      goal.direction < 1 ||
      goal.direction > 8 ||
      !Number.isInteger(goal.room) ||
      goal.room < 0 ||
      goal.room > 255 ||
      goal.room === this.startRoom
    ) {
      throw new RangeError("An exit needs a direction 1..8 and a different expected room 0..255.");
    }
  }

  get progress(): Readonly<NavigationBudgets> {
    return { ...this.counters };
  }

  next(progress: { hostPolls: number; logicCycles: number }): NavigationDecision {
    if (this.result) return { direction: null, key: null, outcome: this.result };
    const engine = this.engine;
    const ego = engine.screenObjects[0]!;
    if (this.startPolls === null) {
      this.startPolls = progress.hostPolls;
      this.startCycles = progress.logicCycles;
      this.previousCycles = progress.logicCycles;
    }
    this.counters.hostPolls = progress.hostPolls - this.startPolls;
    this.counters.logicCycles = progress.logicCycles - this.startCycles;
    this.counters.wallMs = Math.max(0, (this.options.now?.() ?? this.startTime) - this.startTime);
    const position = `${ego.x},${ego.y}`;
    const updates = engine.movementUpdateCount - this.previousMovement;
    this.previousMovement = engine.movementUpdateCount;
    this.counters.movementUpdates += updates;
    const advanced = progress.logicCycles !== this.previousCycles;
    this.previousCycles = progress.logicCycles;
    if (advanced) this.pendingDirection = null;
    if (updates > 0) {
      this.stall = position === this.previousPosition ? this.stall + updates : 0;
      this.positions.push(position);
      if (this.positions.length > this.stallLimit + 1) this.positions.shift();
    }
    this.previousPosition = position;
    if (this.options.cancelled?.()) return this.finish("cancelled", "Cancelled by the host.");
    if (this.options.until?.()) return this.finish("satisfied", "The caller's condition holds.");
    const hazard = this.options.hazard?.();
    if (hazard) return this.finish("hazard_detected", hazard);
    if (engine.vars[0] !== this.startRoom) {
      return this.goal.kind === "exit" && engine.vars[0] === this.goal.room
        ? this.finish("reached", "Entered the expected room.")
        : this.finish(
            "unexpected_transition",
            `Expected ${this.goal.kind === "exit" ? this.goal.room : this.startRoom}, observed room ${engine.vars[0]}.`,
          );
    }
    if (engine.modalKind !== null || engine.continuationPending)
      return this.finish(
        "needs_input",
        "A modal or suspended interaction needs explicit host input.",
      );
    if (
      this.goal.kind === "position" &&
      this.inTarget(this.goal.target) &&
      (!this.goal.planned ||
        this.lastPlan === null ||
        (ego.x === this.lastPlan.reached?.x && ego.y === this.lastPlan.reached?.y))
    )
      return this.finish("reached", "Ego entered the target region.");
    while (
      this.pointIndex < this.points.length &&
      this.points[this.pointIndex]!.x === ego.x &&
      this.points[this.pointIndex]!.y === ego.y
    ) {
      this.pointIndex++;
      this.completedWaypoints++;
    }
    if (this.goal.kind === "waypoints" && this.pointIndex === this.points.length)
      return this.finish("reached", "Completed every waypoint.");
    if (
      !engine.movementControlEnabled ||
      !ego.active ||
      !ego.update ||
      ego.earlierPartition ||
      engine.textModeActive
    )
      return this.finish(
        "movement_control_unavailable",
        "Ego is not currently available for player movement.",
      );
    for (const metric of ["hostPolls", "logicCycles", "movementUpdates", "wallMs"] as const) {
      if (this.counters[metric] >= this.budgets[metric])
        return this.finish("budget_exhausted", `${metric} budget exhausted.`);
    }
    const boundedOptions = {
      ...this.options.planOptions,
      maxSteps: Math.min(
        this.options.planOptions?.maxSteps ?? Infinity,
        this.budgets.movementUpdates - this.counters.movementUpdates,
      ),
    };
    const planningOptions =
      this.goal.kind === "exit" && [1, 3, 5, 7].includes(this.goal.direction)
        ? { ...boundedOptions, exitDirection: this.goal.direction }
        : boundedOptions;
    let crossingInvalidated = false;
    if (
      this.exitCrossing &&
      !validateWalk(
        { engine, state: () => ({ room: engine.vars[0]!, x: ego.x, y: ego.y }) },
        [],
        planningOptions,
      )
    ) {
      this.exitCrossing = false;
      crossingInvalidated = true;
    }
    let plannedTarget =
      this.goal.kind === "position" && this.goal.planned ? this.goal.target : this.exitApproach();
    if (
      this.goal.kind === "exit" &&
      plannedTarget !== null &&
      this.inTarget(plannedTarget) &&
      validateWalk(
        { engine, state: () => ({ room: engine.vars[0]!, x: ego.x, y: ego.y }) },
        [],
        planningOptions,
      )
    ) {
      this.exitCrossing = true;
      plannedTarget = null;
    }
    if (plannedTarget !== null) {
      const snapshot = this.snapshotKey();
      const key = JSON.stringify([
        snapshot.geometry,
        snapshot.objects,
        snapshot.minimumBaseline,
        snapshot.waterWidth,
      ]);
      if (
        !crossingInvalidated &&
        key !== this.modelKey &&
        snapshot.geometry === this.geometryKey &&
        validateWalk(
          { engine, state: () => ({ room: engine.vars[0]!, x: ego.x, y: ego.y }) },
          this.points.slice(this.pointIndex),
          planningOptions,
        )
      ) {
        // Moving actors, ceiling changes and animated water-scan widths need
        // replacement search only when the remaining trace is no longer legal.
        // Other geometry changes always consume the replacement-search budget.
        this.modelKey = key;
      }
      if (key !== this.modelKey || crossingInvalidated) {
        if (this.modelKey !== null) {
          if (this.counters.replans >= this.budgets.replans)
            return this.finish(
              "budget_exhausted",
              "replans budget exhausted after a model change.",
            );
          this.counters.replans++;
        }
        this.modelKey = key;
        this.geometryKey = snapshot.geometry;
        this.lastPlan = planWalk(
          { engine, state: () => ({ room: engine.vars[0]!, x: ego.x, y: ego.y }) },
          plannedTarget,
          planningOptions,
        );
        this.points = this.lastPlan.waypoints;
        this.pointIndex = 0;
        this.stall = 0;
        this.positions = [];
        if (!this.lastPlan.found)
          return this.finish(
            this.lastPlan.searchStatus === "budget_exhausted" ||
              this.lastPlan.searchStatus === "movement_budget_exhausted"
              ? "budget_exhausted"
              : "unreachable_under_current_model",
            this.lastPlan.searchStatus === "movement_budget_exhausted"
              ? "No route fits the remaining movement allowance."
              : this.lastPlan.searchStatus === "budget_exhausted"
                ? "Search work budget exhausted before a route was established."
                : "No route in the current static model.",
          );
        if (
          this.goal.kind === "position" &&
          ego.x === this.lastPlan.reached?.x &&
          ego.y === this.lastPlan.reached?.y
        )
          return this.finish("reached", "Ego reached the selected target endpoint.");
      }
    }
    if (this.stall >= this.stallLimit)
      return this.finish(
        "blocked",
        `No position change in ${this.stall} eligible movement updates.`,
      );
    if (this.positions.length === this.stallLimit + 1 && new Set(this.positions).size <= 2)
      return this.finish("blocked", "Short position oscillation without progress.");
    let direction: number;
    if (this.goal.kind === "exit" && plannedTarget === null) direction = this.goal.direction;
    else {
      const point =
        this.points[this.pointIndex] ??
        (this.goal.kind === "position"
          ? {
              x: Math.max(this.goal.target.x0, Math.min(ego.x, this.goal.target.x1)),
              y: Math.max(this.goal.target.y0, Math.min(ego.y, this.goal.target.y1)),
            }
          : { x: ego.x, y: ego.y });
      direction = directionForDelta(Math.sign(point.x - ego.x), Math.sign(point.y - ego.y));
    }
    // Search and live-trace validation are synchronous work. Recheck the host
    // limits after they finish so an expired action cannot issue its first key.
    this.counters.wallMs = Math.max(0, (this.options.now?.() ?? this.startTime) - this.startTime);
    if (this.options.cancelled?.()) return this.finish("cancelled", "Cancelled by the host.");
    if (this.counters.wallMs >= this.budgets.wallMs)
      return this.finish("budget_exhausted", "wallMs budget exhausted.");
    const emitted = this.input(direction);
    return { direction: emitted, key: this.inputKey, outcome: null };
  }

  /** Cardinal exits approach a legal boundary before sending the crossing input.
   * Diagonal exits remain explicit directional gestures: there is no unique edge.
   */
  private exitApproach(): Target | null {
    if (this.goal.kind !== "exit" || this.goal.planned === false || this.exitCrossing) return null;
    const ego = this.engine.screenObjects[0]!;
    const minY = Math.max(ego.height - 1, ego.observeHorizon ? this.engine.horizon + 1 : 0);
    let width = ego.width;
    if (this.options.planOptions?.geometry !== "current") {
      for (const loop of this.engine.getView(ego.view)?.loops ?? [])
        for (const cel of loop.cels) width = Math.max(width, cel.width);
    }
    const maxX = 160 - width;
    const band = Math.max(0, ego.stepSize - 1);
    switch (this.goal.direction) {
      case 1:
        return { x0: 0, x1: maxX, y0: minY, y1: Math.min(167, minY + band) };
      case 3:
        return { x0: Math.max(0, maxX - band), x1: maxX, y0: minY, y1: 167 };
      case 5:
        return { x0: 0, x1: maxX, y0: Math.max(minY, 167 - band), y1: 167 };
      case 7:
        return { x0: 0, x1: Math.min(maxX, band), y0: minY, y1: 167 };
      default:
        return null;
    }
  }

  private inTarget(target: Target): boolean {
    const ego = this.engine.screenObjects[0]!;
    return ego.x >= target.x0 && ego.x <= target.x1 && ego.y >= target.y0 && ego.y <= target.y1;
  }
  private input(direction: number): number | null {
    this.inputKey = null;
    const effective = this.pendingDirection ?? this.engine.vars[6]!;
    if (effective === direction) return null;
    this.inputKey = DIRECTION_KEYS[direction || effective] ?? null;
    this.pendingDirection = direction;
    return direction;
  }
  private finish(status: NavigationStatus, reason: string): NavigationDecision {
    const ego = this.engine.screenObjects[0]!;
    this.result = {
      status,
      reason,
      room: this.engine.vars[0]!,
      x: ego.x,
      y: ego.y,
      inputEnabled: this.engine.inputEnabled,
      movementControlEnabled: this.engine.movementControlEnabled,
      completedWaypoints: this.completedWaypoints,
      counters: { ...this.counters },
    };
    // Do not send direction keys into a modal: navigation events can select menu items.
    this.inputKey = null;
    const direction =
      this.engine.modalKind === null &&
      !this.engine.continuationPending &&
      this.engine.movementControlEnabled
        ? this.input(0)
        : null;
    return { direction, key: this.inputKey, outcome: this.result };
  }
  private snapshotKey(): {
    geometry: string;
    objects: string;
    minimumBaseline: number;
    waterWidth: number | null;
  } {
    const engine = this.engine;
    const ego = engine.screenObjects[0]!;
    const save = decodeSave(engine.serialize(), engine.profile);
    let width = ego.width;
    if (this.options.planOptions?.geometry !== "current") {
      for (const loop of engine.getView(ego.view)?.loops ?? [])
        for (const cel of loop.cels) width = Math.max(width, cel.width);
    }
    const minimumBaseline = Math.max(ego.height - 1, ego.observeHorizon ? engine.horizon + 1 : 0);
    const geometry = JSON.stringify([
      fnv1a32(engine.surface.priority),
      save.blockEnabled,
      save.blockLeft,
      save.blockRight,
      save.blockTop,
      save.blockBottom,
      width,
      ego.stepSize,
      ego.observeBlocks,
      ego.observeHorizon,
      ego.observeObjects,
      ego.waterGate,
      ego.fixedPriority && ego.priority === 15,
    ]);
    const objects = JSON.stringify(
      engine.screenObjects
        .slice(1)
        .filter((o) => o.active && o.update && o.observeObjects)
        .map((o) => [o.x, o.y, o.width, o.height, o.earlierPartition]),
    );
    // Current water-scan width and the ceiling may animate without invalidating
    // any remaining anchor. Both require live trace validation when they change.
    return {
      geometry,
      objects,
      minimumBaseline,
      waterWidth: ego.waterGate === null ? null : ego.width,
    };
  }
}
