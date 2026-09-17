import type { Engine } from "../runtime/engine.ts";
import { DIRECTION_KEYS } from "./gameTestSteps.ts";
import {
  NavigationController,
  type NavigationBudgets,
  type NavigationGoal,
  type NavigationOptions,
  type NavigationOutcome,
  type NavigationStatus,
} from "./navigationController.ts";

export type TraversalPhase = "approach" | "activation" | "observe" | "passage" | "landing";
export interface TraversalCondition {
  label: string;
  test: (engine: Engine) => boolean;
}
export interface TraversalRequest {
  approach?: NavigationGoal;
  /** A scripted mount can replace the original approach geometry before its endpoint. */
  approachComplete?: TraversalCondition;
  activation?: {
    keys: readonly number[];
    ready: TraversalCondition;
    changed: TraversalCondition;
  };
  passage: NavigationGoal;
  /** A script-triggered transition can occur before the position goal is observed. */
  expectedRoom?: number;
  landing: TraversalCondition;
  /** Trigger and geometry policy must be declared for each movement phase. */
  approachOptions?: NavigationOptions["planOptions"];
  passageOptions?: NavigationOptions["planOptions"];
}
export interface TraversalOptions extends NavigationOptions {
  maxSearches?: number;
}
export interface TraversalOutcome extends NavigationOutcome {
  phase: TraversalPhase;
  counters: NavigationBudgets & { searches: number; activationInputs: number };
}
export interface TraversalDecision {
  direction: number | null;
  key: number | null;
  outcome: TraversalOutcome | null;
  phase: TraversalPhase;
}

/** One bounded ordinary-input transaction across a known passage's state changes. */
export class NavigationTraversal {
  readonly engine: Engine;
  readonly request: TraversalRequest;
  readonly options: TraversalOptions;
  private phase: TraversalPhase;
  private controller: NavigationController | null = null;
  private result: TraversalOutcome | null = null;
  private transitionObserved = false;
  private readonly startTime: number;
  private readonly startRoom: number;
  private readonly expectedRoom: number | undefined;
  private readonly startMovement: number;
  private readonly budgets: NavigationBudgets;
  private start: { hostPolls: number; logicCycles: number } | null = null;
  private previousCycles: number | null = null;
  private settleCycle: number | null = null;
  private pendingDirection: number | null;
  private activationIndex = 0;
  private observedPlan: NavigationController["lastPlan"] = null;
  private searches = 0;
  private counters: TraversalOutcome["counters"] = {
    hostPolls: 0,
    logicCycles: 0,
    movementUpdates: 0,
    replans: 0,
    wallMs: 0,
    searches: 0,
    activationInputs: 0,
  };

  constructor(engine: Engine, request: TraversalRequest, options: TraversalOptions = {}) {
    this.engine = engine;
    this.request = request;
    this.options = options;
    this.phase = request.approach ? "approach" : request.activation ? "activation" : "passage";
    this.pendingDirection = options.pendingDirection ?? null;
    this.startTime = options.now?.() ?? 0;
    this.startRoom = engine.vars[0]!;
    this.expectedRoom =
      request.expectedRoom ?? (request.passage.kind === "exit" ? request.passage.room : undefined);
    this.startMovement = engine.movementUpdateCount;
    // Delegate common option validation to the ordinary movement controller.
    const validator = new NavigationController(engine, request.passage, options);
    this.budgets = validator.budgets;
    if (
      request.expectedRoom !== undefined &&
      (!Number.isInteger(request.expectedRoom) ||
        request.expectedRoom < 0 ||
        request.expectedRoom > 255)
    )
      throw new RangeError("expectedRoom must be an integer 0..255.");
    if (this.expectedRoom === this.startRoom)
      throw new RangeError("A transition must name a different expected room.");
    if (
      request.passage.kind === "exit" &&
      request.expectedRoom !== undefined &&
      request.expectedRoom !== request.passage.room
    )
      throw new RangeError("expectedRoom must match the passage exit room.");
    if (!Number.isInteger(options.maxSearches ?? 10) || (options.maxSearches ?? 10) < 0)
      throw new RangeError("maxSearches must be a nonnegative integer.");
    if (request.activation?.keys.some((key) => !Number.isInteger(key) || key < 0 || key > 65535))
      throw new RangeError("Activation keys must be integers 0..65535.");
  }

