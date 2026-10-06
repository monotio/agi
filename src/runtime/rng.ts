/**
 * The interpreter's random-number generator (docs/fidelity.md, "Original
 * RNG and wander countdown"): one unsigned 16-bit state word. A draw that
 * enters at zero first reads the host's clock word — the original calls
 * BIOS 1Ah and takes DX — so the reseed is per-draw external input, not
 * one-time initialization: state 58235 advances to zero and the next draw
 * reads the clock again. Then `state * 31821 + 1` is kept to 16 bits and
 * the returned value is `(low ^ high)`, an unsigned byte — the full state
 * persists for the next draw.
 */
export function rngDraw(state: number, reseed: () => number): { state: number; byte: number } {
  let next = state & 0xffff;
  if (next === 0) next = reseed() & 0xffff;
  next = (next * 31821 + 1) & 0xffff;
  return { state: next, byte: (next & 255) ^ (next >>> 8) };
}

/** Host entropy ownership, separate from the interpreter's arithmetic. */
export type RngPolicy =
  { kind: "external" } | { kind: "sequence"; next: number; cursor: number; untilRoomChange?: true };
export interface HostRngState {
  word: number;
  policy: RngPolicy;
}

/** Each deterministic entropy read advances even when a draw returns zero. */
export function takeSequenceWord(policy: Extract<RngPolicy, { kind: "sequence" }>): number {
  const word = policy.next;
  policy.next = (word * 31821 + 1) & 0xffff;
  policy.cursor++;
  return word;
}

/** Validate optional host metadata without changing legacy records on read. */
export function readRngPolicy(value: unknown): RngPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Random source needs an object.");
  const policy = value as Record<string, unknown>;
  if (policy["kind"] === "external" && Object.keys(policy).length === 1)
    return { kind: "external" };
  if (
    policy["kind"] === "sequence" &&
    Object.keys(policy).every((key) =>
      ["kind", "next", "cursor", "untilRoomChange"].includes(key),
    ) &&
    (policy["untilRoomChange"] === undefined || policy["untilRoomChange"] === true) &&
    Number.isInteger(policy["next"]) &&
    (policy["next"] as number) >= 0 &&
    (policy["next"] as number) <= 65535 &&
    Number.isSafeInteger(policy["cursor"]) &&
    (policy["cursor"] as number) >= 0
  )
    return {
      kind: "sequence",
      next: policy["next"] as number,
      cursor: policy["cursor"] as number,
      ...(policy["untilRoomChange"] === true ? { untilRoomChange: true } : {}),
    };
  throw new Error("Random source has invalid state.");
}

export function readHostRngState(value: unknown): HostRngState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Random state needs an object.");
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== 2 ||
    !Number.isInteger(state["word"]) ||
    (state["word"] as number) < 0 ||
    (state["word"] as number) > 65535
  )
    throw new Error("Random state has an invalid word.");
  return { word: state["word"] as number, policy: readRngPolicy(state["policy"]) };
}
