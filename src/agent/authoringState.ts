/** Portable authoring intent and stable names; game behavior remains in AGI resources. */
export type BindingKind = "logic" | "picture" | "view" | "sound" | "flag" | "variable";
export interface AuthoringState {
  version: 1;
  /** Authored musical intent, usable only while the compiled SOUND revision matches. */
  music?: Record<string, { revision: string; tempo: number }>;
  bindings: Record<string, { kind: BindingKind; num: number }>;
  world: {
    rooms: Record<string, { title: string; description: string; exits: Record<string, number> }>;
    facts: Record<string, string>;
    quests: Record<string, { description: string; requires: string[]; completedFlag?: string }>;
  };
}

export function createAuthoringState(): AuthoringState {
  return { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } };
}

/** Small content revision for optimistic edits, not a cryptographic signature. */
export function resourceRevision(payload: Uint8Array | null): string {
  if (payload === null) return "absent";
  let hash = 0x811c9dc5;
  for (const byte of payload) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `${payload.length}-${hash.toString(16).padStart(8, "0")}`;
}

function record(value: unknown, label: string, limit: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected an object.`);
  const entries = Object.entries(value);
  if (
    entries.length > limit ||
    entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key))
  )
    throw new Error(`Invalid ${label}: too many entries or reserved name.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`Invalid ${label}: expected text of at most ${max} characters.`);
  return value;
}

/** Validate imported/project state and return a detached, explicitly selected structure. */
export function validateAuthoringState(value: unknown): AuthoringState {
  const raw = record(value, "authoring state", 8);
  if (raw["version"] !== 1) throw new Error("Unsupported authoring state version.");
  const result = createAuthoringState();
  if (raw["music"] !== undefined) {
    const music: NonNullable<AuthoringState["music"]> = {};
    for (const [num, entry] of Object.entries(record(raw["music"], "music", 256))) {
      const item = record(entry, "music entry", 2);
      if (
        !/^(0|[1-9]\d{0,2})$/.test(num) ||
        Number(num) > 255 ||
        typeof item["tempo"] !== "number" ||
        !Number.isFinite(item["tempo"]) ||
        item["tempo"] < 40 ||
        item["tempo"] > 240 ||
        typeof item["revision"] !== "string" ||
        !/^\d{1,6}-[0-9a-f]{8}$/.test(item["revision"])
      )
        throw new Error(`Invalid music metadata for sound '${num}'.`);
      music[num] = { revision: item["revision"], tempo: item["tempo"] };
    }
    result.music = music;
  }
  for (const [name, entry] of Object.entries(record(raw["bindings"], "bindings", 1536))) {
    const item = record(entry, "binding", 4);
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(name) ||
      !["logic", "picture", "view", "sound", "flag", "variable"].includes(String(item["kind"])) ||
      !Number.isInteger(item["num"]) ||
      Number(item["num"]) < 0 ||
      Number(item["num"]) > 255
    )
      throw new Error(`Invalid binding '${name}'.`);
    result.bindings[name] = { kind: item["kind"] as BindingKind, num: Number(item["num"]) };
  }
  const world = record(raw["world"], "world", 4);
  for (const [num, entry] of Object.entries(record(world["rooms"], "rooms", 255))) {
    if (!/^\d+$/.test(num) || Number(num) < 1 || Number(num) > 255)
      throw new Error(`Invalid room '${num}'.`);
    const item = record(entry, "room", 5);
    const exits: Record<string, number> = {};
    for (const [name, destination] of Object.entries(record(item["exits"], "exits", 32))) {
      if (!Number.isInteger(destination) || Number(destination) < 1 || Number(destination) > 255)
        throw new Error(`Invalid exit '${name}'.`);
      exits[text(name, "exit name", 80)] = Number(destination);
    }
    result.world.rooms[num] = {
      title: text(item["title"], "room title", 160),
      description: text(item["description"], "room description"),
      exits,
    };
  }
  for (const [name, value] of Object.entries(record(world["facts"], "facts", 512)))
    result.world.facts[text(name, "fact name", 80)] = text(value, "fact");
  for (const [name, entry] of Object.entries(record(world["quests"], "quests", 256))) {
    const item = record(entry, "quest", 5);
    const requires = item["requires"];
    if (!Array.isArray(requires) || requires.length > 64)
      throw new Error(`Invalid quest dependencies for '${name}'.`);
    result.world.quests[text(name, "quest name", 80)] = {
      description: text(item["description"], "quest description"),
      requires: requires.map((value) => text(value, "quest dependency", 80)),
      ...(item["completedFlag"] === undefined
        ? {}
        : { completedFlag: text(item["completedFlag"], "completion flag", 64) }),
    };
  }
  return result;
}
