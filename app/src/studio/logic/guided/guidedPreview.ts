/**
 * Presentation helpers for the guided panel: option lists for its pickers, the
 * room's annotated regions for the cue target, a tolerant picture lookup for
 * the placement preview, and the small unified line diff shown before Apply.
 * These describe; they never decide — the backend's prepare outcome stays the
 * sole authority over what is safe to write.
 */
import { documentLabel } from "../logicWorkspace.ts";

export interface GuidedOption {
  readonly value: number;
  readonly label: string;
}

/** A binding table mid-edit: values are unknown until each entry is checked. */
type GuidedBindings = Readonly<Record<string, unknown>>;

interface GuidedWorld {
  readonly rooms: Record<string, unknown>;
}

/** True for a plain object (JSON object), false for null and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant readers for the workspace's JSON auxiliaries; `{}` on garbage. */
function readBindings(text: string | undefined): GuidedBindings {
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The numeric target of one binding entry of `kind`; null for any other shape. */
function bindingNumber(binding: unknown, kind: string): number | null {
  if (!isRecord(binding)) return null;
  return binding["kind"] === kind && Number.isInteger(binding["num"])
    ? (binding["num"] as number)
    : null;
}

function readWorld(text: string | undefined): GuidedWorld {
  if (text === undefined) return { rooms: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { rooms: {} };
    const rooms = parsed["rooms"];
    return isRecord(rooms) ? { rooms } : { rooms: {} };
  } catch {
    return { rooms: {} };
  }
}

/** `logic:1..254` documents as rooms, titled from the world document. */
export function roomOptions(
  documents: Readonly<Record<string, unknown>>,
  worldText: string | undefined,
): GuidedOption[] {
  const world = readWorld(worldText);
  return Object.keys(documents)
    .map((key) => /^logic:(\d+)$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((num) => num >= 1 && num <= 254)
    .sort((a, b) => a - b)
    .map((num) => {
      const room = world.rooms[String(num)];
      const title = isRecord(room) ? room["title"] : undefined;
      return {
        value: num,
        label: `Room ${num}${typeof title === "string" && title !== "" ? ` · ${title}` : ""}`,
      };
    });
}

/** Existing `view:N`/`sound:N`/`picture:N` documents, labeled by their bindings. */
export function resourceOptions(
  documents: Readonly<Record<string, unknown>>,
  bindingsText: string | undefined,
  kind: "view" | "sound" | "picture",
): GuidedOption[] {
  const bindings = readBindings(bindingsText);
  const names: Record<number, string[]> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    const num = bindingNumber(binding, kind);
    if (num === null) continue;
    (names[num] ??= []).push(name);
  }
  return Object.keys(documents)
    .map((key) => new RegExp(`^${kind}:(\\d+)$`).exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b)
    .map((num) => {
      const named = names[num];
      const label = documentLabel(`${kind}:${num}`);
      return { value: num, label: named ? `${label} · ${named.join(", ")}` : label };
    });
}

/**
 * The picture a recognized room entry draws, for painting the placement
 * preview: the `assignn(v…)`/`draw.pic(…)` pattern read as text. Not a parser —
 * a wrong guess simply renders no preview while the backend stays authoritative.
 */
export function roomPictureNumber(source: string, bindingsText: string | undefined): number | null {
  const bindings = readBindings(bindingsText);
  const locals = new Map<number, number>();
  let picture: number | null = null;
  for (const line of source.split("\n")) {
    const assign = /\bassignn\(\s*v(\d+)\s*,\s*([a-zA-Z0-9_]+)\s*\)/.exec(line);
    if (assign) {
      const target = Number(assign[1]);
      const operand = assign[2]!;
      const value = /^\d+$/.test(operand)
        ? Number(operand)
        : bindingNumber(bindings[operand], "picture");
      if (value !== null) locals.set(target, value);
      continue;
    }
    const draw = /\bdraw\.pic\(\s*(?:v(\d+)|(\d+))\s*\)/.exec(line);
    if (draw) {
      const value = draw[1] !== undefined ? locals.get(Number(draw[1])) : Number(draw[2]);
      if (value !== undefined && value !== null) {
        picture = value;
        break;
      }
    }
  }
  return picture;
}
