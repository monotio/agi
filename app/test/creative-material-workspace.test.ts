import assert from "node:assert/strict";
import { test } from "node:test";
import { versionRefKey } from "../../src/creative/catalog.ts";
import { openContainer } from "../../src/container/container.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { PICTURE_UNDERLAY_ALGORITHM } from "../../src/picture/preparation.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { detectProfile, PROFILES } from "../../src/runtime/profile.ts";
import { parseView } from "../../src/view/view.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { openProjectResourceEditor } from "../src/studio/project/projectResourceEdits.ts";
import {
  collectCreativeGarbage,
  loadCreativeCatalog,
  readCreativeBlob,
} from "../src/project/creativeStore.ts";
import { CreativeDraftError, listCreativeDrafts } from "../src/project/creativeDrafts.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { CreativeImageIntake } from "../src/references/creativeImageDecode.ts";
import {
  openCreativeWorkspace,
  type CreativeMaterialWorkspace,
} from "../src/studio/creative/creativeWorkspace.ts";
import { FieldDrafts, numericText } from "../src/studio/creative/creativeFieldEdits.ts";

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

const PROFILE = PROFILES["2.936"]!;

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
/** 4x2 sheet: left half red opaque, right half green half-alpha. */
const SHEET_4X2 = intake(4, 2, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 64]));

async function seed(name: string): Promise<EditableProject> {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  return openEditableProject(prepared.projectId);
}

async function storedBody(projectId: EditableProject["projectId"]) {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

const PICTURE_ALT = "# traced room\nvis 6\nline 0,0 40,40\nend";

test("import stages the exact original and canonical raster under the workspace lease", async () => {
  const ws = await seed("cw-import");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Red plate" });

  const { catalog } = await loadCreativeCatalog(ws.projectId);
  const lease = catalog!.leases.find((entry) => entry.id === cw.leaseId);
  assert.ok(lease, "the workspace lease is staged");
  assert.equal(lease!.workspace, ws.workspaceId);
  const staged = lease!.staged.sources.find((entry) => entry.identity.id === src.identity.id);
  assert.ok(staged);
  assert.equal(staged!.origin.title, "Red plate");

  // Both blobs verify by hash: the encoded original byte-for-byte, and the
  // orientation-applied canonical raster.
  const encoded = await readCreativeBlob(ws.projectId, src.encoded.hash);
  assert.deepEqual([...encoded.bytes], [...RED_2X2.encodedBytes]);
  const raster = await readCreativeBlob(ws.projectId, src.normalized.blob.hash);
  assert.deepEqual([...raster.bytes], [...RED_2X2.pixels]);
  await cw.dispose();
});

test("keep() publishes an original-only keep: body marker, catalog and receipt in one commit", async () => {
  const ws = await seed("cw-keep-original");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Red plate" });
  const base = ws.savedIdentity();

  const result = await cw.keep();
  assert.equal(result.kind, "savedOnly");
  // No native change was admitted: the resource revision is unchanged.
  assert.equal(result.saved.revision, base.revision);
  assert.equal(result.saved.authoring, base.authoring);
  assert.equal(result.saved.generation, base.generation + 1);

  const data = await storedBody(ws.projectId);
  assert.ok(data.creative !== undefined, "the body carries the creative marker");
  const { catalog, marker } = await loadCreativeCatalog(ws.projectId);
  assert.deepEqual(marker, data.creative);
  assert.equal(catalog!.kept, marker!.kept);
  assert.equal(catalog!.sources.length, 1);
  assert.equal(catalog!.sources[0]!.identity.id, src.identity.id);
  assert.equal(catalog!.leases.length, 0, "the keep consumed the staging lease");
  // The kept original is still byte-exact.
  const encoded = await readCreativeBlob(ws.projectId, src.encoded.hash);
  assert.deepEqual([...encoded.bytes], [...RED_2X2.encodedBytes]);
  await cw.dispose();
});

test("a prepared VIEW keeps native bytes, recipe and original in one transaction", async () => {
  const ws = await seed("cw-keep-view");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(SHEET_4X2, { title: "Walker sheet" });
  cw.beginViewJob(srcKey(cw, src.identity.id), { columns: 2 });
  const prepared = cw.prepareViewJob();
  assert.equal(prepared.frames.length, 2);
  cw.setViewDestination(3);
  cw.applyViewToDraft();
  const result = await cw.keep();
  assert.ok(result.creative !== undefined);

  const data = await storedBody(ws.projectId);
  const image = openContainer(new Map(Object.entries(data.files)));
  const bytes = image.getResource("view", 3);
  assert.ok(bytes, "VIEW.3 was published");
  assert.deepEqual([...bytes!], [...prepared.payload]);
  // The kept recipe binds exactly these bytes.
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  const recipe = catalog!.recipes.find((r) => r.destination.resourceId === 3);
  assert.ok(recipe);
  assert.equal(recipe!.destination.kind, "view");
  assert.equal(recipe!.outputPayloadHash, sha256Hex(prepared.payload));
  // The stored view decodes under the project profile with the mapped cels.
  const view = parseView(bytes!, PROFILE);
  assert.equal(view.loops.length, 1);
  assert.equal(view.loops[0]!.cels.length, 2);
  assert.equal(view.loops[0]!.cels[0]!.width, 2);
  assert.equal(view.loops[0]!.cels[0]!.height, 2);
  await cw.dispose();
});

test("view preparation maps palette, alpha and the draggable baseline to native cels", async () => {
  const ws = await seed("cw-view-map");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(SHEET_4X2, { title: "Sheet" });
  cw.beginViewJob(srcKey(cw, src.identity.id), {
    regions: [
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 2, y: 0, width: 2, height: 2 },
    ],
  });
  const prepared = cw.prepareViewJob();
  const [opaque, sheer] = prepared.frames;
  assert.equal(opaque!.width, 2);
  assert.equal(opaque!.height, 2);
  assert.equal(opaque!.baseline, 1);
  // The opaque region keeps red (EGA 4) under the default alpha threshold.
  assert.deepEqual([...opaque!.mask], [1, 1, 1, 1]);
  assert.equal(opaque!.pixels[0], 4);
  // The 64-alpha region falls below the default threshold: fully masked.
  assert.deepEqual([...sheer!.mask], [0, 0, 0, 0]);
  assert.ok(sheer!.transparentIndex !== null);
  // A lower alpha threshold keeps the green pixels opaque (EGA 2).
  cw.updateViewJob({ mask: { alphaThreshold: 32, key: null } });
  const lowered = cw.prepareViewJob();
  assert.equal(lowered.frames[1]!.mask[0], 1);
  assert.equal(lowered.frames[1]!.pixels[0], 2);
  await cw.dispose();
});

