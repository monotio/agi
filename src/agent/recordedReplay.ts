import type { JoystickSample } from "../runtime/keys.ts";
/** Exact host/interpreter operation tape. Authored step ticks keep their existing meaning. */
import { validateEngineReplayState, type EngineReplayState } from "../runtime/replayState.ts";

export type RecordedHostCall =
  | ["clock", number]
  | ["keyResume", 1]
  | ["soundEnabled", 0 | 1]
  | ["keys", number[]]
  | ["joystick", JoystickSample | null]
  | ["clicks", [number, number][]]
  | ["line", string | null]
  | ["random" | "number" | "waitKey" | "soundDevice", number]
  | ["string" | "version", string];
export type RecordedOperation =
  | ["tick" | "release" | "joystick", RecordedHostCall[]]
  | ["clock", number]
  | ["edit", string]
  | ["navigate" | "soundEnabled", number]
  /** An Amiga menu strip event: op, screen x, screen y, sticky (0/1). */
  | ["menu", [string, number, number, number]]
  | ["ack"];
export interface RecordedReplay {
  state: EngineReplayState;
  operations: RecordedOperation[];
}
const MAX_RECORDED_OPERATIONS = 60000;
export const MAX_RECORDED_BYTES = 180000;

export class OperationRecorder {
  readonly operations: RecordedOperation[] = [];
  private calls: RecordedHostCall[] | null = null;
  /**
   * Host-call list of a tick op left open by a suspended host interaction.
   * The replay engine never suspends — it consumes the whole tick in one
   * pass — so the delivered answer and the resumed run's calls must join the
   * operation the suspension began in.
   */
  private openCalls: RecordedHostCall[] | null = null;
  private lastCalls: RecordedHostCall[] | null = null;
  // Matches JSON.stringify(operations).length incrementally: 2 for the outer
  // array brackets, plus one comma per operation and per host call after the
  // first. Charged below where each element is appended.
  private bytes = 2;
  error: string | null = null;
  record(operation: RecordedOperation): void {
    if (this.error) return;
    let bytes = JSON.stringify(operation).length;
    if (this.operations.length > 0) bytes += 1;
    if (
      this.operations.length >= MAX_RECORDED_OPERATIONS ||
      (this.bytes += bytes) > MAX_RECORDED_BYTES
    ) {
      this.error = "Recording reached its size limit; record a shorter scenario.";
      return;
    }
    this.operations.push(operation);
  }
  clock(): void {
    if (this.calls || this.openCalls) this.host(["clock", 1]);
    else this.record(["clock", 1]);
  }
  /** Native switches during a parked tick precede its eventual key answer. */
  recordSound(enabled: boolean): void {
    if (this.calls || this.openCalls) this.host(["soundEnabled", enabled ? 1 : 0]);
    else this.record(["soundEnabled", enabled ? 1 : 0]);
  }
  host(call: RecordedHostCall): void {
    const target = this.calls ?? this.openCalls;
    if (!target || this.error) return;
    let bytes = JSON.stringify(call).length;
    if (target.length > 0) bytes += 1;
    if ((this.bytes += bytes) > MAX_RECORDED_BYTES) {
      this.error = "Recording reached its size limit; record a shorter scenario.";
      return;
    }
    target.push(call);
  }
  run(kind: "tick" | "release" | "joystick", run: () => void): void {
    if (this.calls !== null) {
      run();
      return;
    }
    if (kind === "joystick" && this.openCalls !== null) {
      // A cancellation while a host answer is pending precedes that answer.
      // Keep the tick open: this input poll does not resume its logic pass.
      this.calls = this.openCalls;
      try {
        run();
      } finally {
        this.calls = null;
      }
      return;
    }
    if (kind === "tick" && this.openCalls !== null) {
      // Resumption of a tick parked on a host answer: keep collecting into
      // the operation it started rather than opening a second tick.
      const calls = this.openCalls;
      this.openCalls = null;
      this.calls = calls;
      this.lastCalls = calls;
      try {
        run();
      } finally {
        this.calls = null;
      }
      return;
    }
    const calls: RecordedHostCall[] = [];
    this.record([kind, calls]);
    this.calls = calls;
    if (kind === "tick") this.lastCalls = calls;
    try {
      run();
    } finally {
      this.calls = null;
    }
  }
  /**
   * Mark the tick just run as suspended on a host interaction: its call list
   * stays open so the delivered answer — and the resumed run's calls — record
   * into the same operation.
   */
  holdTick(): void {
    if (this.lastCalls !== null) this.openCalls = this.lastCalls;
  }
}

