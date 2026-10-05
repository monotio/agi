/** The map storage contract stays separate from static resource analysis. */
import type { EdgeSide, RoomMapSidecar, RoomTransitionCause } from "./roomGraph.ts";

const MAX_JOURNAL_ENTRIES = 4096;
const MAX_DISCOVERED_ROOMS = 256;
// The full discovery domain: 256×256 directed pairs × 5 label variants.
const MAX_DISCOVERED_EDGES = 256 * 256 * 5;
const MAX_LAYOUT_NODES = 512;
const MAX_NOTES = 512;
const MAX_NOTE_CHARS = 4000;
const CAUSES: readonly RoomTransitionCause[] = [
  "boot",
  "edge",
  "logic",
  "restore",
  "restart",
  "reenter",
  "jump",
];
const SIDES: readonly string[] = ["top", "right", "bottom", "left"];

function roomNum(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)
    throw new Error(`Invalid ${label}: expected a room number 0..255.`);
  return value as number;
}

function numList(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error(`Invalid ${label}: expected at most 256 item numbers.`);
  return value.map((v) => roomNum(v, label));
}

/**
 * Validate a parsed MAP.JSON body. A missing sidecar is an empty map;
 * malformed or unsupported data is rejected so the caller can explain a
 * reset or reimport. No old-version readers.
 */