test("an underlay recipe keeps through the room editor Keep in one candidate, Walk/Depth untouched", async () => {
  const ws = await seed("cw-underlay-room");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Room plate" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);

  const session = openProjectResourceEditor(ws, "picture:1", {});
  session.bindCreativeKeep(cw.creativeKeepProvider);
  // keepPicture requires the reviewed bytes to be exactly what the source
  // compiles to — compile the real source so the edit is authentic.
  const result = await session.keepPicture({
    pictureNumber: 1,
    source: PICTURE_ALT,
    bytes: compilePictureSource(PICTURE_ALT, { profile: PROFILE }).bytes,
    baseRevision: ws.savedIdentity().revision,
  });
  assert.equal(result.status, "committed");

  const { catalog } = await loadCreativeCatalog(ws.projectId);
  const recipe = catalog!.recipes.find((r) => r.preparation.kind === "picture-underlay");
  assert.ok(recipe, "the underlay recipe kept atomically with the drawing");
  assert.equal(recipe!.algorithm, PICTURE_UNDERLAY_ALGORITHM);
  assert.equal(recipe!.destination.resourceId, 1);
  session.close();
  await cw.dispose();
});

test("an underlay-only keep publishes the recipe without forcing a native change", async () => {
  const ws = await seed("cw-underlay-only");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Room plate" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  const base = ws.savedIdentity();
  const result = await cw.keep();
  assert.equal(result.saved.revision, base.revision, "no picture bytes changed");
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.recipes.length, 1);
  assert.equal(catalog!.recipes[0]!.preparation.kind, "picture-underlay");
  await cw.dispose();
});

test("an underlay keeps guiding after its own Keep: the kept source stays resolvable", async () => {
  const ws = await seed("cw-underlay-retained");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Room plate" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  await cw.keep();
  assert.equal(cw.sources.length, 0, "the pending set cleared");
  assert.notEqual(cw.underlay, null, "the tracing job stays open");
  const preview = cw.underlayPreview();
  assert.notEqual(preview, null, "the kept source's raster still resolves");
  assert.equal(preview!.rgba.length, 160 * 168 * 4);
  cw.clearUnderlay();
  assert.equal(cw.underlayPreview(), null);
  await cw.dispose();
});

