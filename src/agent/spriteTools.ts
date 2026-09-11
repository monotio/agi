/** Bounded, row-oriented helpers for mechanical AGI sprite authoring. */
import { resourceRevision } from "./authoringState.ts";
import type { AgentSessionState, AgentToolResult, ToolDefinition } from "./tools.ts";
import { viewFeedback } from "./viewFeedback.ts";

import {
  buildView,
  parseView,
  readViewCel,
  selectViewCel,
  type AgiView,
  type BuildCelInput,
  type BuildLoopInput,
  type BuildViewInput,
  type ViewCel,
} from "../view/view.ts";

const CEL_ROWS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 168,
  items: {
    type: "string",
    minLength: 1,
    maxLength: 160,
    pattern: "^[0-9A-Fa-f]+$",
  },
  description: "One string per row; every character is one EGA color index (0-F).",
} as const;

/** Strict-compatible schemas for the bounded sprite helpers. */
export const SPRITE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "patch_view_cels",
    description:
      "Patch a subset of cels in view `num`: `patches` carries 1..64 targets. A target supplies `recolor` — {from,to} EGA remaps applied in place (prefer this for color changes; read_view's per-cel color usage gives the mapping, no pixel rows needed) — or replaces a cel's pixels with equal-width EGA hex `rows` (0-F; the cel keeps its transparent color). Transparent pixels are never remapped. Everything is validated against the current view before anything writes; mirrored loops are isolated by copy-on-write. `expectedRevision` must match. Atomic: one compile, one commit, or nothing. Returns the new revision, per-cel geometry and a contact sheet.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer", minimum: 0, maximum: 255 },
        expectedRevision: {
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
        patches: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              loop: { type: "integer", minimum: 0, maximum: 254 },
              cel: { type: "integer", minimum: 0, maximum: 254 },
              rows: { ...CEL_ROWS_SCHEMA, type: ["array", "null"] },
              recolor: {
                type: ["array", "null"],
                minItems: 1,
                maxItems: 15,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    from: { type: "integer", minimum: 0, maximum: 15 },
                    to: { type: "integer", minimum: 0, maximum: 15 },
                  },
                  required: ["from", "to"],
                },
              },
            },
            required: ["loop", "cel", "rows", "recolor"],
          },
        },
      },
      required: ["num", "expectedRevision", "patches"],
    },
  },
];

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function celFromRows(
  value: unknown,
  label: string,
  transparentColor: number,
  adjustments: string[],
): BuildCelInput {
  if (!Array.isArray(value) || value.length < 1 || value.length > 168) {
    throw new Error(`${label} must contain 1..168 rows.`);
  }
  const rows: string[] = [];
  let normalized = false;
  for (let y = 0; y < value.length; y++) {
    const raw = value[y];
    if (typeof raw !== "string") throw new Error(`${label} row ${y} must be a string.`);
    const trimmed = raw.trim();
    if (trimmed !== raw || trimmed !== trimmed.toUpperCase()) normalized = true;
    const row = trimmed.toUpperCase();
    if (!/^[0-9A-F]+$/.test(row)) {
      throw new Error(`${label} row ${y} must contain only EGA hex digits 0-F.`);
    }
    if (row.length > 160) throw new Error(`${label} row ${y} exceeds 160 pixels.`);
    rows.push(row);
  }
  const width = rows[0]!.length;
  for (let y = 1; y < rows.length; y++) {
    if (rows[y]!.length !== width) {
      throw new Error(
        `${label} rows must all have the same width (row 0 is ${width}, row ${y} is ${rows[y]!.length}).`,
      );
    }
  }
  if (normalized)
    adjustments.push(`${label}: normalized surrounding whitespace and lowercase hex digits.`);
  const pixels = rows.flatMap((row) => [...row].map((digit) => Number.parseInt(digit, 16)));
  return { width, height: rows.length, transparentColor, mirror: false, pixels };
}

function direction(
  value: unknown,
  label: string,
  transparentColor: number,
  adjustments: string[],
): BuildCelInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 15) {
    throw new Error(`${label} must contain 1..15 cels.`);
  }
  return value.map((rows, index) =>
    celFromRows(rows, `${label} cel ${index}`, transparentColor, adjustments),
  );
}

