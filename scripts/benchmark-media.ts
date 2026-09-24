#!/usr/bin/env node
/**
 * README images from the committed 1.0.0 Genesis benchmark.
 *
 *   node --experimental-strip-types scripts/benchmark-media.ts [out-dir]
 *
 * Writes three images to docs/media (or out-dir), deterministically, from
 * evals/benchmarks/genesis/1.0.0: the Knight's Trial opening as each model
 * drew it, the heroes' walk cycles as an animated PNG, and one room beside
 * its walkability map. Labels use the engine's own 8x8 font.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { decodePng } from "./sheet-to-view.ts";
import { encodePngPaletteRgb, EGA_RGB } from "../src/picture/png.ts";
import { openContainer } from "../src/container/container.ts";
import { parseView, type ViewCel } from "../src/view/view.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { FONT } from "../app/src/font8x8.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT = join(ROOT, "evals/benchmarks/genesis/1.0.0");
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs/media"));

/** An RGB canvas with the few drawing operations the images need. */
class Canvas {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
  constructor(
    width: number,
    height: number,
    background: readonly [number, number, number] = [0, 0, 0],
  ) {
    this.width = width;
    this.height = height;
    this.rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) this.rgb.set(background, i * 3);
  }
  set(x: number, y: number, colour: readonly [number, number, number]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rgb.set(colour, (y * this.width + x) * 3);
  }
  /** Paste a decoded RGBA image at (x, y). */
  paste(image: { width: number; height: number; rgba: Uint8Array }, x: number, y: number): void {
    for (let sy = 0; sy < image.height; sy++)
      for (let sx = 0; sx < image.width; sx++) {
        const i = (sy * image.width + sx) * 4;
        this.set(x + sx, y + sy, [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!]);
      }
  }
  /** Text in the engine's 8x8 font, each font pixel drawn as scale x scale. */
  text(
    value: string,
    x: number,
    y: number,
    scale: number,
    colour: readonly [number, number, number],
  ): void {
    [...value].forEach((char, index) => {
      const code = char.charCodeAt(0);
      for (let row = 0; row < 8; row++)
        for (let col = 0; col < 8; col++)
          if (FONT[code * 8 + row]! & (0x80 >> col))
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++)
                this.set(x + (index * 8 + col) * scale + dx, y + row * scale + dy, colour);
    });
  }
  /** Text centred horizontally within [x, x + width). */
  centred(
    value: string,
    x: number,
    width: number,
    y: number,
    scale: number,
    colour: readonly [number, number, number],
  ): void {
    this.text(value, x + Math.floor((width - value.length * 8 * scale) / 2), y, scale, colour);
  }
}

const WHITE = EGA_RGB[15]!;
const YELLOW = EGA_RGB[14]!;
const GREY = EGA_RGB[7]!;

const read = (path: string) => decodePng(new Uint8Array(readFileSync(path)));

/** The five lanes, in the order the images show them, with the brief's cost. */
const LANES = [
  { id: "anthropic-claude-opus-5-5-lean-high", label: "OPUS 5.5", effort: "HIGH" },
  { id: "anthropic-claude-opus-5-5-lean-medium", label: "OPUS 5.5", effort: "MEDIUM" },
  { id: "openai-gpt-6-astra-lean-medium", label: "GPT-6 ASTRA", effort: "MEDIUM" },
  { id: "openai-gpt-6-sol-lean-medium", label: "GPT-6 SOL", effort: "MEDIUM" },
  { id: "openai-gpt-6-luna-lean-medium", label: "GPT-6 LUNA", effort: "MEDIUM" },
];
const cost = (lane: string, brief: string) =>
  (
    JSON.parse(
      readFileSync(join(SNAPSHOT, "runs", `${lane}--${brief}--r1.report.json`), "utf8"),
    ) as {
      costUsd: number;
    }
  ).costUsd;