export function validateMapSidecar(value: unknown): RoomMapSidecar {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid map data: expected an object.");
  const raw = value as Record<string, unknown>;
  if (raw["format"] !== "monotio.agi.map" || raw["version"] !== 1)
    throw new Error("Unsupported map data version.");
  const sidecar: RoomMapSidecar = {
    journal: [],
    discovered: { rooms: {}, edges: [] },
    layout: {},
    notes: {},
    edgeNotes: {},
  };

  const journal = raw["journal"] ?? [];
  if (!Array.isArray(journal) || journal.length > MAX_JOURNAL_ENTRIES)
    throw new Error("Invalid map journal: too many entries.");
  const seen = new Set<string>();
  for (const entry of journal) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid map journal entry.");
    const e = entry as Record<string, unknown>;
    if (!Number.isInteger(e["seq"]) || (e["seq"] as number) < 0)
      throw new Error("Invalid journal sequence.");
    if (!Number.isInteger(e["session"]) || (e["session"] as number) < 0)
      throw new Error("Invalid journal session.");
    const identity = `${e["session"]}:${e["seq"]}`;
    if (seen.has(identity)) throw new Error("Duplicate journal entry.");
    seen.add(identity);
    const from = e["from"] === null ? null : roomNum(e["from"], "journal source");
    const to = roomNum(e["to"], "journal target");
    const cause = e["cause"];
    if (!CAUSES.includes(cause as RoomTransitionCause)) throw new Error("Invalid journal cause.");
    const edge = e["edge"];
    if (edge !== undefined && !SIDES.includes(edge as string))
      throw new Error("Invalid journal edge side.");
    if (!Number.isInteger(e["cycle"]) || (e["cycle"] as number) < 0)
      throw new Error("Invalid journal cycle.");
    if (typeof e["resourceSet"] !== "string" || e["resourceSet"].length > 128)
      throw new Error("Invalid journal resource revision.");
    const hist = e["history"];
    if (hist !== undefined) {
      if (!hist || typeof hist !== "object" || Array.isArray(hist))
        throw new Error("Invalid journal history position.");
      const hp = hist as Record<string, unknown>;
      if (typeof hp["segment"] !== "string" || hp["segment"].length > 64)
        throw new Error("Invalid journal history segment.");
      if (!Number.isInteger(hp["seq"]) || (hp["seq"] as number) < 0)
        throw new Error("Invalid journal history sequence.");
      if (!Number.isInteger(hp["tick"]) || (hp["tick"] as number) < 0)
        throw new Error("Invalid journal history tick.");
    }
    sidecar.journal.push({
      seq: e["seq"] as number,
      session: e["session"] as number,
      from,
      to,
      cause: cause as RoomTransitionCause,
      ...(edge !== undefined ? { edge: edge as EdgeSide } : {}),
      cycle: e["cycle"] as number,
      resourceSet: e["resourceSet"],
      scoreDelta: Number.isInteger(e["scoreDelta"]) ? (e["scoreDelta"] as number) : 0,
      gained: numList(e["gained"] ?? [], "gained items"),
      lost: numList(e["lost"] ?? [], "lost items"),
      ...(hist !== undefined
        ? {
            history: {
              segment: (hist as Record<string, unknown>)["segment"] as string,
              seq: (hist as Record<string, unknown>)["seq"] as number,
              tick: (hist as Record<string, unknown>)["tick"] as number,
            },
          }
        : {}),
    });
  }

  const discovered = raw["discovered"];
  if (discovered !== undefined) {
    if (!discovered || typeof discovered !== "object" || Array.isArray(discovered))
      throw new Error("Invalid map discovery data.");
    const d = discovered as Record<string, unknown>;
    const rooms = d["rooms"] ?? {};
    if (!rooms || typeof rooms !== "object" || Array.isArray(rooms))
      throw new Error("Invalid map discovery rooms.");
    const roomEntries = Object.entries(rooms);
    if (roomEntries.length > MAX_DISCOVERED_ROOMS)
      throw new Error("Map discovery has too many rooms.");
    for (const [num, count] of roomEntries) {
      if (!/^\d+$/.test(num)) throw new Error("Invalid discovery room.");
      roomNum(Number(num), "discovery room");
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 1_000_000)
        throw new Error("Invalid discovery visit count.");
      sidecar.discovered.rooms[num] = count as number;
    }
    const edges = d["edges"] ?? [];
    if (!Array.isArray(edges) || edges.length > MAX_DISCOVERED_EDGES)
      throw new Error("Map discovery has too many edges.");
    const seenEdges = new Set<string>();
    for (const edge of edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge))
        throw new Error("Invalid discovery edge.");
      const e = edge as Record<string, unknown>;
      const from = roomNum(e["from"], "discovery edge source");
      const to = roomNum(e["to"], "discovery edge target");
      const label = e["label"];
      if (label !== undefined && (typeof label !== "string" || label.length > 64))
        throw new Error("Invalid discovery edge label.");
      if (!Number.isInteger(e["count"]) || (e["count"] as number) < 1)
        throw new Error("Invalid discovery edge count.");
      const identity = `${from}->${to}:${label ?? ""}`;
      if (seenEdges.has(identity)) throw new Error("Duplicate discovery edge.");
      seenEdges.add(identity);
      sidecar.discovered.edges.push({
        from,
        to,
        ...(label !== undefined ? { label: label as string } : {}),
        count: e["count"] as number,
      });
    }
  }

  const layout = raw["layout"];
  if (layout !== undefined) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout))
      throw new Error("Invalid map layout.");
    const entries = Object.entries(layout);
    if (entries.length > MAX_LAYOUT_NODES) throw new Error("Map layout has too many nodes.");
    for (const [num, pos] of entries) {
      roomNum(Number(num), "layout room");
      if (!/^\d+$/.test(num)) throw new Error("Invalid layout room.");
      if (
        !pos ||
        typeof pos !== "object" ||
        !Number.isFinite((pos as { x: unknown }).x) ||
        !Number.isFinite((pos as { y: unknown }).y)
      )
        throw new Error("Invalid layout position.");
      const p = pos as { x: number; y: number };
      if (Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) throw new Error("Invalid layout position.");
      sidecar.layout[num] = { x: p.x, y: p.y };
    }
  }

  const notes = raw["notes"];
  if (notes !== undefined) {
    if (!notes || typeof notes !== "object" || Array.isArray(notes))
      throw new Error("Invalid map notes.");
    const entries = Object.entries(notes);
    if (entries.length > MAX_NOTES) throw new Error("Map has too many notes.");
    for (const [num, note] of entries) {
      if (!/^\d+$/.test(num)) throw new Error("Invalid note room.");
      roomNum(Number(num), "note room");
      if (typeof note !== "string" || note.length > MAX_NOTE_CHARS)
        throw new Error("Invalid map note.");
      sidecar.notes[num] = note;
    }
  }

  const edgeNotes = raw["edgeNotes"];
  if (edgeNotes !== undefined) {
    if (!edgeNotes || typeof edgeNotes !== "object" || Array.isArray(edgeNotes))
      throw new Error("Invalid map edge notes.");
    const entries = Object.entries(edgeNotes);
    if (entries.length > MAX_NOTES) throw new Error("Map has too many notes.");
    for (const [key, note] of entries) {
      const m = /^(\d+)->(\d+):(.{0,64})$/.exec(key);
      if (!m) throw new Error("Invalid edge note key.");
      roomNum(Number(m[1]), "edge note source");
      roomNum(Number(m[2]), "edge note target");
      if (typeof note !== "string" || note.length > MAX_NOTE_CHARS)
        throw new Error("Invalid map note.");
      sidecar.edgeNotes[key] = note;
    }
  }
  return sidecar;
}

/** Serialize the sidecar for the project record and the MAP.JSON entry. */
export function serializeMapSidecar(sidecar: RoomMapSidecar): Record<string, unknown> {
  return {
    format: "monotio.agi.map",
    version: 1,
    journal: sidecar.journal,
    discovered: sidecar.discovered,
    layout: sidecar.layout,
    notes: sidecar.notes,
    edgeNotes: sidecar.edgeNotes,
  };
}