function u16le(payload: Uint8Array, offset: number): number {
  return payload[offset]! | (payload[offset + 1]! << 8);
}

interface AliasGroup {
  readonly members: number[];
  readonly cels: BuildCelInput[];
  readonly headerHigh: number;
  readonly controlHighs: number[];
}

interface MetadataPlan {
  readonly loop: number;
  readonly headerHigh: number;
  readonly controlHighs: readonly number[];
}

function cloneCel(cel: ViewCel): BuildCelInput {
  return {
    width: cel.width,
    height: cel.height,
    transparentColor: cel.transparentColor,
    mirror: false,
    pixels: cel.pixels.slice(),
  };
}

function aliasGroups(payload: Uint8Array, view: AgiView, packed: boolean): AliasGroup[] {
  const byOffset = new Map<number, AliasGroup>();
  const groups: AliasGroup[] = [];
  for (let loop = 0; loop < view.loops.length; loop++) {
    const loopStart = u16le(payload, 5 + loop * 2);
    const existing = byOffset.get(loopStart);
    if (existing) {
      existing.members.push(loop);
      continue;
    }
    const header = payload[loopStart]!;
    const celCount = packed ? header & 0x0f : header;
    const cels: BuildCelInput[] = [];
    const controlHighs: number[] = [];
    for (let cel = 0; cel < celCount; cel++) {
      const loaded = readViewCel(view, loop, cel);
      if (!loaded) throw new RangeError(`view loop ${loop}, cel ${cel} could not be decoded`);
      cels.push(cloneCel(loaded));
      const celStart = loopStart + u16le(payload, loopStart + 1 + cel * 2);
      controlHighs.push(payload[celStart + 2]! & 0xf0);
    }
    const group: AliasGroup = {
      members: [loop],
      cels,
      headerHigh: header & 0xf0,
      controlHighs,
    };
    byOffset.set(loopStart, group);
    groups.push(group);
  }
  return groups;
}

function reverseRows(cel: BuildCelInput): BuildCelInput {
  const pixels = new Uint8Array(cel.width * cel.height);
  for (let y = 0; y < cel.height; y++) {
    for (let x = 0; x < cel.width; x++) {
      pixels[y * cel.width + x] = cel.pixels[y * cel.width + cel.width - 1 - x]!;
    }
  }
  return { ...cel, pixels };
}

function reverseColumns(cel: BuildCelInput): BuildCelInput {
  const pixels = new Uint8Array(cel.width * cel.height);
  for (let y = 0; y < cel.height; y++) {
    const srcY = cel.height - 1 - y;
    for (let x = 0; x < cel.width; x++) {
      pixels[y * cel.width + x] = cel.pixels[srcY * cel.width + x]!;
    }
  }
  return { ...cel, pixels };
}

function applyMetadata(payload: Uint8Array, packed: boolean, plans: readonly MetadataPlan[]): void {
  for (const plan of plans) {
    const loopStart = u16le(payload, 5 + plan.loop * 2);
    if (packed) payload[loopStart] = (payload[loopStart]! & 0x0f) | plan.headerHigh;
    else {
      for (let cel = 0; cel < plan.controlHighs.length; cel++) {
        const celStart = loopStart + u16le(payload, loopStart + 1 + cel * 2);
        payload[celStart + 2] = (payload[celStart + 2]! & 0x0f) | plan.controlHighs[cel]!;
      }
    }
  }
}

/**
 * Rebuild a view with a set of cel replacements resolved against the original
 * snapshot. Loop-alias groups are copy-on-write: a patched loop is isolated
 * into its own data (its displayed pixels plus the edits), while untouched
 * members keep sharing the original block. Patches to several members of one
 * alias group isolate each of them.
 */