function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new Error("Recorded operation number is out of range.");
  return v;
}
function string(v: unknown): string {
  if (typeof v !== "string" || v.length > 1000)
    throw new Error("Recorded operation text is invalid.");
  return v;
}
function tuple(v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 2)
    throw new Error("Recorded operation must be a tuple.");
  return v;
}
function host(value: unknown): RecordedHostCall {
  const v = tuple(value);
  if (v.length !== 2) throw new Error("Recorded host call requires a value.");
  switch (v[0]) {
    case "soundEnabled":
      return ["soundEnabled", integer(v[1], 0, 1) as 0 | 1];
    case "keyResume":
      return ["keyResume", integer(v[1], 1, 1) as 1];
    case "clock":
      return ["clock", integer(v[1], 1, 60000)];
    case "keys":
      if (!Array.isArray(v[1]) || v[1].length > 256)
        throw new Error("Recorded key batch is invalid.");
      return ["keys", v[1].map((k) => integer(k, 0, 65535))];
    case "clicks":
      if (!Array.isArray(v[1]) || v[1].length > 256)
        throw new Error("Recorded click batch is invalid.");
      return [
        "clicks",
        v[1].map((p): [number, number] => {
          if (!Array.isArray(p) || p.length !== 2)
            throw new Error("Recorded click batch is invalid.");
          return [integer(p[0], 0, 319), integer(p[1], 0, 199)];
        }),
      ];
    case "joystick": {
      if (v[1] === null) return ["joystick", null];
      if (typeof v[1] !== "object" || Array.isArray(v[1]))
        throw new Error("Recorded joystick sample is invalid.");
      const s = v[1] as Record<string, unknown>;
      if (
        Object.keys(s).some((k) => !["x", "y", "button1", "button2"].includes(k)) ||
        typeof s["x"] !== "number" ||
        !Number.isFinite(s["x"]) ||
        s["x"] < -1 ||
        s["x"] > 65535 ||
        typeof s["y"] !== "number" ||
        !Number.isFinite(s["y"]) ||
        s["y"] < -1 ||
        s["y"] > 65535 ||
        (s["button1"] !== undefined && typeof s["button1"] !== "boolean") ||
        (s["button2"] !== undefined && typeof s["button2"] !== "boolean")
      )
        throw new Error("Recorded joystick sample is invalid.");
      return [
        "joystick",
        { x: s["x"], y: s["y"], button1: s["button1"] === true, button2: s["button2"] === true },
      ];
    }
    case "line":
      return ["line", v[1] === null ? null : string(v[1])];
    case "string":
    case "version":
      return [v[0], string(v[1])];
    case "random":
    case "waitKey":
      return [v[0], integer(v[1], 0, 65535)];
    case "number":
      return ["number", integer(v[1], -2147483648, 2147483647)];
    case "soundDevice":
      return ["soundDevice", integer(v[1], 0, 255)];
    default:
      throw new Error("Unknown recorded host call.");
  }
}
export function validateRecordedReplay(value: unknown): RecordedReplay {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Recorded replay must be an object.");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 2 || !Object.hasOwn(r, "state") || !Object.hasOwn(r, "operations"))
    throw new Error("Recorded replay has missing or unknown fields.");
  if (!Array.isArray(r["operations"]) || r["operations"].length > MAX_RECORDED_OPERATIONS)
    throw new Error("Recorded replay has too many operations.");
  if (JSON.stringify(r["operations"]).length > MAX_RECORDED_BYTES)
    throw new Error("Recorded replay exceeds its size limit.");
  let ticks = 0,
    clocks = 0;
  const operations = r["operations"].map((value): RecordedOperation => {
    const v = tuple(value);
    if (v[0] === "ack") {
      if (v.length !== 1) throw new Error("Recorded operation has surplus fields.");
      return [v[0]];
    }
    if (v.length !== 2) throw new Error("Recorded operation requires a value.");
    if (v[0] === "clock") {
      const n = integer(v[1], 1, 60000);
      clocks += n;
      return ["clock", n];
    }
    if (v[0] === "edit") return ["edit", string(v[1])];
    if (v[0] === "soundEnabled") return ["soundEnabled", integer(v[1], 0, 1)];
    if (v[0] === "navigate") return ["navigate", integer(v[1], 1, 8)];
    if (v[0] === "menu") {
      const m = tuple(v[1]);
      if (m.length !== 4) throw new Error("Recorded menu event requires op, x, y and sticky.");
      const op = string(m[0]);
      if (!["open", "move", "release", "tap", "cancel"].includes(op))
        throw new Error("Recorded menu op is invalid.");
      return ["menu", [op, integer(m[1], -1, 319), integer(m[2], -1, 199), integer(m[3], 0, 1)]];
    }
    if (v[0] === "tick" || v[0] === "release" || v[0] === "joystick") {
      if (!Array.isArray(v[1]) || v[1].length > 60000)
        throw new Error("Recorded tick has too many host calls.");
      if (v[0] === "tick") ticks++;
      const calls = v[1].map(host);
      for (const call of calls) if (call[0] === "clock") clocks += call[1];
      return [v[0], calls];
    }
    throw new Error("Unknown recorded operation.");
  });
  if (ticks > 60000 || clocks > 360000)
    throw new Error("Recorded replay exceeds execution limits.");
  return { state: validateEngineReplayState(r["state"]), operations };
}

/** Machine-generated JSON payload. Keep it opaque in the model-facing tool schema. */
export function decodeRecordedReplay(text: string): RecordedReplay {
  if (text.length > 262144) throw new Error("Recorded replay payload is too large.");
  return validateRecordedReplay(JSON.parse(text));
}

/**
 * Player inputs on a recorded tape: typed command lines, key presses
 * (direction holds and dismissals included), pointer clicks, clicks that close
 * a message, key-wait answers and prompt answers. Releases end a hold and are
 * not inputs of their own.
 */
export function recordedPlayerInputs(replay: RecordedReplay): number {
  let inputs = 0;
  for (const operation of replay.operations) {
    if (operation[0] === "navigate" || operation[0] === "ack" || operation[0] === "menu") inputs++;
    if (operation[0] !== "tick" && operation[0] !== "release") continue;
    for (const call of operation[1]) {
      if (call[0] === "line") inputs += call[1] === null ? 0 : 1;
      else if (call[0] === "keys" || call[0] === "clicks") inputs += call[1].length;
      else if (call[0] === "waitKey" || call[0] === "string" || call[0] === "number") inputs++;
    }
  }
  return inputs;
}
