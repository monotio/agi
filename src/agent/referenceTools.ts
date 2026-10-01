import { toolDescription, parameterDescriptions } from "../vocabulary.ts";
/**
 * Reference art by handle. The player's uploads (room plates, character
 * sheets, mood boards) reach the model as ids: a turn carries one
 * manifest line per image plus a single contact strip of 64-pixel thumbnails,
 * and the model calls read_reference_image for the size or region it needs. A
 * viewed image stays in the conversation: the transcript is append-only so
 * the provider's prompt cache keeps serving it at the cache-read rate, which
 * is far cheaper than rewriting the history that follows it to drop it
 * (measured by evals/cache-probe.ts).
 *
 * Ids are content-derived, the first ten hex digits of the stored bytes'
 * SHA-256, so they stay the same across reloads, copies and exports. The host decodes pixels (a browser canvas, or a script in the
 * evals); this module only resamples, crops, overlays a grid and encodes PNG,
 * so it runs unchanged in the browser, a worker and Node.
 */
import { sha256Hex } from "../crypto.ts";
import { EGA_RGB, encodePngRgb } from "../picture/png.ts";
import { EGA_COLOUR_NAMES } from "../studio/sceneGroups.ts";
import type { AgentToolImage, AgentToolResult } from "./agentState.ts";
import type { ToolDefinition } from "./tools.ts";
import { REFERENCE_WORKING_EDGE } from "./toolTransport.ts";

/** Longest edge of a thumbnail: the manifest strip and read_reference_image size "thumb". */
const THUMB_EDGE = 64;
/** Longest edge of read_reference_image size "small". */
const SMALL_EDGE = 256;
/** Longest edge a region is enlarged to at size "full"; "small" and "thumb" use their own edges. */
const REGION_EDGE = 512;
/** Gutter around and between contact-strip tiles. */
const STRIP_GAP = 4;
const STRIP_COLUMNS = 8;
/** Pixels the colour summary samples at most; larger images are read on a stride. */
const COLOUR_SAMPLES = 262_144;
/** Transparent pixels are shown over this grey. */
const BACKDROP = 128;

type ReferenceTarget =
  | { readonly kind: "room"; readonly num: number }
  | { readonly kind: "view"; readonly num: number }
  | { readonly kind: "general" };

/** Decoded pixels, row-major RGBA, straight (not premultiplied) alpha. */
export interface ReferenceBitmap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

/** One stored reference image, as a task sees it. */
export interface ReferenceArt {
  /** Content-derived handle, `referenceArtId` of the stored bytes. */
  readonly id: string;
  /** What it is: "Room plate", "Character sheet, right-facing row". */
  readonly label: string;
  readonly target: ReferenceTarget;
  /** The player's note, verbatim. */
  readonly note: string;
  /** The player attached it to this request. */
  readonly attached: boolean;
  /** Working-size pixels (see workingBitmap). */
  pixels(): ReferenceBitmap | Promise<ReferenceBitmap>;
}

/** The reference art a task may view. */
export interface ReferenceSource {
  readonly art: readonly ReferenceArt[];
}

/** The stable handle for a stored reference image's bytes. */
export function referenceArtId(bytes: Uint8Array): string {
  return `art-${sha256Hex(bytes).slice(0, 10)}`;
}

/** Dimensions with the longest edge at most `edge`, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Resample the source rectangle to `dw` x `dh` RGBA: an area average when
 * shrinking, nearest neighbour when enlarging (a whole factor repeats each
 * pixel exactly, so pixel art stays crisp). Colour is averaged by alpha.
 */