test("the board preserves earlier kept entries when adding another", async () => {
  const ws = await seed("cw-board");
  const cw = openCreativeWorkspace(ws);
  const first = await cw.importIntake(RED_2X2, { title: "First" });
  cw.addBoardEntry(srcKey(cw, first.identity.id), { roles: ["style"], notes: "pin one" });
  await cw.keep();
  const second = await cw.importIntake(SHEET_4X2, { title: "Second" });
  cw.addBoardEntry(srcKey(cw, second.identity.id), {
    roles: ["composition", "exact-source"],
    notes: "pin two",
  });
  await cw.keep();
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.board.length, 2);
  const notes = catalog!.board.map((entry) => entry.notes).sort();
  assert.deepEqual(notes, ["pin one", "pin two"]);
  await cw.dispose();
});

test("a view destination holding unkept edits refuses to be overwritten", async () => {
  const ws = await seed("cw-view-dirty");
  const cw = openCreativeWorkspace(ws);
  // Foreign unkept content in view:5.
  const snapshot = ws.draft.capture();
  ws.draft.edit("view:5", new Uint8Array([1, 2, 3]), snapshot.version("view:5"));

  const src = await cw.importIntake(SHEET_4X2, { title: "Sheet" });
  cw.beginViewJob(srcKey(cw, src.identity.id));
  cw.setViewDestination(5);
  assert.throws(() => cw.applyViewToDraft(), /unkept/i);
  await cw.dispose();
});

test("a new view number allocates a real document and keeps it", async () => {
  const ws = await seed("cw-view-new");
  const cw = openCreativeWorkspace(ws);
  const free = cw.freeViewNumber();
  assert.ok(free !== undefined);
  const src = await cw.importIntake(SHEET_4X2, { title: "Sheet" });
  cw.beginViewJob(srcKey(cw, src.identity.id));
  cw.setViewDestination(free!);
  cw.applyViewToDraft();
  assert.ok(ws.draft.dirtyKeys().includes(`view:${free}`));
  await cw.keep();
  const data = await storedBody(ws.projectId);
  const image = openContainer(new Map(Object.entries(data.files)));
  const bytes = image.getResource("view", free!);
  assert.ok(bytes);
  parseView(bytes!, PROFILE);
  await cw.dispose();
});

test("a failed keep leaves the staged source and the draft readable for retry", async () => {
  const ws = await seed("cw-keep-fault");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Faulty" });
  // Inject a commit-time write fault on the project body.
  const originalSet = records.set.bind(records);
  let injected = true;
  records.set = function (key: IDBValidKey, value: unknown) {
    if (injected && key === ws.projectId) throw new Error("injected write failure");
    return originalSet(key, value);
  };
  try {
    await assert.rejects(cw.keep());
  } finally {
    injected = false;
    records.set = originalSet;
  }
  // The staged source and its bytes survived the aborted transaction.
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.kept, 0);
  const blob = await readCreativeBlob(ws.projectId, src.encoded.hash);
  assert.deepEqual([...blob.bytes], [...RED_2X2.encodedBytes]);
  // Retry publishes cleanly through a fresh candidate.
  const result = await cw.keep();
  assert.equal(result.kind, "savedOnly");
  assert.equal((await loadCreativeCatalog(ws.projectId)).catalog!.sources.length, 1);
  await cw.dispose();
});

test("close and reopen recover the staged work durably, then keep it", async () => {
  const ws = await seed("cw-recover");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Crash plate" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  cw.addBoardEntry(srcKey(cw, src.identity.id), { roles: ["style"], notes: "keep me" });
  await cw.saveRecovery();
  await cw.dispose();

  const rows = await listCreativeDrafts(ws.projectId);
  assert.ok(rows.length >= 1);
  const row = rows.find((entry) => entry.status === "current");
  assert.ok(row, "a current recovery row exists");

  // A cold reopen: a fresh EditableProject gets a new workspace identity.
  const ws2 = await openEditableProject(ws.projectId);
  const cw2 = openCreativeWorkspace(ws2);
  await cw2.restoreRecovery(row!.workspaceId);
  assert.equal(cw2.sources.length, 1);
  assert.equal(cw2.sources[0]!.record.origin.title, "Crash plate");
  assert.ok(cw2.underlay !== null, "the underlay job was rehydrated");
  const result = await cw2.keep();
  assert.equal(result.kind, "savedOnly");
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.board.length, 1);
  assert.equal(catalog!.recipes.length, 1);
  await cw2.dispose();
});

