import assert from "node:assert/strict";
import { test } from "node:test";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { loadAuthoredGame, clearCachedGame } from "../src/project/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  },
});

for (const kind of ["blank", "starter"] as const) {
  test(`${kind} creation saves editable source with no assistant or running game`, async () => {
    const candidate = prepareLocalProject({ title: "  My adventure  ", kind });
    const before = candidate.data();
    assert.equal(await loadAuthoredGame(candidate.projectId), null, "preparation is unsaved");
    const saved = await candidate.save();
    const loaded = (await loadAuthoredGame(candidate.projectId))!;
    assert.equal(loaded.title, "My adventure");
    assert.equal(loaded.library?.profile, "2.936");
    assert.equal(loaded.roomGeneration, false);
    assert.equal(loaded.templateId, `agihere.${kind}`);
    for (const key of ["provider", "model", "transcript", "sessionId", "conversationHistory"])
      assert.equal(Object.hasOwn(loaded, key), false, key);
    assert.deepEqual(loaded.files, before.files);
    const documents = readProjectWorkspace(loaded.workspace);
    assert.equal(typeof documents["logic:0"], "string");
    assert.equal(typeof documents["logic:1"], "string");
    assert.equal(typeof documents["picture:1"], "string");
    const compiled = compileProjectDocuments({
      files: loaded.files,
      profileId: "2.936",
      documents,
    });
    assert.equal(compiled.build.identity.buildId, saved.receipt.saved.buildId);
    assert.deepEqual(Object.fromEntries(compiled.files()), loaded.files);
    assert.deepEqual((await candidate.save()).receipt, saved.receipt, "retry reuses receipt");
    assert.equal((await loadAuthoredGame(candidate.projectId))!.generation, 1);
  });
}

test("prepared projects have independent identities and own their source and native bytes", async () => {
  const first = prepareLocalProject({ title: "One", kind: "starter" });
  const second = prepareLocalProject({ title: "One", kind: "starter" });
  assert.notEqual(first.projectId, second.projectId);
  const expected = first.data();
  const exposed = first.data();
  exposed.files["VOL.0"]!.fill(0);
  exposed.title = "Replaced";
  exposed.authoringState!["sources"] = {};
  assert.deepEqual(first.data(), expected);
  assert.deepEqual(second.data().files, expected.files);
  await first.save();
  assert.deepEqual((await loadAuthoredGame(first.projectId))!.files, expected.files);
});

test("failed initial storage leaves the prepared project recoverable and retryable", async () => {
  const candidate = prepareLocalProject({ title: "Retry me", kind: "blank" });
  const expected = candidate.data();
  const originalSet = records.set;
  records.set = function (key, value) {
    if (key === candidate.projectId) throw new Error("disk full");
    return originalSet.call(this, key, value);
  };
  try {
    await assert.rejects(candidate.save());
    assert.equal(records.has(candidate.projectId), false);
    assert.deepEqual(candidate.data(), expected);
  } finally {
    records.set = originalSet;
  }
  await candidate.save();
  assert.deepEqual((await loadAuthoredGame(candidate.projectId))!.files, expected.files);
  await clearCachedGame(candidate.projectId);
  await assert.rejects(candidate.save(), /removed|replaced|lifetime/i);
  assert.equal(await loadAuthoredGame(candidate.projectId), null);
});

test("local creation rejects an empty or oversized title before saving anything", () => {
  const size = records.size;
  for (const title of ["", " \n ", "x".repeat(161)])
    assert.throws(() => prepareLocalProject({ title, kind: "starter" }), /title/i);
  assert.equal(records.size, size);
});