function resample(
  bitmap: ReferenceBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const { rgba, width } = bitmap;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = sy + Math.floor((dy * sh) / dh);
    const y1 = Math.max(y0 + 1, sy + Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = sx + Math.floor((dx * sw) / dw);
      const x1 = Math.max(x0 + 1, sx + Math.floor(((dx + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const at = (y * width + x) * 4;
          const alpha = rgba[at + 3]!;
          r += rgba[at]! * alpha;
          g += rgba[at + 1]! * alpha;
          b += rgba[at + 2]! * alpha;
          a += alpha;
        }
      const o = (dy * dw + dx) * 4;
      const n = (x1 - x0) * (y1 - y0);
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** RGBA over the grey backdrop, as RGB. */
function toRgb(rgba: Uint8Array): Uint8Array {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    const alpha = rgba[i + 3]!;
    for (let c = 0; c < 3; c++)
      rgb[o + c] = Math.round((rgba[i + c]! * alpha + BACKDROP * (255 - alpha)) / 255);
  }
  return rgb;
}

/** The bitmap at the working size: longest edge REFERENCE_WORKING_EDGE. */
export function workingBitmap(bitmap: ReferenceBitmap): ReferenceBitmap {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, REFERENCE_WORKING_EDGE);
  if (width === bitmap.width && height === bitmap.height) return bitmap;
  return {
    width,
    height,
    rgba: resample(bitmap, 0, 0, bitmap.width, bitmap.height, width, height),
  };
}

/** Nearest EGA colour index by squared RGB distance. */
function nearestEga(r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < EGA_RGB.length; index++) {
    const [er, eg, eb] = EGA_RGB[index]!;
    const distance = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Pixel share per EGA colour after quantising each opaque pixel to its
 * nearest palette entry, plus the transparent share. Large areas are sampled
 * on an even stride.
 */
function egaShares(
  bitmap: ReferenceBitmap,
  area: { x: number; y: number; w: number; h: number } = {
    x: 0,
    y: 0,
    w: bitmap.width,
    h: bitmap.height,
  },
): { shares: number[]; transparent: number } {
  const step = Math.max(1, Math.ceil(Math.sqrt((area.w * area.h) / COLOUR_SAMPLES)));
  const counts = new Array<number>(16).fill(0);
  const memo = new Map<number, number>();
  let transparent = 0;
  let total = 0;
  for (let y = area.y; y < area.y + area.h; y += step)
    for (let x = area.x; x < area.x + area.w; x += step) {
      const at = (y * bitmap.width + x) * 4;
      total++;
      if (bitmap.rgba[at + 3]! < 128) {
        transparent++;
        continue;
      }
      const key = (bitmap.rgba[at]! << 16) | (bitmap.rgba[at + 1]! << 8) | bitmap.rgba[at + 2]!;
      let index = memo.get(key);
      if (index === undefined) {
        index = nearestEga(bitmap.rgba[at]!, bitmap.rgba[at + 1]!, bitmap.rgba[at + 2]!);
        memo.set(key, index);
      }
      counts[index]!++;
    }
  return {
    shares: counts.map((count) => (total ? count / total : 0)),
    transparent: total ? transparent / total : 0,
  };
}

/** "blue 38%, light cyan 21%": up to four AGI colours holding at least 2% each. */
function colourSummary(
  bitmap: ReferenceBitmap,
  area?: { x: number; y: number; w: number; h: number },
): string {
  const { shares, transparent } = egaShares(bitmap, area);
  const parts = shares
    .map((share, index) => ({ share, name: EGA_COLOUR_NAMES[index]! }))
    .filter(({ share }) => share >= 0.02)
    .sort((a, b) => b.share - a.share)
    .slice(0, 4)
    .map(({ share, name }) => `${name} ${Math.round(share * 100)}%`);
  if (transparent >= 0.02) parts.push(`transparent ${Math.round(transparent * 100)}%`);
  return parts.join(", ") || "mixed colours";
}

function targetText(target: ReferenceTarget): string {
  return target.kind === "general" ? "general" : `${target.kind} ${target.num}`;
}

/** One manifest line: id · label · target · WxH · colours · [attached] · [note]. */
function manifestLine(art: ReferenceArt, bitmap: ReferenceBitmap, colours: string): string {
  const note = art.note.trim().replace(/\s+/g, " ");
  return [
    art.id,
    art.label,
    targetText(art.target),
    `${bitmap.width}x${bitmap.height}`,
    colours,
    ...(art.attached ? ["attached to this request"] : []),
    ...(note
      ? [`note: ${JSON.stringify(note.length > 160 ? `${note.slice(0, 157)}...` : note)}`]
      : []),
  ].join(" · ");
}

/** Thumbnails in one image: 64-pixel cells, a 4-pixel gutter, up to eight per row. */
function contactStrip(thumbs: readonly { width: number; height: number; rgb: Uint8Array }[]) {
  const columns = Math.min(STRIP_COLUMNS, thumbs.length);
  const rows = Math.ceil(thumbs.length / STRIP_COLUMNS);
  const width = columns * THUMB_EDGE + (columns + 1) * STRIP_GAP;
  const height = rows * THUMB_EDGE + (rows + 1) * STRIP_GAP;
  const rgb = new Uint8Array(width * height * 3).fill(0x33);
  thumbs.forEach((thumb, index) => {
    const cellX = STRIP_GAP + (index % STRIP_COLUMNS) * (THUMB_EDGE + STRIP_GAP);
    const cellY = STRIP_GAP + Math.floor(index / STRIP_COLUMNS) * (THUMB_EDGE + STRIP_GAP);
    const left = cellX + Math.floor((THUMB_EDGE - thumb.width) / 2);
    const top = cellY + Math.floor((THUMB_EDGE - thumb.height) / 2);
    for (let y = 0; y < thumb.height; y++)
      rgb.set(
        thumb.rgb.subarray(y * thumb.width * 3, (y + 1) * thumb.width * 3),
        ((top + y) * width + left) * 3,
      );
  });
  return encodePngRgb(width, height, rgb);
}

/**
 * The manifest a turn carries instead of the pictures: one line per image and
 * one contact strip of thumbnails in the same order.
 */
export async function referenceManifest(
  source: ReferenceSource,
): Promise<{ text: string; image: AgentToolImage }> {
  const lines: string[] = [];
  const thumbs: { width: number; height: number; rgb: Uint8Array }[] = [];
  for (const art of source.art) {
    let bitmap: ReferenceBitmap;
    try {
      bitmap = await art.pixels();
    } catch {
      // One unreadable image must not cost the turn its other references.
      lines.push(`${art.id} · ${art.label} · ${targetText(art.target)} · could not be decoded`);
      thumbs.push({ width: 1, height: 1, rgb: new Uint8Array(3).fill(BACKDROP) });
      continue;
    }
    lines.push(manifestLine(art, bitmap, colourSummary(bitmap)));
    const size = fitWithin(bitmap.width, bitmap.height, THUMB_EDGE);
    thumbs.push({
      ...size,
      rgb: toRgb(resample(bitmap, 0, 0, bitmap.width, bitmap.height, size.width, size.height)),
    });
  }
  const ids = source.art.map((art) => art.id).join(", ");
  return {
    text: [
      "### REFERENCE ART",
      "The player's reference art, one line per image: id · what it is · target · size in pixels · main AGI colours · note. The strip shows each as a thumbnail; only the thumbnails are in view. Call read_reference_image with an id before you match anything to it. It shows the whole image at the working size unless you ask for a smaller look or a region.",
      ...lines,
    ].join("\n"),
    image: {
      png: contactStrip(thumbs),
      caption: `Reference thumbnails, left to right and top to bottom: ${ids}. Each fits ${THUMB_EDGE}x${THUMB_EDGE}.`,
    },
  };
}

type ViewSize = "thumb" | "small" | "full";

/**
 * The views that would show more than this one, named in the result so the
 * model's next call can be exact: a smaller look points to the working size,
 * a whole image to a region, and a region to its grid.
 */
function moreViews(
  size: ViewSize,
  region: { x: number; y: number; w: number; h: number } | null,
  dims: string,
  gridded: boolean,
): string {
  const grid = gridded ? "" : " grid: true labels source coordinates for an exact next region.";
  if (size !== "full")
    return region
      ? `size full shows this region enlarged up to ${REGION_EDGE} px.`
      : `For shapes, poses and outlines, view it at size full (${dims}) or a region of it.`;
  return region
    ? grid.trim()
    : `For fine detail, view a region: it is enlarged by a whole factor up to ${REGION_EDGE} px.${grid}`;
}

export const VIEW_REFERENCE_TOOL: ToolDefinition = {
  name: "read_reference_image",
  description: toolDescription(
    "read_reference_image",
    "Look at the player's reference art by `id`, the art-… handle from the reference list. The request carries only a manifest line and a thumbnail per reference; view one before you match anything to it. `size`: null or full shows the stored image (up to 1024 px, longest edge), the size for tracing shapes, poses and outlines; small (256 px) and thumb (64 px) are cheaper looks at colour and composition. `region` crops x, y, w, h in the reference's own pixels (the size its manifest line gives) and enlarges the crop by a whole factor up to 512 px (256 at small, 64 at thumb); null shows the whole image. `grid`: true draws lines labelled in the reference's pixel coordinates, so the next region can be exact. Each result names the views that would show more. A viewed image stays in the conversation, so view each reference once at the size and region you need.",
  ),
  parameters: parameterDescriptions("read_reference_image", {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: "^art-[0-9a-f]{10}$" },
      size: { type: ["string", "null"], enum: ["thumb", "small", "full", null] },
      region: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          x: { type: "integer", minimum: 0, maximum: 4095 },
          y: { type: "integer", minimum: 0, maximum: 4095 },
          w: { type: "integer", minimum: 1, maximum: 4096 },
          h: { type: "integer", minimum: 1, maximum: 4096 },
        },
        required: ["x", "y", "w", "h"],
      },
      grid: { type: ["boolean", "null"] },
    },
    required: ["id", "size", "region", "grid"],
  }),
};

