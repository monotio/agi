import { test } from "node:test";
import assert from "node:assert/strict";
import { fnv1a32 } from "../src/runtime/hash.ts";

// Reference vectors from the FNV-1a definition (32-bit offset basis and the
// canonical "a" check value).
test("fnv1a32 matches the published reference vectors", () => {
  assert.equal(fnv1a32(new Uint8Array(0)), 0x811c9dc5);
  assert.equal(fnv1a32(new TextEncoder().encode("a")), 0xe40c292c);
});

test("fnv1a32 distinguishes content, not identity", () => {
  const a = new Uint8Array([1, 2, 3]);
  const same = new Uint8Array([1, 2, 3]);
  const different = new Uint8Array([1, 2, 4]);
  assert.equal(fnv1a32(a), fnv1a32(same));
  assert.notEqual(fnv1a32(a), fnv1a32(different));
});
