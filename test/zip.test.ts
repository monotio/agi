import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildZip, crc32 } from "../app/src/zip.ts";

describe("buildZip", () => {
  it("computes accurate CRC32 for known strings", () => {
    const encoder = new TextEncoder();
    // Standard CRC32 check values
    assert.equal(crc32(new Uint8Array(0)), 0);
    assert.equal(crc32(encoder.encode("123456789")), 0xcbf43926);
  });

  it("builds a valid zip file containing multiple files", () => {
    const zipBytes = buildZip([
      { name: "HELLO.TXT", data: "Hello, World!" },
      { name: "BIN.DAT", data: new Uint8Array([1, 2, 3, 4, 5]) },
    ]);

    assert.ok(zipBytes.length > 50);
    // Local header signature at 0
    assert.equal(zipBytes[0], 0x50);
    assert.equal(zipBytes[1], 0x4b);
    assert.equal(zipBytes[2], 0x03);
    assert.equal(zipBytes[3], 0x04);

    // EOCD signature at end - 22
    const eocdPos = zipBytes.length - 22;
    assert.equal(zipBytes[eocdPos], 0x50);
    assert.equal(zipBytes[eocdPos + 1], 0x4b);
    assert.equal(zipBytes[eocdPos + 2], 0x05);
    assert.equal(zipBytes[eocdPos + 3], 0x06);
  });
});