/** Knight's Trial's opening, one cell per model, with a title card. */
function castles(): Uint8Array {
  const [cellW, cellH, label, gap] = [320, 200, 48, 8];
  const canvas = new Canvas(3 * cellW + 4 * gap, 2 * (cellH + label) + 3 * gap);
  const cells = LANES.map((lane) => ({
    image: read(join(SNAPSHOT, "runs", `${lane.id}--knights-trial--r1.first-frame.png`)),
    caption: `${lane.label} ${lane.effort}`,
    price: `$${cost(lane.id, "knights-trial").toFixed(2)}`,
  }));
  cells.forEach((cell, index) => {
    const x = gap + (index % 3) * (cellW + gap);
    const y = gap + Math.floor(index / 3) * (cellH + label + gap);
    canvas.paste(cell.image, x, y);
    canvas.centred(cell.caption, x, cellW, y + cellH + 6, 2, WHITE);
    canvas.centred(cell.price, x, cellW, y + cellH + 26, 2, YELLOW);
  });
  // The sixth cell names the brief.
  const x = gap + 2 * (cellW + gap);
  const y = gap + cellH + label + gap;
  canvas.centred("KNIGHT'S TRIAL", x, cellW, y + 60, 2, YELLOW);
  canvas.centred("ONE BRIEF", x, cellW, y + 100, 2, WHITE);
  canvas.centred("FIVE MODELS", x, cellW, y + 124, 2, WHITE);
  return encodePngPaletteRgb(canvas.width, canvas.height, canvas.rgb);
}

/** Every AGI view in a run's generated game. */
function views(lane: string, brief: string): { num: number; loops: ViewCel[][] }[] {
  const dir = join(SNAPSHOT, "runs", `${lane}--${brief}--r1.resources`);
  const files = new Map(
    readdirSync(dir).map((name) => [
      name.toUpperCase(),
      new Uint8Array(readFileSync(join(dir, name))),
    ]),
  );
  const container = openContainer(files);
  const profile = detectProfile(files);
  const found: { num: number; loops: ViewCel[][] }[] = [];
  for (let num = 0; num < 256; num++) {
    const payload = container.getResource("view", num);
    if (payload) found.push({ num, loops: parseView(payload, profile).loops.map((l) => l.cels) });
  }
  return found;
}

/** The hero: the first four-loop view whose right loop animates. */
function hero(lane: string): ViewCel[][] {
  const view = views(lane, "knights-trial").find(
    (candidate) => candidate.loops.length === 4 && candidate.loops[0]!.length > 1,
  );
  if (!view) throw new Error(`${lane}: no animated four-direction hero`);
  return view.loops;
}

