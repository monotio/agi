/** Bounded, detached execution of authored resources using the real interpreter. */
import { openContainer } from "../container/container.ts";
import { parseWordsTok } from "../logic/words.ts";
import { TIMER_INCREMENT_MS } from "../runtime/cycleClock.ts";
import { Engine, type EngineHost } from "../runtime/engine.ts";
import { frameToPng, framesToContactSheet, textRows, type AgentFrame } from "./frames.ts";
import {
  directionForDelta,
  randomSource,
  validateObjectAssertion,
  validateUntilPredicate,
  validateVarAssertion,
  type UntilPredicate,
} from "./gameTestSteps.ts";
import type { AgentSessionState, AgentToolResult } from "./tools.ts";

const DEFAULT_CYCLES = 600;
/** Genesis boots get this many cycles, plus GENESIS_CYCLES_PER_ACK for every dismissed message or key. */
const GENESIS_CYCLES = 120;
const GENESIS_CYCLES_PER_ACK = 30;
const GENESIS_MAX_ACKS = 16;
const DIRECTIONS: Readonly<Record<string, number>> = {
  up: 1,
  "up-right": 2,
  right: 3,
  "down-right": 4,
  down: 5,
  "down-left": 6,
  left: 7,
  "up-left": 8,
};

const DIRECTION_DELTAS: Readonly<Record<number, readonly [number, number]>> = {
  1: [0, -1],
  2: [1, -1],
  3: [1, 0],
  4: [1, 1],
  5: [0, 1],
  6: [-1, 1],
  7: [-1, 0],
  8: [-1, -1],
};
/** Every non-null condition of a wait-until predicate must hold. */
function untilMet(engine: Engine, until: UntilPredicate): boolean {
  if (until.room !== null && engine.vars[0] !== until.room) return false;
  if (until.flag !== null && (engine.flags[until.flag.id] !== 0) !== until.flag.value) return false;
  if (until.var !== null) {
    const value = engine.vars[until.var.id]!;
    if (until.var.value !== null) {
      if (value !== until.var.value) return false;
    } else {
      if (until.var.min !== null && value < until.var.min) return false;
      if (until.var.max !== null && value > until.var.max) return false;
    }
  }
  return true;
}

/** A compact readout of a wait-until predicate for failure messages. */
function describeUntil(until: UntilPredicate): string {
  const parts: string[] = [];
  if (until.room !== null) parts.push(`room ${until.room}`);
  if (until.flag !== null) parts.push(`f${until.flag.id}=${until.flag.value}`);
  if (until.var !== null)
    parts.push(
      until.var.value !== null
        ? `v${until.var.id}=${until.var.value}`
        : `v${until.var.id} in ${until.var.min ?? 0}..${until.var.max ?? 255}`,
    );
  return parts.join(", ");
}

class SimulationStop extends Error {
  readonly status: "needs_host" | "needs_authoring" | "needs_input";
  constructor(message: string, status: "needs_host" | "needs_authoring" | "needs_input") {
    super(message);
    this.status = status;
  }
}

interface CapturedCheckpoint {
  frame: AgentFrame;
  stepIndex: number;
  tick: number;
  estimatedGameTimeMs: number | null;
  room: number;
  objects: {
    num: number;
    view: number;
    loop: number;
    cel: number;
    x: number;
    y: number;
    width: number;
    height: number;
    priority: number;
  }[];
}

