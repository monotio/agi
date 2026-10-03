import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installedProgressTarget, projectProgressTarget } from "../src/project/progressTarget.ts";
import { bindSavedProgressTarget, resolveProgressTarget } from "../src/project/progressBinding.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { saveAuthoredGame } from "../src/project/gameStorage.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";

import { autosaveKey, readGameProgress, writeAutosave } from "../src/saves/gameProgress.ts";
const records = installIndexedDbFixture();
const local = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => local.set(k, v),
    removeItem: (k: string) => local.delete(k),
  },
});

test("a live binding cannot borrow another project's captured epoch", () => {
  const target = projectProgressTarget(
    "first-project",
    "1".repeat(64),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.ok(target);
  assert.equal(
    resolveProgressTarget({
      installed: false,
      projectId: "second-project",
      revision: "2".repeat(64),
      progressTarget: target,
    }),
    null,
  );
});

test("a saved progress identity uses the complete stored native bytes", async () => {
  records.clear();
  local.clear();
  const seed = prepareLocalProject({ title: "Revision drift", kind: "starter" });
  const data = seed.data();
  const files = structuredClone(data.files);
  const vol = files["VOL.0"]!;
  files["VOL.0"] = Uint8Array.from([...vol, 0x42]);
  const actual = await gameRevision(files);
  assert.notEqual(actual, data.library!.revision);
  await saveAuthoredGame(seed.projectId, { ...data, files });
  const target = await bindSavedProgressTarget(seed.projectId);
  assert.ok(target);
  assert.equal(target.identity.revision, actual);
});

test("a typed installed target refuses a checkpoint from earlier different bytes", () => {
  local.clear();
  const oldTarget = installedProgressTarget({ folder: "same-folder" }, "1".repeat(64));
  const currentTarget = installedProgressTarget({ folder: "same-folder" }, "2".repeat(64));
  assert.ok(oldTarget);
  assert.ok(currentTarget);
  // The revision is part of the physical address: the same folder running
  // earlier and current bytes owns two distinct locators.
  assert.notEqual(oldTarget.locator, currentTarget.locator);
  const storage = globalThis.localStorage;
  const record = {
    format: "monotio.agi.autosave" as const,
    version: 1 as const,
    image: "aA==",
    cycle: 1,
    room: 1,
    savedAt: 1,
    game: { installed: true, identity: oldTarget.identity },
  };
  assert.ok(writeAutosave(storage, oldTarget, record));
  // The earlier build's record physically placed under the current build's
  // address is still foreign there: the locator's revision wins over what
  // the stray record claims, and the read refuses it.
  local.set(autosaveKey(currentTarget.locator), JSON.stringify(record));
  const before = structuredClone(local);
  assert.equal(readGameProgress(storage, currentTarget).autosave, null);
  // The original checkpoint stays readable at its own address, unerased.
  assert.deepEqual(readGameProgress(storage, oldTarget).autosave, record);
  assert.deepEqual(local, before, "refusing an earlier checkpoint does not erase it");
});

test("target-only evidence stays with its project and a changed native revision", () => {
  const captured = projectProgressTarget(
    "same-project",
    "1".repeat(64),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.ok(captured);
  const rebound = resolveProgressTarget({
    installed: false,
    projectId: "same-project",
    revision: "2".repeat(64),
    progressTarget: captured,
  });
  assert.ok(rebound);
  assert.equal(rebound.locator, captured.locator);
  assert.equal(rebound.identity.revision, "2".repeat(64));
  assert.equal(
    resolveProgressTarget({
      installed: false,
      projectId: "same-project",
      revision: "2".repeat(64),
      historyLifetime: null,
      progressTarget: captured,
    }),
    null,
  );
});
