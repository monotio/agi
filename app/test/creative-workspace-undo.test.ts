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

const RED_2X2 = intake(2, 2, () => [255, 0, 0, 255]);
const BLUE_4X4 = intake(4, 4, () => [0, 0, 255, 255]);
const SHEET_4X2 = intake(4, 2, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 64]));

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

/**
 * Drain the workspace's serialized tail: a queued capture is durable and
 * registered with the cursor only after this resolves — a step taken right
 * after an edit may not be undoable until its row lands.
 */
async function flush(cw: CreativeMaterialWorkspace): Promise<void> {
  await cw.saveRecovery().catch(() => undefined);
}

test("undo removes an imported source and redo restores its exact bytes", async () => {
  const ws = await seed("cw-undo-import");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  assert.equal(cw.canUndo, false);
  const src = await cw.importIntake(RED_2X2, { title: "Red plate" });
  await flush(cw);
  assert.equal(cw.canUndo, true);

  await cw.undo();
  assert.equal(cw.sources.length, 0);
  assert.equal(cw.canUndo, false);
  assert.equal(cw.canRedo, true);

  await cw.redo();
  assert.equal(cw.sources.length, 1);
  assert.equal(cw.sources[0]!.record.identity.id, src.identity.id);
  assert.deepEqual([...cw.sources[0]!.encoded], [...RED_2X2.encodedBytes]);
  assert.deepEqual([...cw.sources[0]!.pixels], [...RED_2X2.pixels]);
  await cw.dispose();
});

test("a numeric crop burst is one step and undo restores the starting crop", async () => {
  const ws = await seed("cw-undo-crop");
  const clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  await flush(cw);
  const before = cw.underlay!.crop;
  // Same field, inside the coalesce window: one gesture, one snapshot.
  cw.updateUnderlay({ crop: { x: 1, y: 0, width: 2, height: 2 } });
  cw.updateUnderlay({ crop: { x: 2, y: 0, width: 2, height: 2 } });
  cw.updateUnderlay({ crop: { x: 3, y: 0, width: 2, height: 2 } });
  await flush(cw);
  const history = cw.undoHistory.length;
  await cw.undo();
  assert.ok(cw.underlay !== null, "the crop undo keeps the open job");
  assert.deepEqual(cw.underlay!.crop, before);
  // One displaced capture was added — no per-edit rows in between.
  assert.equal(cw.undoHistory.length, history + 1);
  await cw.dispose();
});

test("view job grid, loop and mask edits undo and redo field-for-field", async () => {
  const ws = await seed("cw-undo-view");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  const src = await cw.importIntake(SHEET_4X2);
  const job = cw.beginViewJob(srcKey(cw, src.identity.id), { columns: 2 });
  cw.setViewDestination(7);
  await flush(cw);
  assert.equal(cw.viewJob!.frames.length, 2);
  assert.deepEqual(
    cw.viewJob!.frames.map((frame) => frame.id),
    ["f0", "f1"],
  );

  clock += 2000;
  cw.updateViewJob({ mask: { alphaThreshold: 32, key: null } });
  clock += 2000;
  cw.updateViewJob({
    loops: [
      { id: "l0", frameIds: ["f0", "f1"], facing: "right" },
      { id: "l1", mirrorOf: "l0", explicitlyApproved: true, facing: "left" },
    ],
  });
  await flush(cw);
  await cw.undo();
  assert.deepEqual(
    cw.viewJob!.loops.map((loop) => loop.id),
    ["l0"],
    "undo drops the mirrored loop",
  );
  await cw.redo();
  const mirrored = cw.viewJob!.loops[1]!;
  assert.ok("mirrorOf" in mirrored && mirrored.mirrorOf === "l0");
  await cw.undo();
  assert.equal(cw.viewJob!.mask.alphaThreshold, 32);
  await cw.undo();
  assert.equal(cw.viewJob!.mask.alphaThreshold, 128);
  await cw.redo();
  await cw.redo();
  assert.equal(cw.viewJob!.mask.alphaThreshold, 32);
  assert.equal(cw.viewJob!.loops.length, 2);

  // Undo destination, then the job's creation step.
  clock += 2000;
  await cw.undo();
  await cw.undo();
  await cw.undo();
  await cw.undo();
  assert.equal(cw.viewJob, null);
  assert.equal(cw.sources.length, 1);
  // Redo walks forward: begin, then the destination step.
  await cw.redo();
  await cw.redo();
  assert.equal(cw.viewJob!.destination, 7);
  assert.deepEqual(
    cw.viewJob!.frames.map((frame) => frame.region.x),
    job.frames.map((frame) => frame.region.x),
  );
  await cw.dispose();
});