test("an expired lease and GC do not lose the source; keep re-stages and succeeds", async () => {
  const ws = await seed("cw-lease-expired");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  const src = await cw.importIntake(RED_2X2, { title: "Expiring" });
  // Past the 10-minute default lease: GC drops the lease row and the blob
  // records that only it kept reachable.
  const later = () => Date.now() + 11 * 60 * 1000;
  const gc = await collectCreativeGarbage({ projectId: ws.projectId, now: later });
  assert.ok(gc.removed >= 2, "encoded + raster blobs were collected");
  await assert.rejects(readCreativeBlob(ws.projectId, src.encoded.hash));
  // Keep re-stages the same bytes under a fresh lease and publishes.
  const result = await cw.keep();
  assert.equal(result.kind, "savedOnly");
  const blob = await readCreativeBlob(ws.projectId, src.encoded.hash);
  assert.deepEqual([...blob.bytes], [...RED_2X2.encodedBytes]);
  await cw.dispose();
});

test("a rival commit between stage and keep is a clean refusal, not a lost source", async () => {
  const ws = await seed("cw-rival");
  const rival = await openEditableProject(ws.projectId);
  const cw = openCreativeWorkspace(ws);
  await cw.importIntake(RED_2X2, { title: "Raced" });
  // The rival moves the stored body first.
  const snap = rival.draft.capture();
  rival.draft.edit("logic:1", "// rival\nreturn;", snap.version("logic:1"));
  await rival.keepCandidate(rival.buildSelected(["logic:1"]));
  await assert.rejects(cw.keep(), (error: unknown) => {
    assert.ok(error instanceof CreativeDraftError);
    assert.equal(error.reason, "stale");
    return true;
  });
  // The staged work is untouched by the refused commit.
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.kept, 0);
  assert.ok(cw.sources.length === 1);
  await cw.dispose();
});

test("late intake after dispose cannot mutate a closed workspace", async () => {
  const ws = await seed("cw-late");
  const cw = openCreativeWorkspace(ws);
  const pending = cw.importIntake(RED_2X2, { title: "Late" });
  await cw.dispose();
  await assert.rejects(pending, /closed|disposed/i);
  await assert.rejects(cw.keep(), /closed|disposed/i);
  assert.throws(() => cw.addBoardEntry("x", { roles: ["style"], notes: "" }));
});

test("frame ordering, loop assignment and explicit mirroring reach the kept payload", async () => {
  const ws = await seed("cw-mirror");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(SHEET_4X2, { title: "Two poses" });
  cw.beginViewJob(srcKey(cw, src.identity.id), { columns: 2 });
  cw.updateViewJob({
    loops: [
      { id: "l0", frameIds: ["f0", "f1"], facing: "right" },
      { id: "l1", mirrorOf: "l0", explicitlyApproved: true, facing: "left" },
    ],
  });
  const prepared = cw.prepareViewJob();
  assert.equal(prepared.loops.length, 2);
  assert.equal(prepared.loops[1]!.kind, "mirror");
  assert.equal(prepared.loops[1]!.mirrorOf, 0);
  cw.setViewDestination(4);
  cw.applyViewToDraft();
  await cw.keep();
  const data = await storedBody(ws.projectId);
  const image = openContainer(new Map(Object.entries(data.files)));
  const view = parseView(image.getResource("view", 4)!, PROFILE);
  assert.equal(view.loops.length, 2);
  assert.equal(view.loops[1]!.cels[0]!.mirrored, true);
  // The mirrored cel's pixels equal the source loop's pixels flipped.
  const source0 = view.loops[0]!.cels[0]!;
  const mirror0 = view.loops[1]!.cels[0]!;
  assert.equal(mirror0.width, source0.width);
  assert.equal(mirror0.pixels[0], source0.pixels[1]);
  assert.equal(mirror0.pixels[1], source0.pixels[0]);
  await cw.dispose();
});

