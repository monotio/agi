/** Bounded, detached execution of authored resources using the real interpreter. */
import { openContainer } from "../container/container.ts";
import { parseWordsTok } from "../logic/words.ts";
import { TIMER_INCREMENT_MS } from "../runtime/cycleClock.ts";
import { Engine, type EngineHost } from "../runtime/engine.ts";
import { frameToPng, textRows } from "./frames.ts";
import type { AgentSessionState, AgentToolResult } from "./tools.ts";

const DEFAULT_CYCLES = 600;
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

class SimulationStop extends Error {
  readonly status: "needs_host" | "needs_authoring" | "needs_input";
  constructor(message: string, status: "needs_host" | "needs_authoring" | "needs_input") {
    super(message);
    this.status = status;
  }
}

class Simulation {
  readonly engine: Engine;
  readonly messages: string[] = [];
  readonly missingRooms: number[] = [];
  readonly steps: Record<string, unknown>[] = [];
  cycles = 0;
  readonly cycleBudget: number;
  private readonly started = Date.now();
  estimatedGameTimeMs: number | null = 0;
  line: string | null = null;
  keys: number[] = [];
  constructor(state: AgentSessionState, cycleBudget = DEFAULT_CYCLES, instructionBudget = 50000) {
    this.cycleBudget = cycleBudget;
    const container = openContainer(state.getFiles(), { kind: state.profile.container });
    const words = container.files.get("WORDS.TOK");
    const dictionary = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
    let random = 123456789;
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
      randomWord: () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random >>> 16;
      },
      waitKey: () => unsupported("waitKey"),
      promptNumber: () => unsupported("get.num"),
      promptString: () => unsupported("get.string"),
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
          "Ticks are logic cycles. Positive v10 uses 50 ms increments; v10=0 is host-rate-dependent and has no elapsed-time claim.",
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
        ...extra,
      },
      images: [
        {
          png: frameToPng(frame, "visual"),
          caption: `Isolated simulation, room ${state.room}, cycle ${this.cycles}. Picture and sprites at authentic geometry; game text is transcribed separately.`,
        },
      ],
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

/** Bootstrap normally, then explicitly enter the requested room in the detached game. */
export function playtestRoom(
  state: AgentSessionState,
  args: Record<string, unknown>,
): AgentToolResult {
  let simulation: Simulation | undefined;
  try {
    const room = integer(args["room"], "room", 1, 255);
    const steps = args["steps"] ?? [];
    if (!Array.isArray(steps) || steps.length > 256)
      throw new Error("steps must contain at most 256 actions.");
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
    simulation.tick();
    let enteredDirectly = false;
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
      throw new Error(`Requested room ${room} immediately transitions to room ${engine.vars[0]}.`);
    const ego = engine.screenObjects[0]!;
    const x = args["spawnX"] == null ? ego.x : integer(args["spawnX"], "spawnX", 0, 159);
    const y = args["spawnY"] == null ? ego.y : integer(args["spawnY"], "spawnY", 0, 167);
    const problems = footprint(engine, x, y);
    const spawn = {
      room,
      spawnX: x,
      spawnY: y,
      spawnWidth: ego.width,
      spawnHeight: ego.height,
      spawnClear: problems.length === 0,
      enteredDirectly,
    };
    if (problems.length)
      return simulation.result(false, "spawn_blocked", problems.join(" "), spawn);
    if (args["spawnX"] != null || args["spawnY"] != null) {
      ego.x = ego.prevX = x;
      ego.y = ego.prevY = y;
    }
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] as Record<string, unknown>;
      if (!step || typeof step !== "object" || Array.isArray(step))
        throw new Error(`steps[${index}] must be an action object.`);
      const ticks =
        step["ticks"] == null ? 1 : integer(step["ticks"], `steps[${index}].ticks`, 1, 60000);
      const action = step["action"];
      if (action === "enter") simulation.keys.push(13);
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
        engine.vars[6] = direction;
      } else if (action !== "wait")
        throw new Error(`steps[${index}].action must be command, move, enter or wait.`);
      const observed: Record<string, unknown> = {
        index,
        action,
        ticks,
        roomBefore: engine.vars[0],
        xBefore: engine.screenObjects[0]!.x,
        yBefore: engine.screenObjects[0]!.y,
      };
      if (action === "command") observed["command"] = step["command"];
      if (action === "move") observed["direction"] = step["direction"];
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
      for (let cycle = 0; cycle < ticks; cycle++) {
        if (action === "wait" && engine.modalKind)
          throw new SimulationStop(
            `steps[${index}]: the ${engine.modalKind} modal pauses animation. Add an enter action before waiting to observe animation. Completed ${cycle} of ${ticks} requested cycles.`,
            "needs_input",
          );
        simulation.tick();
        observed["completedTicks"] = cycle + 1;
        for (const observation of observations) {
          const object = engine.screenObjects[observation.num]!;
          if (object.cel !== observation.celAfter) observation.celChanges++;
          observation.celAfter = object.cel;
          observation.xAfter = object.x;
          observation.yAfter = object.y;
        }
      }
      Object.assign(observed, {
        roomAfter: engine.vars[0],
        xAfter: engine.screenObjects[0]!.x,
        yAfter: engine.screenObjects[0]!.y,
        modal: engine.modalKind,
      });
      if (action === "move") {
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

/** Execute the actual boot driver; resource names alone cannot establish a playable start. */
export function validateGenesis(state: AgentSessionState): AgentToolResult {
  let simulation: Simulation | undefined;
  try {
    const files = state.getFiles();
    if (!state.container.getResource("logic", 0) || !files.has("WORDS.TOK"))
      throw new Error(
        "Cannot finish genesis: missing required initial resources: boot logic 0 or WORDS.TOK.",
      );
    simulation = new Simulation(state);
    const engine = simulation.engine;
    let acknowledgements = 0;
    for (let i = 0; i < 120; i++) {
      simulation.tick();
      const current = engine.readState();
      if (current.pictureShown && current.inputEnabled && engine.screenObjects[0]!.active) {
        const issues = footprint(engine, current.egoX, current.egoY);
        if (issues.length)
          throw new Error(
            `Booted room ${current.room} has an invalid ego spawn: ${issues.join(" ")}`,
          );
        return simulation.result(true, "passed", undefined, {
          genesisValidated: true,
          acknowledgements,
        });
      }
      if (engine.modalKind) {
        if (++acknowledgements > 8)
          throw new Error(
            "Boot did not reach an interactive scene after eight modal acknowledgements.",
          );
        engine.ackPrint();
      }
    }
    throw new Error(
      "Boot did not reach a shown picture, active ego and enabled parser within 120 cycles.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SimulationStop ? error.status : "failed";
    return simulation
      ? simulation.result(false, status, message)
      : { success: false, error: message };
  }
}