test("undo reverts a coordinated draft write and redo restores it", async () => {
  const ws = await seed("cw-undo-draft");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const src = await cw.importIntake(SHEET_4X2);
  cw.beginViewJob(srcKey(cw, src.identity.id), { columns: 2 });
  cw.setViewDestination(4);
  await flush(cw);
  cw.applyViewToDraft();
  assert.ok(ws.draft.capture().read("view:4"), "the prepared view landed in the draft");
  await flush(cw);

  await cw.undo();
  assert.equal(
    ws.draft.capture().read("view:4"),
    undefined,
    "undo removes the coordinated draft document",
  );
  await cw.redo();
  assert.ok(ws.draft.capture().read("view:4"), "redo restores it");
  await cw.dispose();
});

test("undo restores a board entry its removal displaced", async () => {
  const ws = await seed("cw-undo-board");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  const added = cw.addBoardEntry(srcKey(cw, src.identity.id), {
    roles: ["style"],
    notes: "mood",
  });
  await flush(cw);
  cw.removeBoardEntry(added.identity);
  assert.equal(cw.board.length, 0);
  await flush(cw);
  await cw.undo();
  assert.equal(cw.board.length, 1);
  assert.equal(cw.board[0]!.notes, "mood");
  await cw.dispose();
});

test("a new edit after undo branches without dropping retained history", async () => {
  const ws = await seed("cw-undo-branch");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  await cw.importIntake(RED_2X2);
  clock += 2000;
  const src2 = await cw.importIntake(BLUE_4X4);
  await flush(cw);
  const retained = cw.undoHistory.length;
  assert.equal(retained, 2);

  await cw.undo();
  assert.equal(cw.sources.length, 1);
  // Branching: a different edit replaces the redo branch but the displaced
  // snapshot stays retained and reviewable.
  clock += 2000;
  await cw.importIntake(intake(3, 3, () => [255, 255, 0, 255]));
  await flush(cw);
  assert.equal(cw.canRedo, false);
  assert.equal(cw.undoHistory.length >= retained, true);
  let gone = false;
  for (const row of cw.undoHistory) {
    const retainedRow = await readCreativeUndo(ws.projectId, row.snapshotId);
    if (retainedRow?.recovery.sources.some((source) => source.identity.id === src2.identity.id))
      gone = true;
  }
  assert.ok(gone, "the displaced snapshot is still listed for review");
  await cw.dispose();
});

test("a Keep stales earlier snapshots: undo refuses, the row stays listed and discardable", async () => {
  const ws = await seed("cw-undo-stale-keep");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  cw.addBoardEntry(srcKey(cw, src.identity.id), { roles: ["style"] });
  await cw.keep();
  await flush(cw);

  assert.equal(cw.canUndo, false, "the top snapshot is stale after the Keep");
  const rows = cw.undoHistory;
  assert.ok(rows.length >= 2);
  await assert.rejects(() => cw.undo(), /stale/);
  // The stale entry is still reviewable and discards by exact receipt.
  await cw.discardUndoSnapshot(rows[rows.length - 1]!);
  assert.equal(cw.undoHistory.length, rows.length - 1);
  await cw.dispose();
});

test("undo after a Keep restores a step captured on the new base", async () => {
  const ws = await seed("cw-undo-postkeep");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  const kept = cw.addBoardEntry(srcKey(cw, src.identity.id), { roles: ["style"] });
  await cw.keep();
  await flush(cw);
  // A removal of the kept entry is a fresh step on the post-Keep base.
  cw.removeBoardEntry(kept.identity);
  assert.equal(cw.board.length, 0);
  await flush(cw);
  await cw.undo();
  assert.equal(cw.board.length, 1, "the kept entry is back on the board");
  await cw.dispose();
});

