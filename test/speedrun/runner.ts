import { AGI_KEY } from "../../src/runtime/keys.ts";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../../src/runtime/engine.ts";
import { CycleClock } from "../../src/runtime/cycleClock.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { DIRECTION_KEYS, directionForDelta, randomSource } from "../../src/agent/gameTestSteps.ts";
import {
  KNOWN_GAME_HASH,
  resolveGameHash,
  getKnownGameByHash,
  getKnownGameByAlias,
  type GameHash,
} from "../../src/games/knownGames.ts";
import { loadGame, type GameFixture } from "../game-fixture.ts";
import { openContainer } from "../../src/container/container.ts";
import { rngDraw } from "../../src/runtime/rng.ts";
import {
  NavigationTraversal,
  type TraversalRequest,
  type TraversalOptions,
  type TraversalOutcome,
} from "../../src/agent/navigationTraversal.ts";
import { type Plan, type PlanOptions, type Target } from "../../src/agent/navigation.ts";

import {
  NavigationController,
  NavigationError,
  type NavigationGoal,
  type NavigationOptions,
  type NavigationOutcome,
} from "../../src/agent/navigationController.ts";

// The step vocabulary is shared with stored game tests (src/agent/gameTestSteps.ts)
// so speedrun proofs and TESTS.JSON can never disagree; re-export the pieces
// this module has always provided.
export { DIRECTION_KEYS, randomSource };

export type DirectionInput = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW" | number;

export const COMPASS_DIRS: Record<string, number> = {
  N: 1,
  NE: 2,
  E: 3,
  SE: 4,
  S: 5,
  SW: 6,
  W: 7,
  NW: 8,
};

export function parseDirection(dir: DirectionInput): number {
  if (typeof dir === "number") return dir;
  const parsed = COMPASS_DIRS[dir];
  if (parsed === undefined) throw new RangeError(`Unknown direction: ${dir}`);
  return parsed;
}

export type Action =
  | { kind: "key"; code: number }
  /** Hold-to-move direction press; dir 0 releases the current heading. */
  | { kind: "direction"; dir: number }
  | { kind: "advance"; ticks: number }
  | { kind: "answer"; text: string }
  | { kind: "checkpoint"; label: string; room: number; score: number; x: number; y: number };
export interface ProbeOptions {
  maxCandidates?: number;
  maxTicksPerCandidate?: number;
  maxTotalTicks?: number;
}
export interface ProbeCandidate<T> {
  label: string;
  run: (branch: Speedrun) => T;
}
export interface ProbeResult<T> {
  label: string;
  status: "completed" | "budget_exhausted" | "failed";
  hostPolls: number;
  logicCycles: number;
  movementUpdates: number;
  wallMs: number;
  value?: T;
  error?: string;
  /** Retain a useful branch; its action prefix remains a cold-boot proof. */
  branch: Speedrun;
}

/** Input driver. No writes to game variables, objects, flags or resources. */
export class Speedrun {
  readonly engine: Engine;
  readonly actions: Action[] = [];
  readonly messages: string[] = [];
  /** get.string prompts, in order; the prompt itself is observed, never answered implicitly. */
  readonly textPrompts: string[] = [];
  /** get.num prompts with the input row's text at prompt time. */
  readonly numPrompts: { prompt: string; row: number; room: number; rowText: string }[] = [];
  readonly seed: number;
  readonly hash: GameHash;
  readonly alias?: string | undefined;
  readonly dwellModals: boolean;
  ticks = 0;
  cycles = 0;
  readonly maxTicks: number;
  private readonly clock = new CycleClock(0);
  private readonly keys: number[] = [];
  private readonly answers: string[] = [];
  private readonly numAnswers: number[] = [];
  private navigationHeading: number | null = null;
  private clockPollTick = 0;
  private rngState: number;
  private readonly fixture: GameFixture;

