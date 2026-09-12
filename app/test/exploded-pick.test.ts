import assert from "node:assert/strict";
import test from "node:test";
import { pickThroughLayers, type PickHit } from "../src/explodedPick.ts";

const PIC_W = 160;
const PIC_H = 168;
const FRAME_W = 320;
const FRAME_H = 200;

/** uv for a logical picture pixel centre. */
function picUv(x: number, y: number): { u: number; v: number } {
  return { u: (x + 0.5) / PIC_W, v: 1 - (y + 0.5) / PIC_H };
}

/** uv for a composed-frame pixel centre. */
function frameUv(x: number, y: number): { u: number; v: number } {
  return { u: (x + 0.5) / FRAME_W, v: 1 - (y + 0.5) / FRAME_H };
}

/** A front-to-back layer stack as raycast hits (text nearest, control last). */
function stack(u: number, v: number, bands = [15, 7, 4]): PickHit[] {
  return [
    { name: "explodedText", u, v },
    ...bands.map((b) => ({ name: `sprite:${b}`, u, v })),
    ...bands.map((b) => ({ name: `pic:${b}`, u, v })),
    { name: "control", u, v },
  ];
}

test("masked sprite pixel falls through to the picture layer that owns it", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(7);
  const priority = new Uint8Array(PIC_W * PIC_H).fill(7);
  const owner = new Uint8Array(PIC_W * PIC_H);
  const { u, v } = picUv(40, 80);
  // Sprite quads are nearer than their walls, but no owner / composed band
  // match means none of them rendered this pixel — the band-7 wall did.
  const pick = pickThroughLayers(stack(u, v), {
    priority,
    picturePriority,
    owner,
  });
  assert.deepEqual(pick, { x: 40, y: 80, kind: "picture", band: 7 });
});

test("a sprite hit reports its rendered band, not the nearest quad", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(4);
  const priority = new Uint8Array(PIC_W * PIC_H).fill(9);
  const owner = new Uint8Array(PIC_W * PIC_H).fill(6);
  const { u, v } = picUv(10, 10);
  const pick = pickThroughLayers(stack(u, v, [15, 9, 7, 4]), {
    priority,
    picturePriority,
    owner,
  });
  // Composed band 9 with an owner → sprite layer 9, even though sprite:15
  // and pic:15 are geometrically nearer.
  assert.deepEqual(pick, { x: 10, y: 10, kind: "sprite", band: 9 });
});

test("a picture pixel under a transparent cel still picks the wall", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(12);
  const priority = new Uint8Array(PIC_W * PIC_H).fill(12);
  const owner = new Uint8Array(PIC_W * PIC_H);
  const i = 80 * PIC_W + 40;
  owner[i] = 3; // object owns the pixel, but only where its band matches
  priority[i] = 9; // and the composed band here is 9 — sprite:9 wins
  const { u, v } = picUv(40, 80);
  const pick = pickThroughLayers(stack(u, v, [15, 12, 9]), {
    priority,
    picturePriority,
    owner,
  });
  assert.deepEqual(pick, { x: 40, y: 80, kind: "sprite", band: 9 });
  // Where the object does not own the pixel the wall renders instead.
  const u2 = picUv(41, 80);
  const pick2 = pickThroughLayers(stack(u2.u, u2.v, [15, 12, 9]), {
    priority,
    picturePriority,
    owner,
  });
  assert.equal(pick2?.kind, "picture");
  assert.equal(pick2?.band, 12);
});

test("control lines pick the rearmost layer only in the control band", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H);
  const { u, v } = picUv(5, 5);
  const i = 5 * PIC_W + 5;
  picturePriority[i] = 2; // control band
  const pick = pickThroughLayers([{ name: "control", u, v }], {
    picturePriority,
  });
  assert.deepEqual(pick, { x: 5, y: 5, kind: "control" });
  // Same quad, drawn pixel: the control mask discards it.
  const picturePriority2 = new Uint8Array(PIC_W * PIC_H).fill(8);
  const masked = pickThroughLayers([{ name: "control", u, v }], {
    picturePriority: picturePriority2,
  });
  assert.equal(masked?.kind, "background");
});