test("discard with a foreign receipt refuses and keeps the row", async () => {
  const ws = await seed("cw-undo-foreign");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  await cw.importIntake(RED_2X2);
  await flush(cw);
  const entry = cw.undoHistory[0]!;
  const foreign = { ...entry, receipt: { incarnation: "foreign", sequence: 999 } };
  await assert.rejects(() => cw.discardUndoSnapshot(foreign), /changed|conflict/i);
  assert.equal(cw.undoHistory.length, 1);
  await cw.dispose();
});

test("undo captures typing that landed while the restore was queued", async () => {
  const ws = await seed("cw-undo-typing");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  await cw.importIntake(RED_2X2);
  clock += 2000;
  // Type into the shared draft while the second import waits on the tail.
  const pending = cw.importIntake(BLUE_4X4);
  const snap = ws.draft.capture();
  ws.draft.edit("logic:1", 'message 1 "typed mid-import";', snap.version("logic:1"));
  await pending;
  await flush(cw);
  await cw.undo();
  assert.equal(cw.sources.length, 1);
  // The racing edit went into the displaced-state snapshot, so redo
  // restores it — newer typing is never silently lost.
  await cw.redo();
  assert.equal(ws.draft.capture().read("logic:1")?.content, 'message 1 "typed mid-import";');
  await cw.dispose();
});

test("history survives a workspace reopen: undo restores the retained step", async () => {
  const ws = await seed("cw-undo-reopen");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  await cw.importIntake(RED_2X2);
  clock += 2000;
  const src = await cw.importIntake(BLUE_4X4);
  await cw.dispose();

  const reopened = openCreativeWorkspace(ws);
  await reopened.ready;
  // Recovery is a reviewable prompt, not an auto-merge — but the retained
  // snapshots hydrate the undo chain directly.
  assert.equal(reopened.sources.length, 0);
  assert.equal(reopened.canUndo, true);
  await reopened.undo();
  assert.equal(reopened.sources.length, 1);
  assert.equal(reopened.sources[0]!.record.identity.id !== src.identity.id, true);
  await reopened.dispose();
});

test("undo on a closed workspace refuses", async () => {
  const ws = await seed("cw-undo-closed");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  await cw.importIntake(RED_2X2);
  await cw.dispose();
  await assert.rejects(() => cw.undo(), /closed/);
  assert.equal(cw.canUndo, false);
});

test("a field edit immediately after redo keeps the redone state as its pre-state", async () => {
  const ws = await seed("cw-undo-redo-branch");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  await flush(cw);
  const original = cw.underlay!.opacity;
  clock += 2000;
  cw.updateUnderlay({ opacity: 0.25 });
  await flush(cw);
  await cw.undo();
  assert.equal(cw.underlay!.opacity, original);
  await cw.redo();
  assert.equal(cw.underlay!.opacity, 0.25);
  // Same field at the same instant as the redo: it must still be a new
  // step, so undoing it returns to the state the redo restored.
  cw.updateUnderlay({ opacity: 0.9 });
  await flush(cw);
  assert.equal(cw.canUndo, true);
  await cw.undo();
  assert.equal(cw.underlay!.opacity, 0.25);
  await cw.redo();
  assert.equal(cw.underlay!.opacity, 0.9);
  await cw.dispose();
});

test("a field edit immediately after a history jump keeps the restored state as its pre-state", async () => {
  const ws = await seed("cw-undo-jump-branch");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  const original = cw.underlay!.opacity;
  clock += 2000;
  cw.updateUnderlay({ opacity: 0.25 });
  clock += 2000;
  cw.updateUnderlay({ opacity: 0.7 });
  await flush(cw);
  // Rows: import, begin, pre-.25-edit, pre-.7-edit. Jump to the third.
  const target = cw.undoHistory[2]!;
  await cw.restoreUndoSnapshot(target.snapshotId);
  assert.equal(cw.underlay!.opacity, original);
  cw.updateUnderlay({ opacity: 0.9 });
  await flush(cw);
  await cw.undo();
  assert.equal(
    cw.underlay!.opacity,
    original,
    "the edit after a jump undoes to the jumped-to state",
  );
  await cw.dispose();
});

