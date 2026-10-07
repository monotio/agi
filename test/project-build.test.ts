import { test } from "node:test";
import assert from "node:assert/strict";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { containerFromResources } from "../src/container/container.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { buildWordsTok } from "../src/logic/words.ts";

function fixture(source = "return;") {
  const payload = compileProjectLogic(source, {
    profile: DEFAULT_V2_PROFILE,
    dictionary: new Map(),
    bindings: {},
  }).assembly.payload;
  const files = Object.fromEntries(
    containerFromResources({ logic: new Map([[0, payload]]) }).files,
  );
  files["WORDS.TOK"] = buildWordsTok([]);
  return files;
}

test("builds pin exact source independently of unchanged playable bytes", () => {
  const files = fixture();
  const first = captureProjectBuild({
    files,
    profileId: "2.936",
    sources: { 0: "return;" },
    bindings: {},
  });
  const commented = captureProjectBuild({
    files,
    profileId: "2.936",
    sources: { 0: "// 😀\nreturn;" },
    bindings: {},
  });
  assert.equal(first.identity.revision, commented.identity.revision);
  assert.notEqual(first.identity.buildId, commented.identity.buildId);
  assert.equal(commented.logics[0]!.sourceMap!.entries[0]!.start, 6);
  const imported = captureProjectBuild({ files, profileId: "2.936", sources: {}, bindings: {} });
  assert.equal(imported.logics[0]!.sourceMap, undefined);
  assert.notEqual(imported.identity.buildId, first.identity.buildId);
});

test("captured builds own input and returned buffers and freeze source origins", () => {
  const files = fixture();
  const input = { files, profileId: "2.936" as const, sources: { 0: "return;" }, bindings: {} };
  const build = captureProjectBuild(input);
  const original = build.files();
  files["VOL.0"]!.fill(1);
  input.sources[0] = "set(f50); return;";
  const exposed = build.files();
  exposed.get("VOL.0")!.fill(2);
  (exposed as Map<string, Uint8Array>).clear();
  assert.deepEqual(build.files(), original);
  assert.equal(build.logics[0]!.sourceMap!.source, "return;");
  assert.ok(Object.isFrozen(build.logics[0]!.sourceMap!.entries[0]));
  assert.ok(Object.isFrozen(build.identity));
});

test("unverified or orphan source is refused without changing files", () => {
  const files = fixture();
  const before = structuredClone(files);
  for (const sources of [{ 0: "set(f50); return;" }, { 1: "return;" }, { "00": "return;" }]) {
    assert.throws(() => captureProjectBuild({ files, profileId: "2.936", sources, bindings: {} }));
  }
  assert.deepEqual(files, before);
});

test("canonical file and binding order is stable while context and profile remain bound", () => {
  const files = fixture();
  const first = captureProjectBuild({
    files,
    profileId: "2.936",
    sources: { 0: "return;" },
    bindings: { z: { num: 50 }, a: { num: 51 } },
  });
  const reordered = captureProjectBuild({
    files: Object.fromEntries(Object.entries(files).reverse()),
    profileId: "2.936",
    sources: { 0: "return;" },
    bindings: { a: { num: 51 }, z: { num: 50 } },
  });
  assert.deepEqual(first.identity, reordered.identity);
  const context = captureProjectBuild({
    files,
    profileId: "2.936",
    sources: { 0: "return;" },
    bindings: { a: { num: 52 }, z: { num: 50 } },
  });
  assert.notEqual(first.identity.buildId, context.identity.buildId);
  const profile = captureProjectBuild({
    files,
    profileId: "3.002.149",
    sources: { 0: "return;" },
    bindings: { a: { num: 51 }, z: { num: 50 } },
  });
  assert.notEqual(first.identity.buildId, profile.identity.buildId);
  assert.equal(first.identity.revision, profile.identity.revision);
});

test("invalid binding numbers are refused even for bytecode-only builds", () => {
  const files = fixture();
  for (const num of [NaN, Infinity, -Infinity, -1, 256, 1.5]) {
    assert.throws(
      () =>
        captureProjectBuild({ files, profileId: "2.936", sources: {}, bindings: { bad: { num } } }),
      /binding/i,
    );
  }
});
