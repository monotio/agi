/**
 * CLI: turn a PNG sprite sheet into an authentic AGI VIEW resource.
 *
 * Node-only tooling. The minimal PNG *decoder* lives here rather than in
 * src/ because it needs node:zlib; the engine core stays zero-dependency and
 * platform-free (AGENTS.md). Supports 8-bit non-interlaced RGB and RGBA, the
 * two forms every image model and export path produces.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sheet-to-view.ts \
 *     --in sheet.png --out ego.view [options]
 *
 *   --cols N          frames per row in the sheet (default 1)
 *   --rows N          rows of frames (default 1)
 *   --height N        downsample every cel to N logical pixels tall
 *   --aspect N        source pixels per logical pixel in X (default 2)
 *   --key #rrggbb     background key colour ("none" = alpha only;
 *                     omitted = detect from the sheet border)
 *   --no-trim         keep the full grid cell instead of trimming margins
 *   --transparent N   preferred cel transparent colour, 0..15
 *   --desc TEXT       embedded display string
 *   --layout SPEC     loops, ';'-separated. Each is a frame range "0-3",
 *                     a list "0,2,4", or "mirror:N" to mirror loop N.
 *                     Default: one loop per sheet row.
 *   --debug FILE.png  write a contact sheet of the decoded cels
 */

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { parseView } from "../src/view/view.ts";
import {
  buildViewFromSheet,
  cutGrid,
  quantizeToEga,
  type CutGridOptions,
  type QuantizeOptions,
  type SheetLoopLayout,
  type SheetViewLayout,
} from "../src/view/spritesheet.ts";
import { encodePngRgb, EGA_RGB } from "./png.ts";

interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  rgba: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode an 8-bit non-interlaced RGB or RGBA PNG to RGBA. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0) throw new Error("compressed PNGs only (method 0)");
      if (data[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `unsupported PNG: bit depth ${bitDepth}, colour type ${colorType} (need 8-bit RGB or RGBA)`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;

  const concat = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) {
    concat.set(c, off);
    off += c.length;
  }
  const raw = new Uint8Array(inflateSync(concat));
  if (raw.length < (stride + 1) * height) throw new Error("truncated PNG image data");

  // Undo the per-scanline filters (PNG spec 9.2); `prior` is the reconstructed
  // previous row, all zero for the first.
  const out = new Uint8Array(stride * height);
  let prior = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prior[i]!;
      const c = i >= channels ? prior[i - channels]! : 0;
      const x = src[i]!;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      row[i] = value & 0xff;
    }
    prior = row;
  }

  if (channels === 4) return { width, height, rgba: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = out[i * 3]!;
    rgba[i * 4 + 1] = out[i * 3 + 1]!;
    rgba[i * 4 + 2] = out[i * 3 + 2]!;
    rgba[i * 4 + 3] = 0xff;
  }
  return { width, height, rgba };
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'`);
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[name] = "true";
    } else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

/** `"0-3;mirror:0;4,6,8"` -> loop layouts. */
export function parseLayoutSpec(spec: string): SheetLoopLayout[] {
  return spec
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const mirror = /^mirror:(\d+)$/.exec(part);
      if (mirror) return { mirrorOf: Number(mirror[1]) };
      const range = /^(\d+)-(\d+)$/.exec(part);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (to < from) throw new Error(`layout range '${part}' runs backwards`);
        return { frames: Array.from({ length: to - from + 1 }, (_, i) => from + i) };
      }
      const list = part.split(",").map((n) => {
        const value = Number(n.trim());
        if (!Number.isInteger(value) || value < 0) throw new Error(`bad frame index '${n}'`);
        return value;
      });
      return { frames: list };
    });
}

function parseKey(value: string | undefined): QuantizeOptions {
  if (value === undefined) return {};
  if (value === "none") return { keyColor: null };
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(value);
  if (!hex) throw new Error(`--key expects #rrggbb or 'none' (got '${value}')`);
  const n = parseInt(hex[1]!, 16);
  return { keyColor: [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] };
}

