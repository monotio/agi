import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCreativeCatalog, writeCreativeCatalogRecord } from "../../src/creative/catalog.ts";
import { commitProject, loadAuthoredGame } from "../src/project/gameStorage.ts";
import { loadCreativeCatalog } from "../src/project/creativeStore.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";

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
function request(name: string) {
  return {
    projectId: testProjectId(name),
    commitId: "first",
    workspaceId: "workspace-one",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:1", version: 1 }],
    data: {
      title: "Adventure",
      provider: "stub",
      model: "offline-stub",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [] as [string, number][],
    },
  };
}
function catalog(projectId: string, expiresAt: number) {
  return {
    ...emptyCreativeCatalog(projectId),
    head: 1,
    leases: [
      {
        id: "lease",
        owner: "editor",
        workspace: "workspace-one",
        expiresAt,
        staged: { sources: [], derivatives: [], recipes: [], blobs: [] },
      },
    ],
  };
}
function publication(asOf: number) {
  return {
    expectedHead: 1,
    asOf,
    lease: { id: "lease", owner: "editor", workspace: "workspace-one" },
    keep: { sources: [], derivatives: [], recipes: [], board: [] },
  };
}

test("creative publication checks lease expiry at admission rather than its old offered timestamp", async () => {
  const input = request("creative-expired-admission");
  const first = await commitProject(input);
  const raw = writeCreativeCatalogRecord(catalog(input.projectId, Date.now() - 1000));
  records.set(String(raw["projectId"]), raw);
  const before = structuredClone([...records]);
  await assert.rejects(
    commitProject({
      ...input,
      commitId: "expired",
      expected: first.receipt.saved,
      creative: publication(1),
    }),
    /expir|lease/i,
  );
  assert.deepEqual([...records], before);
});

test("an ordinary source Keep preserves the authoritative kept creative marker", async () => {
  const input = request("creative-marker-preservation");
  const first = await commitProject(input);
  const raw = writeCreativeCatalogRecord(catalog(input.projectId, Date.now() + 60000));
  records.set(String(raw["projectId"]), raw);
  const published = await commitProject({
    ...input,
    commitId: "art",
    expected: first.receipt.saved,
    creative: publication(Date.now()),
  });
  assert.deepEqual((await loadCreativeCatalog(input.projectId)).marker, { kept: 1 });
  await commitProject({
    ...input,
    commitId: "logic",
    expected: published.receipt.saved,
    data: { ...input.data, title: "Edited logic" },
  });
  assert.deepEqual((await loadCreativeCatalog(input.projectId)).marker, { kept: 1 });
  assert.deepEqual((await loadAuthoredGame(input.projectId))!.creative, { kept: 1 });
});

test("candidate metadata cannot forge a creative marker without catalog publication", async () => {
  const input = request("creative-marker-forgery");
  const first = await commitProject(input);
  const before = structuredClone([...records]);
  await assert.rejects(
    commitProject({
      ...input,
      commitId: "forged",
      expected: first.receipt.saved,
      data: { ...input.data, creative: { kept: 999 } },
    }),
    /creative|catalog|marker/i,
  );
  assert.deepEqual([...records], before);
});

test("a published creative catalog cannot be opened or overwritten after its body marker is lost", async () => {
  const input = request("creative-missing-durable-marker");
  const first = await commitProject(input);
  const raw = writeCreativeCatalogRecord(catalog(input.projectId, Date.now() + 60000));
  records.set(String(raw["projectId"]), raw);
  const published = await commitProject({
    ...input,
    commitId: "art",
    expected: first.receipt.saved,
    creative: publication(Date.now()),
  });
  const damaged = structuredClone(records.get(input.projectId)) as Record<string, unknown>;
  delete damaged["creative"];
  records.set(input.projectId, damaged);
  const before = structuredClone([...records]);
  await assert.rejects(loadCreativeCatalog(input.projectId), /marker|catalog|creative/i);
  await assert.rejects(
    commitProject({
      ...input,
      commitId: "logic-after-marker-loss",
      expected: published.receipt.saved,
    }),
    /marker|catalog|creative/i,
  );
  assert.deepEqual([...records], before);
});
