import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256Hex } from "../src/crypto.ts";

test("sha256Hex matches the FIPS 180-4 vectors", () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256Hex agrees with node:crypto across the block-padding boundaries", () => {
  for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70000]) {
    const bytes = new Uint8Array(randomBytes(length));
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256Hex(bytes), expected, `length ${length}`);
  }
  // A view into a larger buffer hashes only its own bytes.
  const backing = new Uint8Array(randomBytes(200));
  const view = backing.subarray(37, 150);
  assert.equal(sha256Hex(view), createHash("sha256").update(view).digest("hex"));
});
