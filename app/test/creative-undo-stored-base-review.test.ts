import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { readCreativeUndo } from "../src/project/creativeUndo.ts";
import { openCreativeWorkspace } from "../src/studio/creative/creativeWorkspace.ts";

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

test("creative Undo refuses when its final snapshot read classifies the stored base as stale", async () => {
  const prepared = prepareLocalProject({ title: "Stored Undo base", kind: "blank" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project, { autosaveRecovery: false });
  await workspace.ready;
  const pixels = new Uint8Array([255, 0, 0, 255]);
  const encodedBytes = encodePngRgb(1, 1, new Uint8Array([255, 0, 0]));
  await workspace.importIntake({
    format: "png", sourceWidth: 1, sourceHeight: 1, orientation: 1,
    encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
    encodedBytes,
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1", width: 1, height: 1,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    pixels,
  });
  await workspace.saveRecovery();
  const target = workspace.undoHistory[0]!;
  const rowKey = `creative/${project.projectId}/undo/${target.snapshotId}`;
  const sourceId = workspace.sources[0]!.record.identity.id;
  const read = records.get.bind(records);
  let reads = 0;
  let injected = false;
  records.get = (key) => {
    // The target is read for the initial gate, displaced capture refresh,
    // replacement preparation, then final receipt/status verification.
    if (key === rowKey && ++reads === 4) {
      const body = structuredClone(read(project.projectId)) as { generation: number };
      assert.equal(typeof body.generation, "number");
      body.generation++;
      records.set(project.projectId, body);
      injected = true;
    }
    return read(key);
  };
  try {
    const refusal = await workspace.undo().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(injected, true, "the stored base moved during final verification");
    assert.equal((await readCreativeUndo(project.projectId, target.snapshotId))?.status, "stale");
    assert.equal(workspace.sources[0]?.record.identity.id, sourceId);
    assert.ok(refusal instanceof Error && /stale|changed|moved/i.test(refusal.message));
  } finally {
    records.get = read;
    await workspace.dispose();
  }
});
