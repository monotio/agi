import assert from "node:assert/strict";
import { test } from "node:test";
import { descrambleAgi } from "../scripts/descramble-agi.ts";

test("loader carries the final key bit into both the wrap and the following block", () => {
  const key = new Uint8Array(128);
  key[0] = 1;
  key[127] = 1;
  // All-zero data exposes each successive key. First rotation starts with
  // CF=0, shifts key[0]'s low bit into key[1], and wraps key[127]'s low bit.
  // Saved carry persists: second key[0] is 0xc0, not the 0x40 of a rotate.
  const expected = new Uint8Array(384);
  expected[0] = expected[127] = 1;
  expected[128] = expected[129] = 0x80;
  expected[256] = 0xc0;
  expected[257] = 0x40;
  assert.deepEqual(descrambleAgi(new Uint8Array(384), key), expected);
  assert.equal(key[0], 1, "call does not mutate the source key");
  assert.equal(key[127], 1);
});

test("first carry is clear, rather than copied from the first key byte", () => {
  const key = new Uint8Array(128);
  key[0] = 1;
  const result = descrambleAgi(new Uint8Array(256), key);
  assert.equal(result[128], 0);
  assert.equal(result[129], 0x80);
});

test("partial final blocks and invalid key sizes are handled explicitly", () => {
  const key = new Uint8Array(128).fill(0xff);
  assert.deepEqual(
    descrambleAgi(new Uint8Array([0, 0x55, 0xff]), key),
    new Uint8Array([255, 170, 0]),
  );
  assert.equal(descrambleAgi(new Uint8Array(), key).length, 0);
  assert.throws(() => descrambleAgi(new Uint8Array(1), new Uint8Array(127)), /128/);
});