  constructor(
    game: string = KNOWN_GAME_HASH.KQ1,
    seed = 1,
    load: {
      /** Defaults to "shipped": a route can rely on what the edition shipped. */
      checkVolumes?: boolean | "shipped";
      maxTicks?: number;
      dwellModals?: boolean;
      /** Explicit assembled fixture, also used for independent retained branches. */
      fixture?: GameFixture;
      profile?: Engine["profile"];
    } = {},
  ) {
    this.seed = seed;
    this.rngState = seed & 0xffff;
    const resolved = resolveGameHash(game);
    const known = resolved ? getKnownGameByHash(resolved) : getKnownGameByAlias(game);
    this.hash = resolved ?? (known ? known.wordsSha256 : game);
    this.alias = known?.alias;
    this.dwellModals = load.dwellModals ?? false;
    this.maxTicks = load.maxTicks ?? 500_000;
    this.fixture =
      load.fixture ??
      loadGame(game, {
        interpreterFiles: true,
        checkVolumes: load.checkVolumes ?? "shipped",
      });
    const { container, dict, files } = this.fixture;
    const host: EngineHost = {
      print: (text) => this.messages.push(text),
      displayAt() {},
      statusLine() {},
      // A cold boot has no manual saves, matching a fresh browser profile.
      listSaveGames: () => [],
      takeKeys: () => this.keys.splice(0),
      // Commands arrive as recorded per-character keys; the engine's own edit
      // line accepts them, so the host never supplies a whole line.
      takeInputLine: () => null,
      waitKey: () => {
        this.actions.push({ kind: "key", code: AGI_KEY.ENTER });
        return AGI_KEY.ENTER;
      },
      promptString: (prompt) => {
        this.textPrompts.push(prompt);
        const answer = this.answers.shift();
        assert.notEqual(answer, undefined, "Walkthrough must supply an explicit prompt answer");
        this.actions.push({ kind: "answer", text: answer! });
        return answer!;
      },
      // get.num is a blocking host prompt; like promptString it needs an
      // explicit queued answer, so a walkthrough never depends on a default.
      promptNumber: (prompt, row = 23) => {
        this.numPrompts.push({
          prompt,
          row,
          room: this.engine.vars[0]!,
          rowText: this.engine.textRow(row),
        });
        const answer = this.numAnswers.shift();
        assert.notEqual(answer, undefined, "Walkthrough must supply an explicit prompt answer");
        this.actions.push({ kind: "answer", text: String(answer!) });
        return answer!;
      },
      randomByte: () => {
        const draw = rngDraw(this.rngState, () => this.seed & 0xffff);
        this.rngState = draw.state;
        return draw.byte;
      },
    };
    this.engine = new Engine(container, host, dict, {
      profile: load.profile ?? detectProfile(files),
      instructionBudget: 1_000_000,
    });
    // Match the app's initial user sound preference before executing game logic.
    this.engine.setSoundEnabled(true);
  }

  /** In-process checkpoint fork; retains a cold-replay tape, never a durable session format. */
  fork(options: { maxAdditionalTicks?: number } = {}): Speedrun {
    const remaining = options.maxAdditionalTicks ?? this.maxTicks - this.ticks;
    if (!Number.isInteger(remaining) || remaining < 0)
      throw new RangeError("Fork tick allowance must be a nonnegative integer.");
    const image = this.engine.recordingImage();
    if (image === null) throw new Error("Exploration requires a resumable room boundary.");
    const replay = this.engine.captureReplayState();
    // Container edits replace its file map; use its current bytes while retaining
    // interpreter identity files needed to select the same behavior profile.
    const files = new Map(
      [...this.fixture.files, ...this.fixture.container.files].map(([name, bytes]) => [
        name,
        bytes.slice(),
      ]),
    );
    const branch = new Speedrun(this.hash, this.seed, {
      maxTicks: Math.min(this.maxTicks, this.ticks + remaining),
      dwellModals: this.dwellModals,
      profile: this.engine.profile,
      fixture: { files, container: openContainer(files), dict: new Map(this.fixture.dict) },
    });
    branch.engine.restoreImage(image, { preservePresentation: true });
    branch.engine.restoreReplayState(replay);
    // Refuse an incomplete reconstruction before it can be mistaken for a probe.
    assert.deepEqual(branch.engine.recordingImage(), image, "Fork image differs from its boundary");
    assert.deepEqual(
      branch.engine.captureReplayState(),
      replay,
      "Fork replay state differs from its boundary",
    );
    branch.rngState = this.rngState;
    branch.ticks = this.ticks;
    branch.cycles = this.cycles;
    branch.clockPollTick = this.clockPollTick;
    branch.clock.restore(this.clock.snapshot(), (this.clockPollTick * 1000) / 60);
    branch.keys.push(...this.keys);
    branch.answers.push(...this.answers);
    branch.numAnswers.push(...this.numAnswers);
    branch.navigationHeading = this.navigationHeading;
    branch.actions.push(...structuredClone(this.actions));
    branch.messages.push(...this.messages);
    branch.textPrompts.push(...this.textPrompts);
    branch.numPrompts.push(...structuredClone(this.numPrompts));
    return branch;
  }

