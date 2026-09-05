import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../src/container/container.ts";
import {
  compareBundles,
  validateBundle,
  parseBundleJson,
  pictureResults,
  decodePpm,
  loadBundle,
} from "../scripts/conformance.ts";

function bundle(values: unknown = { variables: { v3: 7 } }): Record<string, unknown> {
  return {
    format: "agi-clean-room-conformance-results",
    format_version: 2,
    suite_id: "synthetic",
    profile: "2.936",
    producer: "test",
    cases: [{ id: "state", status: "ok", values }],
  };
}
const hash = (pixels: Uint8Array): string => createHash("sha256").update(pixels).digest("hex");
const frame = (sha256: string): Record<string, unknown> => ({
  width: 160,
  height: 168,
  pixel_format: "ega16-indexed-row-major",
  sha256,
});

describe("portable conformance results", () => {
  it("validates the v2 envelope and observation contracts", () => {
    assert.equal(validateBundle(bundle()).format_version, 2);
    for (const patch of [
      { format_version: 1 },
      { suite_id: "" },
      { cases: null },
      { cases: [{ id: "x", status: "ok" }] },
      { cases: [{ id: "x", status: "ok", values: { n: 1.5 } }] },
      { cases: [{ id: "x", status: "ok", frame: frame("bad") }] },
      {
        cases: [
          { id: "x", status: "error" },
          { id: "x", status: "error" },
        ],
      },
    ])
      assert.throws(() => validateBundle({ ...bundle(), ...patch }));
  });
  it("requires every exact case and observation but allows extra candidate observations", () => {
    assert.deepEqual(compareBundles(bundle(), bundle()), []);
    const extra = bundle();
    (extra["cases"] as Record<string, unknown>[])[0]!["frame"] = frame("a".repeat(64));
    assert.deepEqual(compareBundles(bundle(), extra), []);
    assert.match(compareBundles(extra, bundle()).join("\n"), /frame/);
    for (const patch of [
      { suite_id: "other" },
      { profile: "2.230" },
      { cases: [{ id: "other", status: "ok", values: {} }] },
      { cases: [{ id: "state", status: "error" }] },
    ])
      assert.ok(compareBundles(bundle(), { ...bundle(), ...patch }).length);
  });
  it("compares portable values exactly and reports escaped JSON pointers", () => {
    assert.deepEqual(
      compareBundles(bundle({ a: 1, b: [true, null] }), bundle({ b: [true, null], a: 1 })),
      [],
    );
    assert.match(
      compareBundles(bundle({ "a/b": { "~key": [7] } }), bundle({ "a/b": { "~key": [8] } })).join(
        "\n",
      ),
      /\/a~1b\/~0key\/0/,
    );
    assert.ok(compareBundles(bundle({ a: [] }), bundle({ a: {} })).length);
    assert.ok(compareBundles(bundle({ a: 1 }), bundle({ a: 1, b: null })).length);
    const text = JSON.stringify(bundle({ n: 0 }));
    const a = parseBundleJson(text.replace('"n":0', '"n":9007199254740992'));
    const b = parseBundleJson(text.replace('"n":0', '"n":9007199254740993'));
    assert.ok(compareBundles(a, b).length, "large adjacent integers must remain distinct");
  });
  it("produces canonical hashes for each picture channel from independent expected pixels", () => {
    const c = createContainer();
    // Enable visual red and priority 7, draw exactly two horizontal pixels.
    c.putResource("picture", 3, Uint8Array.of(0xf0, 4, 0xf2, 7, 0xf6, 0, 0, 1, 0, 0xff));
    const visual = new Uint8Array(26880).fill(15);
    visual[0] = 4;
    visual[1] = 4;
    const priority = new Uint8Array(26880).fill(4);
    priority[0] = 7;
    priority[1] = 7;
    const result = pictureResults(c.files, { suiteId: "two-pixels", profile: "2.936" });
    assert.equal(result.suite_id, "two-pixels");
    assert.deepEqual(
      result.cases.map((c) => [c.id, c.frame?.sha256]),
      [
        ["picture_003/visual", hash(visual)],
        ["picture_003/priority", hash(priority)],
      ],
    );
    assert.equal(
      result.cases.some((c) => c.frame?.artifact),
      false,
    );
    const early = pictureResults(c.files, { profile: "2.230" });
    assert.equal(early.profile, "2.230");
  });
  it("renders pictures using the requested profile's pattern semantics", () => {
    const c = createContainer();
    c.putResource("picture", 0, Uint8Array.of(0xf0, 4, 0xf9, 0x12, 0xfa, 10, 10, 0xff));
    const expected = new Uint8Array(26880).fill(15);
    expected[10 * 160 + 10] = 4;
    const result = pictureResults(c.files, { profile: "2.411" });
    assert.equal(result.cases[0]!.frame!.sha256, hash(expected));
  });
  it("decodes P6 headers, checks EGA membership and validates artifact digests", async () => {
    const rgb = new Uint8Array(26880 * 3).fill(255);
    rgb.set([170, 85, 0]);
    const ppm = Buffer.concat([Buffer.from("P6\n# original synthetic frame\n160 168\n255\n"), rgb]);
    const expected = new Uint8Array(26880).fill(15);
    expected[0] = 6;
    assert.deepEqual(decodePpm(ppm), expected);
    const bad = Uint8Array.from(ppm);
    bad[bad.length - 1] = 254;
    assert.throws(() => decodePpm(bad), /EGA/);
    assert.throws(() => decodePpm(ppm.slice(0, -1)), /length/);
    const dir = await mkdtemp(join(tmpdir(), "agi-conformance-"));
    try {
      await writeFile(join(dir, "frame.ppm"), ppm);
      const input = {
        ...bundle(),
        cases: [
          { id: "frame", status: "ok", frame: { ...frame(hash(expected)), artifact: "frame.ppm" } },
        ],
      };
      const path = join(dir, "results.json");
      await writeFile(path, JSON.stringify(input));
      assert.equal((await loadBundle(path)).cases.length, 1);
      Object.assign(input.cases[0]!.frame, { sha256: "0".repeat(64) });
      await writeFile(path, JSON.stringify(input));
      await assert.rejects(() => loadBundle(path), /digest/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