  next(progress: { hostPolls: number; logicCycles: number }): TraversalDecision {
    if (this.result) return this.decision(null, null, this.result);
    this.start ??= { ...progress };
    if (this.previousCycles !== null && this.previousCycles !== progress.logicCycles)
      this.pendingDirection = null;
    this.previousCycles = progress.logicCycles;
    this.counters.hostPolls = progress.hostPolls - this.start.hostPolls;
    this.counters.logicCycles = progress.logicCycles - this.start.logicCycles;
    this.counters.movementUpdates = this.engine.movementUpdateCount - this.startMovement;
    this.counters.wallMs = Math.max(0, (this.options.now?.() ?? this.startTime) - this.startTime);
    this.counters.searches = this.searches;
    if (this.options.cancelled?.()) return this.finish("cancelled", "Cancelled by the host.");
    const hazard = this.options.hazard?.();
    if (hazard) return this.finish("hazard_detected", hazard);
    if (this.engine.modalKind !== null || this.engine.continuationPending)
      return this.finish(
        "needs_input",
        "A modal or suspended interaction needs explicit host input.",
      );
    const room = this.engine.vars[0]!;
    if (
      (this.transitionObserved && room !== this.expectedRoom) ||
      (room !== this.startRoom &&
        (room !== this.expectedRoom || (this.phase !== "passage" && this.phase !== "landing")))
    )
      return this.finish("unexpected_transition", `Observed undeclared room ${room}.`);
    if (room === this.expectedRoom) {
      this.transitionObserved = true;
      if (this.phase === "passage") {
        this.completeController();
        this.phase = "landing";
      }
    }
    if (
      this.phase === "landing" &&
      (this.pendingDirection ?? this.engine.vars[6]!) === 0 &&
      this.settleCycle !== progress.logicCycles &&
      (this.expectedRoom === undefined || this.transitionObserved) &&
      this.request.landing.test(this.engine)
    )
      return this.finish("reached", this.request.landing.label);
    for (const metric of ["hostPolls", "logicCycles", "movementUpdates", "wallMs"] as const)
      if (this.counters[metric] >= this.budgets[metric])
        return this.finish("budget_exhausted", `${metric} budget exhausted during ${this.phase}.`);
    if (this.phase === "approach" && this.request.approachComplete?.test(this.engine)) {
      this.completeController();
      this.phase = this.request.activation ? "activation" : "passage";
      this.settleCycle = progress.logicCycles;
      return this.stopHeading(progress) ?? this.decision();
    }
    if (this.phase === "landing") {
      const stopped = this.stopHeading(progress);
      if (stopped) return stopped;
    }
    if (this.settleCycle !== null) {
      if (progress.logicCycles === this.settleCycle) return this.decision();
      this.settleCycle = null;
    }
    if (this.phase === "activation") {
      const activation = this.request.activation!;
      if (this.activationIndex === 0 && !activation.ready.test(this.engine))
        return this.finish("blocked", `Activation precondition failed: ${activation.ready.label}`);
      const key = activation.keys[this.activationIndex++];
      if (key !== undefined) {
        this.counters.activationInputs++;
        const heading = Object.entries(DIRECTION_KEYS).find(([, value]) => value === key)?.[0];
        if (heading !== undefined) {
          const desired = Number(heading);
          this.pendingDirection =
            desired === (this.pendingDirection ?? this.engine.vars[6]!) ? 0 : desired;
          return this.decision(this.pendingDirection, key);
        }
        return this.decision(null, key);
      }
      this.phase = "observe";
    }
    if (this.phase === "observe") {
      if (!this.request.activation!.changed.test(this.engine)) return this.decision();
      this.phase = "passage";
    }
    if (this.phase === "landing") return this.decision();
    if (!this.controller) {
      const goal = this.phase === "approach" ? this.request.approach! : this.request.passage;
      const ego = this.engine.screenObjects[0]!;
      const alreadyInTarget =
        goal.kind === "position" &&
        ego.x >= goal.target.x0 &&
        ego.x <= goal.target.x1 &&
        ego.y >= goal.target.y0 &&
        ego.y <= goal.target.y1;
      const needsSearch =
        goal.kind === "position"
          ? goal.planned === true && !alreadyInTarget
          : goal.kind === "exit" && goal.planned !== false && [1, 3, 5, 7].includes(goal.direction);
      if (needsSearch && this.counters.searches >= (this.options.maxSearches ?? 10))
        return this.finish("budget_exhausted", "Search budget exhausted.");
      const planOptions =
        this.phase === "approach" ? this.request.approachOptions : this.request.passageOptions;
      const remaining = { ...this.budgets };
      for (const metric of [
        "hostPolls",
        "logicCycles",
        "movementUpdates",
        "replans",
        "wallMs",
      ] as const)
        remaining[metric] -= this.counters[metric];
      remaining.replans = Math.max(
        0,
        Math.min(remaining.replans, (this.options.maxSearches ?? 10) - this.searches - 1),
      );
      // An absent host clock keeps the unmeasured wall budget out of validation.
      const { wallMs, ...countBudgets } = remaining;
      this.controller = new NavigationController(this.engine, goal, {
        ...this.options,
        budgets: { ...countBudgets, ...(this.options.now ? { wallMs } : {}) },
        ...(planOptions ? { planOptions } : {}),
        ...(this.pendingDirection !== null ? { pendingDirection: this.pendingDirection } : {}),
      });
    }
    const result = this.controller.next(progress);
    if (this.controller.lastPlan && this.controller.lastPlan !== this.observedPlan) {
      if (this.observedPlan) this.counters.replans++;
      this.observedPlan = this.controller.lastPlan;
      this.counters.searches = ++this.searches;
    }
    if (result.direction !== null) this.pendingDirection = result.direction;
    if (result.outcome) {
      if (result.outcome.status !== "reached")
        return this.finish(
          result.outcome.status,
          result.outcome.reason,
          result.key,
          result.direction,
        );
      this.completeController();
      this.phase =
        this.phase === "approach"
          ? this.request.activation
            ? "activation"
            : "passage"
          : "landing";
      this.settleCycle = progress.logicCycles;
    }
    return this.decision(result.direction, result.key);
  }

