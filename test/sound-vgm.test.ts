import assert from "node:assert/strict";
import { test } from "node:test";
import { importVgm } from "../src/sound/vgm.ts";

function vgm(commands: number[], clock = 3181813, version = 0x150): Uint8Array {
  const bytes = new Uint8Array(64 + commands.length);
  bytes.set([86, 103, 109, 32]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 4, true);
  view.setUint32(8, version, true);
  view.setUint32(12, clock, true);
  bytes.set(commands, 64);
  return bytes;
}

test("VGM reconstructs latched PSG writes, waits, independent voices and noise to exact bytes", () => {
  const doc = importVgm(
    vgm([
      0x50, 0x82, 0x50, 0x0e, 0x50, 0x93, 0x50, 0xe5, 0x50, 0xf4, 0x62, 0x50, 0x9f, 0x61, 0xbe,
      0x05, 0x66,
    ]),
  ).document;
  assert.deepEqual(
    [...doc.encode()],
    [
      8, 0, 20, 0, 27, 0, 34, 0, 1, 0, 14, 130, 147, 2, 0, 0, 128, 159, 255, 255, 3, 0, 0, 160, 191,
      255, 255, 3, 0, 0, 192, 223, 255, 255, 3, 0, 5, 229, 244, 255, 255,
    ],
  );
});

test("VGM accumulates sub-tick waits and scales a foreign PSG clock", () => {
  const doc = importVgm(
    vgm([0x50, 0x84, 0x50, 0x1c, 0x50, 0x90, 0x63, 0x63, 0x63, 0x63, 0x63, 0x66], 6363626),
  ).document;
  assert.deepEqual([...doc.encode().slice(8, 13)], [6, 0, 14, 130, 144]);
  const short = importVgm(
    vgm([0x50, 0x82, 0x50, 0x0e, 0x50, 0x90, ...Array(46).fill(0x7f), 0x66]),
  ).document;
  assert.equal(short.tracks()![0]![0]!.durationTicks, 1);
});

test("VGM rejects other chips with their name and a next action, and truncated commands", () => {
  const other = vgm([0x66], 0);
  new DataView(other.buffer).setUint32(0x2c, 7670454, true);
  assert.throws(() => importVgm(other), /YM2612.*SN76489/);
  assert.throws(() => importVgm(vgm([0x50])), /truncated/i);
  assert.throws(() => importVgm(vgm([0x62])), /end/i);
  assert.throws(() => importVgm(vgm([0x66], 3181813, 0x160)), /1\.5/);
});

test("repeated VGM noise latches preserve their retrigger boundaries", () => {
  const result = importVgm(vgm([0x50, 0xe5, 0x50, 0xf3, 0x62, 0x50, 0xe5, 0x62, 0x66]));
  assert.deepEqual(
    result.document.tracks()![3]!.map((n) => n.durationTicks),
    [1, 1],
  );
});

test("VGM active zero tone words remain exact raw native events", () => {
  const result = importVgm(vgm([0x50, 0x80, 0x50, 0, 0x50, 0x93, 0x62, 0x66]));
  assert.deepEqual([...result.document.encode().slice(8, 13)], [1, 0, 0, 128, 147]);
});

test("VGM chip commands name their chip even when the clock header is missing", () => {
  assert.throws(() => importVgm(vgm([0x52, 0, 0, 0x66])), /YM2612.*SN76489/);
});
