#!/usr/bin/env node
/**
 * The README and docs/media images, from the real app and the agent's own tools.
 *
 *   npm run media:capture
 *
 * Browser shots: Playwright drives the app in test mode on its own Vite
 * server (app/playwright.media.config.ts, app/e2e/media/docs.media.ts) at
 * 1440×900 and device scale 2, downsampled to CSS pixels, with the stub
 * provider for any AI state and only the bundled tutorial and original test
 * fixtures on screen. Tool shots: scripts/capture-feedback.ts calls the
 * picture, sound, playtest and navigation tools on the tutorial.
 *
 * Everything is staged in .captures/media first. A PNG of at most 256
 * colours is re-encoded losslessly as an indexed PNG; every PNG must fit the
 * size budget before docs/media is written. The report names each file as
 * new, changed or unchanged, so a rerun shows exactly what the UI changed.
 * Needs Chromium for Playwright (`npm --prefix app exec -- playwright install chromium`).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { decodePng } from "./sheet-to-view.ts";

const ROOT = resolve(import.meta.dirname, "..");
const APP = join(ROOT, "app");
const STAGING = join(ROOT, ".captures/media");
const OUT = join(ROOT, "docs/media");
/** A README image should load quickly: ~350 KB per PNG. */
const BUDGET = 350 * 1024;

/** app/e2e/media/docs.media.ts writes one PNG per test, named after it. */
const BROWSER_SHOTS = [
  "home",
  "tutorial-gallery",
  "create-mode",
  "room-studio",
  "room-studio-walk",
  "studio-ask",
  "sprite-studio",
].map((name) => `${name}.png`);
/** The capture-feedback files the media gallery shows. */
const TOOL_FILES = [
  "picture-controls-1.png",
  "gallery-navigation.png",
  "playtest-lever-2.png",
  "sound-timeline-1.png",
  "sound-preview-1.wav",
];

function run(args: string[], cwd: string, env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed (${result.status})`);
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "latin1"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An indexed PNG from its header, palette and filtered scanlines, deflated at level 9. */
function indexedPng(header: Uint8Array, palette: Uint8Array, scanlines: Uint8Array): Uint8Array {
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", new Uint8Array(deflateSync(scanlines, { level: 9 }))),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * The same pixels in fewer bytes: an indexed PNG is deflated again at level
 * 9, and an opaque RGB(A) PNG of at most 256 colours becomes an indexed one.
 * Anything else, or a larger result, keeps the original bytes.
 */
function compactPng(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = new Map<string, Uint8Array[]>();
  for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
    const type = Buffer.from(bytes.subarray(at + 4, at + 8)).toString("latin1");
    const data = bytes.subarray(at + 8, at + 8 + view.getUint32(at));
    chunks.set(type, [...(chunks.get(type) ?? []), data]);
  }
  const header = chunks.get("IHDR")![0]!;
  const palette = chunks.get("PLTE")?.[0];
  let compact = bytes;
  if (header[9] === 3 && palette && !chunks.has("tRNS")) {
    const scanlines = new Uint8Array(inflateSync(Buffer.concat(chunks.get("IDAT")!)));
    compact = indexedPng(header, palette, scanlines);
  } else if (header[9] === 2 || header[9] === 6) {
    const { width, height, rgba } = decodePng(bytes);
    const indexOf = new Map<number, number>();
    // Each row starts with filter type 0.
    const scanlines = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (rgba[i + 3] !== 255) return bytes;
        const key = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!;
        let index = indexOf.get(key);
        if (index === undefined) {
          if (indexOf.size === 256) return bytes;
          index = indexOf.size;
          indexOf.set(key, index);
        }
        scanlines[y * (width + 1) + 1 + x] = index;
      }
    const colours = new Uint8Array(indexOf.size * 3);
    for (const [key, index] of indexOf)
      colours.set([key >> 16, (key >> 8) & 255, key & 255], index * 3);
    const indexedHeader = Uint8Array.from(header);
    indexedHeader.set([8, 3, 0, 0, 0], 8);
    compact = indexedPng(indexedHeader, colours, scanlines);
  }
  return compact.length < bytes.length ? compact : bytes;
}

rmSync(STAGING, { recursive: true, force: true });
const raw = join(STAGING, "raw");
const tools = join(STAGING, "tools");
mkdirSync(raw, { recursive: true });

run(
  [join(APP, "node_modules/playwright/cli.js"), "test", "--config", "playwright.media.config.ts"],
  APP,
  { AGI_MEDIA_OUT: raw },
);
run(["--experimental-strip-types", join(ROOT, "scripts/capture-feedback.ts"), tools], ROOT);

const staged = [
  ...BROWSER_SHOTS.map((name) => ({ name, from: join(raw, name) })),
  ...TOOL_FILES.map((name) => ({ name, from: join(tools, name) })),
].map(({ name, from }) => {
  const bytes = new Uint8Array(readFileSync(from));
  return { name, bytes: name.endsWith(".png") ? compactPng(bytes) : bytes };
});
const over = staged.filter(({ name, bytes }) => name.endsWith(".png") && bytes.length > BUDGET);
if (over.length)
  throw new Error(
    `Over the ${BUDGET / 1024} KB budget: ${over.map(({ name, bytes }) => `${name} ${Math.round(bytes.length / 1024)} KB`).join(", ")}`,
  );

mkdirSync(OUT, { recursive: true });
for (const { name, bytes } of staged) {
  const target = join(OUT, name);
  const before = existsSync(target) ? new Uint8Array(readFileSync(target)) : null;
  const state = !before ? "new" : Buffer.from(before).equals(bytes) ? "unchanged" : "changed";
  if (state !== "unchanged") writeFileSync(target, bytes);
  console.log(
    `${name.padEnd(26)} ${`${Math.round(bytes.length / 1024)} KB`.padStart(7)}  ${state}`,
  );
}