test("an opaque text pixel picks the text surface in frame coordinates", () => {
  const text = new Uint8Array(FRAME_W * FRAME_H * 4);
  text[(10 * FRAME_W + 30) * 4 + 3] = 255;
  const { u, v } = frameUv(30, 10);
  const pick = pickThroughLayers([{ name: "explodedText", u, v }, ...stack(u, v).slice(1)], {
    text,
  });
  assert.deepEqual(pick, { x: 30, y: 10, kind: "text" });
});

test("transparent text falls through to the layer underneath", () => {
  const text = new Uint8Array(FRAME_W * FRAME_H * 4); // all alpha 0
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(6);
  const { u, v } = picUv(20, 20);
  const pick = pickThroughLayers(stack(u, v, [15, 6]), { text, picturePriority });
  assert.deepEqual(pick, { x: 20, y: 20, kind: "picture", band: 6 });
});

test("uv coordinates are clamped at layer edges", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(11);
  const pick = pickThroughLayers([{ name: "pic:11", u: 0.999999, v: 0.000001 }], {
    picturePriority,
  });
  assert.deepEqual(pick, { x: PIC_W - 1, y: PIC_H - 1, kind: "picture", band: 11 });
});

test("geometry hit with every layer masked reports background", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(5);
  const { u, v } = picUv(0, 0);
  const pick = pickThroughLayers([{ name: "pic:9", u, v }], { picturePriority });
  assert.equal(pick?.kind, "background");
  assert.equal(pick?.x, 1); // frame coords: logical pixel 0's centre is x 1
  assert.equal(pick?.y, 0);
});

test("no intersection at all returns null", () => {
  assert.equal(pickThroughLayers([], {}), null);
});

test("a show.obj preview pixel picks the modal layer, not the sprite band", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(4);
  const priority = new Uint8Array(PIC_W * PIC_H).fill(15); // preview writes pri 15
  const owner = new Uint8Array(PIC_W * PIC_H); // and owns nothing
  const preview = new Uint8Array(PIC_W * PIC_H);
  const i = 120 * PIC_W + 70;
  preview[i] = 1;
  const { u, v } = picUv(70, 120);
  // The preview layer sits nearer than sprite:15 and in front of the wall.
  const hits: PickHit[] = [
    { name: "preview", u, v },
    { name: "sprite:15", u, v },
    { name: "pic:15", u, v },
    { name: "pic:4", u, v },
    { name: "control", u, v },
  ];
  const pick = pickThroughLayers(hits, { priority, picturePriority, owner, preview });
  assert.deepEqual(pick, { x: 70, y: 120, kind: "preview" });
});

test("a masked preview pixel falls through to the layer that owns it", () => {
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(6);
  const preview = new Uint8Array(PIC_W * PIC_H); // modal closed elsewhere
  const { u, v } = picUv(30, 90);
  const hits: PickHit[] = [
    { name: "preview", u, v },
    { name: "pic:6", u, v },
  ];
  const pick = pickThroughLayers(hits, { picturePriority, preview });
  assert.deepEqual(pick, { x: 30, y: 90, kind: "picture", band: 6 });
  // Without the mask at all the preview layer can never claim the pixel.
  const noMask = pickThroughLayers(hits, { picturePriority });
  assert.deepEqual(noMask, { x: 30, y: 90, kind: "picture", band: 6 });
});

test("missing channel data masks rather than misreports", () => {
  // Ownership absent (channel disarmed): a sprite quad must not claim the
  // pixel; the wall that actually rendered it still can.
  const picturePriority = new Uint8Array(PIC_W * PIC_H).fill(4);
  const { u, v } = picUv(60, 60);
  const pick = pickThroughLayers(stack(u, v, [15, 8, 4]), { picturePriority });
  assert.deepEqual(pick, { x: 60, y: 60, kind: "picture", band: 4 });
});