function patchedView(
  original: Uint8Array,
  state: AgentSessionState,
  targets: ReadonlyMap<number, ReadonlyMap<number, BuildCelInput>>,
  adjustments: string[],
): { payload: Uint8Array; spec: BuildViewInput } {
  const view = parseView(original, state.profile);
  const groups = aliasGroups(original, view, state.profile.packedViewLoopHeader);
  const loops: BuildLoopInput[] = new Array(view.loops.length);
  const plans: MetadataPlan[] = [];
  for (const group of groups) {
    const targeted = group.members.filter((member) => targets.has(member));
    if (group.members.length === 1 || targeted.length === 0) {
      const first = group.members[0]!;
      const cels: BuildCelInput[] = group.cels.map((cel) => ({
        ...cel,
        pixels: Uint8Array.from(cel.pixels),
      }));
      if (targeted.length === 1) {
        for (const [celIndex, replacement] of targets.get(first)!) {
          const displayed = view.loops[first]!.cels[celIndex]!;
          cels[celIndex] = displayed.mirrored ? reverseRows(replacement) : replacement;
        }
      }
      loops[first] = { cels };
      for (const member of group.members.slice(1)) loops[member] = { mirrorLoop: first };
      plans.push({ loop: first, headerHigh: group.headerHigh, controlHighs: group.controlHighs });
      continue;
    }

    // Untargeted members keep one shared block; each targeted loop is isolated
    // with its displayed pixels plus this loop's edits.
    for (const loop of targeted) {
      const displayedCels = view.loops[loop]!.cels.map(cloneCel);
      for (const [celIndex, replacement] of targets.get(loop)!)
        displayedCels[celIndex] = replacement;
      loops[loop] = { cels: displayedCels };
    }
    const remaining = group.members.filter((loop) => !targets.has(loop));
    if (remaining.length) {
      const firstRemaining = remaining[0]!;
      loops[firstRemaining] = {
        cels: group.cels.map((cel) => ({ ...cel, pixels: Uint8Array.from(cel.pixels) })),
      };
      for (const member of remaining.slice(1)) loops[member] = { mirrorLoop: firstRemaining };
      plans.push({
        loop: firstRemaining,
        headerHigh: group.headerHigh,
        controlHighs: group.controlHighs,
      });
    }
    adjustments.push(
      `Loop${targeted.length > 1 ? "s" : ""} ${targeted.join(", ")} ${targeted.length > 1 ? "were" : "was"} isolated from its mirrored alias before patching so the other facing${remaining.length === 1 ? "" : "s"} retained its pixels.`,
    );
  }
  const spec: BuildViewInput = {
    loops,
    ...(view.description === undefined ? {} : { description: view.description }),
  };
  const payload = buildView(spec, state.profile);
  applyMetadata(payload, state.profile.packedViewLoopHeader, plans);
  parseView(payload, state.profile);
  return { payload, spec };
}