test("typing during the first snapshot read refuses undo and preserves the draft", async () => {
  const ws = await seed("cw-undo-early-race");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  await cw.ready;
  await cw.importIntake(RED_2X2);
  const src = cw.sources[0]!;
  cw.beginUnderlay(versionRefKey(src.record.identity), 1);
  await flush(cw);
  const typed = "// newer typing during the target read\nreturn;";
  const get = records.get.bind(records);
  let injected = false;
  records.get = (key: IDBValidKey) => {
    // The first `/undo/` row read is the operation's first await.
    if (!injected && typeof key === "string" && key.includes("/undo/")) {
      injected = true;
      ws.draft.edit("logic:1", typed, ws.draft.capture().version("logic:1"));
    }
    return get(key);
  };
  const before = cw.undoHistory.length;
  try {
    const refusal = await cw.undo().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(injected, true, "the edit landed during the first await");
    assert.equal(ws.draft.capture().read("logic:1")?.content, typed);
    assert.equal(cw.sources.length, 1);
    assert.equal(cw.underlay !== null, true);
    assert.ok(refusal instanceof Error && /changed|newer|moved/i.test(refusal.message));
    // The refused step stays undoable and the displaced row stays listed.
    assert.equal(cw.canUndo, true);
    assert.equal(cw.undoHistory.length, before + 1);
  } finally {
    records.get = get;
    await cw.dispose();
  }
});

test("typing during the final snapshot re-read refuses undo and preserves the draft", async () => {
  const ws = await seed("cw-undo-final-race");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  await cw.ready;
  await cw.importIntake(RED_2X2);
  const src = cw.sources[0]!;
  cw.beginUnderlay(versionRefKey(src.record.identity), 1);
  await flush(cw);
  const typed = "// newer typing during the final re-read\nreturn;";
  // The target row is read four times: the pre-retain check, the list
  // refresh inside the displaced persist, the restore's own load, and the
  // last receipt re-read before the swap. Inject on the fourth.
  const targetId = cw.undoHistory[cw.undoHistory.length - 1]!.snapshotId;
  const get = records.get.bind(records);
  let reads = 0;
  let injected = false;
  records.get = (key: IDBValidKey) => {
    if (!injected && typeof key === "string" && key.includes(`/undo/${targetId}`)) {
      reads += 1;
      if (reads === 4) {
        injected = true;
        ws.draft.edit("logic:1", typed, ws.draft.capture().version("logic:1"));
      }
    }
    return get(key);
  };
  try {
    const refusal = await cw.undo().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(injected, true, "the edit landed during the final re-read");
    assert.equal(ws.draft.capture().read("logic:1")?.content, typed);
    assert.equal(cw.sources.length, 1);
    assert.equal(cw.underlay !== null, true);
    assert.ok(refusal instanceof Error && /changed|newer|moved/i.test(refusal.message));
    assert.equal(cw.canUndo, true);
  } finally {
    records.get = get;
    await cw.dispose();
  }
});

test("queued bookkeeping draining ahead of an undo does not refuse it", async () => {
  const ws = await seed("cw-undo-queue-drain");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  cw.beginUnderlay(versionRefKey(src.identity), 1);
  await flush(cw);
  // saveRecovery ends with a bookkeeping changed() on the tail. Queue it,
  // then the undo behind it: the save's notification lands while the undo
  // waits — no content moves — so the undo must proceed.
  const save = cw.saveRecovery();
  await cw.undo();
  await save;
  assert.equal(cw.underlay, null);
  assert.equal(cw.sources.length, 1);
  assert.equal(cw.canRedo, true);
  await cw.redo();
  assert.equal(cw.underlay !== null, true);
  await cw.dispose();
});

