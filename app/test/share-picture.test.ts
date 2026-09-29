import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE as profile } from "../../src/runtime/profile.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../src/types.ts";
import {
  CAPTION_FRAMES,
  commandCells,
  commandCost,
  HOLD_FRAMES,
  PAINT_FRAMES,
  paintWeights,
  planClip,
  planPaintFrames,
} from "../src/studio/share/paintClip.ts";
import {
  captionText,
  composeFrame,
  FRAME_WIDTH,
  shareFileBase,
  shareRoomName,
  stillPng,
} from "../src/studio/share/shareFrame.ts";
import { buildStudioModel } from "../src/studio/useStudioDocument.ts";

/** Timeline: 0 vis 1, 1 a 4-cell line, 2 a fill of every other cell, 3 vis off, 4 pri 9, 5 a priority-only line, 6 end. */
const TINY = [
  "vis 1",
  "line 0,0 3,0",
  "fill 5,5",
  "vis off",
  "pri 9",
  "line 0,10 9,10",
  "end",
  "",
].join("\n");

const plane = (value: number): Uint8Array =>
  new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(value);
const at = (frame: Uint8Array, x: number, y: number): number => frame[y * FRAME_WIDTH + x]!;

test("a command costs one plus the square root of its cell writes, if you can see them", () => {
  assert.equal(commandCost(0, true), 0);
  assert.equal(commandCost(1, true), 2);
  assert.equal(commandCost(4, true), 3);
  assert.equal(commandCost(9, true), 4);
  assert.equal(commandCost(9, false), 0);
});

test("cell writes are counted per command, and priority-only drawing weighs nothing", () => {
  const bytes = compilePictureSource(TINY, { profile }).bytes;
  const model = buildStudioModel({ bytes, authoredSource: TINY, profile });
  const cells = commandCells(model.compiled, profile);
  // The fill floods every white cell but the line's four: 160×168 − 4.
  assert.deepEqual(cells, [0, 4, 26876, 0, 0, 10, 0]);
  assert.deepEqual(paintWeights(model.timeline, cells), [0, 3, 1 + Math.sqrt(26876), 0, 0, 0, 0]);
});

test("paint frames follow the running cost, not the command count", () => {
  // Costs 0,3,0,4,1 (total 8) over 4 frames: due 2, 4, 6, 8.
  assert.deepEqual(planPaintFrames([0, 3, 0, 4, 1], 4), [1, 3, 3, 5]);
  // Four cheap lines share the first frame; the costly fill holds the rest.
  assert.deepEqual(planPaintFrames([1, 1, 1, 1, 12], 4), [4, 4, 4, 5]);
  // Nothing visible to paint: everything is there from the first frame.
  assert.deepEqual(planPaintFrames([0, 0], 3), [2, 2, 2]);
});

test("the clip paints for five seconds, holds a second, then captions for a second and a half", () => {
  const frames = planClip([0, 3, 0, 4, 1]);
  assert.equal(PAINT_FRAMES + HOLD_FRAMES + CAPTION_FRAMES, 225);
  assert.equal(frames.length, 225);
  assert.equal(frames[PAINT_FRAMES - 1]!.commands, 5);
  const tail = frames.slice(PAINT_FRAMES);
  assert.ok(tail.every((frame) => frame.commands === 5));
  assert.deepEqual(
    tail.map((frame) => frame.caption),
    [...Array<boolean>(30).fill(false), ...Array<boolean>(45).fill(true)],
  );
  assert.ok(frames.slice(0, PAINT_FRAMES).every((frame) => !frame.caption));
});

test("the frame doubles each picture cell and leaves the strip black without a caption", () => {
  const visual = plane(1);
  visual[1] = 12;
  const frame = composeFrame(visual, null);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((x) => at(frame, x, 0)),
    [1, 1, 12, 12, 1],
  );
  assert.equal(at(frame, 319, 167), 1);
  assert.ok(frame.subarray(168 * FRAME_WIDTH).every((colour) => colour === 0));
});

test("the caption is drawn with the engine font, the wordmark's full stop in cyan", () => {
  const frame = composeFrame(plane(1), { room: "A", commands: 1, bytes: 9 });
  // The engine font's "A" at the name's place (8,173), in white.
  const A = [
    "..###...",
    ".#...#..",
    ".#...#..",
    ".#####..",
    ".#...#..",
    ".#...#..",
    ".#...#..",
    "........",
  ];
  const drawn = A.map((row, y) =>
    [...row].map((_, x) => (at(frame, 8 + x, 173 + y) === 15 ? "#" : ".")).join(""),
  );
  assert.deepEqual(drawn, A);
  // "AGI IS HERE." ends one glyph from the right edge of the size row (y 185):
  // its stop is the glyph at x 304, lit in columns 3-4 of rows 5-6. Nothing
  // else is cyan.
  const cyan: string[] = [];
  frame.forEach((colour, i) => {
    if (colour === 11) cyan.push(`${i % FRAME_WIDTH},${Math.floor(i / FRAME_WIDTH)}`);
  });
  assert.deepEqual(cyan, ["307,190", "308,190", "307,191", "308,191"]);
  // "1 command · 9 bytes": the middle dot is the full stop raised two rows,
  // the 11th glyph (x 88) of the size line at y 185, in grey.
  assert.equal(captionText({ room: "A", commands: 1, bytes: 9 }).stats, "1 command · 9 bytes");
  assert.deepEqual(
    [
      [91, 188],
      [92, 189],
      [91, 190],
    ].map(([x, y]) => at(frame, x!, y!)),
    [7, 7, 0],
  );
  // The strip's top rule is dark grey across the frame.
  assert.ok(frame.subarray(168 * FRAME_WIDTH, 169 * FRAME_WIDTH).every((c) => c === 8));
});