/** Four-facing actor shorthand -> BuildViewInput (right, left, down, up order). */
export function actorSpecFromFacings(facings: Record<string, unknown>): {
  spec: BuildViewInput;
  adjustments: string[];
} {
  const transparentColor = integer(facings["transparentColor"], "Transparent color", 0, 15);
  const mirrorLeftFromRight = facings["mirrorLeftFromRight"];
  if (mirrorLeftFromRight != null && typeof mirrorLeftFromRight !== "boolean") {
    throw new Error("mirrorLeftFromRight must be a boolean or null.");
  }
  const mirrorUpFromDown = facings["mirrorUpFromDown"];
  if (mirrorUpFromDown != null && typeof mirrorUpFromDown !== "boolean") {
    throw new Error("mirrorUpFromDown must be a boolean or null.");
  }
  const description = facings["description"];
  if (description !== null && (typeof description !== "string" || description.length > 512)) {
    throw new Error("facings.description must be null or at most 512 characters.");
  }
  const adjustments: string[] = [];

  const rawRight = facings["right"];
  const rawLeft = facings["left"];
  const rawDown = facings["down"];
  const rawUp = facings["up"];

  if (rawRight == null && rawLeft == null && rawDown == null && rawUp == null) {
    throw new Error("At least one direction (right, left, down, or up) must be provided.");
  }

  let rightCels: BuildCelInput[] | null =
    rawRight != null ? direction(rawRight, "right", transparentColor, adjustments) : null;
  const leftCels: BuildCelInput[] | null =
    rawLeft != null ? direction(rawLeft, "left", transparentColor, adjustments) : null;
  let downCels: BuildCelInput[] | null =
    rawDown != null ? direction(rawDown, "down", transparentColor, adjustments) : null;
  let upCels: BuildCelInput[] | null =
    rawUp != null ? direction(rawUp, "up", transparentColor, adjustments) : null;

  const primary = rightCels ?? downCels ?? leftCels ?? upCels!;
  const primaryName = rightCels ? "right" : downCels ? "down" : leftCels ? "left" : "up";

  if (!rightCels) {
    rightCels = primary.map((cel) => ({ ...cel, pixels: Uint8Array.from(cel.pixels) }));
    adjustments.push(`Warning: 'right' was omitted; reused '${primaryName}' cels.`);
  }

  let left: BuildLoopInput;
  if (
    mirrorLeftFromRight === true ||
    (rawLeft == null && leftCels == null && mirrorLeftFromRight !== false)
  ) {
    if (rawLeft != null) throw new Error("left must be null when mirrorLeftFromRight is true.");
    left = { mirrorLoop: 0 };
    if (mirrorLeftFromRight !== true) {
      adjustments.push("'left' was omitted; mirrored from 'right' (loop 0).");
    }
  } else if (leftCels) {
    left = { cels: leftCels };
  } else {
    left = { cels: rightCels.map((cel) => ({ ...cel, pixels: Uint8Array.from(cel.pixels) })) };
    adjustments.push("Warning: 'left' was omitted; reused 'right' cels unmirrored.");
  }

  if (!downCels) {
    downCels = rightCels.map((cel) => ({ ...cel, pixels: Uint8Array.from(cel.pixels) }));
    adjustments.push(
      "Warning: 'down' was omitted; reused 'right' cels. The actor will use this facing when moving down.",
    );
  }

  if (mirrorUpFromDown === true) {
    if (rawUp != null) throw new Error("up must be null when mirrorUpFromDown is true.");
    upCels = downCels.map(reverseColumns);
    adjustments.push("Flipped 'up' vertically from 'down'.");
  } else if (!upCels) {
    const sourceName = rawDown != null ? "down" : "right";
    const sourceCels = rawDown != null ? downCels : rightCels;
    upCels = sourceCels.map((cel) => ({ ...cel, pixels: Uint8Array.from(cel.pixels) }));
    adjustments.push(
      `Warning: 'up' was omitted; reused '${sourceName}' cels. The actor will use this facing when moving up.`,
    );
  }

  return {
    spec: {
      loops: [{ cels: rightCels }, left, { cels: downCels }, { cels: upCels }],
      ...(description === null ? {} : { description }),
    },
    adjustments,
  };
}

