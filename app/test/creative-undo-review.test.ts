import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import {
  creativeBlobKey,
  creativeCatalogKey,
  writeCreativeCatalogRecord,
} from "../../src/creative/catalog.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { openCreativeWorkspace } from "../src/studio/creative/creativeWorkspace.ts";
import { readCreativeDraft } from "../src/project/creativeDrafts.ts";
import { loadCreativeCatalog } from "../src/project/creativeStore.ts";
import {
  CreativeDraftError,
  discardCreativeUndo,
  readCreativeUndo,
  saveCreativeUndo,
} from "../src/project/creativeUndo.ts";

const records = installIndexedDbFixture();
const encodedBytes = encodePngRgb(1, 1, new Uint8Array([255, 0, 0]));
const pixels = new Uint8Array([255, 0, 0, 255]);

for (const damage of ["hold", "blob"] as const) {
  test(`an exact undo append retry refuses a damaged retained ${damage}`, async () => {
    const prepared = prepareLocalProject({ title: `Undo retry ${damage}`, kind: "starter" });
    await prepared.save();
    const project = await openEditableProject(prepared.projectId);
    const workspace = openCreativeWorkspace(project);
    await workspace.ready;
    await workspace.importIntake({
      format: "png",
      sourceWidth: 1,
      sourceHeight: 1,
      orientation: 1,
      encoded: {
        hash: sha256Hex(encodedBytes),
        byteLength: encodedBytes.length,
        mime: "image/png",
      },
      encodedBytes,
      normalized: {
        format: "rgba8-srgb-unpremultiplied-v1",
        width: 1,
        height: 1,
        blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
      },
      pixels,
    });
    await workspace.saveRecovery();
    const draft = await readCreativeDraft(project.projectId, project.workspaceId);
    assert.ok(draft && draft.integrity && draft.status === "current");
    const input = {
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      snapshotId: crypto.randomUUID(),
      expected: draft.expected,
      authority: { kind: "draft" as const, receipt: draft.receipt },
      recovery: draft.recovery,
    };
    const appended = await saveCreativeUndo(input);
    if (damage === "hold") {
      const { catalog } = await loadCreativeCatalog(project.projectId);
      assert.ok(catalog);
      records.set(
        creativeCatalogKey(project.projectId),
        writeCreativeCatalogRecord({
          ...catalog,
          holds: catalog.holds.filter((hold) => hold.id !== `undo-${appended.receipt.incarnation}`),
        }),
      );
    } else {
      const key = creativeBlobKey(project.projectId, sha256Hex(encodedBytes));
      const raw = records.get(key) as { bytes: Uint8Array };
      assert.ok(raw && raw.bytes instanceof Uint8Array);
      const corrupt = raw.bytes.slice();
      corrupt[0] = (corrupt[0]! + 1) & 255;
      records.set(key, { ...raw, bytes: corrupt });
    }
    const before = structuredClone(records);
    try {
      await assert.rejects(
        saveCreativeUndo(input),
        (error: unknown) =>
          error instanceof CreativeDraftError && /integrity|missing|conflict/.test(error.reason),
        "idempotence must not report an intact retained snapshot after its hold or bytes were lost",
      );
      assert.deepEqual(records, before, "a refused retry leaves retained work untouched");
    } finally {
      await workspace.dispose().catch(() => undefined);
    }
  });
}

test("a discarded snapshot's old receipt cannot delete a recreated snapshot", async () => {
  const prepared = prepareLocalProject({ title: "Undo receipt recreation", kind: "starter" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project);
  await workspace.ready;
  await workspace.importIntake({
    format: "png",
    sourceWidth: 1,
    sourceHeight: 1,
    orientation: 1,
    encoded: {
      hash: sha256Hex(encodedBytes),
      byteLength: encodedBytes.length,
      mime: "image/png",
    },
    encodedBytes,
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    pixels,
  });
  await workspace.saveRecovery();
  const draft = await readCreativeDraft(project.projectId, project.workspaceId);
  assert.ok(draft && draft.integrity && draft.status === "current");
  const input = {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    snapshotId: crypto.randomUUID(),
    expected: draft.expected,
    authority: { kind: "draft" as const, receipt: draft.receipt },
    recovery: draft.recovery,
  };
  const first = await saveCreativeUndo(input);
  await discardCreativeUndo(project.projectId, input.snapshotId, first.receipt);
  const second = await saveCreativeUndo(input);
  assert.ok(await readCreativeUndo(project.projectId, input.snapshotId));
  const before = structuredClone(records);
  try {
    await assert.rejects(
      discardCreativeUndo(project.projectId, input.snapshotId, first.receipt),
      (error: unknown) => error instanceof CreativeDraftError && error.reason === "conflict",
      "an old receipt must not authorize deletion of a later snapshot incarnation",
    );
    assert.deepEqual(records, before, "the later snapshot and its hold survive a stale discard");
    assert.notDeepEqual(second.receipt, first.receipt);
  } finally {
    await workspace.dispose().catch(() => undefined);
  }
});
