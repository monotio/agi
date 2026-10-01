import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { versionRefKey } from "../../src/creative/catalog.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { loadCreativeCatalog } from "../src/project/creativeStore.ts";
import { openCreativeWorkspace } from "../src/studio/creative/creativeWorkspace.ts";

const records = installIndexedDbFixture();
const encodedBytes = encodePngRgb(1, 1, new Uint8Array([255, 0, 0]));
const pixels = new Uint8Array([255, 0, 0, 255]);
const intake = {
  format: "png" as const,
  sourceWidth: 1,
  sourceHeight: 1,
  orientation: 1,
  encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
  encodedBytes,
  normalized: {
    format: "rgba8-srgb-unpremultiplied-v1" as const,
    width: 1,
    height: 1,
    blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
  },
  pixels,
};

async function seed(title: string): Promise<EditableProject> {
  const prepared = prepareLocalProject({ title, kind: "starter" });
  await prepared.save();
  return openEditableProject(prepared.projectId);
}

test("creative Keep preserves a board edit accepted after its publication was captured", async () => {
  const project = await seed("Creative Keep concurrent board review");
  let published!: () => void;
  let release!: () => void;
  const publication = new Promise<void>((resolve) => (published = resolve));
  const proceed = new Promise<void>((resolve) => (release = resolve));
  const delayedKeep: EditableProject["keepCandidate"] = async (...args) => {
    const result = await project.keepCandidate(...args);
    published();
    await proceed;
    return result;
  };
  const wrapped = new Proxy(project, {
    get(target, property) {
      if (property === "keepCandidate") return delayedKeep;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const workspace = openCreativeWorkspace(wrapped, { autosaveRecovery: false });
  await workspace.ready;
  const source = await workspace.importIntake(intake);
  const keep = workspace.keep();
  await publication;
  let acceptedId: string | undefined;
  try {
    acceptedId = workspace.addBoardEntry(versionRefKey(source.identity), { roles: ["style"] })
      .identity.id;
  } catch (error) {
    assert.match(
      String(error),
      /busy|progress|keep/i,
      "a mutation may explicitly refuse during Keep",
    );
  } finally {
    release();
  }
  await keep;
  try {
    if (acceptedId !== undefined) {
      assert.ok(
        workspace.board.some((entry) => entry.identity.id === acceptedId),
        "an accepted late board edit must remain pending after the earlier Keep",
      );
      const { catalog } = await loadCreativeCatalog(project.projectId);
      assert.equal(
        catalog?.board.some((entry) => entry.identity.id === acceptedId),
        false,
      );
    }
  } finally {
    await workspace.dispose();
  }
});

test("restoring creative recovery restores the real source edits it carries", async () => {
  const project = await seed("Creative recovery source review");
  const workspace = openCreativeWorkspace(project);
  await workspace.ready;
  await workspace.importIntake(intake);
  const before = project.draft.capture().read("logic:1");
  assert.ok(before && typeof before.content === "string");
  const authored = `${before.content}\n// This room belongs to the recovered drawing.\n`;
  project.draft.edit("logic:1", authored, before.version);
  await workspace.dispose();
  const reopened = await openEditableProject(project.projectId);
  const restored = openCreativeWorkspace(reopened);
  await restored.ready;
  try {
    const entry = (await restored.listRecoveries()).find(
      (candidate) => candidate.workspaceId === project.workspaceId,
    );
    assert.ok(entry);
    assert.equal(entry.status, "current");
    await restored.restoreRecovery(entry.workspaceId);
    assert.equal(
      reopened.draft.capture().read("logic:1")?.content,
      authored,
      "Restore must apply the current recovery's coordinated source instead of silently losing it",
    );
  } finally {
    await restored.dispose();
  }
});

test("creative Keep retains cleanup authority after a storage failure so recovery can retry", async () => {
  const project = await seed("Creative recovery cleanup retry");
  const workspace = openCreativeWorkspace(project);
  await workspace.ready;
  const source = await workspace.importIntake(intake);
  workspace.beginUnderlay(versionRefKey(source.identity), 1);
  await workspace.saveRecovery();
  const recoveryKey = `creative/${project.projectId}/draft/${project.workspaceId}`;
  assert.ok(records.has(recoveryKey), "the draft receipt has a durable row before Keep");
  const originalDelete = records.delete;
  let faults = 0;
  records.delete = function (key) {
    if (key === recoveryKey && faults++ === 0)
      throw new Error("Synthetic recovery cleanup storage failure");
    return originalDelete.call(this, key);
  };
  try {
    await workspace.keep();
  } finally {
    records.delete = originalDelete;
  }
  try {
    assert.equal(faults, 1, "only the intended recovery cleanup was refused");
    await assert.doesNotReject(
      workspace.saveRecovery(),
      "a failed cleanup must retain its exact receipt for retry instead of stranding recovery",
    );
    const recoveries = await workspace.listRecoveries();
    assert.equal(
      recoveries.find((entry) => entry.workspaceId === project.workspaceId)?.status,
      "current",
    );
  } finally {
    await workspace.dispose().catch(() => undefined);
  }
});
