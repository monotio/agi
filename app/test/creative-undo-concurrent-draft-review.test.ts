import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { versionRefKey } from "../../src/creative/catalog.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
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

test("a field edit immediately after Undo branches and has its own pre-state", async () => {
  const prepared = prepareLocalProject({ title: "Creative field branch", kind: "blank" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project, { autosaveRecovery: false, now: () => 0 });
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
  workspace.beginUnderlay(versionRefKey(source.identity), 1);
  await workspace.saveRecovery();
  const original = workspace.underlay!.opacity;
  workspace.updateUnderlay({ opacity: 0.25 });
  await workspace.saveRecovery();
  await workspace.undo();
  assert.equal(workspace.underlay!.opacity, original);
  assert.equal(workspace.canRedo, true);
  workspace.updateUnderlay({ opacity: 0.75 });
  await workspace.saveRecovery();
  try {
    assert.equal(
      workspace.canRedo,
      false,
      "typing after Undo replaces the redo branch immediately",
    );
    await workspace.undo();
    assert.equal(workspace.underlay!.opacity, original);
  } finally {
    await workspace.dispose();
  }
});

test("typing during displaced-state persistence refuses creative Undo and preserves the draft", async () => {
  const prepared = prepareLocalProject({ title: "Concurrent creative Undo", kind: "blank" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project, { autosaveRecovery: false });
  await workspace.ready;
  const pixels = new Uint8Array([255, 0, 0, 255]);
  const encodedBytes = encodePngRgb(1, 1, new Uint8Array([255, 0, 0]));
  await workspace.importIntake({
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
  await workspace.saveRecovery();
  assert.equal(workspace.canUndo, true);
  const sourceId = workspace.sources[0]!.record.identity.id;
  const typed = "// newer typing during Undo persistence\nreturn;";
  const write = records.set.bind(records);
  let injected = false;
  records.set = (key, value) => {
    const result = write(key, value);
    // The actual IndexedDB fixture commits the displaced-state snapshot
    // before its awaiting caller resumes. A shared editor can type here.
    if (!injected && typeof key === "string" && key.includes("/undo/")) {
      injected = true;
      const draft = project.draft.capture();
      project.draft.edit("logic:1", typed, draft.version("logic:1"));
    }
    return result;
  };
  try {
    const refusal = await workspace.undo().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(injected, true, "the edit happened during displaced-state persistence");
    assert.equal(project.draft.capture().read("logic:1")?.content, typed);
    assert.equal(workspace.sources[0]!.record.identity.id, sourceId);
    assert.ok(refusal instanceof Error && /changed|newer|moved/i.test(refusal.message));
  } finally {
    records.set = write;
    await workspace.dispose();
  }
});

test("typing while earlier capture drains cannot rebase a queued creative Undo", async () => {
  const prepared = prepareLocalProject({ title: "Queued Undo authority", kind: "blank" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project, { autosaveRecovery: false, now: () => 0 });
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
  workspace.beginUnderlay(versionRefKey(source.identity), 1);
  await workspace.saveRecovery();
  const typed = "// newer typing while queued Undo awaits its tail\nreturn;";
  const write = records.set.bind(records);
  let injected = false;
  records.set = (key, value) => {
    const result = write(key, value);
    if (!injected && typeof key === "string" && key.includes("/undo/")) {
      injected = true;
      const snap = project.draft.capture();
      project.draft.edit("logic:1", typed, snap.version("logic:1"));
    }
    return result;
  };
  try {
    workspace.updateUnderlay({ opacity: 0.25 });
    const refusal = await workspace.undo().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(injected, true, "the earlier queued capture drained after Undo was called");
    assert.equal(project.draft.capture().read("logic:1")?.content, typed);
    assert.equal(workspace.underlay?.opacity, 0.25);
    assert.ok(refusal instanceof Error && /changed|newer|moved/i.test(refusal.message));
  } finally {
    records.set = write;
    await workspace.dispose();
  }
});