/** Execute one sprite helper, or return undefined when the name belongs to another registry. */
export function executeSpriteTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (name === "patch_view_cels") {
    try {
      const num = integer(args["num"], "View number", 0, 255);
      if (typeof args["expectedRevision"] !== "string") {
        throw new Error("expectedRevision must be a string.");
      }
      const original = state.container.getResource("view", num);
      if (!original)
        return { success: false, error: `View ${num} is not present in the container.` };
      const actualRevision = resourceRevision(original);
      if (args["expectedRevision"] !== actualRevision) {
        return {
          success: false,
          error: `Stale view ${num} revision: expected ${args["expectedRevision"]}, current revision is ${actualRevision}. Read the cels again before patching.`,
          details: { resource: { kind: "view", num }, revision: actualRevision },
        };
      }
      const before = parseView(original, state.profile);
      const patches = args["patches"];
      if (!Array.isArray(patches) || patches.length < 1 || patches.length > 64)
        throw new Error("patches must name 1..64 cel targets.");
      // Validate every patch against the original snapshot before writing.
      const adjustments: string[] = [];
      const targets = new Map<number, Map<number, BuildCelInput>>();
      let pixels = 0;
      for (const [index, raw] of patches.entries()) {
        const patch = (raw ?? {}) as Record<string, unknown>;
        const loop = integer(patch["loop"], `patches[${index}].loop`, 0, 254);
        const cel = integer(patch["cel"], `patches[${index}].cel`, 0, 254);
        const current = before.loops[loop]?.cels[cel];
        if (!current)
          throw new Error(`patches[${index}]: view ${num} has no loop ${loop}, cel ${cel}.`);
        if (targets.get(loop)?.has(cel))
          throw new Error(`patches[${index}]: duplicate target loop ${loop}, cel ${cel}.`);
        const label = `patches[${index}] (loop ${loop}, cel ${cel})`;
        const hasRows = patch["rows"] !== null && patch["rows"] !== undefined;
        const hasRecolor = patch["recolor"] !== null && patch["recolor"] !== undefined;
        if (hasRows === hasRecolor)
          throw new Error(`${label}: exactly one of "rows" or "recolor" is required.`);
        let replacement: BuildCelInput;
        if (hasRows) {
          replacement = celFromRows(patch["rows"], label, current.transparentColor, adjustments);
        } else {
          const recolor = patch["recolor"];
          if (!Array.isArray(recolor))
            throw new Error(`${label}: recolor must be a list of {from,to} remaps.`);
          const remap = new Map<number, number>();
          for (const [entryIndex, rawEntry] of recolor.entries()) {
            const entry = (rawEntry ?? {}) as Record<string, unknown>;
            const from = integer(entry["from"], `${label}.recolor[${entryIndex}].from`, 0, 15);
            const to = integer(entry["to"], `${label}.recolor[${entryIndex}].to`, 0, 15);
            if (from === to)
              throw new Error(`${label}.recolor[${entryIndex}]: from and to are both ${from}.`);
            if (from === current.transparentColor)
              throw new Error(
                `${label}.recolor[${entryIndex}]: from ${from} is the cel's transparent color; use rows to change transparency.`,
              );
            if (remap.has(from))
              throw new Error(`${label}.recolor[${entryIndex}]: duplicate from ${from}.`);
            remap.set(from, to);
          }
          const pixelsOut = new Uint8Array(current.pixels.length);
          for (let i = 0; i < current.pixels.length; i++) {
            const pixel = current.pixels[i]!;
            pixelsOut[i] = pixel === current.transparentColor ? pixel : (remap.get(pixel) ?? pixel);
          }
          replacement = {
            width: current.width,
            height: current.height,
            transparentColor: current.transparentColor,
            pixels: pixelsOut,
          };
        }
        pixels += replacement.width * replacement.height;
        if (pixels > 32768)
          throw new Error(`patches[${index}]: batch exceeds the 32768-pixel budget.`);
        if (!targets.has(loop)) targets.set(loop, new Map());
        targets.get(loop)!.set(cel, replacement);
      }
      const { payload, spec } = patchedView(original, state, targets, adjustments);
      const after = parseView(payload, state.profile);
      state.container.putResource("view", num, payload);
      state.sources.views.set(num, spec);
      const revision = resourceRevision(payload);
      const geometry = [...targets.entries()].flatMap(([loop, cels]) =>
        [...cels.keys()].map((cel) => {
          const selected = selectViewCel(after, loop, cel)!;
          return {
            loop,
            cel,
            width: selected.width,
            height: selected.height,
            transparentColor: selected.transparentColor,
          };
        }),
      );
      const preview = viewFeedback(payload, state.profile, num);
      return {
        success: true,
        message: `View ${num}: patched ${geometry.length} cel${geometry.length === 1 ? "" : "s"} in one commit; revision ${revision}.`,
        ...(adjustments.length === 0 ? {} : { adjustments }),
        details: {
          resource: { kind: "view", num },
          writtenResources: [{ kind: "view", num }],
          num,
          patches: geometry,
          revision,
        },
        images: [{ png: preview.png, caption: preview.caption }],
      };
    } catch (error) {
      return { success: false, error: `View cels were not patched: ${String(error)}` };
    }
  }

  return undefined;
}
