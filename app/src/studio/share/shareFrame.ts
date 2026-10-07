import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
/**
 * The shared picture's frame: the authentic 320×200 screen, the 160×168
 * picture with each cell two pixels wide above a 32-row strip that carries
 * the caption card, all in the 16 EGA colours. The caption (the game and
 * the room, the picture's size, the "AGI IS HERE." wordmark with its cyan
 * full stop) is drawn with the engine's own 8×8 font, as game text is. The
 * still is this frame at 2× as a PNG; renderClip.ts scales it for video.
 */

import { encodePngPaletteRgbDeflated, EGA_RGB } from "../../../../src/picture/png.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../../src/types.ts";
import { FONT } from "../../render/font8x8.ts";

export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 200;
/** The still's integer scale: 640×400. */
const STILL_SCALE = 2;

export interface ShareCaption {
  /** The game's title, when known. */
  game?: string | undefined;
  /** The room's name (`shareRoomName`). */
  room: string;
  commands: number;
  bytes: number;
}

const DARK_GREY = 8;
const GREY = 7;
const WHITE = 15;
const CYAN = 11;

/** The caption strip's rule, its two text rows and their left margin. */
const STRIP_TOP = SCREEN_HEIGHT;
const NAME_Y = STRIP_TOP + 5;
const STATS_Y = NAME_Y + 12;
const TEXT_X = 8;
const WORDMARK = "AGI IS HERE.";
/** The wordmark stands right-aligned on the size row, one glyph in from the edge. */
const WORDMARK_X = FRAME_WIDTH - 8 - WORDMARK.length * 8;
/** The name row runs the strip's width, a glyph in from each edge: 38 columns. */
const NAME_COLUMNS = (FRAME_WIDTH - 2 * TEXT_X) / 8;
/** The size stops a glyph short of the wordmark: 25 columns. */
const STATS_COLUMNS = (WORDMARK_X - 8 - TEXT_X) / 8;
/** Fewer columns than this left for the game's title beside the room, and the room stands alone. */
const MIN_GAME_COLUMNS = 8;

/**
 * A glyph's eight rows, bit 7 leftmost. The font has no middle dot, so "·"
 * is its full stop raised to the middle of the cell; anything else the font
 * does not draw (outside printable ASCII) shows as "?".
 */
function glyphRows(ch: string): Uint8Array {
  if (ch === "·") {
    const dot = glyphRows(".");
    return Uint8Array.from({ length: 8 }, (_, row) => dot[row + 2] ?? 0);
  }
  const code = ch.charCodeAt(0);
  const printable = ch.length === 1 && code >= 0x20 && code <= 0x7e;
  const at = (printable ? code : 0x3f) * 8;
  return FONT.slice(at, at + 8);
}

/** Draw `text` onto a 320-wide frame of colour indices, lit pixels only. */
function drawText(frame: Uint8Array, text: string, x: number, y: number, colour: number) {
  [...text].forEach((ch, i) => {
    const rows = glyphRows(ch);
    for (let row = 0; row < 8; row++)
      for (let col = 0; col < 8; col++)
        if (rows[row]! & (0x80 >> col)) frame[(y + row) * FRAME_WIDTH + x + i * 8 + col] = colour;
  });
}

/** `text` in at most `columns` characters: cut, its trailing space trimmed, then "...". */
function fit(text: string, columns: number): string {
  const chars = [...text.trim()];
  if (chars.length <= columns) return chars.join("");
  return `${chars
    .slice(0, columns - 3)
    .join("")
    .trimEnd()}...`;
}

/**
 * The room's name for sharing: the first title known (the world plan's, the
 * map's), else "Room N", else `fallback` for a picture no room frames.
 */
export function shareRoomName(
  titles: readonly (string | undefined)[],
  room: number | null,
  fallback: string,
): string {
  const title = titles.map((candidate) => candidate?.trim() ?? "").find(Boolean);
  return room !== null && room > 0
    ? numberedLabel("room", room, { name: title ?? "" })
    : (title ?? fallback);
}

