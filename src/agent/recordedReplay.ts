/** Exact host/interpreter operation tape. Authored step ticks keep their existing meaning. */
import { validateEngineReplayState, type EngineReplayState } from "../runtime/replayState.ts";

export type RecordedHostCall =
  | ["clock", number]
  | ["keys", number[]]
  | ["line", string | null]
  | ["random" | "number" | "waitKey" | "soundDevice", number]
  | ["string" | "version", string];
export type RecordedOperation =
  | ["tick" | "release", RecordedHostCall[]]
  | ["clock", number]
  | ["edit", string]
  | ["navigate" | "soundEnabled", number]
  | ["ack"];
export interface RecordedReplay {
  state: EngineReplayState;
  operations: RecordedOperation[];
}
export const MAX_RECORDED_OPERATIONS = 60000;
export const MAX_RECORDED_BYTES = 180000;

export class OperationRecorder {
  readonly operations: RecordedOperation[] = [];
  private calls: RecordedHostCall[] | null = null;
  private bytes = 0;
  error: string | null = null;
  record(operation: RecordedOperation): void {
    if (this.error) return;
    if (
      this.operations.length >= MAX_RECORDED_OPERATIONS ||
      (this.bytes += JSON.stringify(operation).length) > MAX_RECORDED_BYTES
    ) {
      this.error = "Recording reached its size limit; record a shorter scenario.";
      return;
    }
    this.operations.push(operation);
  }
  clock(): void {
    if (this.calls) this.host(["clock", 1]);
    else this.record(["clock", 1]);
  }
  host(call: RecordedHostCall): void {
    if (!this.calls || this.error) return;
    if ((this.bytes += JSON.stringify(call).length) > MAX_RECORDED_BYTES) {
      this.error = "Recording reached its size limit; record a shorter scenario.";
      return;
    }
    this.calls.push(call);
  }
  run(kind: "tick" | "release", run: () => void): void {
    const calls: RecordedHostCall[] = [];
    this.record([kind, calls]);
    this.calls = calls;
    try {
      run();
    } finally {
      this.calls = null;
    }
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
    case "clock":
      return ["clock", integer(v[1], 1, 60000)];
    case "keys":
      if (!Array.isArray(v[1]) || v[1].length > 256)
        throw new Error("Recorded key batch is invalid.");
      return ["keys", v[1].map((k) => integer(k, 0, 65535))];
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
    if (v[0] === "tick" || v[0] === "release") {
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
