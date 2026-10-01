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

export interface GuidedRuleOption {
  readonly id: string;
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
 * The literal commands a room's `said("…")` handlers already answer, for the
 * cue picker's suggestions. Free text stays possible; the backend matches the
 * phrase through the real dictionary either way.
 */
export function commandHints(source: string): string[] {
  const seen = new Set<string>();
  for (const line of source.split("\n")) {
    for (const match of line.matchAll(/\bsaid\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      try {
        const parsed: unknown = JSON.parse(`"${match[1]!}"`);
        if (typeof parsed === "string" && parsed !== "") seen.add(parsed);
      } catch {
        /* not a readable literal — skip */
      }
    }
  }
  return [...seen].sort();
}

/**
 * The room's annotated `region` rules for the cue picker, scanned from the
 * source text alone. The backend re-validates whatever is submitted; this only
 * fills the select.
 */
export function regionRules(source: string): GuidedRuleOption[] {
  const rules: GuidedRuleOption[] = [];
  for (const line of source.split("\n")) {
    const match = /^\/\/\s*@rule\s+(\S+)\s+("(?:[^"\\]|\\.)*")\s+(exit|region)\b/.exec(line.trim());
    if (!match || match[3] !== "region") continue;
    let label = match[1]!;
    try {
      const parsed: unknown = JSON.parse(match[2]!);
      if (typeof parsed === "string" && parsed.trim() !== "") label = parsed;
    } catch {
      /* the id still names the rule */
    }
    rules.push({ id: match[1]!, label });
  }
  return rules;
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

export interface GuidedDiffRow {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
}

/** A folded context run: `count` unchanged lines the review skips over. */
interface GuidedDiffGap {
  readonly kind: "gap";
  readonly count: number;
}

export type GuidedDiffLine = GuidedDiffRow | GuidedDiffGap;

/** Keep add/del rows plus `edge` context lines on each side; fold the rest. */
export function compactDiff(rows: readonly GuidedDiffRow[], edge = 3): GuidedDiffLine[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === "same") return;
    for (let i = Math.max(0, index - edge); i <= Math.min(rows.length - 1, index + edge); i++)
      keep[i] = true;
  });
  const out: GuidedDiffLine[] = [];
  let pending = 0;
  rows.forEach((row, index) => {
    if (!keep[index]) {
      pending++;
      return;
    }
    if (pending > 0) {
      out.push({ kind: "gap", count: pending });
      pending = 0;
    }
    out.push(row);
  });
  if (pending > 0) out.push({ kind: "gap", count: pending });
  return out;
}

/**
 * A minimal unified line diff (longest common subsequence) for the detached
 * preview — document-sized inputs, capped; beyond it the whole document shows
 * as replaced rather than lying.
 */
export function diffLines(before: string | null, after: string | null): GuidedDiffRow[] {
  const oldLines = before === null ? [] : before.split("\n");
  const newLines = after === null ? [] : after.split("\n");
  if (oldLines.length === 0) return newLines.map((text) => ({ kind: "add" as const, text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ kind: "del" as const, text }));
  if (oldLines.length * newLines.length > 4_000_000) {
    return [
      ...oldLines.map((text) => ({ kind: "del" as const, text })),
      ...newLines.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  // rows[y][x] = LCS length of old[y..] and new[x..].
  const rows: Uint32Array[] = new Array(oldLines.length + 1);
  for (let y = 0; y <= oldLines.length; y++) rows[y] = new Uint32Array(newLines.length + 1);
  for (let y = oldLines.length - 1; y >= 0; y--) {
    for (let x = newLines.length - 1; x >= 0; x--) {
      rows[y]![x] =
        oldLines[y] === newLines[x]
          ? rows[y + 1]![x + 1]! + 1
          : Math.max(rows[y + 1]![x]!, rows[y]![x + 1]!);
    }
  }
  const out: GuidedDiffRow[] = [];
  let y = 0;
  let x = 0;
  while (y < oldLines.length && x < newLines.length) {
    if (oldLines[y] === newLines[x]) {
      out.push({ kind: "same", text: oldLines[y]! });
      y++;
      x++;
    } else if (rows[y + 1]![x]! >= rows[y]![x + 1]!) {
      out.push({ kind: "del", text: oldLines[y]! });
      y++;
    } else {
      out.push({ kind: "add", text: newLines[x]! });
      x++;
    }
  }
  for (; y < oldLines.length; y++) out.push({ kind: "del", text: oldLines[y]! });
  for (; x < newLines.length; x++) out.push({ kind: "add", text: newLines[x]! });
  return out;
}
