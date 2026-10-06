/**
 * Presentation helpers for the guided panel: a tolerant picture lookup for
 * the placement preview and the entry block's literal VIEW. These describe;
 * they never decide — the backend's prepare outcome stays the sole authority
 * over what is safe to write.
 */
import {
  actionsNamed,
  initBlocks,
  isEgo,
  numRef,
  parseRoomSource,
} from "../../../../../src/authoring/guidedSource.ts";

/** A binding table mid-edit: values are unknown until each entry is checked. */
type GuidedBindings = Readonly<Record<string, unknown>>;

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

/** The literal VIEW in the room's entry block, with authored names expanded. */
export function roomHeroView(source: string, bindingsText?: string): number | null {
  try {
    const bindings = readBindings(bindingsText) as Readonly<Record<string, { num: number }>>;
    const room = parseRoomSource(source, bindings);
    const entries = initBlocks(room.program);
    if (entries.length !== 1) return null;
    const views = actionsNamed(entries[0]!.then, "set.view").filter((action) =>
      isEgo(action.args[0]),
    );
    return views.length === 1 ? numRef(views[0]!.args[1]) : null;
  } catch {
    return null;
  }
}
