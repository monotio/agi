import assert from "node:assert/strict";
import { test } from "node:test";
import { versionRefKey } from "../../src/creative/catalog.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { readCreativeUndo } from "../src/project/creativeUndo.ts";
import type { CreativeImageIntake } from "../src/references/creativeImageDecode.ts";
import {
  openCreativeWorkspace,
  type CreativeMaterialWorkspace,
} from "../src/studio/creative/creativeWorkspace.ts";

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

/** A real intake shape: an encoded PNG original plus its canonical raster. */
function intake(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
): CreativeImageIntake {
  const pixels = new Uint8Array(width * height * 4);
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const p = (y * width + x) * 4;
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = a;
      const q = (y * width + x) * 3;
      rgb[q] = r;
      rgb[q + 1] = g;
      rgb[q + 2] = b;
    }
  }
  const encodedBytes = encodePngRgb(width, height, rgb);
  return {
    format: "png",
    sourceWidth: width,
    sourceHeight: height,
    orientation: 1,
    encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
    encodedBytes,
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width,
      height,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    pixels,
  };
}

async function seed(name: string): Promise<EditableProject> {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  return openEditableProject(prepared.projectId);
}

function srcKey(cw: CreativeMaterialWorkspace, id: string): string {
  const source = cw.sources.find((entry) => entry.record.identity.id === id);
  assert.ok(source, `source ${id} staged`);
  return versionRefKey(source.record.identity);
}

test("own creative Keep preserves live Undo while old rows stay stale and saved bytes stay kept", async () => {
  const ws = await seed("own-keep-live-undo-contract");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  await cw.ready;
  try {
    const source = await cw.importIntake(intake(2, 2, () => [255, 0, 0, 255]));
    cw.addBoardEntry(srcKey(cw, source.identity.id), { roles: ["style"] });
    await cw.saveRecovery();
    assert.equal(cw.canUndo, true);
    await cw.keep();
    await cw.saveRecovery();
    const saved = ws.savedIdentity();
    const stored = structuredClone(records.get(ws.projectId));
    const rows = cw.undoHistory;
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(
        (await readCreativeUndo(ws.projectId, row.snapshotId))?.status,
        "stale",
        "own Keep must not rewrite a historical row's original base",
      );
    }
    assert.equal(cw.canUndo, true, "own Keep must preserve this live workspace's Undo chain");
    await cw.undo();
    assert.deepEqual(
      records.get(ws.projectId),
      stored,
      "Undo creates unkept work and never rewinds the saved body",
    );
    assert.equal(ws.savedIdentity(), saved);
    assert.equal(cw.canRedo, true);
    await cw.redo();
    assert.deepEqual(records.get(ws.projectId), stored);
    assert.equal(ws.savedIdentity(), saved);
  } finally {
    await cw.dispose();
  }
});
