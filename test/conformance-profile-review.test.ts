import assert from "node:assert/strict";
import { test } from "node:test";
import { pictureResults } from "../scripts/conformance.ts";
import { runtimeResults } from "../scripts/runtime-conformance.ts";

// A one-entry combined directory and a real record in volume 15. No binary or
// catalog identity: the explicitly selected profile must decide entry absence.
function image(kind: "logic" | "picture", payload: Uint8Array) {
  const offsets = kind === "logic" ? [8, 11, 11, 11] : [8, 8, 11, 11];
  const directory = Uint8Array.from([...offsets.flatMap((offset) => [offset, 0]), 0xf0, 0, 0]);
  const record = Uint8Array.from([
    0x12,
    0x34,
    15,
    payload.length,
    0,
    payload.length,
    0,
    ...payload,
  ]);
  return new Map([
    ["XDIR", directory],
    ["XVOL.0", new Uint8Array()],
    ["XVOL.15", record],
  ]);
}

test("picture conformance honors its declared Amiga directory policy", () => {
  const files = image("picture", Uint8Array.of(0xff));
  assert.equal(pictureResults(files, { profile: "3.002.149" }).cases.length, 2);
  assert.deepEqual(pictureResults(files, { profile: "amiga-2.333" }).cases, []);
});

test("runtime conformance cannot execute a boot entry absent under its declared profile", () => {
  // One return opcode, zero messages, and the three-byte message section header.
  const files = image("logic", Uint8Array.of(1, 0, 0, 0, 3, 0));
  const scenario = {
    suiteId: "declared-profile",
    steps: [{ advance: 100 }, { checkpoint: "boot" }],
  };
  assert.doesNotThrow(() => runtimeResults(files, { ...scenario, profile: "3.002.149" }));
  assert.throws(
    () => runtimeResults(files, { ...scenario, profile: "amiga-2.333" }),
    /logic resource 0 not in container/,
  );
});