class Simulation {
  readonly engine: Engine;
  readonly messages: string[] = [];
  readonly missingRooms: number[] = [];
  /** Answers queued by answer steps for the game's get.string prompts. */
  readonly answers: string[] = [];
  readonly steps: Record<string, unknown>[] = [];
  readonly checkpoints: CapturedCheckpoint[] = [];
  cycles = 0;
  readonly cycleBudget: number;
  private readonly started = Date.now();
  estimatedGameTimeMs: number | null = 0;
  line: string | null = null;
  keys: number[] = [];
  /** Keys the simulation pressed for a blocking wait; only genesis boots allow that. */
  keyPresses = 0;
  constructor(
    state: AgentSessionState,
    cycleBudget = DEFAULT_CYCLES,
    instructionBudget = 50000,
    options: { pressKeys?: boolean } = {},
  ) {
    this.cycleBudget = cycleBudget;
    const container = openContainer(state.getFiles(), { kind: state.profile.container });
    const words = container.files.get("WORDS.TOK");
    const dictionary = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
    const randomWord = randomSource(123456789);
    const unsupported = (name: string): never => {
      throw new SimulationStop(
        `Simulation requires host service ${name}; no external action was performed.`,
        "needs_host",
      );
    };
    const host: EngineHost = {
      print: (text) => {
        if (this.messages.length < 32) this.messages.push(text.slice(0, 1000));
      },
      displayAt: () => {},
      statusLine: () => {},
      takeInputLine: () => {
        const line = this.line;
        this.line = null;
        return line;
      },
      takeKeys: () => {
        const keys = this.keys;
        this.keys = [];
        return keys;
      },
      prepareRoom: (room) => {
        if (!container.getResource("logic", room)) {
          this.missingRooms.push(room);
          throw new SimulationStop(
            `Room ${room} has not been authored. The transition was reached, but entering that room was not tested.`,
            "needs_authoring",
          );
        }
        return true;
      },
      randomWord,
      waitKey: () => {
        if (!options.pressKeys) return unsupported("waitKey");
        this.keyPresses += 1;
        return 13;
      },
      promptNumber: () => unsupported("get.num"),
      promptString: () => {
        const answer = this.answers.shift();
        if (answer === undefined)
          throw new SimulationStop(
            "Simulation requires host service get.string; no answer step supplied one and no external action was performed.",
            "needs_host",
          );
        return answer;
      },
      saveGame: () => unsupported("save.game"),
      restoreGame: () => unsupported("restore.game"),
      quit: () => unsupported("quit"),
    };
    this.engine = new Engine(container, host, dictionary, {
      profile: state.profile,
      instructionBudget,
    });
  }
  tick(): void {
    if (++this.cycles > this.cycleBudget)
      throw new Error(
        `Simulation cycle limit (${this.cycleBudget}) exceeded. Increase cycleBudget for a longer sequence.`,
      );
    if (Date.now() - this.started > 5000)
      throw new Error(
        "Simulation reached its five-second execution deadline. Split the scenario into shorter checks.",
      );
    // Each requested tick is a logic cycle. Positive v10 waits that many 50 ms
    // timer increments; zero is host-rate-dependent, so it has no wall-time claim.
    const delay = this.engine.vars[10]!;
    if (delay === 0) this.estimatedGameTimeMs = null;
    else if (this.estimatedGameTimeMs !== null)
      this.estimatedGameTimeMs += delay * TIMER_INCREMENT_MS;
    for (let i = 0; i < 3 * Math.max(1, delay); i++) {
      this.engine.advanceClock(1000 / 60);
      this.engine.soundTick();
    }
    this.engine.tick();
  }
  captureCheckpoint(stepIndex: number, tick: number): void {
    const raw = this.engine.getFrame();
    this.checkpoints.push({
      frame: {
        visual: raw.visual.slice(),
        priority: raw.priority.slice(),
        cycle: this.cycles,
        picRow: this.engine.displayBase,
        text: this.engine.textCells.slice(),
      },
      stepIndex,
      tick,
      estimatedGameTimeMs: this.estimatedGameTimeMs,
      room: this.engine.vars[0]!,
      objects: this.engine
        .readObjects()
        .map(({ num, view, loop, cel, x, y, width, height, priority }) => ({
          num,
          view,
          loop,
          cel,
          x,
          y,
          width,
          height,
          priority,
        })),
    });
  }
  result(
    success: boolean,
    status: string,
    error?: string,
    extra: Record<string, unknown> = {},
  ): AgentToolResult {
    const engine = this.engine;
    const state = engine.readState();
    const raw = engine.getFrame();
    const frame = {
      ...raw,
      cycle: this.cycles,
      picRow: engine.displayBase,
      text: engine.textCells.slice(),
    };
    const checkpointSheet = this.checkpoints.length
      ? framesToContactSheet(
          this.checkpoints.map(({ frame: checkpoint }) => checkpoint),
          "visual",
        )
      : null;
    const checkpoints = this.checkpoints.map((checkpoint, tile) => ({
      tile,
      row: Math.floor(tile / checkpointSheet!.grid.cols),
      col: tile % checkpointSheet!.grid.cols,
      stepIndex: checkpoint.stepIndex,
      tick: checkpoint.tick,
      cycle: checkpoint.frame.cycle,
      estimatedGameTimeMs: checkpoint.estimatedGameTimeMs,
      room: checkpoint.room,
      objects: checkpoint.objects,
    }));
    const images = [
      {
        png: frameToPng(frame, "visual"),
        caption: `Isolated simulation, room ${state.room}, cycle ${this.cycles}. Picture and sprites at authentic geometry; game text is transcribed separately.`,
      },
    ];
    if (checkpointSheet)
      images.push({
        png: checkpointSheet.png,
        caption: `${this.checkpoints.length} requested intermediate composed frame${this.checkpoints.length === 1 ? "" : "s"} in row-major order (${checkpointSheet.grid.cols} columns by ${checkpointSheet.grid.rows} rows). Tile timing and object state are listed in details.checkpoints.`,
      });
    return {
      success,
      ...(error
        ? { error }
        : {
            message:
              status === "passed"
                ? extra["genesisValidated"]
                  ? "Boot reached a shown, interactive scene with a valid ego spawn."
                  : "Executed the supplied actions; all supplied outcome assertions passed."
                : "Spawn footprint checked. Add steps and expect to verify an interaction or exit.",
          }),
      details: {
        simulation: status,
        cycles: this.cycles,
        estimatedGameTimeMs: this.estimatedGameTimeMs,
        timing:
          "Ticks are logic cycles. Timing begins at boot; playtest_room restarts the estimate at the action sequence after room setup. Positive v10 uses 50 ms increments; v10=0 is host-rate-dependent and has no elapsed-time claim.",
        missingRooms: this.missingRooms,
        steps: this.steps,
        state: {
          profile: state.profile,
          room: state.room,
          previousRoom: state.previousRoom,
          egoX: state.egoX,
          egoY: state.egoY,
          modalKind: state.modalKind,
          inventory: state.inventory,
          inputEnabled: state.inputEnabled,
          pictureShown: state.pictureShown,
          activeFlags: state.flags.flatMap((value, id) => (value ? [id] : [])),
          nonzeroVariables: state.vars.flatMap((value, id) => (value ? [{ id, value }] : [])),
          lastInputLine: state.lastInputLine,
          parsedWords: state.parsedWordTexts,
        },
        objects: engine.readObjects(),
        messages: this.messages,
        text: textRows(frame).filter((row) => row.trim()),
        checkpoints,
        ...extra,
      },
      images,
    };
  }
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

/** Validate the actor's entire AGI baseline, dimensions, horizon and object overlaps. */
function footprint(engine: Engine, x: number, y: number): string[] {
  const ego = engine.screenObjects[0]!;
  const issues: string[] = [];
  if (!ego.active || ego.width < 1 || ego.height < 1)
    return ["Room initialization did not draw an ego with a valid cel."];
  if (x < 0 || x + ego.width > 160 || y < ego.height - 1 || y >= 168)
    issues.push(`Ego ${ego.width}x${ego.height} at (${x},${y}) extends outside the picture.`);
  if (ego.observeHorizon && y <= engine.horizon)
    issues.push(`Baseline y=${y} must be below horizon ${engine.horizon}.`);
  if (!(ego.fixedPriority && ego.priority === 15)) {
    for (let dx = 0; dx < ego.width; dx++) {
      const priority = engine.surface.priority[y * 160 + x + dx];
      if (priority === 0 || (priority === 1 && ego.observeBlocks)) {
        issues.push(`Ego baseline intersects barrier priority ${priority} at (${x + dx},${y}).`);
        break;
      }
    }
    const last = engine.surface.priority[y * 160 + x + ego.width - 1];
    if (ego.waterGate === "on" && last !== 3)
      issues.push("Ego requires water, but the final baseline cell is not water.");
    if (ego.waterGate === "off" && last === 3)
      issues.push("Ego requires land, but the final baseline cell is water.");
  }
  if (ego.observeObjects) {
    for (let i = 1; i < engine.screenObjects.length; i++) {
      const other = engine.screenObjects[i]!;
      if (
        other.active &&
        other.update &&
        other.observeObjects &&
        y === other.y &&
        !(x + ego.width < other.x || x > other.x + other.width)
      )
        issues.push(`Ego baseline overlaps object ${i} at (${other.x},${other.y}).`);
    }
  }
  return issues;
}

interface ControlSpan {
  value: number;
  x0: number;
  x1: number;
}

/** Exact scene controls under a proposed actor baseline, grouped into horizontal spans. */
function baselineProbe(engine: Engine, x: number, y: number) {
  const ego = engine.screenObjects[0]!;
  const values = new Set<number>();
  const blockingControls: ControlSpan[] = [];
  for (let offset = 0; offset < ego.width; offset++) {
    const at = x + offset;
    if (at < 0 || at >= 160 || y < 0 || y >= 168) continue;
    const value = engine.surface.priority[y * 160 + at]! & 0x0f;
    values.add(value);
    const blocking = value === 0 || (value === 1 && ego.observeBlocks);
    const previous = blockingControls[blockingControls.length - 1];
    if (blocking && previous?.value === value && previous.x1 === at - 1) previous.x1 = at;
    else if (blocking) blockingControls.push({ value, x0: at, x1: at });
  }
  return {
    x0: x,
    x1: x + ego.width - 1,
    y,
    values: [...values].sort((a, b) => a - b),
    blockingControls,
  };
}

/** Current rendered depth over ego's logical bounding box; flag f1 is the exact engine verdict. */
function occlusionProbe(engine: Engine) {
  const ego = engine.screenObjects[0]!;
  let actorBoxCells = 0;
  let sceneCellsAboveActorPriority = 0;
  const top = ego.y - ego.height + 1;
  for (let y = Math.max(0, top); y <= Math.min(167, ego.y); y++) {
    for (let x = Math.max(0, ego.x); x <= Math.min(159, ego.x + ego.width - 1); x++) {
      actorBoxCells++;
      let comparison = engine.surface.priority[y * 160 + x]! & 0x0f;
      // drawCel resolves controls 0..2 to the first ordinary priority below.
      if (comparison <= 2) {
        comparison = 0;
        for (let belowY = y + 1; belowY < 168; belowY++) {
          const below = engine.surface.priority[belowY * 160 + x]! & 0x0f;
          if (below > 2) {
            comparison = below;
            break;
          }
        }
      }
      if (comparison > ego.priority) sceneCellsAboveActorPriority++;
    }
  }
  return {
    actorPriority: ego.priority,
    actorBoxCells,
    sceneCellsAboveActorPriority,
    completelyOccluded: engine.flags[1] !== 0,
  };
}

/** Bootstrap normally, then explicitly enter the requested room in the detached game. */
export function playtestRoom(
  state: AgentSessionState,
  args: Record<string, unknown>,
  options: { setupImage?: Uint8Array } = {},
): AgentToolResult {
  let simulation: Simulation | undefined;
  try {
    const room = integer(args["room"], "room", 1, 255);
    const setupImage = options.setupImage;
    const steps = args["steps"] ?? [];
    if (!Array.isArray(steps) || steps.length > 256)
      throw new Error("steps must contain at most 256 actions.");
    // walkTo and wait-until poll toward a goal, so their default budget is
    // generous; every other step acts once per default tick.
    const stepTicks = (action: Record<string, unknown>, index: number): number =>
      action["ticks"] == null
        ? action["action"] === "walkTo" || (action["action"] === "wait" && action["until"] != null)
          ? 600
          : 1
        : integer(action["ticks"], `steps[${index}].ticks`, 1, 60000);
    const captureTicksByStep: number[][] = [];
    let totalCaptureTicks = 0;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (!step || typeof step !== "object" || Array.isArray(step))
        throw new Error(`steps[${index}] must be an action object.`);
      const action = step as Record<string, unknown>;
      const ticks = stepTicks(action, index);
      const requested = action["captureTicks"];
      if (requested == null) {
        captureTicksByStep.push([]);
        continue;
      }
      if (!Array.isArray(requested))
        throw new Error(`steps[${index}].captureTicks must be an array or null.`);
      if (requested.length > 9)
        throw new Error(`steps[${index}].captureTicks must contain at most 9 ticks.`);
      const validated: number[] = [];
      for (let captureIndex = 0; captureIndex < requested.length; captureIndex++) {
        const tick = integer(
          requested[captureIndex],
          `steps[${index}].captureTicks[${captureIndex}]`,
          1,
          ticks,
        );
        if (validated.length && tick <= validated[validated.length - 1]!)
          throw new Error(`steps[${index}].captureTicks must be strictly increasing.`);
        validated.push(tick);
      }
      totalCaptureTicks += validated.length;
      if (totalCaptureTicks > 9)
        throw new Error("captureTicks may request at most 9 checkpoints across the scenario.");
      captureTicksByStep.push(validated);
    }
    simulation = new Simulation(
      state,
      args["cycleBudget"] == null
        ? DEFAULT_CYCLES
        : integer(args["cycleBudget"], "cycleBudget", 1, 60000),
      args["instructionBudget"] == null
        ? 50000
        : integer(args["instructionBudget"], "instructionBudget", 1, 1000000),
    );
    const engine = simulation.engine;
    let enteredDirectly = false;
    if (setupImage) {
      // A recorded test replays from the interpreter state at record-start:
      // the engine under test is built from the CURRENT staged resources and
      // the image only supplies interpreter state — the interpreter's own
      // save/restore contract (restoreImage validates the image against a
      // disposable engine of the same container before applying it). No boot
      // cycle, no room re-entry and no footprint gate: the restored position
      // is historical, not an authored spawn.
      engine.restoreImage(setupImage);
    } else {
      simulation.tick();
      if (engine.vars[0] !== room) {
        // This is explicit room setup, not evidence that a player can reach it.
        for (let i = 0; engine.modalKind && i < 8; i++) engine.ackPrint();
        if (engine.modalKind)
          throw new Error("Room setup is blocked by more than eight stacked modals.");
        engine.reenterRoom(room);
        simulation.tick();
        enteredDirectly = true;
      }
      if (engine.vars[0] !== room)
        throw new Error(
          `Requested room ${room} immediately transitions to room ${engine.vars[0]}.`,
        );
    }
    const ego = engine.screenObjects[0]!;
    const x = args["spawnX"] == null ? ego.x : integer(args["spawnX"], "spawnX", 0, 159);
    const y = args["spawnY"] == null ? ego.y : integer(args["spawnY"], "spawnY", 0, 167);
    const problems = setupImage ? [] : footprint(engine, x, y);
    const spawn = {
      room,
      spawnX: x,
      spawnY: y,
      spawnWidth: ego.width,
      spawnHeight: ego.height,
      spawnClear: problems.length === 0,
      enteredDirectly,
      restored: Boolean(setupImage),
    };
    if (problems.length)
      return simulation.result(false, "spawn_blocked", problems.join(" "), spawn);
    if (args["spawnX"] != null || args["spawnY"] != null) {
      ego.x = ego.prevX = x;
      ego.y = ego.prevY = y;
    }
    if (steps.length) simulation.estimatedGameTimeMs = engine.vars[10] === 0 ? null : 0;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] as Record<string, unknown>;
      if (!step || typeof step !== "object" || Array.isArray(step))
        throw new Error(`steps[${index}] must be an action object.`);
      const ticks = stepTicks(step, index);
      const captureTicks = captureTicksByStep[index]!;
      const action = step["action"];
      let moveDirection: number | null = null;
      let walkTarget: { x: number; y: number } | null = null;
      let until: UntilPredicate | null = null;
      if (action === "enter") simulation.keys.push(13);
      else if (action === "key")
        simulation.keys.push(integer(step["key"], `steps[${index}].key`, 0, 65535));
      else if (action === "command") {
        if (engine.modalKind)
          throw new Error(
            `steps[${index}]: acknowledge the ${engine.modalKind} modal with an enter action before sending a command.`,
          );
        if (
          typeof step["command"] !== "string" ||
          !step["command"].trim() ||
          step["command"].length > 80
        )
          throw new Error(`steps[${index}].command must be nonempty and at most 80 characters.`);
        simulation.line = step["command"];
      } else if (action === "move") {
        if (engine.modalKind)
          throw new Error(
            `steps[${index}]: acknowledge the ${engine.modalKind} modal before moving.`,
          );
        const direction =
          typeof step["direction"] === "string" ? DIRECTIONS[step["direction"]] : undefined;
        if (!direction)
          throw new Error(
            `steps[${index}].direction must name one of the eight compass directions.`,
          );
        // Same host movement input as the app's direction messages.
        moveDirection = direction;
        engine.vars[6] = direction;
      } else if (action === "direction") {
        if (engine.modalKind)
          throw new Error(
            `steps[${index}]: acknowledge the ${engine.modalKind} modal before moving.`,
          );
        // The numeric form of move: 0..8, one heading decision per cycle.
        moveDirection = integer(step["direction"], `steps[${index}].direction`, 0, 8);
        engine.vars[6] = moveDirection;
      } else if (action === "walkTo") {
        if (engine.modalKind)
          throw new Error(
            `steps[${index}]: acknowledge the ${engine.modalKind} modal before moving.`,
          );
        walkTarget = {
          x: integer(step["x"], `steps[${index}].x`, 0, 159),
          y: integer(step["y"], `steps[${index}].y`, 0, 167),
        };
      } else if (action === "answer") {
        if (
          typeof step["answer"] !== "string" ||
          !step["answer"].trim() ||
          step["answer"].length > 80
        )
          throw new Error(`steps[${index}].answer must be nonempty and at most 80 characters.`);
        simulation.answers.push(step["answer"]);
      } else if (action === "wait") {
        if (step["until"] != null)
          until = validateUntilPredicate(step["until"], `steps[${index}].until`);
      } else
        throw new Error(
          `steps[${index}].action must be command, move, enter, wait, key, direction, walkTo or answer.`,
        );
      const observed: Record<string, unknown> = {
        index,
        action,
        ticks,
        roomBefore: engine.vars[0],
        xBefore: engine.screenObjects[0]!.x,
        yBefore: engine.screenObjects[0]!.y,
      };
      if (action === "command") observed["command"] = step["command"];
      if (action === "move" || action === "direction") observed["direction"] = step["direction"];
      if (action === "key") observed["key"] = step["key"];
      if (walkTarget !== null) observed["walkTo"] = walkTarget;
      if (action === "answer") observed["answer"] = step["answer"];
      if (until !== null) observed["until"] = until;
      simulation.steps.push(observed);
      const active = engine.readObjects();
      const observations = active.slice(0, 8).map((object) => ({
        num: object.num,
        view: object.view,
        cycleTime: object.cycleTime,
        cycleDelay: engine.vars[10],
        millisecondsPerCel:
          engine.vars[10]! > 0
            ? TIMER_INCREMENT_MS * engine.vars[10]! * Math.max(1, object.cycleTime)
            : null,
        celBefore: object.cel,
        celAfter: object.cel,
        celChanges: 0,
        xBefore: object.x,
        yBefore: object.y,
        xAfter: object.x,
        yAfter: object.y,
      }));
      observed["objects"] = observations;
      observed["observedObjects"] = observations.length;
      observed["totalObjects"] = active.length;
      observed["completedTicks"] = 0;
      const estimatedStart = simulation.estimatedGameTimeMs;
      let positionChanges = 0;
      let previousEgoX = engine.screenObjects[0]!.x;
      let previousEgoY = engine.screenObjects[0]!.y;
      let reachedTarget = false;
      for (let cycle = 0; cycle < ticks; cycle++) {
        if (action === "wait") {
          if (until !== null && untilMet(engine, until)) break;
          if (engine.modalKind)
            throw new SimulationStop(
              `steps[${index}]: the ${engine.modalKind} modal pauses animation. Add an enter action before waiting to observe animation. Completed ${cycle} of ${ticks} requested cycles.`,
              "needs_input",
            );
        }
        if (walkTarget !== null) {
          const walker = engine.screenObjects[0]!;
          const dx = Math.sign(walkTarget.x - walker.x);
          const dy = Math.sign(walkTarget.y - walker.y);
          if (dx === 0 && dy === 0) {
            reachedTarget = true;
            break;
          }
          engine.vars[6] = directionForDelta(dx, dy);
        }
        simulation.tick();
        observed["completedTicks"] = cycle + 1;
        const currentEgo = engine.screenObjects[0]!;
        if (currentEgo.x !== previousEgoX || currentEgo.y !== previousEgoY) positionChanges++;
        previousEgoX = currentEgo.x;
        previousEgoY = currentEgo.y;
        for (const observation of observations) {
          const object = engine.screenObjects[observation.num]!;
          if (object.cel !== observation.celAfter) observation.celChanges++;
          observation.celAfter = object.cel;
          observation.xAfter = object.x;
          observation.yAfter = object.y;
        }
        if (captureTicks.includes(cycle + 1)) simulation.captureCheckpoint(index, cycle + 1);
      }
      if (walkTarget !== null) {
        engine.vars[6] = 0;
        engine.screenObjects[0]!.direction = 0;
        observed["walkTo"] = { ...walkTarget, reached: reachedTarget };
        if (!reachedTarget) {
          const walker = engine.screenObjects[0]!;
          throw new Error(
            `steps[${index}]: walkTo did not reach (${walkTarget.x},${walkTarget.y}) within ${ticks} cycles; ego stopped at (${walker.x},${walker.y}).`,
          );
        }
      }
      if (action === "wait" && until !== null && !untilMet(engine, until))
        throw new Error(
          `steps[${index}]: wait did not satisfy ${describeUntil(until)} within ${ticks} cycles.`,
        );
      Object.assign(observed, {
        roomAfter: engine.vars[0],
        xAfter: engine.screenObjects[0]!.x,
        yAfter: engine.screenObjects[0]!.y,
        modal: engine.modalKind,
        egoCompletelyOccluded: engine.flags[1] !== 0,
        estimatedDurationMs:
          estimatedStart === null || simulation.estimatedGameTimeMs === null
            ? null
            : simulation.estimatedGameTimeMs - estimatedStart,
        occlusion: occlusionProbe(engine),
      });
      if (moveDirection !== null) {
        const xBefore = observed["xBefore"] as number;
        const yBefore = observed["yBefore"] as number;
        const xAfter = engine.screenObjects[0]!.x;
        const yAfter = engine.screenObjects[0]!.y;
        const roomChanged = engine.vars[0] !== observed["roomBefore"];
        const finalDirection = engine.screenObjects[0]!.direction;
        const finalDelta = DIRECTION_DELTAS[finalDirection];
        const probe =
          !roomChanged && finalDelta
            ? baselineProbe(
                engine,
                xAfter + finalDelta[0] * engine.screenObjects[0]!.stepSize,
                yAfter + finalDelta[1] * engine.screenObjects[0]!.stepSize,
              )
            : null;
        const firstBlock = probe?.blockingControls[0];
        const distance = Math.max(Math.abs(xAfter - xBefore), Math.abs(yAfter - yBefore));
        const issue = firstBlock
          ? `${positionChanges === 0 ? `No movement in ${ticks} cycles` : `Moved ${distance} pixel${distance === 1 ? "" : "s"}, then stopped`}; the next baseline intersects ${firstBlock.value === 0 ? "barrier" : "conditional barrier"} priority ${firstBlock.value} at x${firstBlock.x0}${firstBlock.x1 === firstBlock.x0 ? "" : `-${firstBlock.x1}`}.`
          : null;
        observed["movement"] = {
          moved: positionChanges > 0 || roomChanged,
          deltaX: xAfter - xBefore,
          deltaY: yAfter - yBefore,
          positionChanges,
          finalDirection,
          blockedAtEnd: firstBlock !== undefined,
          attemptedBaseline: probe
            ? { x0: probe.x0, x1: probe.x1, y: probe.y, values: probe.values }
            : null,
          blockingControls: probe?.blockingControls ?? [],
          issue,
        };
      }
      if (moveDirection !== null) {
        engine.vars[6] = 0;
        engine.screenObjects[0]!.direction = 0;
      }
      if (
        action === "command" &&
        engine.lastInputLine !== step["command"] &&
        engine.vars[0] === room
      )
        throw new Error(`steps[${index}]: the game did not accept the supplied command.`);
    }
    const expected = args["expect"];
    const failures: string[] = [];
    const nextSteps: string[] = [];
    if (expected != null) {
      if (typeof expected !== "object" || Array.isArray(expected))
        throw new Error("expect must be an assertion object.");
      const assertions = expected as Record<string, unknown>;
      if (assertions["room"] != null) {
        const wanted = integer(assertions["room"], "expect.room", 0, 255);
        if (engine.vars[0] !== wanted) {
          failures.push(`Expected room ${wanted}; observed room ${engine.vars[0]}.`);
          nextSteps.push(
            "Use read_room_context to inspect the exit logic and priority/control plane. For edge exits, check ego boundary variable v2, horizon, footprint and blocking pixels; for portals, check the position condition that should call new.room. Replay the actual movement after repair.",
          );
        }
      }
      if (assertions["carriedItems"] != null) {
        if (!Array.isArray(assertions["carriedItems"]) || assertions["carriedItems"].length > 256)
          throw new Error("expect.carriedItems must be an array of at most 256 item IDs.");
        const inventory = engine.readState().inventory;
        for (const value of assertions["carriedItems"]) {
          const id = integer(value, "expect.carriedItems entry", 0, 255);
          const item = inventory.find((item) => item.num === id);
          if (item?.room !== 255) {
            nextSteps.push(
              `Inspect item ${id} with read_room_context and its interaction logic: get places it in carried inventory (room 255); has tests possession. Check said vocabulary, item location and puzzle preconditions before changing the outcome.`,
            );
            failures.push(
              `Expected item ${id} carried; observed ${item ? `room ${item.room}` : "missing item"}.`,
            );
          }
        }
      }
      if (assertions["flags"] != null) {
        if (!Array.isArray(assertions["flags"]) || assertions["flags"].length > 256)
          throw new Error("expect.flags must be an array of at most 256 assertions.");
        for (const value of assertions["flags"]) {
          if (!value || typeof value !== "object")
            throw new Error("Each flag assertion needs id and boolean value.");
          const id = integer(value.id, "expect.flags id", 0, 255);
          if (typeof value.value !== "boolean")
            throw new Error("expect.flags value must be boolean.");
          const actual = engine.flags[id] !== 0;
          if (actual !== value.value) {
            failures.push(`Expected flag ${id}=${value.value}; observed ${actual}.`);
            nextSteps.push(
              `Inspect the set/reset paths for f${id}, their input and inventory preconditions, and whether room-entry code resets it each cycle. Use inspect_world_bible to check the binding's purpose and read_command_reference for condition semantics. Replay the triggering action instead of forcing the expected flag.`,
            );
          }
        }
      }
    }
    if (expected != null) {
      const assertions = expected as Record<string, unknown>;
      if (assertions["vars"] != null) {
        if (!Array.isArray(assertions["vars"]) || assertions["vars"].length > 256)
          throw new Error("expect.vars must be an array of at most 256 assertions.");
        for (const value of assertions["vars"]) {
          const variable = validateVarAssertion(value, "expect.vars entry");
          const observed = engine.vars[variable.id]!;
          const holds =
            variable.value !== null
              ? observed === variable.value
              : (variable.min === null || observed >= variable.min) &&
                (variable.max === null || observed <= variable.max);
          if (!holds) {
            failures.push(
              variable.value !== null
                ? `Expected v${variable.id}=${variable.value}; observed ${observed}.`
                : `Expected v${variable.id} in ${variable.min ?? 0}..${variable.max ?? 255}; observed ${observed}.`,
            );
            nextSteps.push(
              `Inspect every assignment to v${variable.id} on the path the steps take; a counter that is reset on room entry or decremented each cycle reads differently from the value the logic stored last.`,
            );
          }
        }
      }
      if (assertions["printed"] != null) {
        if (typeof assertions["printed"] !== "string" || assertions["printed"].length > 200)
          throw new Error("expect.printed must be text of at most 200 characters.");
        const wanted = assertions["printed"];
        if (!simulation.messages.some((message) => message.includes(wanted))) {
          failures.push(
            `Expected a printed message containing ${JSON.stringify(wanted)}; none did.`,
          );
          nextSteps.push(
            "Compare the printed messages in details.messages with the said() handler or event that should print this text; check the words are registered and the handler's conditions hold on this path.",
          );
        }
      }
      if (assertions["text"] != null) {
        if (typeof assertions["text"] !== "string" || assertions["text"].length > 200)
          throw new Error("expect.text must be text of at most 200 characters.");
        const wanted = assertions["text"];
        const rows = Array.from({ length: 25 }, (_, row) => engine.textRow(row));
        if (!rows.some((row) => row.includes(wanted))) {
          failures.push(`Expected visible text containing ${JSON.stringify(wanted)}; none shown.`);
          nextSteps.push(
            "Compare details.text with the display call that should show it; text shows only while nothing repaints its rows, and an open window pauses the room.",
          );
        }
      }
      if (assertions["score"] != null) {
        const wanted = integer(assertions["score"], "expect.score", 0, 255);
        if (engine.vars[3] !== wanted) {
          failures.push(`Expected score ${wanted}; observed ${engine.vars[3]}.`);
          nextSteps.push(
            "Inspect every addn/subn to v3 on the path the steps take; the score changes in the logic that awards it, not at the assertion.",
          );
        }
      }
      if (assertions["object"] != null) {
        const spec = validateObjectAssertion(assertions["object"], "expect.object");
        const target = engine.screenObjects[spec.num]!;
        const misses: string[] = [];
        if (spec.active !== null && target.active !== spec.active)
          misses.push(`active=${spec.active}; observed ${target.active}`);
        if (spec.view !== null && target.view !== spec.view)
          misses.push(`view ${spec.view}; observed ${target.view}`);
        if (spec.x0 !== null && target.x < spec.x0)
          misses.push(`x >= ${spec.x0}; observed ${target.x}`);
        if (spec.x1 !== null && target.x > spec.x1)
          misses.push(`x <= ${spec.x1}; observed ${target.x}`);
        if (spec.y0 !== null && target.y < spec.y0)
          misses.push(`y >= ${spec.y0}; observed ${target.y}`);
        if (spec.y1 !== null && target.y > spec.y1)
          misses.push(`y <= ${spec.y1}; observed ${target.y}`);
        if (misses.length) {
          failures.push(`Expected object ${spec.num} ${misses.join(", ")}.`);
          nextSteps.push(
            `Inspect object ${spec.num} with read_objects and the logic that draws, positions or moves it; check the view is loaded and the motion reaches the asserted box on this path.`,
          );
        }
      }
      if (assertions["reachable"] != null) {
        const target = assertions["reachable"] as Record<string, unknown>;
        const reachX = integer(target["x"], "expect.reachable.x", 0, 159);
        const reachY = integer(target["y"], "expect.reachable.y", 0, 167);
        let reached = false;
        for (let n = 0; n < 600 && !reached && simulation.cycles < simulation.cycleBudget; n++) {
          const walker = engine.screenObjects[0]!;
          const dx = Math.sign(reachX - walker.x);
          const dy = Math.sign(reachY - walker.y);
          if (dx === 0 && dy === 0) {
            reached = true;
            break;
          }
          engine.vars[6] = directionForDelta(dx, dy);
          simulation.tick();
        }
        engine.vars[6] = 0;
        engine.screenObjects[0]!.direction = 0;
        if (!reached) {
          const walker = engine.screenObjects[0]!;
          failures.push(
            `Expected (${reachX},${reachY}) reachable on foot; ego stopped at (${walker.x},${walker.y}).`,
          );
          nextSteps.push(
            "Walk the route in the composed frame: read the priority and control lines between ego and the target with read_room_context and check the walkTo observation for where progress stopped.",
          );
        }
      }
    }
    if (failures.length)
      return simulation.result(false, "failed", failures.join(" "), { ...spawn, nextSteps });
    return simulation.result(true, steps.length ? "passed" : "not_requested", undefined, spawn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SimulationStop ? error.status : "failed";
    return simulation
      ? simulation.result(false, status, message)
      : { success: false, error: message };
  }
}