  private stopHeading(progress: { logicCycles: number }): TraversalDecision | null {
    const current = this.pendingDirection ?? this.engine.vars[6]!;
    if (current === 0 || !this.engine.movementControlEnabled) return null;
    this.pendingDirection = 0;
    this.settleCycle = progress.logicCycles;
    return this.decision(0, DIRECTION_KEYS[current]!);
  }

  private completeController(): void {
    this.controller = null;
    this.observedPlan = null;
  }

  private decision(
    direction: number | null = null,
    key: number | null = null,
    outcome: TraversalOutcome | null = null,
  ): TraversalDecision {
    return { direction, key, outcome, phase: this.phase };
  }

  private finish(
    status: NavigationStatus,
    reason: string,
    key?: number | null,
    direction?: number | null,
  ): TraversalDecision {
    const ego = this.engine.screenObjects[0]!;
    this.result = {
      status,
      reason,
      phase: this.phase,
      room: this.engine.vars[0]!,
      x: ego.x,
      y: ego.y,
      inputEnabled: this.engine.inputEnabled,
      movementControlEnabled: this.engine.movementControlEnabled,
      completedWaypoints: 0,
      counters: { ...this.counters },
    };
    const current = this.pendingDirection ?? this.engine.vars[6]!;
    const canStop =
      this.engine.modalKind === null &&
      !this.engine.continuationPending &&
      this.engine.movementControlEnabled;
    return this.decision(
      direction ?? (canStop && current !== 0 ? 0 : null),
      key ?? (canStop && current !== 0 ? DIRECTION_KEYS[current]! : null),
      this.result,
    );
  }
}