/**
 * The caption's two lines: "Game · Room" across the strip, the game's title
 * cut first so the room's name stays whole, and the size beside the
 * wordmark, shortened when a big picture's would reach it.
 */
export function captionText(caption: ShareCaption): { name: string; stats: string } {
  const room = fit(caption.room, NAME_COLUMNS);
  const game = caption.game?.trim() ?? "";
  const gameColumns = NAME_COLUMNS - [...room].length - 3;
  const name =
    game && gameColumns >= MIN_GAME_COLUMNS ? `${fit(game, gameColumns)} · ${room}` : room;
  const { commands, bytes } = caption;
  const stats = `${commands} command${commands === 1 ? "" : "s"} · ${bytes} byte${bytes === 1 ? "" : "s"}`;
  return {
    name,
    stats: [...stats].length <= STATS_COLUMNS ? stats : `${commands} cmds · ${bytes} B`,
  };
}

/**
 * The 320×200 frame for a picture's visual plane (160×168 colour indices),
 * with the caption card in the strip below it, or the strip left black (0).
 */
export function composeFrame(visual: Uint8Array, caption: ShareCaption | null): Uint8Array {
  const frame = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  for (let y = 0; y < SCREEN_HEIGHT; y++)
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const colour = visual[y * SCREEN_WIDTH + x]! & 0x0f;
      frame[y * FRAME_WIDTH + 2 * x] = colour;
      frame[y * FRAME_WIDTH + 2 * x + 1] = colour;
    }
  if (!caption) return frame;
  frame.fill(DARK_GREY, STRIP_TOP * FRAME_WIDTH, (STRIP_TOP + 1) * FRAME_WIDTH);
  const { name, stats } = captionText(caption);
  drawText(frame, name, TEXT_X, NAME_Y, WHITE);
  drawText(frame, stats, TEXT_X, STATS_Y, GREY);
  drawText(frame, WORDMARK.slice(0, -1), WORDMARK_X, STATS_Y, WHITE);
  drawText(frame, ".", WORDMARK_X + (WORDMARK.length - 1) * 8, STATS_Y, CYAN);
  return frame;
}

/** Expand a frame of colour indices to RGB (or RGBA, with `channels` 4) at an integer scale. */
export function frameToRgb(
  frame: Uint8Array,
  scale: number,
  channels: 3 | 4 = 3,
): Uint8Array<ArrayBuffer> {
  const width = FRAME_WIDTH * scale;
  const out = new Uint8Array(width * FRAME_HEIGHT * scale * channels);
  for (let y = 0; y < FRAME_HEIGHT * scale; y++) {
    const source = Math.floor(y / scale) * FRAME_WIDTH;
    for (let x = 0; x < width; x++) {
      const rgb = EGA_RGB[frame[source + Math.floor(x / scale)]! & 0x0f]!;
      const at = (y * width + x) * channels;
      out.set(rgb, at);
      if (channels === 4) out[at + 3] = 255;
    }
  }
  return out;
}

/** A zlib stream (RFC 1950, as a PNG's IDAT holds) through the platform's CompressionStream. */
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw.slice()]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The still: the finished picture and its caption, 640×400, as a compressed indexed PNG. */
export function stillPng(visual: Uint8Array, caption: ShareCaption): Promise<Uint8Array> {
  const rgb = frameToRgb(composeFrame(visual, caption), STILL_SCALE);
  return encodePngPaletteRgbDeflated(
    FRAME_WIDTH * STILL_SCALE,
    FRAME_HEIGHT * STILL_SCALE,
    rgb,
    deflate,
  );
}

const slug = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The shared file's name without extension: the game and the room, e.g. "adventure-department-sprite-lab". */
export function shareFileBase(game: string | undefined, room: string): string {
  return [slug(game ?? ""), slug(room)].filter(Boolean).join("-") || "picture";
}