/** Minimal APNG: every frame full size, RGB, no disposal or blending. */
function apng(width: number, height: number, frames: Uint8Array[], delayMs: number): Uint8Array {
  const chunks: Uint8Array[] = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)];
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    chunks.push(out);
  };
  const u32 = (...values: number[]) => {
    const out = new Uint8Array(values.length * 4);
    values.forEach((value, i) => new DataView(out.buffer).setUint32(i * 4, value));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  chunk("IHDR", ihdr);
  chunk("acTL", u32(frames.length, 0));
  let sequence = 0;
  frames.forEach((rgb, index) => {
    const control = new Uint8Array(26);
    const view = new DataView(control.buffer);
    view.setUint32(0, sequence++);
    view.setUint32(4, width);
    view.setUint32(8, height);
    view.setUint16(20, delayMs);
    view.setUint16(22, 1000);
    chunk("fcTL", control);
    const raw = new Uint8Array(height * (width * 3 + 1));
    for (let y = 0; y < height; y++)
      raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
    const data = new Uint8Array(deflateSync(raw));
    if (index === 0) chunk("IDAT", data);
    else {
      const sequenced = new Uint8Array(4 + data.length);
      new DataView(sequenced.buffer).setUint32(0, sequence++);
      sequenced.set(data, 4);
      chunk("fdAT", sequenced);
    }
  });
  chunk("IEND", new Uint8Array());
  const out = new Uint8Array(chunks.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Each model's hero walking right and towards the viewer, as an animated PNG. */
function heroes(): Uint8Array {
  const lanes = LANES.filter((lane) => lane.id !== "anthropic-claude-opus-5-5-lean-medium");
  const cast = lanes.map((lane) => ({
    label: lane.label,
    effort: lane.effort,
    loops: hero(lane.id),
  }));
  // AGI pixels are twice as wide as tall: 4 x 8 screen pixels per AGI pixel.
  const [sx, sy] = [8, 4];
  const cellW = 10 * sx;
  const tallest = Math.max(
    ...cast.flatMap((c) => [c.loops[0]!, c.loops[2]!].flat().map((cel) => cel.height)),
  );
  const column = 2 * cellW + 32;
  const [top, spriteH, labelH] = [12, tallest * sy, 48];
  const width = cast.length * column + 16;
  const height = top + spriteH + 12 + labelH;
  const frameCount = Math.max(
    ...cast.map((c) => c.loops[0]!.length),
    ...cast.map((c) => c.loops[2]!.length),
  );
  const frames: Uint8Array[] = [];
  for (let frame = 0; frame < frameCount * 2; frame++) {
    const canvas = new Canvas(width, height, [24, 24, 32]);
    cast.forEach((member, index) => {
      const left = 16 + index * column;
      [0, 2].forEach((loop, side) => {
        const cels = member.loops[loop]!;
        const cel = cels[frame % cels.length]!;
        const x0 = left + side * (cellW + 16) + Math.floor((cellW - cel.width * sx) / 2);
        const y0 = top + spriteH - cel.height * sy;
        for (let y = 0; y < cel.height; y++)
          for (let x = 0; x < cel.width; x++) {
            const colour = cel.pixels[y * cel.width + x]!;
            if (colour === cel.transparentColor) continue;
            for (let dy = 0; dy < sy; dy++)
              for (let dx = 0; dx < sx; dx++)
                canvas.set(x0 + x * sx + dx, y0 + y * sy + dy, EGA_RGB[colour]!);
          }
      });
      for (let x = left - 4; x < left + column - 12; x++) canvas.set(x, top + spriteH + 2, GREY);
      canvas.centred(member.label, left - 8, column, top + spriteH + 12, 2, WHITE);
      canvas.centred(member.effort, left - 8, column, top + spriteH + 32, 2, GREY);
    });
    frames.push(canvas.rgb);
  }
  return apng(width, height, frames, 200);
}

/** One room as the player sees it, beside the depth and walkability the game keeps. */
function depth(): Uint8Array {
  const base = join(SNAPSHOT, "matrix/knights-trial/anthropic-claude-opus-5-5-lean-high");
  const visual = read(`${base}-visual.png`);
  const walk = read(`${base}-walk.png`);
  const gap = 12;
  const canvas = new Canvas(visual.width + walk.width + 3 * gap, visual.height + 2 * gap + 28);
  canvas.paste(visual, gap, gap);
  canvas.paste(walk, 2 * gap + visual.width, gap);
  canvas.centred("WHAT YOU SEE", gap, visual.width, gap + visual.height + 10, 2, WHITE);
  canvas.centred(
    "WHERE YOU CAN WALK",
    2 * gap + visual.width,
    walk.width,
    gap + visual.height + 10,
    2,
    WHITE,
  );
  return encodePngPaletteRgb(canvas.width, canvas.height, canvas.rgb);
}

const outputs: Record<string, Uint8Array> = {
  "genesis-castles.png": castles(),
  "genesis-heroes.png": heroes(),
  "genesis-depth.png": depth(),
};
for (const [name, bytes] of Object.entries(outputs)) {
  writeFileSync(join(OUT, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