/** Contact sheet of every decoded cel, transparency as a grey checkerboard. */
function debugPng(payload: Uint8Array, scaleX: number, scaleY: number): Uint8Array {
  const view = parseView(payload);
  const gap = 2;
  const rowWidths = view.loops.map((loop) =>
    loop.cels.reduce((n, cel) => n + cel.width + gap, gap),
  );
  const rowHeights = view.loops.map((loop) =>
    loop.cels.reduce((n, cel) => Math.max(n, cel.height), 1),
  );
  const cellsWide = Math.max(1, ...rowWidths);
  const cellsHigh = rowHeights.reduce((n, h) => n + h + gap, gap);
  const width = cellsWide * scaleX;
  const height = cellsHigh * scaleY;
  const rgb = new Uint8Array(width * height * 3);
  // Background checkerboard on the logical grid.
  for (let y = 0; y < cellsHigh; y++) {
    for (let x = 0; x < cellsWide; x++) {
      const shade = ((x >> 1) + (y >> 1)) % 2 === 0 ? 0x30 : 0x40;
      paint(rgb, width, x, y, scaleX, scaleY, shade, shade, shade);
    }
  }
  let cursorY = gap;
  for (let l = 0; l < view.loops.length; l++) {
    let cursorX = gap;
    for (const cel of view.loops[l]!.cels) {
      for (let y = 0; y < cel.height; y++) {
        for (let x = 0; x < cel.width; x++) {
          const color = cel.pixels[y * cel.width + x]!;
          if (color === cel.transparentColor) continue;
          const [r, g, b] = EGA_RGB[color & 0x0f]!;
          paint(rgb, width, cursorX + x, cursorY + y, scaleX, scaleY, r, g, b);
        }
      }
      cursorX += cel.width + gap;
    }
    cursorY += rowHeights[l]! + gap;
  }
  return encodePngRgb(width, height, rgb);
}

function paint(
  rgb: Uint8Array,
  width: number,
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let dy = 0; dy < scaleY; dy++) {
    for (let dx = 0; dx < scaleX; dx++) {
      const o = ((y * scaleY + dy) * width + x * scaleX + dx) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
}

function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  const input = args["in"];
  const output = args["out"];
  if (input === undefined || output === undefined) {
    throw new Error("--in <sheet.png> and --out <view.bin> are required");
  }
  const columns = args["cols"] === undefined ? 1 : Number(args["cols"]);
  const rows = args["rows"] === undefined ? 1 : Number(args["rows"]);

  const png = decodePng(new Uint8Array(readFileSync(input)));
  const sheet = quantizeToEga(png.rgba, png.width, png.height, parseKey(args["key"]));

  const cutOptions: CutGridOptions = { trim: args["no-trim"] === undefined };
  if (args["height"] !== undefined) cutOptions.targetHeight = Number(args["height"]);
  if (args["aspect"] !== undefined) cutOptions.pixelAspect = Number(args["aspect"]);
  const frames = cutGrid(sheet, columns, rows, cutOptions);

  const loops: SheetLoopLayout[] =
    args["layout"] === undefined
      ? Array.from({ length: rows }, (_, r) => ({
          frames: Array.from({ length: columns }, (_, c) => r * columns + c),
        }))
      : parseLayoutSpec(args["layout"]);
  const layout: SheetViewLayout = { loops };
  if (args["desc"] !== undefined) layout.description = args["desc"];
  if (args["transparent"] !== undefined) layout.preferTransparent = Number(args["transparent"]);

  const payload = buildViewFromSheet(frames, layout);
  writeFileSync(output, payload);

  // The written bytes must decode: the resource is the contract, not the
  // in-memory frames.
  const decoded = parseView(payload);
  const celCount = decoded.loops.reduce((n, loop) => n + loop.cels.length, 0);
  const first = decoded.loops[0]!.cels[0]!;
  process.stdout.write(
    `${output}: ${payload.length} bytes, ${decoded.loops.length} loops, ${celCount} cels, ` +
      `cel 0 ${first.width}x${first.height} transparent ${first.transparentColor}, ` +
      `key index ${sheet.keyIndex ?? "none"}\n`,
  );

  if (args["debug"] !== undefined) {
    writeFileSync(args["debug"], debugPng(payload, 8, 4));
    process.stdout.write(`${args["debug"]}: cel contact sheet\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `sheet-to-view: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