function textVisible(engine: Engine): boolean {
  return engine.textCells.some((byte, index) => index % 2 === 0 && byte > 32);
}

/**
 * Execute the actual boot driver; resource names alone cannot establish a playable start.
 *
 * Only real defects fail: a missing resource, a black screen, or an ego that spawns
 * in unwalkable space. Messages and key waits are dismissed the way a player would.
 * An opening that has not enabled the parser or animated ego within the budget still
 * passes, with warnings in the result, so title cards, intros and ego-less scenes are
 * reported to the model rather than blocked.
 */
export function validateGenesis(state: AgentSessionState): AgentToolResult {
  let simulation: Simulation | undefined;
  try {
    const files = state.getFiles();
    if (!state.container.getResource("logic", 0) || !files.has("WORDS.TOK"))
      throw new Error(
        "Cannot finish genesis: missing required initial resources: boot logic 0 or WORDS.TOK.",
      );
    simulation = new Simulation(state, DEFAULT_CYCLES, 50000, { pressKeys: true });
    const engine = simulation.engine;
    const warnings: string[] = [];
    let dismissed = 0;
    let budget = GENESIS_CYCLES;
    let seen = false;
    for (let i = 0; i < budget; i++) {
      simulation.tick();
      const current = engine.readState();
      seen ||= current.pictureShown || textVisible(engine);
      if (current.pictureShown && current.inputEnabled) {
        if (engine.screenObjects[0]!.active) {
          const issues = footprint(engine, current.egoX, current.egoY);
          if (issues.length)
            throw new Error(
              `Booted room ${current.room} has an invalid ego spawn: ${issues.join(" ")}`,
            );
        } else {
          warnings.push(
            `Room ${current.room} accepts input without an active ego (object 0), so players can type but not walk. That suits a text or cutscene opening; otherwise animate.obj, position and draw object 0 before accept.input().`,
          );
        }
        return simulation.result(true, "passed", undefined, {
          genesisValidated: true,
          acknowledgements: dismissed + simulation.keyPresses,
          ...(warnings.length ? { warnings } : {}),
        });
      }
      if (engine.modalKind) {
        engine.ackPrint();
        dismissed += 1;
        budget += GENESIS_CYCLES_PER_ACK;
      }
      if (dismissed + simulation.keyPresses > GENESIS_MAX_ACKS)
        throw new Error(
          `Boot did not reach an interactive scene after ${GENESIS_MAX_ACKS} dismissed messages or key presses.`,
        );
    }
    if (!seen)
      throw new Error(
        `Boot showed nothing within ${budget} cycles: no picture and no text. Draw the first room (load.pic, draw.pic, show.pic) or display text before waiting.`,
      );
    const final = engine.readState();
    warnings.push(
      final.pictureShown
        ? `The parser was not enabled within ${budget} cycles: the opening shows a picture but never calls accept.input(). Fine for a title card or intro that advances on a key; otherwise players cannot act.`
        : final.inputEnabled
          ? `No picture was shown within ${budget} cycles although the parser is on. Fine for a text adventure; otherwise draw the first room with load.pic, draw.pic and show.pic.`
          : `Only text was shown within ${budget} cycles: no picture, and the parser is off. Fine for a text intro; otherwise draw the first room and call accept.input().`,
    );
    return simulation.result(true, "passed", undefined, {
      genesisValidated: true,
      acknowledgements: dismissed + simulation.keyPresses,
      warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SimulationStop ? error.status : "failed";
    return simulation
      ? simulation.result(false, status, message)
      : { success: false, error: message };
  }
}
