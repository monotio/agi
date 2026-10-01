import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { openCreativeWorkspace } from "../src/studio/creative/creativeWorkspace.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  },
});

test("a native history lease refusing Creative Undo preserves every live participant", async () => {
  const prepared = prepareLocalProject({ title: "Creative lease atomicity", kind: "blank" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project, { autosaveRecovery: false });
  await workspace.ready;
  const pixels = new Uint8Array([255, 0, 0, 255]);
  const encodedBytes = encodePngRgb(1, 1, new Uint8Array([255, 0, 0]));
  const source = await workspace.importIntake({
    format: "png",
    sourceWidth: 1,
    sourceHeight: 1,
    orientation: 1,
    encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
    encodedBytes,
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    pixels,
  });
  const typed = "return; // current shared code";
  const base = project.draft.capture();
  project.draft.edit("logic:1", typed, base.version("logic:1"));
  await workspace.saveRecovery();
  assert.equal(workspace.canUndo, true);
  const lease = project.draft.acquireHistoryMutation(project.draft.capture().revision);
  try {
    await assert.rejects(workspace.undo(), /native history|running|busy/i);
    assert.equal(project.draft.capture().read("logic:1")?.content, typed);
    assert.equal(
      workspace.sources[0]?.record.identity.id,
      source.identity.id,
      "a refused first draft mutation must not already replace Creative state",
    );
    assert.equal(workspace.canUndo, true, "the refusal must not advance the live cursor");
  } finally {
    project.draft.releaseHistoryMutation(lease);
    await workspace.dispose();
  }
});
