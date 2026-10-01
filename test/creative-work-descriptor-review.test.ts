import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../src/creative/catalog.ts";
import { writeCreativeRecovery } from "../src/creative/recovery.ts";
import { resourceRevision } from "../src/gameIdentity.ts";
import { readCreativeWork, writeCreativeWork } from "../src/creative/workArchive.ts";

for (const operation of ["read", "write"] as const) {
  test(`creative work ${operation} refuses a later shared-hash MIME disagreement`, () => {
    const encoded = Uint8Array.of(1, 2, 3);
    const raster = Uint8Array.of(255, 0, 0, 255);
    const original = { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" };
    const canonical = {
      hash: sha256Hex(raster),
      byteLength: raster.length,
      mime: "application/x-rgba8",
    };
    const basis = {
      revision: resourceRevision("a".repeat(64))!,
      authoring: "b".repeat(64),
      profileId: "2.936" as const,
      kept: 0,
    };
    const source: CreativeSource = {
      format: CREATIVE_SOURCE_FORMAT,
      version: 1,
      identity: { id: "original", incarnation: "source-incarnation", revision: 0 },
      encoded: original,
      availability: "original",
      normalized: {
        format: "rgba8-srgb-unpremultiplied-v1",
        width: 1,
        height: 1,
        blob: canonical,
      },
      origin: { kind: "import", title: "Reference" },
    };
    const recovery = {
      base: { ...basis, pins: [] },
      sources: [source],
      derivatives: [],
      recipes: [],
      board: [],
      drafts: [],
    };
    const input = {
      basis,
      drafts: [
        { workspace: "workspace-a", status: "current" as const, recovery },
        { workspace: "workspace-b", status: "current" as const, recovery },
      ],
      undos: [],
      retained: [],
      blobs: {
        [original.hash]: { ...original, buckets: ["original" as const] },
        [canonical.hash]: { ...canonical, buckets: ["canonical" as const] },
      },
    };
    const valid = writeCreativeWork(input);
    assert.equal(readCreativeWork(valid).drafts.length, 2);
    const conflicting = {
      ...recovery,
      sources: [{ ...source, encoded: { ...original, mime: "image/jpeg" } }],
    };
    // Each recovery is internally valid. Only the second workspace's claim
    // disagrees with the shared archive registry, after the hash was seen.
    const conflictRecord = writeCreativeRecovery(conflicting);
    if (operation === "write") {
      assert.throws(
        () =>
          writeCreativeWork({
            ...input,
            drafts: [input.drafts[0]!, { ...input.drafts[1]!, recovery: conflicting }],
          }),
        /mime|descriptor|disagree/i,
      );
    } else {
      const entries = valid["drafts"] as Record<string, unknown>[];
      assert.throws(
        () =>
          readCreativeWork({
            ...valid,
            drafts: [entries[0], { ...entries[1], recovery: conflictRecord }],
          }),
        /mime|descriptor|disagree/i,
      );
    }
  });
}