  /** Bound simulation polls across synchronous candidate callbacks; never replay the prefix. */
  probe<T>(
    candidates: readonly ProbeCandidate<T>[],
    options: ProbeOptions = {},
  ): {
    candidates: ProbeResult<T>[];
    hostPolls: number;
    prefixTicksReused: number;
    unattempted: number;
  } {
    const maxCandidates = options.maxCandidates ?? 8;
    const perCandidate = options.maxTicksPerCandidate ?? 600;
    const total = options.maxTotalTicks ?? 2400;
    for (const limit of [maxCandidates, perCandidate, total])
      if (!Number.isInteger(limit) || limit < 0)
        throw new RangeError("Probe limits must be nonnegative integers.");
    if (candidates.length > maxCandidates) throw new RangeError("Probe candidate limit exceeded.");
    const results: ProbeResult<T>[] = [];
    let hostPolls = 0;
    for (const candidate of candidates) {
      if (hostPolls >= total) break;
      const started = performance.now();
      const branch = this.fork({ maxAdditionalTicks: Math.min(perCandidate, total - hostPolls) });
      const movement = branch.engine.movementUpdateCount;
      let value: T | undefined;
      let error: string | undefined;
      let status: ProbeResult<T>["status"] = "completed";
      try {
        value = candidate.run(branch);
        if (value !== null && typeof value === "object" && "then" in value)
          throw new TypeError("Probe callbacks must be synchronous.");
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        status = error.startsWith("Speedrun tick ceiling exceeded") ? "budget_exhausted" : "failed";
      }
      const polls = branch.ticks - this.ticks;
      hostPolls += polls;
      results.push({
        label: candidate.label,
        status,
        hostPolls: polls,
        logicCycles: branch.cycles - this.cycles,
        movementUpdates: branch.engine.movementUpdateCount - movement,
        wallMs: performance.now() - started,
        ...(value === undefined ? {} : { value }),
        ...(error === undefined ? {} : { error }),
        branch,
      });
    }
    return {
      candidates: results,
      hostPolls,
      prefixTicksReused: results.length * this.ticks,
      unattempted: candidates.length - results.length,
    };
  }

  state() {
    const ego = this.engine.screenObjects[0]!;
    return {
      room: this.engine.vars[0]!,
      score: this.engine.vars[3]!,
      x: ego.x,
      y: ego.y,
      direction: this.engine.vars[6]!,
      modal: this.engine.modalKind,
      control: this.engine.movementControlEnabled,
      inputEnabled: this.engine.inputEnabled,
      text: Array.from({ length: 25 }, (_, row) => this.engine.textRow(row)).join("\n"),
    };
  }

  key(code: number): void {
    this.actions.push({ kind: "key", code });
    this.keys.push(code);
  }

  answer(text: string): void {
    this.answers.push(text);
  }

  answerNumber(value: number): void {
    this.numAnswers.push(value);
  }