test("mutations refuse by name while a Keep is in flight, then work again", async () => {
  const ws = await seed("cw-keep-busy");
  let published!: () => void;
  let release!: () => void;
  const publication = new Promise<void>((resolve) => (published = resolve));
  const proceed = new Promise<void>((resolve) => (release = resolve));
  const delayedKeep: EditableProject["keepCandidate"] = async (...args) => {
    const result = await ws.keepCandidate(...args);
    published();
    await proceed;
    return result;
  };
  const wrapped = new Proxy(ws, {
    get(target, property) {
      if (property === "keepCandidate") return delayedKeep;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cw = openCreativeWorkspace(wrapped, { autosaveRecovery: false });
  await cw.ready;
  const src = await cw.importIntake(RED_2X2, { title: "Plate" });
  const key = versionRefKey(src.identity);
  cw.beginUnderlay(key, 1);
  const keep = cw.keep();
  await publication;
  // Every synchronous mutation route refuses with the named reason while
  // the publication phase is sealed.
  for (const mutate of [
    () => cw.updateUnderlay({ opacity: 0.9 }),
    () => cw.clearUnderlay(),
    () => cw.beginViewJob(key),
    () => cw.setViewDestination(4),
    () => cw.addBoardEntry(key, { roles: ["style"] }),
    () => cw.removeBoardEntry(src.identity),
  ]) {
    assert.throws(mutate, /keep is in progress|busy|in progress/i);
  }
  release();
  await keep;
  // After the durable receipt the workspace mutates again, and the board
  // edit lands pending on top of the kept base.
  const entry = cw.addBoardEntry(key, { roles: ["style"], notes: "after keep" });
  assert.ok(cw.board.some((candidate) => candidate.identity.id === entry.identity.id));
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.board.length, 0, "the later edit was not acknowledged by the earlier Keep");
  await cw.dispose();
});

test("returned job snapshots and caller patches cannot reach owned job state", async () => {
  const ws = await seed("cw-alias");
  const cw = openCreativeWorkspace(ws, { autosaveRecovery: false });
  const src = await cw.importIntake(SHEET_4X2, { title: "Sheet" });
  const key = versionRefKey(src.identity);
  const job = cw.beginViewJob(key, { columns: 2 });
  const sealed = sha256Hex(cw.prepareViewJob().payload);
  // Mutating the returned snapshot must not move the owned job.
  (job.frames[0]!.region as { width: number }).width = 99;
  const loop0 = job.loops[0]!;
  if ("frameIds" in loop0) (loop0.frameIds as string[]).push("f9");
  (job.mask as { alphaThreshold: number }).alphaThreshold = 0;
  assert.equal(sha256Hex(cw.prepareViewJob().payload), sealed);
  // Nor may a caller-held patch object after updateViewJob.
  const frames = cw.viewJob!.frames;
  cw.updateViewJob({ frames });
  (frames[0]!.region as { width: number }).width = 1;
  (frames[0]!.region as { x: number }).x = 3;
  assert.equal(sha256Hex(cw.prepareViewJob().payload), sealed);
  const underlay = cw.beginUnderlay(key, 1);
  const preview = cw.underlayPreview()!;
  (underlay.crop as { x: number }).x = 1;
  (underlay.bounds as { width: number }).width = 1;
  assert.deepEqual(cw.underlayPreview(), preview);
  await cw.dispose();
});

test("restore refuses a conflicting dirty document without adopting anything", async () => {
  const ws = await seed("cw-restore-conflict");
  const cw = openCreativeWorkspace(ws);
  await cw.importIntake(RED_2X2, { title: "Plate" });
  const before = ws.draft.capture().read("logic:1")!;
  const recovered = `${before.content}\n// recovered edit\n`;
  ws.draft.edit("logic:1", recovered, before.version);
  await cw.dispose();

  const ws2 = await openEditableProject(ws.projectId);
  const cw2 = openCreativeWorkspace(ws2);
  await cw2.ready;
  const divergent = `${before.content}\n// a different live edit\n`;
  const current = ws2.draft.capture().read("logic:1")!;
  ws2.draft.edit("logic:1", divergent, current.version);
  const row = (await cw2.listRecoveries()).find((entry) => entry.status === "current")!;
  await assert.rejects(cw2.restoreRecovery(row.workspaceId), /conflict/i);
  // Nothing was adopted or overwritten: the live edit is intact and the
  // carried source stayed out of this workspace.
  assert.equal(ws2.draft.capture().read("logic:1")?.content, divergent);
  assert.equal(cw2.sources.length, 0);
  await cw2.dispose();
});

test("restore refuses when a coordinated operation's sibling diverged", async () => {
  const ws = await seed("cw-restore-sibling");
  const cw = openCreativeWorkspace(ws);
  const snapshot = ws.draft.capture();
  const logicBefore = snapshot.read("logic:1")!.content as string;
  const wordsBefore = snapshot.read("words")!.content as string;
  const proposal = ws.draft.propose(snapshot, "coordinated pair", [
    { key: "logic:1", content: `${logicBefore}\n// paired\n` },
    { key: "words", content: `${wordsBefore.slice(0, -2)},"paired"]` },
  ]);
  ws.draft.apply(proposal);
  // Reverting words leaves the group behind: logic:1 stays dirty inside it.
  const after = ws.draft.capture();
  ws.draft.edit("words", wordsBefore, after.version("words"));
  await cw.dispose();

  const ws2 = await openEditableProject(ws.projectId);
  const cw2 = openCreativeWorkspace(ws2);
  await cw2.ready;
  const live = ws2.draft.capture();
  ws2.draft.edit("words", `${wordsBefore.slice(0, -2)},"diverged"]`, live.version("words"));
  const row = (await cw2.listRecoveries()).find((entry) => entry.status === "current")!;
  await assert.rejects(cw2.restoreRecovery(row.workspaceId), /conflict/i);
  // The whole restore refused: logic:1 was not half-restored.
  assert.equal(
    ws2.draft.capture().read("logic:1")?.content,
    logicBefore,
    "the coordinated partner was not partially restored",
  );
  await cw2.dispose();
});

test("restore keeps coordinated edits selected together and preserves unrelated work", async () => {
  const ws = await seed("cw-restore-group");
  const cw = openCreativeWorkspace(ws);
  const snapshot = ws.draft.capture();
  const logicBefore = snapshot.read("logic:1")!.content as string;
  const wordsBefore = snapshot.read("words")!.content as string;
  const proposal = ws.draft.propose(snapshot, "coordinated pair", [
    { key: "logic:1", content: `${logicBefore}\n// paired\n` },
    { key: "words", content: `${wordsBefore.slice(0, -2)},"paired"]` },
  ]);
  ws.draft.apply(proposal);
  await cw.dispose();

  const ws2 = await openEditableProject(ws.projectId);
  const cw2 = openCreativeWorkspace(ws2);
  await cw2.ready;
  // An unrelated unkept edit is not part of the recovery and must survive it.
  const picBefore = ws2.draft.capture().read("picture:1")!.content as string;
  const picLive = `${picBefore}\nline 1,1 2,2\n`;
  ws2.draft.edit("picture:1", picLive, ws2.draft.capture().version("picture:1"));
  const row = (await cw2.listRecoveries()).find((entry) => entry.status === "current")!;
  await cw2.restoreRecovery(row.workspaceId);
  assert.equal(ws2.draft.capture().read("logic:1")?.content, `${logicBefore}\n// paired\n`);
  assert.equal(ws2.draft.capture().read("picture:1")?.content, picLive);
  // The recovered operation group is live again: selecting one member pulls
  // its coordinated sibling into the selection closure.
  const selection = ws2.draft.select(["logic:1"]);
  assert.ok(selection.keys.includes("words"), "the operation group restored its closure");
  await cw2.dispose();
});

test("a kept board source is selectable and reusable after reopen", async () => {
  const ws = await seed("cw-board-reuse");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Reference plate" });
  const entry = cw.addBoardEntry(versionRefKey(src.identity), {
    roles: ["style"],
    notes: "kept reference",
  });
  await cw.keep();
  await cw.dispose();

  const ws2 = await openEditableProject(ws.projectId);
  const cw2 = openCreativeWorkspace(ws2);
  await cw2.ready;
  const kept = cw2.board.find(
    (candidate) => versionRefKey(candidate.identity) === versionRefKey(entry.identity),
  );
  assert.ok(kept, "the kept board entry is listed after reopen");
  const adopted = await cw2.adoptSource(kept!.source);
  assert.ok(adopted, "the kept source resolves into this workspace");
  assert.equal(adopted!.origin.title, "Reference plate");
  const info = await cw2.sourceInfo(kept!.source);
  assert.ok(info !== null && info.recipes.length === 0);
  const key = versionRefKey(adopted!.identity);
  const job = cw2.beginUnderlay(key, 1);
  assert.equal(job.resourceId, 1);
  assert.notEqual(cw2.underlayPreview(), null, "the adopted source drives a real preview");
  await cw2.dispose();
});

test("a kept recipe reserves its VIEW destination for allocation", async () => {
  const ws = await seed("cw-view-reserved");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(SHEET_4X2, { title: "Sheet" });
  cw.beginViewJob(versionRefKey(src.identity));
  cw.setViewDestination(4);
  cw.applyViewToDraft();
  await cw.keep();
  // The document is deleted locally; the kept recipe still claims the slot.
  const snapshot = ws.draft.capture();
  ws.draft.edit("view:4", null, snapshot.version("view:4"));
  const free = cw.freeViewNumber();
  assert.ok(free !== undefined);
  assert.notEqual(free, 4, "the kept byte-only destination stays reserved");
  await cw.dispose();
});

test("a detected non-v2 profile still prepares through its own decoder", async () => {
  const ws = await seed("cw-profile");
  const data = await storedBody(ws.projectId);
  const profile = detectProfile(new Map(Object.entries(data.files)), data.library?.profile);
  assert.equal(profile.id, "2.936");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(SHEET_4X2, { title: "Sheet" });
  cw.beginViewJob(srcKey(cw, src.identity.id));
  const prepared = cw.prepareViewJob();
  assert.equal(prepared.profileId, "2.936");
  await cw.dispose();
});

function srcKey(cw: CreativeMaterialWorkspace, id: string): string {
  const source = cw.sources.find((entry) => entry.record.identity.id === id);
  assert.ok(source, `source ${id} staged`);
  return versionRefKey(source.record.identity);
}

test("a refused recovery cleanup keeps the exact receipt and a retry preserves pending work", async () => {
  const ws = await seed("cw-cleanup-retry");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Retry" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  await cw.saveRecovery();
  const rowKey = `creative/${ws.projectId}/draft/${ws.workspaceId}`;
  const originalDelete = records.delete.bind(records);
  let faults = 0;
  records.delete = function (key: IDBValidKey) {
    if (key === rowKey && faults++ === 0) throw new Error("injected delete failure");
    return originalDelete(key);
  };
  try {
    // The durable commit stands; only the recovery-row delete is refused.
    const result = await cw.keep();
    assert.equal(result.kind, "savedOnly");
  } finally {
    records.delete = originalDelete;
  }
  assert.equal(faults, 1, "cleanup tried the owned row exactly once");
  assert.match(cw.cleanupError ?? "", /delete failure/i);
  // The stale row survived under the retained receipt; the job stays pending.
  const stale = (await listCreativeDrafts(ws.projectId)).find(
    (entry) => entry.workspaceId === ws.workspaceId,
  );
  assert.equal(stale?.status, "stale");
  assert.ok(cw.underlay !== null, "the open underlay job survived the keep");
  // The retry discards the same owned row, then captures a fresh recovery.
  await cw.saveRecovery();
  const fresh = (await listCreativeDrafts(ws.projectId)).find(
    (entry) => entry.workspaceId === ws.workspaceId,
  );
  assert.equal(fresh?.status, "current");
  assert.notEqual(
    fresh?.receipt.sequence,
    stale?.receipt.sequence,
    "the retried save wrote a fresh row, not a rebase of the stale one",
  );
  assert.equal(cw.cleanupError, null);
  assert.ok(cw.underlay !== null, "pending work was carried into the fresh recovery");
  await cw.dispose();
});

test("a foreign newer recovery row is never discarded or overwritten on retry", async () => {
  const ws = await seed("cw-cleanup-foreign");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Held" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  await cw.saveRecovery();
  const rowKey = `creative/${ws.projectId}/draft/${ws.workspaceId}`;
  const originalDelete = records.delete.bind(records);
  let faults = 0;
  records.delete = function (key: IDBValidKey) {
    if (key === rowKey && faults++ === 0) throw new Error("injected delete failure");
    return originalDelete(key);
  };
  try {
    await cw.keep();
  } finally {
    records.delete = originalDelete;
  }
  assert.equal(faults, 1);
  // A second workspace on the same project legitimately reviews the stale
  // row, discards it, and publishes its own recovery in the same slot.
  const cw2 = openCreativeWorkspace(ws);
  await cw2.ready;
  const staleRow = (await listCreativeDrafts(ws.projectId)).find(
    (entry) => entry.workspaceId === ws.workspaceId,
  );
  assert.equal(staleRow?.status, "stale");
  await cw2.discardRecovery(staleRow!);
  const src2 = await cw2.importIntake(RED_2X2, { title: "Foreign" });
  cw2.beginUnderlay(srcKey(cw2, src2.identity.id), 2);
  await cw2.saveRecovery();
  const foreign = (await listCreativeDrafts(ws.projectId)).find(
    (entry) => entry.workspaceId === ws.workspaceId,
  );
  assert.equal(foreign?.status, "current");
  // The first workspace's retry refuses instead of deleting the foreign row.
  await assert.rejects(cw.saveRecovery(), /changed; read the latest/i);
  const untouched = (await listCreativeDrafts(ws.projectId)).find(
    (entry) => entry.workspaceId === ws.workspaceId,
  );
  assert.deepEqual(untouched?.receipt, foreign?.receipt, "the foreign row was not touched");
  assert.equal(untouched?.status, "current");
  await cw.dispose();
  await cw2.dispose();
});

/* ---------- pending field edits (creativeFieldEdits.ts) ---------- */

/** A DOM-free change/input event carrying the field's raw text. */
function fieldEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

test("a pending field draft survives unrelated model churn, then commits once", () => {
  const drafts = new FieldDrafts();
  const key = "incA frame f0 region.width";
  const stamp0 = "frame-v1";
  drafts.edit(key, stamp0, fieldEvent("8"));
  // An unrelated update re-reads the same entity: identical stamp, model
  // unchanged — the draft text is what the field shows.
  assert.equal(drafts.show(key, stamp0, 48), "8");
  assert.equal(drafts.show(key, stamp0, 48), "8");
  let applied = -1;
  drafts.commit(
    key,
    stamp0,
    fieldEvent("8"),
    numericText,
    (t) => (applied = Math.max(1, Math.floor(Number(t)))),
  );
  assert.equal(applied, 8);
  // The committed draft is gone; the model is what the field shows now.
  assert.equal(drafts.show(key, "frame-v2", 8), 8);
});

test("incomplete typing stays unclamped until commit; invalid text is not silently erased", () => {
  const drafts = new FieldDrafts();
  const key = "incA frame f0 outputWidth";
  const stamp = "frame-v1";
  // Typing "12" passes through "1" — no greedy clamp to the minimum.
  drafts.edit(key, stamp, fieldEvent("1"));
  assert.equal(drafts.show(key, stamp, 160), "1");
  drafts.edit(key, stamp, fieldEvent("12"));
  assert.equal(drafts.show(key, stamp, 160), "12");
  // An empty commit attempt keeps the draft instead of erasing it.
  let applied = 0;
  drafts.edit(key, stamp, fieldEvent(""));
  drafts.commit(key, stamp, fieldEvent(""), numericText, () => void applied++);
  assert.equal(applied, 0);
  assert.equal(drafts.show(key, stamp, 160), "");
  // A valid commit after that still applies once.
  drafts.edit(key, stamp, fieldEvent("16"));
  drafts.commit(
    key,
    stamp,
    fieldEvent("16"),
    numericText,
    (t) => (applied = Math.floor(Number(t))),
  );
  assert.equal(applied, 16);
});

test("a replaced owner never receives stale typing just because the slot survived", () => {
  const drafts = new FieldDrafts();
  const key = "incA frame f0 region.x";
  drafts.edit(key, "frame-A", fieldEvent("7"));
  // The entity under the slot was replaced by foreign work: same key, new
  // content. The draft is dropped and the model wins — nothing applies.
  assert.equal(drafts.show(key, "frame-B", 30), 30);
  let applied = 0;
  drafts.commit(key, "frame-B", fieldEvent("7"), numericText, () => void applied++);
  assert.equal(applied, 0, "stale typing must not land on a replaced entity");
  assert.equal(drafts.show(key, "frame-B", 30), 30);
});

test("own commits re-stamp sibling drafts; removed owners lose theirs", () => {
  const drafts = new FieldDrafts();
  const widthKey = "incA frame f0 width";
  const heightKey = "incA frame f0 height";
  const xKey = "incA frame f1 x";
  drafts.edit(widthKey, "A", fieldEvent("8"));
  drafts.edit(heightKey, "A", fieldEvent("9"));
  drafts.edit(xKey, "B", fieldEvent("3"));
  // The height commit rebuilt the frames; sibling drafts re-stamp to it.
  drafts.rebase("incA frame ", (key) => (key.includes("f0") ? "A2" : null));
  assert.equal(drafts.show(widthKey, "A2", 48), "8");
  assert.equal(drafts.show(heightKey, "A2", 32), "9");
  // f0's removal drops its drafts; they cannot revive under a reused id.
  assert.equal(drafts.show(xKey, "anything", 0), 0);
});

test("the released workspace saves its own recovery; a successor is untouched", async () => {
  const ws = await seed("cw-release-recovery");
  const cw = openCreativeWorkspace(ws);
  const src = await cw.importIntake(RED_2X2, { title: "Held" });
  cw.beginUnderlay(srcKey(cw, src.identity.id), 1);
  await cw.dispose();
  // Dispose wrote this workspace's own durable recovery.
  const rows = await listCreativeDrafts(ws.projectId);
  const own = rows.find((entry) => entry.workspaceId === ws.workspaceId);
  assert.equal(own?.status, "current");
  // The released workspace is closed and cannot reach in again.
  assert.throws(() => cw.updateUnderlay({ opacity: 0.2 }), /closed|disposed/i);
  await cw.dispose();
  // A successor workspace for the same project opens on that recovery.
  const cw2 = openCreativeWorkspace(ws);
  await cw2.ready;
  const recoveries = await cw2.listRecoveries();
  assert.equal(recoveries.length, 1);
  await cw2.discardRecovery(recoveries[0]!);
  assert.equal((await listCreativeDrafts(ws.projectId)).length, 0);
  await cw2.dispose();
});
