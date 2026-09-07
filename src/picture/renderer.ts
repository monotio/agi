/**
 * AGI picture-resource command-stream decoder (full-EGA, profile 2.936).
 *
 * Decodes the byte stream of a picture resource onto a PictureSurface per
 * Peter Kelly's agi-re behavioral specification, "Picture Resources and Rendering":
 * drawing channels, path commands with the normative integer line
 * rasterization, seed fill, and shaped/stippled pattern plots with the v2
 * shaped-brush geometry (horizontal limit 320) and linear right-edge wrap.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, type PictureSurface } from "../types.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

/** Column masks for pattern plot columns 0..7. */
const COLUMN_MASKS: readonly number[] = [
  0x8000, 0x2000, 0x0800, 0x0200, 0x0080, 0x0020, 0x0008, 0x0002,
];

/** Geometric row words per radius for the shaped-brush v2 family. */
const ROW_WORDS_V2: readonly (readonly number[])[] = [
  [0x8000],
  [0xe000, 0xe000, 0xe000],
  [0x7000, 0xf800, 0xf800, 0xf800, 0x7000],
  [0x3800, 0x7c00, 0xfe00, 0xfe00, 0xfe00, 0x7c00, 0x3800],
  [0x1c00, 0x7f00, 0xff80, 0xff80, 0xff80, 0xff80, 0xff80, 0x7f00, 0x1c00],
  [0x0e00, 0x3f80, 0x7fc0, 0x7fc0, 0xffe0, 0xffe0, 0xffe0, 0x7fc0, 0x7fc0, 0x3f80, 0x1f00],
  [
    0x0f80, 0x3fe0, 0x7ff0, 0x7ff0, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0x7ff0, 0x7ff0, 0x3fe0,
    0x0f80,
  ],
  [
    0x07c0, 0x1ff0, 0x3ff8, 0x7ffc, 0x7ffc, 0xfffe, 0xfffe, 0xfffe, 0xfffe, 0xfffe, 0x7ffc, 0x7ffc,
    0x3ff8, 0x1ff0, 0x07c0,
  ],
];

export interface RenderPictureOptions {
  /** Decode over existing cells without resetting (overlay semantics). */
  overlay?: boolean;
  /** Select command vocabulary and pattern geometry for the running game. */
  profile?: AgiProfile;
  /** Optional per-seed observations for authoring diagnostics. */
  fillDiagnostics?: PictureFillDiagnostic[];
}

export interface PictureFillDiagnostic {
  channel: "visual" | "priority";
  x: number;
  y: number;
  selectedValue: number;
  targetValue: number;
  seedValue: number;
  filledCells: number;
}

/**
 * Decode a picture command stream onto `surface`.
 *
 * Default (prepare) semantics reset the surface first; `overlay: true`
 * preserves existing cells. Either way, decoding starts with both drawing
 * channels disabled and pattern mode zero, and processes bytes until 0xff.
 */
