/** Sparse host entry inputs, applied after the ordinary room reset. */
export interface RoomEntryState {
  cameFrom?: { room: number; edge?: 1 | 2 | 3 | 4 };
  flags?: Record<string, boolean>;
  variables?: Record<string, number>;
  items?: Record<string, number>;
  hero?: { x: number; y: number };
  seed?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

/** Validate every input before a host changes state; inventory identities come from OBJECT. */
export function roomEntryProblem(value: unknown, inventoryCount = 256): string | null {
  if (!record(value)) return "Launch inputs must be an object.";
  for (const key of Object.keys(value))
    if (
      !["id", "name", "note", "cameFrom", "flags", "variables", "items", "hero", "seed"].includes(
        key,
      )
    )
      return `Invalid launch field '${key}'.`;
  for (const kind of ["flags", "variables", "items"] as const) {
    const rows = value[kind];
    if (rows === undefined) continue;
    if (!record(rows)) return `Launch ${kind} must be a list of numbered values.`;
    for (const [key, entry] of Object.entries(rows)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || !integer(Number(key), 255))
        return `Launch ${kind} identity ${key} must be 0 to 255.`;
      if (kind === "items" && Number(key) >= inventoryCount)
        return `Inventory item ${key} is missing from OBJECT.`;
      if (kind === "flags" ? typeof entry !== "boolean" : !integer(entry, 255))
        return `Launch ${kind} value ${key} is invalid.`;
      if (
        (kind === "variables" && [0, 2].includes(Number(key))) ||
        (kind === "flags" && key === "5")
      )
        return `Launch ${kind} ${key} is set by the room transition.`;
    }
  }
  const from = value["cameFrom"];
  if (
    from !== undefined &&
    (!record(from) ||
      Object.keys(from).some((key) => !["room", "edge"].includes(key)) ||
      !integer(from["room"], 255) ||
      (from["edge"] !== undefined && (!integer(from["edge"], 4) || from["edge"] === 0)))
  )
    return "Came from needs a room from 0 to 255 and an edge from 1 to 4.";
  const hero = value["hero"];
  if (
    hero !== undefined &&
    (!record(hero) ||
      Object.keys(hero).some((key) => !["x", "y"].includes(key)) ||
      !integer(hero["x"], 159) ||
      !integer(hero["y"], 167))
  )
    return "Hero position needs X from 0 to 159 and Y from 0 to 167.";
  if (value["seed"] !== undefined && !integer(value["seed"], 65535))
    return "Same random each time needs a seed from 0 to 65535.";
  return null;
}