  advance(ticks = 1): void {
    assert.ok(Number.isInteger(ticks) && ticks > 0);
    assert.ok(
      this.ticks + ticks <= this.maxTicks,
      `Speedrun tick ceiling exceeded (${this.ticks + ticks} > ${this.maxTicks})`,
    );
    for (let i = 0; i < ticks; i++) {
      const previous = this.actions.at(-1);
      if (previous?.kind === "advance") previous.ticks++;
      else this.actions.push({ kind: "advance", ticks: 1 });
      this.ticks++;
      this.clockPollTick = this.ticks;
      if (this.engine.timerPaused) this.clock.freeze((this.ticks * 1000) / 60);
      else this.clock.advance((this.ticks * 1000) / 60);
      this.engine.advanceClock(1000 / 60);
      this.engine.soundTick();
      if (this.engine.modalKind !== null || this.engine.continuationPending) this.engine.tick();
      else {
        if (this.clock.poll((this.ticks * 1000) / 60, this.engine.vars[10]!)) {
          this.engine.tick();
          this.cycles++;
          this.navigationHeading = null;
        }
      }
      if (this.hash === KNOWN_GAME_HASH.KQ1 && this.engine.flags[63] !== 0)
        assert.fail(`Graham died: ${JSON.stringify(this.state())}`);
    }
  }