export function renderPicture(
  payload: Uint8Array,
  surface: PictureSurface,
  opts?: RenderPictureOptions,
): void {
  const profile = opts?.profile ?? DEFAULT_V2_PROFILE;
  if (!opts?.overlay) {
    surface.reset();
  }

  let pos = 0;
  let visualEnabled = false;
  let priorityEnabled = false;
  let visualColor = 0;
  let priorityValue = 0;
  let patternMode = 0;

  /**
   * Write the cell at a linear row-major index using the channel rule:
   * enabled channels are replaced, disabled channels preserved. Pattern
   * candidates may address linear index row*160+160 (wrap to the next row's
   * X 0); an index beyond the surface has no effect.
   */
  const writeCell = (index: number): void => {
    if (index < 0 || index >= SCREEN_WIDTH * SCREEN_HEIGHT) return;
    if (visualEnabled) surface.visual[index] = visualColor;
    if (priorityEnabled) surface.priority[index] = priorityValue;
  };

  const plot = (x: number, y: number): void => {
    writeCell(y * SCREEN_WIDTH + x);
  };

  /**
   * Normative integer line rasterization. The start point is already plotted;
   * this plots `major` further points including the endpoint. The error
   * accumulators are modulo-256 and must not be widened.
   */
  const drawLine = (x0: number, y0: number, x1: number, y1: number): void => {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const xstep = x1 >= x0 ? 1 : -1;
    const ystep = y1 >= y0 ? 1 : -1;
    let major: number;
    let xerror: number;
    let yerror: number;
    if (dx >= dy) {
      major = dx;
      xerror = 0;
      yerror = dx >> 1;
    } else {
      major = dy;
      xerror = dy >> 1;
      yerror = 0;
    }
    let x = x0;
    let y = y0;
    for (let i = 0; i < major; i++) {
      yerror = (yerror + dy) & 0xff;
      if (yerror >= major) {
        yerror = (yerror - major) & 0xff;
        y += ystep;
      }
      xerror = (xerror + dx) & 0xff;
      if (xerror >= major) {
        xerror = (xerror - major) & 0xff;
        x += xstep;
      }
      plot(x, y);
    }
  };

  /**
   * Four-connected seed fill. Visual enabled: connectivity on the visual
   * channel, target 15. Otherwise priority enabled: connectivity on the
   * priority channel, target 4. Otherwise no effect. A fill whose selected
   * value equals the target, or whose seed does not hold the target value,
   * has no effect. The whole region is written with the normal channel rule.
   */
  const floodFill = (sx: number, sy: number): void => {
    let channel: Uint8Array;
    let channelName: PictureFillDiagnostic["channel"];
    let selectedValue: number;
    let target: number;
    if (visualEnabled) {
      if (visualColor === 15) return;
      channel = surface.visual;
      channelName = "visual";
      selectedValue = visualColor;
      target = 15;
    } else if (priorityEnabled) {
      if (priorityValue === 4) return;
      channel = surface.priority;
      channelName = "priority";
      selectedValue = priorityValue;
      target = 4;
    } else {
      return;
    }
    const start = sy * SCREEN_WIDTH + sx;
    const seedValue = channel[start]!;
    if (seedValue !== target) {
      opts?.fillDiagnostics?.push({
        channel: channelName,
        x: sx,
        y: sy,
        selectedValue,
        targetValue: target,
        seedValue,
        filledCells: 0,
      });
      return;
    }
    // Writing replaces the target value in the connectivity channel (the
    // selected value differs from the target), so written cells double as
    // the visited set.
    const stack: number[] = [start];
    let filledCells = 0;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (channel[idx] !== target) continue;
      writeCell(idx);
      filledCells++;
      const x = idx % SCREEN_WIDTH;
      if (x > 0) stack.push(idx - 1);
      if (x < SCREEN_WIDTH - 1) stack.push(idx + 1);
      if (idx >= SCREEN_WIDTH) stack.push(idx - SCREEN_WIDTH);
      if (idx < SCREEN_WIDTH * (SCREEN_HEIGHT - 1)) stack.push(idx + SCREEN_WIDTH);
    }
    opts?.fillDiagnostics?.push({
      channel: channelName,
      x: sx,
      y: sy,
      selectedValue,
      targetValue: target,
      seedValue,
      filledCells,
    });
  };

  /** One shaped-brush v2 pattern plot at clamped logical coordinates. */
  const plotPattern = (x: number, y: number, seed: number): void => {
    const r = patternMode & 0x07;
    const bypassMask = (patternMode & 0x10) !== 0;
    const stipple = (patternMode & 0x20) !== 0;
    let doubledX = 2 * x - r;
    if (doubledX < 0) doubledX = 0;
    const maxDoubledX = (profile.patternProfile === "v3-center-row" ? 318 : 320) - 2 * r;
    if (doubledX > maxDoubledX) doubledX = maxDoubledX;
    const startX = doubledX >> 1;
    let startY = y - r;
    if (startY < 0) startY = 0;
    const maxStartY = 167 - 2 * r;
    if (startY > maxStartY) startY = maxStartY;
    const rows =
      r === 1 && profile.patternProfile === "v3-center-row"
        ? [0x4000, 0xe000, 0x4000]
        : ROW_WORDS_V2[r]!;
    let state = (seed | 1) & 0xff;
    for (let row = 0; row < rows.length; row++) {
      const rowWord = rows[row]!;
      const cellY = startY + row;
      for (let col = 0; col <= r; col++) {
        if (!bypassMask && (rowWord & COLUMN_MASKS[col]!) === 0) continue;
        if (stipple) {
          const carry = state & 1;
          state >>= 1;
          if (carry !== 0) state ^= 0xb8;
          // Write only when bit 0 is clear and bit 1 is set.
          if ((state & 3) !== 2) continue;
        }
        writeCell(cellY * SCREEN_WIDTH + startX + col);
      }
    }
  };

  /**
   * Guarded data reader: accepts only bytes 0x00..0xef. A byte >= 0xf0
   * terminates the current command without being consumed.
   */
  const readGuarded = (): number => {
    const b = payload[pos];
    if (b === undefined || b >= 0xf0) return -1;
    pos += 1;
    return b;
  };

  /** Raw operand reader (after 0xf0/0xf2/0xf9): consumed even if >= 0xf0. */
  const readRaw = (): number => {
    const b = payload[pos];
    if (b === undefined) return -1;
    pos += 1;
    return b;
  };

  /**
   * Guarded coordinate pair, clamped to 159/167. If X is accepted but Y is a
   * command byte, the pair draws nothing and the command byte stays pending.
   */
  const readPair = (): { x: number; y: number } | null => {
    const gx = readGuarded();
    if (gx < 0) return null;
    const gy = readGuarded();
    if (gy < 0) return null;
    return { x: Math.min(gx, 159), y: Math.min(gy, 167) };
  };

  while (pos < payload.length) {
    const command = payload[pos]!;
    pos += 1;
    if (command === 0xff) break;
    if (command < 0xf0) continue; // ignored at command boundaries
    if (command > profile.pictureMaxCommand) continue;
    switch (command) {
      case 0xf0: {
        const operand = readRaw();
        if (operand < 0) return;
        visualColor = operand & 0x0f;
        visualEnabled = true;
        break;
      }
      case 0xf1:
        visualEnabled = false;
        break;
      case 0xf2: {
        const operand = readRaw();
        if (operand < 0) return;
        priorityValue = operand & 0x0f;
        priorityEnabled = true;
        break;
      }
      case 0xf3:
        priorityEnabled = false;
        break;
      case 0xf4:
      case 0xf5: {
        // 0xf4 y-corner: vertical segment first; 0xf5 x-corner: horizontal.
        const start = readPair();
        if (start === null) break;
        plot(start.x, start.y);
        let cx = start.x;
        let cy = start.y;
        let expectY = command === 0xf4;
        for (;;) {
          const v = readGuarded();
          if (v < 0) break;
          if (expectY) {
            const ny = Math.min(v, 167);
            drawLine(cx, cy, cx, ny);
            cy = ny;
          } else {
            const nx = Math.min(v, 159);
            drawLine(cx, cy, nx, cy);
            cx = nx;
          }
          expectY = !expectY;
        }
        break;
      }
      case 0xf6: {
        const start = readPair();
        if (start === null) break;
        plot(start.x, start.y);
        let px = start.x;
        let py = start.y;
        for (;;) {
          const next = readPair();
          if (next === null) break;
          drawLine(px, py, next.x, next.y);
          px = next.x;
          py = next.y;
        }
        break;
      }
      case 0xf7: {
        const start = readPair();
        if (start === null) break;
        plot(start.x, start.y);
        let cx = start.x;
        let cy = start.y;
        for (;;) {
          const b = readGuarded();
          if (b < 0) break;
          const dxMag = (b & 0x70) >> 4;
          const dyMag = b & 0x07;
          // Addition/subtraction modulo 256, then upper clamp (wrap-then-clamp).
          const nx = Math.min((cx + ((b & 0x80) !== 0 ? -dxMag : dxMag)) & 0xff, 159);
          const ny = Math.min((cy + ((b & 0x08) !== 0 ? -dyMag : dyMag)) & 0xff, 167);
          drawLine(cx, cy, nx, ny);
          cx = nx;
          cy = ny;
        }
        break;
      }
      case 0xf8: {
        for (;;) {
          const seed = readPair();
          if (seed === null) break;
          floodFill(seed.x, seed.y);
        }
        break;
      }
      case 0xf9: {
        const mode = readRaw();
        if (mode < 0) return;
        patternMode = profile.patternProfile === "point-2.411" ? 0 : mode & 0xff;
        break;
      }
      case 0xfa: {
        for (;;) {
          let seed = 0;
          if ((patternMode & 0x20) !== 0) {
            seed = readGuarded();
            if (seed < 0) break;
          }
          const pair = readPair();
          if (pair === null) break;
          if (profile.patternProfile === "point-2.411") plot(pair.x, pair.y);
          else plotPattern(pair.x, pair.y, seed);
        }
        break;
      }
      default:
        // 0xfb..0xfe: unused by valid streams; ignored.
        break;
    }
  }
}