export const NO_REFERENCES = "No reference art is attached to this task.";

/** 3x5 digits for grid labels, row strings top to bottom. */
const DIGITS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

/** Grid spacings in source pixels; the first giving at most ten divisions is used. */
const GRID_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

function gridStep(span: number): number {
  return GRID_STEPS.find((step) => span / step <= 10) ?? 1000;
}

/**
 * Dashed black-and-white lines every `step` source pixels over the view of
 * `view` (source rectangle) drawn at outW x outH, each labelled with its
 * source coordinate: x along the top edge, y down the left edge.
 */
function drawGrid(
  rgb: Uint8Array,
  outW: number,
  outH: number,
  view: { x: number; y: number; w: number; h: number },
  step: number,
): void {
  const put = (x: number, y: number, value: number) => {
    if (x < 0 || y < 0 || x >= outW || y >= outH) return;
    rgb.fill(value, (y * outW + x) * 3, (y * outW + x) * 3 + 3);
  };
  const dash = (i: number) => ((i >> 1) & 1 ? 255 : 0);
  const scale = Math.max(outW, outH) >= 384 ? 2 : 1;
  const label = (text: string, left: number, top: number) => {
    const boxW = text.length * 4 * scale + scale;
    const boxH = 7 * scale;
    for (let y = 0; y < boxH; y++) for (let x = 0; x < boxW; x++) put(left + x, top + y, 0);
    [...text].forEach((digit, index) =>
      DIGITS[digit]!.forEach((row, gy) =>
        [...row].forEach((bit, gx) => {
          if (bit !== "1") return;
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              put(
                left + scale + index * 4 * scale + gx * scale + sx,
                top + scale + gy * scale + sy,
                255,
              );
        }),
      ),
    );
    return { right: left + boxW, bottom: top + boxH };
  };
  const columns: { at: number; value: number }[] = [];
  const rows: { at: number; value: number }[] = [];
  for (let c = Math.ceil(view.x / step) * step; c < view.x + view.w; c += step) {
    const at = Math.round(((c - view.x) * outW) / view.w);
    if (at >= outW) continue;
    columns.push({ at, value: c });
    for (let y = 0; y < outH; y++) put(at, y, dash(y));
  }
  for (let c = Math.ceil(view.y / step) * step; c < view.y + view.h; c += step) {
    const at = Math.round(((c - view.y) * outH) / view.h);
    if (at >= outH) continue;
    rows.push({ at, value: c });
    for (let x = 0; x < outW; x++) put(x, at, dash(x));
  }
  const band = 7 * scale + 2;
  let right = -1;
  for (const { at, value } of columns)
    if (at + 1 > right) right = label(String(value), at + 1, 1).right + scale;
  let bottom = band;
  for (const { at, value } of rows)
    if (at + 1 >= bottom) bottom = label(String(value), 1, at + 1).bottom + scale;
}