  private calculateModalDwellTicks(): number {
    const rows = Array.from({ length: 25 }, (_, row) => this.engine.textRow(row));
    if (!rows || rows.length <= 1) return 0;
    const content = rows.slice(1).join(" ");
    const matches = content.match(/[A-Za-z0-9']{2,}/g);
    const words = matches ? matches.length : 0;
    // ~200 words/min baseline reading pace at 60Hz: 1.8s (108 ticks) + 120ms (7.2 ticks) per word
    const baseTicks = 108;
    const perWordTicks = 7;
    const rawTicks = Math.min(300, Math.max(90, baseTicks + words * perWordTicks));
    if (this.engine.vars[21] !== 0) {
      return Math.min(rawTicks, this.engine.vars[21]! * 30);
    }
    return rawTicks;
  }

  dismiss(): void {
    for (let n = 0; this.engine.modalKind !== null || this.engine.continuationPending; n++) {
      assert.ok(n < 100, `Unsettled modal: ${this.state().text}`);
      if (this.engine.modalKind !== null) {
        if (this.dwellModals) {
          const dwellTicks = this.calculateModalDwellTicks();
          if (dwellTicks > 0) {
            this.advance(dwellTicks);
          }
        }
        if (this.engine.modalKind !== null) {
          this.key(AGI_KEY.ENTER);
        }
      }
      this.advance();
    }
  }

  /**
   * Step until the predicate holds; the budget is an explicit, observed bound.
   * Unlike wait(), nothing is dismissed — modal windows and prompts stay
   * observable while time advances them.
   */
  until(predicate: () => boolean, budget: number, label: string): void {
    for (let i = 0; i < budget; i++) {
      if (predicate()) return;
      this.advance();
    }
    assert.ok(predicate(), `${label} within ${budget} ticks`);
  }

  /**
   * Buffer a parser command exactly as a player would: one key action per
   * letter, one tick between letters — the engine consumes the whole key queue
   * each cycle — then verify what landed. A modal or cutscene opening
   * mid-burst eats the queued letters; a player dismisses the popup and
   * retypes them, so the recording does the same. The line stays buffered for
   * `submit()` — the engine echoes it onto its own input row while the player
   * is free to keep walking, the classic type-ahead technique.
   */
  type(text: string): void {
    this.dismiss();
    this.wait(() => this.engine.inputEnabled, `Parser available for ${text}`);
    assert.match(text, /^[\x20-\x7e]+$/, `Command must be printable ASCII: ${text}`);
    while (this.engine.inputEdit !== text) {
      if (this.engine.modalKind !== null || this.engine.continuationPending) {
        this.dismiss();
        continue;
      }
      if (!this.engine.inputEnabled) {
        this.advance();
        continue;
      }
      const current = this.engine.inputEdit;
      assert.ok(text.startsWith(current), `Input row diverged from command: ${text}`);
      const before = this.cycles;
      // The input queue holds nineteen events; burst in chunks below that.
      for (const ch of text.slice(current.length, current.length + 12)) {
        this.key(ch.charCodeAt(0));
        this.advance(1);
      }
      for (let n = 0; (this.cycles === before || this.keys.length > 0) && n < 1000; n++) {
        if (this.engine.modalKind !== null || this.engine.continuationPending) break;
        this.advance();
      }
    }
  }

  /**
   * Press Enter until the engine accepts the buffered line: an Enter consumed
   * by a popup still needs a second press once the popup is dismissed.
   */
  submit(label = "command"): void {
    for (let n = 0; this.engine.inputEdit !== ""; n++) {
      assert.ok(n < 100, `Command not consumed: ${label}`);
      if (this.engine.modalKind !== null || this.engine.continuationPending) {
        this.dismiss();
        continue;
      }
      if (!this.engine.inputEnabled) {
        this.advance();
        continue;
      }
      this.key(AGI_KEY.ENTER);
      for (let c = 0; this.engine.inputEdit !== "" && c < 40; c++) {
        if (this.engine.modalKind !== null || this.engine.continuationPending) break;
        this.advance();
      }
    }
    this.dismiss();
  }

  /** Type and submit in one go; routes that must move first use type/submit. */
  command(text: string): void {
    assert.equal(this.engine.inputEdit, "", "Previous command must be consumed");
    this.type(text);
    this.submit(text);
  }

  press(key: number, waitTicks = 5): void {
    this.key(key);
    this.advance(waitTicks);
  }

  direction(dir: DirectionInput): void {
    const d = parseDirection(dir);
    const current = this.navigationHeading ?? this.engine.vars[6]!;
    if (current === d && this.navigationHeading === null) return;
    if (current !== d) {
      // Record the actual toggle key: a prior navigation stop may still be
      // queued, so the observed direction alone cannot reconstruct this input.
      const key = DIRECTION_KEYS[d || current]!;
      this.actions.push({ kind: "key", code: key });
      this.keys.push(key);
      this.navigationHeading = d;
    }
    // A matching queued heading still has to reach an input phase before this
    // synchronous contributor helper returns. Do not enqueue the same toggle twice.
    const from = this.cycles;
    for (let n = 0; this.cycles === from; n++) {
      assert.ok(n < 1000, "Direction input did not reach a cycle");
      if (this.engine.modalKind !== null || this.engine.continuationPending) this.dismiss();
      this.advance();
    }
  }

  private diagnostics(label: string): string {
    const s = this.state();
    const recent = this.actions
      .slice(-5)
      .map((a) => {
        if (a.kind === "key") return `key(${a.code})`;
        if (a.kind === "direction") return `direction(${a.dir})`;
        if (a.kind === "advance") return `advance(${a.ticks})`;
        if (a.kind === "answer") return `answer("${a.text}")`;
        if (a.kind === "checkpoint") return `checkpoint("${a.label}")`;
        return JSON.stringify(a);
      })
      .join(", ");
    return `Timed out: ${label}; room ${s.room}, score ${s.score}, pos (${s.x},${s.y}), dir ${s.direction}; recent actions: [${recent}]`;
  }

  walkDirection(dir: DirectionInput, until: () => boolean, label: string, max = 3000): void {
    const d = parseDirection(dir);
    for (let n = 0; n < max; n++) {
      if (this.engine.modalKind !== null || this.engine.continuationPending) this.dismiss();
      if (until()) {
        this.direction(0);
        return;
      }
      this.direction(d);
      this.advance();
    }
    this.direction(0);
    throw new Error(this.diagnostics(`walking ${dir}: ${label}`));
  }

  walkToUntil(x: number, y: number, until: () => boolean, label: string, max = 3000): void {
    const ego = this.engine.screenObjects[0]!;
    for (let n = 0; n < max; n++) {
      if (this.engine.modalKind !== null || this.engine.continuationPending) this.dismiss();
      if (until()) {
        this.direction(0);
        return;
      }
      const dx = Math.sign(x - ego.x);
      const dy = Math.sign(y - ego.y);
      if (!dx && !dy) {
        this.direction(0);
        break;
      }
      this.direction(directionForDelta(dx, dy));
      this.advance();
    }
    this.direction(0);
    if (!until()) {
      throw new Error(this.diagnostics(`walking toward (${x},${y}): ${label}`));
    }
  }

  walkWaypoints(
    points: readonly (readonly [number, number])[],
    options: { continuous?: boolean } = {},
  ): void {
    // This contributor convenience preserves the established stop between
    // explicit points. navigate({kind:"waypoints",...}) bounds one continuous goal.
    if (!options.continuous) {
      for (const [x, y] of points) this.walkTo(x, y);
      return;
    }
    const { outcome } = this.navigate({
      kind: "waypoints",
      points: points.map(([x, y]) => ({ x, y })),
    });
    this.finishNavigation(outcome, 3000);
  }

  repeatUntil(action: () => void, until: () => boolean, label: string, maxAttempts = 100): void {
    for (let n = 0; n < maxAttempts; n++) {
      action();
      if (until()) return;
    }
    throw new Error(this.diagnostics(`after ${maxAttempts} attempts: ${label}`));
  }

  carried(item: number): boolean {
    return this.engine.itemLocation(item) === 0xff;
  }

  assertCarried(item: number, name?: string): void {
    assert.equal(
      this.engine.itemLocation(item),
      0xff,
      `${name ? name + " " : ""}(item ${item}) must be carried`,
    );
  }

  waitForItem(item: number, label?: string, max?: number): void {
    this.wait(() => this.carried(item), label ?? `item ${item} carried`, max);
  }

  take(command: string, item: number, label?: string): void {
    this.command(command);
    this.waitForItem(item, label ?? `${command} -> carried`);
  }

  waitForRoom(room: number, label?: string, max?: number): void {
    this.wait(() => this.state().room === room, label ?? `entered room ${room}`, max);
  }

  waitForFlag(flag: number, label?: string, max?: number): void {
    this.wait(() => this.engine.flags[flag] !== 0, label ?? `flag ${flag} set`, max);
  }

  wait(predicate: () => boolean, label: string, max = 30000): void {
    for (let n = 0; n < max; n++) {
      if (this.engine.modalKind !== null || this.engine.continuationPending) this.dismiss();
      if (predicate()) return;
      this.advance();
    }
    throw new Error(this.diagnostics(label));
  }

  /** Poll the shared controller, recording ordinary direction gestures only. */
  navigate(
    goal: NavigationGoal,
    options: NavigationOptions = {},
  ): {
    outcome: NavigationOutcome;
    plan: Plan | null;
  } {
    const controller = new NavigationController(this.engine, goal, {
      ...options,
      ...(this.navigationHeading === null ? {} : { pendingDirection: this.navigationHeading }),
      now: options.now ?? (() => performance.now()),
      budgets: {
        ...options.budgets,
        hostPolls: Math.min(options.budgets?.hostPolls ?? 3000, this.maxTicks - this.ticks),
      },
    });
    for (;;) {
      const decision = controller.next({ hostPolls: this.ticks, logicCycles: this.cycles });
      if (decision.direction !== null && decision.direction !== this.navigationHeading) {
        const effective = this.navigationHeading ?? this.engine.vars[6]!;
        const key = DIRECTION_KEYS[decision.direction || effective];
        if (key !== undefined) {
          this.actions.push({ kind: "key", code: key });
          this.keys.push(key);
          this.navigationHeading = decision.direction;
        }
      }
      if (decision.outcome) return { outcome: decision.outcome, plan: controller.lastPlan };
      this.advance();
    }
  }

  /** Execute declared approach, activation, passage and landing as ordinary inputs. */
  traverse(request: TraversalRequest, options: TraversalOptions = {}): TraversalOutcome {
    const traversal = new NavigationTraversal(this.engine, request, {
      ...options,
      ...(this.navigationHeading === null ? {} : { pendingDirection: this.navigationHeading }),
      now: options.now ?? (() => performance.now()),
      budgets: {
        ...options.budgets,
        hostPolls: Math.min(options.budgets?.hostPolls ?? 3000, this.maxTicks - this.ticks),
      },
    });
    for (;;) {
      const decision = traversal.next({ hostPolls: this.ticks, logicCycles: this.cycles });
      if (decision.key !== null) this.key(decision.key);
      if (decision.direction !== null) this.navigationHeading = decision.direction;
      if (decision.outcome) return decision.outcome;
      this.advance();
    }
  }

  /** Acknowledge the already-recorded stop within the synchronous helper's poll allowance. */
  private finishNavigation(outcome: NavigationOutcome, maxPolls: number): void {
    if (outcome.status !== "reached") throw new NavigationError(outcome);
    const startPolls = this.ticks;
    const startCycles = this.cycles;
    const startMovement = this.engine.movementUpdateCount;
    const startWall = performance.now();
    while (
      this.navigationHeading !== null &&
      this.engine.modalKind === null &&
      !this.engine.continuationPending
    ) {
      const hostPolls = outcome.counters.hostPolls + this.ticks - startPolls;
      if (hostPolls >= maxPolls || this.ticks >= this.maxTicks) {
        throw new NavigationError({
          ...outcome,
          status: "budget_exhausted",
          reason: "hostPolls budget exhausted before the queued stop reached an input phase.",
          counters: {
            ...outcome.counters,
            hostPolls,
            logicCycles: outcome.counters.logicCycles + this.cycles - startCycles,
            movementUpdates:
              outcome.counters.movementUpdates + this.engine.movementUpdateCount - startMovement,
            wallMs: outcome.counters.wallMs + performance.now() - startWall,
          },
        });
      }
      this.advance();
    }
  }

  walkTo(x: number, y: number, max = 3000): void {
    const result = this.navigate(
      { kind: "position", target: { x0: x, x1: x, y0: y, y1: y } },
      { budgets: { hostPolls: max } },
    );
    this.finishNavigation(result.outcome, max);
  }

  walkPath(
    targetOrX: Target | number,
    yOrOptions?: number | PlanOptions,
    options?: PlanOptions,
  ): Plan {
    let target: Target;
    let opts = options;
    if (typeof targetOrX === "number") {
      const x = targetOrX;
      const y = typeof yOrOptions === "number" ? yOrOptions : 0;
      if (typeof yOrOptions === "object") opts = yOrOptions;
      const ego = this.engine.screenObjects[0];
      const maxX = ego ? 160 - ego.width : 159;
      const minY = ego
        ? Math.max(ego.height - 1, ego.observeHorizon ? this.engine.horizon + 1 : 0)
        : 0;
      const clampedX = Math.max(0, Math.min(x, maxX));
      const clampedY = Math.max(minY, Math.min(y, 167));
      target = { x0: clampedX, x1: clampedX, y0: clampedY, y1: clampedY };
    } else {
      target = targetOrX;
      if (typeof yOrOptions === "object") opts = yOrOptions;
    }
    const result = this.navigate(
      { kind: "position", target, planned: true },
      opts === undefined ? {} : { planOptions: opts },
    );
    this.finishNavigation(result.outcome, 3000);
    return (
      result.plan ?? {
        found: true,
        room: result.outcome.room,
        from: { x: result.outcome.x, y: result.outcome.y },
        target,
        reached: { x: result.outcome.x, y: result.outcome.y },
        cells: 0,
        steps: 0,
        waypoints: [],
        assumptions: [],
      }
    );
  }

  exit(dir: DirectionInput, room: number, max = 10000): void {
    const result = this.navigate(
      { kind: "exit", direction: parseDirection(dir), room, planned: false },
      { budgets: { hostPolls: max } },
    );
    this.finishNavigation(result.outcome, max);
  }

  checkpoint(label: string, expected: { room?: number; score?: number }): void {
    const state = this.state();
    if (expected.room !== undefined) assert.equal(state.room, expected.room, label);
    if (expected.score !== undefined) assert.equal(state.score, expected.score, label);
    this.actions.push({
      kind: "checkpoint",
      label,
      room: state.room,
      score: state.score,
      x: state.x,
      y: state.y,
    });
    process.stdout.write(
      `${label}: room ${state.room}, score ${state.score}, (${state.x},${state.y}), ${this.ticks} ticks\n`,
    );
  }
}
