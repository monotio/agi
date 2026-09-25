/** Bounded, row-oriented helpers for mechanical AGI sprite authoring. */
import { resourceCacheHint } from "./authoringState.ts";
import type { AgentSessionState, AgentToolResult, ToolDefinition } from "./tools.ts";
import { viewFeedback } from "./viewFeedback.ts";

import { patchedView } from "../view/celEdit.ts";
import { parseView, selectViewCel, type BuildCelInput } from "../view/view.ts";

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
      const actualRevision = resourceCacheHint(original);
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
      const { payload, spec } = patchedView(original, state.profile, targets, adjustments);
      const after = parseView(payload, state.profile);
      // Everything that can fail runs before the commit, so "not patched"
      // is true whenever it is reported.
      const revision = resourceCacheHint(payload);
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
      state.container.putResource("view", num, payload);
      state.sources.views.set(num, spec);
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