/** read_reference_image: the image at a size or a region, with an optional grid. */
export async function viewReference(
  source: ReferenceSource | undefined,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  if (!source?.art.length) return { success: false, error: NO_REFERENCES };
  const id = String(args["id"]);
  const art = source.art.find((candidate) => candidate.id === id);
  if (!art)
    return {
      success: false,
      error: `No reference art has the id ${id}. This request has ${source.art.map((candidate) => candidate.id).join(", ")}.`,
    };
  let bitmap: ReferenceBitmap;
  try {
    bitmap = await art.pixels();
  } catch {
    return { success: false, error: `${id} could not be decoded in this browser.` };
  }
  // Left out, the tool shows the working size: the one that holds shapes.
  const size = (args["size"] ?? "full") as ViewSize;
  const region = args["region"] as { x: number; y: number; w: number; h: number } | null;
  const dims = `${bitmap.width}x${bitmap.height}`;
  if (region) {
    const edges = [
      ["x", region.x + region.w, bitmap.width, "right"],
      ["y", region.y + region.h, bitmap.height, "bottom"],
    ] as const;
    for (const [axis, end, limit, edge] of edges)
      if (end > limit)
        return {
          success: false,
          error: `That region ends at ${axis} ${end}, past the ${edge} edge of ${id} (${dims}). Keep x + w within ${bitmap.width} and y + h within ${bitmap.height}.`,
        };
  }
  const view = region ?? { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  let outW: number;
  let outH: number;
  let scale: number | null = null;
  let viewedAt: string;
  if (region) {
    const edge = size === "thumb" ? THUMB_EDGE : size === "small" ? SMALL_EDGE : REGION_EDGE;
    const longest = Math.max(region.w, region.h);
    if (longest <= edge) {
      scale = Math.floor(edge / longest);
      outW = region.w * scale;
      outH = region.h * scale;
    } else ({ width: outW, height: outH } = fitWithin(region.w, region.h, edge));
    viewedAt = `region x ${region.x}, y ${region.y}, ${region.w}x${region.h}, shown at ${scale !== null ? `${scale}x ` : ""}(${outW}x${outH})`;
  } else {
    ({ width: outW, height: outH } =
      size === "full"
        ? { width: bitmap.width, height: bitmap.height }
        : fitWithin(bitmap.width, bitmap.height, size === "thumb" ? THUMB_EDGE : SMALL_EDGE));
    viewedAt = `${size} (${outW}x${outH} of ${dims})`;
  }
  const rgb = toRgb(resample(bitmap, view.x, view.y, view.w, view.h, outW, outH));
  const step = args["grid"] === true ? gridStep(Math.max(view.w, view.h)) : null;
  if (step !== null) drawGrid(rgb, outW, outH, view, step);
  const colours = colourSummary(bitmap, view);
  const gridText =
    step !== null ? `; grid every ${step} source pixels, labelled in source coordinates` : "";
  const more = moreViews(size, region, dims, step !== null);
  return {
    success: true,
    message: `${id} at ${viewedAt}${gridText}. Colours here: ${colours}.${more ? ` ${more}` : ""}`,
    details: {
      id,
      size,
      region,
      grid: step,
      source: { width: bitmap.width, height: bitmap.height },
      output: { width: outW, height: outH },
      scale,
      colours,
    },
    images: [
      {
        png: encodePngRgb(outW, outH, rgb),
        caption: `Reference ${id} viewed at ${viewedAt}${gridText}. ${manifestLine(art, bitmap, colourSummary(bitmap))}`,
      },
    ],
  };
}

/** Tools whose success writes art a reference could be matched against. */
const ART_WRITES: ReadonlySet<string> = new Set([
  "write_picture",
  "draw_picture_items",
  "write_room",
  "write_view",
  "edit_cels",
  "propose_changes",
]);

/** A reply that says the work follows the reference. */
const MATCH_CLAIM =
  /\b(match(es|ed|ing)?|follow(s|ed|ing)?|based on|according to|like (the|your)|from (the|your) (reference|sketch|sheet|art|drawing))\b/i;

/**
 * Under-fetch: attached references a turn wrote art for, or claimed to
 * match, without a successful read_reference_image of that id. Read from the
 * turn's tool log; the claim is read from its final reply.
 */
export function referenceUnderFetch(turn: {
  readonly attached: readonly string[];
  readonly calls: readonly {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly success: boolean;
  }[];
  readonly text: string;
}): string[] {
  if (!turn.attached.length) return [];
  const viewed = new Set(
    turn.calls
      .filter((call) => call.tool === "read_reference_image" && call.success)
      .map((call) => call.args["id"]),
  );
  const wrote = turn.calls.some((call) => ART_WRITES.has(call.tool) && call.success);
  if (!wrote && !MATCH_CLAIM.test(turn.text)) return [];
  return turn.attached.filter((id) => !viewed.has(id));
}

/**
 * One turn's reference log. `record` passes each tool result through and,
 * after an art write while an attached reference is still unviewed, adds a
 * line naming it; `unviewed` reads the under-fetch from the final reply.
 */
export function createReferenceWatch(source: ReferenceSource | undefined) {
  const attached = (source?.art ?? []).filter((art) => art.attached).map((art) => art.id);
  const calls: { tool: string; args: Record<string, unknown>; success: boolean }[] = [];
  return {
    attached,
    record(tool: string, args: Record<string, unknown>, result: AgentToolResult): AgentToolResult {
      calls.push({ tool, args, success: result.success });
      if (!result.success || !ART_WRITES.has(tool)) return result;
      const missing = referenceUnderFetch({ attached, calls, text: "" });
      if (!missing.length) return result;
      return {
        ...result,
        message: `${result.message ?? "Done."}\nReference art attached to this request has not been viewed: ${missing.join(", ")}. Call read_reference_image before matching the art to it.`,
      };
    },
    unviewed(text: string): string[] {
      return referenceUnderFetch({ attached, calls, text });
    },
  };
}