test("the room is named by its planned title, else its number, beside the game's title", () => {
  // The world plan's title first, then the map's; "Room N" when neither is known.
  assert.equal(shareRoomName(["Sprite Lab", "Lab"], 2, "PIC 2"), "Sprite Lab");
  assert.equal(shareRoomName([undefined, " Lab "], 2, "PIC 2"), "Lab");
  assert.equal(shareRoomName(["", undefined], 2, "PIC 2"), "Room 2");
  assert.equal(shareRoomName([], null, "PIC 7"), "PIC 7");
  const caption = { game: "Adventure Department", room: "Sprite Lab", commands: 219, bytes: 1148 };
  assert.deepEqual(captionText(caption), {
    name: "Adventure Department · Sprite Lab",
    stats: "219 commands · 1148 bytes",
  });
});

test("a long name fits the strip: the game's title gives way first; unknown characters show as ?", () => {
  // 38 columns: the room's 10 and " · " leave the game 25, so 22 characters,
  // the space before the cut trimmed, then "...".
  const long = captionText({
    game: "The Very Long Hall of Many Portraits Adventure",
    room: "Sprite Lab",
    commands: 2,
    bytes: 1,
  });
  assert.equal(long.name, "The Very Long Hall of... · Sprite Lab");
  assert.equal(long.stats, "2 commands · 1 byte");
  // A room so long the game would get under 8 columns stands alone, cut at 38.
  const room = "The Grand Observatory of the Western Tower";
  assert.equal(
    captionText({ game: "Quest", room, commands: 0, bytes: 0 }).name,
    "The Grand Observatory of the Wester...",
  );
  // A size that would run into the wordmark (27 columns > 25) is shortened.
  assert.equal(
    captionText({ room: "A", commands: 4000, bytes: 12000 }).stats,
    "4000 cmds · 12000 B",
  );
  const frame = composeFrame(plane(1), { room: "é", commands: 0, bytes: 0 });
  const question = composeFrame(plane(1), { room: "?", commands: 0, bytes: 0 });
  assert.deepEqual(frame, question);
});

test("the still is a compressed 640×400 indexed PNG of the captioned frame", async () => {
  const png = await stillPng(plane(1), { room: "A", commands: 1, bytes: 9 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset);
  assert.deepEqual([view.getUint32(16), view.getUint32(20), png[25]], [640, 400, 3]);
  // Decode: PLTE, then the one IDAT's rows (filter byte + 640 indices).
  let offset = 8;
  let palette: Uint8Array = new Uint8Array();
  let idat: Uint8Array = new Uint8Array();
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "PLTE") palette = data;
    if (type === "IDAT") idat = data;
    offset += 12 + length;
  }
  // Stored, the 400 rows of 641 bytes would be 256 KB; deflated, a flat
  // frame and one caption line are a few KB.
  assert.ok(png.length < 10_000, `${png.length} bytes`);
  const rows = inflateSync(idat);
  assert.equal(rows.length, 400 * 641);
  const rgb = (x: number, y: number): number[] => {
    const index = rows[y * 641 + 1 + x]!;
    return [...palette.subarray(index * 3, index * 3 + 3)];
  };
  // The cyan stop at 2×: frame pixel 307,190 covers 614-615 × 380-381.
  assert.deepEqual(rgb(614, 380), [0x55, 0xff, 0xff]);
  assert.deepEqual(rgb(615, 381), [0x55, 0xff, 0xff]);
  assert.deepEqual(rgb(613, 380), [0, 0, 0]);
  assert.deepEqual(rgb(0, 0), [0, 0, 0xaa]);
});

test("the file is named for the game and the room", () => {
  assert.equal(
    shareFileBase("Adventure Department", "Sprite Lab"),
    "adventure-department-sprite-lab",
  );
  assert.equal(shareFileBase("Adventure Department", "Room 2"), "adventure-department-room-2");
  assert.equal(shareFileBase(undefined, "PIC 7"), "pic-7");
  assert.equal(shareFileBase("Über Quest!", "Café"), "uber-quest-cafe");
});