test("a stored-base move during the final read refuses undo and preserves the cursor", async () => {
  const ws = await seed("cw-undo-stored-base");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  cw.beginUnderlay(versionRefKey(src.identity), 1);
  await flush(cw);
  // The target row is read for the pre-retain gate, the displaced persist
  // refresh, the restore's own load, then final verification. A rival
  // commit landing at the fourth read advances the stored generation while
  // the row's receipt is untouched — status classifies stale.
  const targetId = cw.undoHistory[cw.undoHistory.length - 1]!.snapshotId;
  const rowKey = `creative/${ws.projectId}/undo/${targetId}`;
  const get = records.get.bind(records);
  let reads = 0;
  let injected = false;
  records.get = (key: IDBValidKey) => {
    if (key === rowKey && ++reads === 4) {
      const body = structuredClone(get(ws.projectId)) as { generation: number };
      body.generation++;
      records.set(ws.projectId, body);
      injected = true;
    }
    return get(key);
  };
  const before = cw.undoHistory.length;
  try {
    const refusal = await cw.undo().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(injected, true, "the stored base moved during final verification");
    assert.equal(
      (await readCreativeUndo(ws.projectId, targetId))?.status,
      "stale",
      "the row is honestly classified stale",
    );
    assert.equal(cw.sources.length, 1);
    assert.equal(cw.underlay !== null, true);
    assert.ok(refusal instanceof Error && /stale|changed|moved/i.test(refusal.message));
    // The cursor stayed put: the step remains undoable, nothing redoes,
    // and the durable displaced row stays listed for review.
    assert.equal(cw.canUndo, true);
    assert.equal(cw.canRedo, false);
    assert.equal(cw.undoHistory.length, before + 1);
    assert.equal(cw.undoError, refusal instanceof Error ? refusal.message : refusal);
  } finally {
    records.get = get;
    await cw.dispose();
  }
});

test("a list failure after a committed restore does not turn success into refusal", async () => {
  const ws = await seed("cw-undo-late-refresh");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  await cw.ready;
  await cw.importIntake(RED_2X2);
  const src = cw.sources[0]!;
  cw.beginUnderlay(versionRefKey(src.record.identity), 1);
  await flush(cw);
  // The target row is read for the last time inside the final receipt
  // re-read; the index read that follows it belongs to the post-commit
  // list refresh — make that one throw.
  const targetId = cw.undoHistory[cw.undoHistory.length - 1]!.snapshotId;
  const get = records.get.bind(records);
  let targetReads = 0;
  let finalReadDone = false;
  records.get = (key: IDBValidKey) => {
    if (finalReadDone && typeof key === "string" && key.endsWith("/undos"))
      throw new Error("list unavailable");
    const value = get(key);
    if (typeof key === "string" && key.includes(`/undo/${targetId}`)) {
      targetReads += 1;
      if (targetReads === 4) finalReadDone = true;
    }
    return value;
  };
  try {
    // The swap and cursor move already committed: the refresh failure
    // cannot reject the operation or undo the restore.
    await cw.undo();
    assert.equal(finalReadDone, true, "the failure fired after the final row read");
    assert.equal(cw.sources.length, 1);
    assert.equal(cw.underlay, null);
    assert.equal(cw.canRedo, true);
    assert.equal(cw.undoError, null);
  } finally {
    records.get = get;
    await cw.dispose();
  }
});

test("the bounded history refuses a capture, then discard plus retry lands it", async () => {
  const ws = await seed("cw-undo-bound");
  let clock = 0;
  const cw = openCreativeWorkspace(ws, { now: () => clock, undoCoalesceMs: 0 });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2);
  await flush(cw);
  // Fill the retained index until the durable append refuses — the rows
  // bound (64) or the holds bound, whichever the catalog reaches first.
  // One capture per iteration keeps the refused set to a single envelope.
  for (let i = 0; i < 70 && !cw.undoRetryPending; i++) {
    clock += 1;
    cw.addBoardEntry(srcKey(cw, src.identity.id), { roles: ["style"], notes: `pin ${i}` });
    await flush(cw);
  }
  assert.equal(cw.undoRetryPending, true, "the bound refused a capture");
  assert.ok(cw.undoError);
  const retained = cw.undoHistory.length;
  assert.ok(retained >= 63 && retained <= 64, `${retained} rows at the bound`);
  // The work itself is untouched — the refused step's add still landed.
  assert.equal(cw.board.length, retained);
  // Discarding one retained row makes room; the exact-envelope retry lands.
  await cw.discardUndoSnapshot(cw.undoHistory[0]!);
  await cw.retryUndoCapture();
  assert.equal(cw.undoRetryPending, false);
  assert.equal(cw.undoError, null);
  assert.equal(cw.undoHistory.length, retained);
  await cw.dispose();
});
