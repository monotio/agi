import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { createSoundDocument } from "../../src/sound/document.ts";
import {
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  creativeCatalogKey,
  type CreativeRecipe,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import { loadCreativeCatalog, stageCreativeBlobs } from "../src/project/creativeStore.ts";
import {
  openEditableProject,
  type EditableKeepReview,
  type EditableProject,
} from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

async function storedBody(projectId: ProjectId) {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

async function seedProject(name: string, adjust?: (data: CachedGameData) => void) {
  const prepared = prepareLocalProject({ title: name, kind: "boilerplate" });
  await prepared.save();
  if (adjust) {
    const data = await storage.loadAuthoredGame(prepared.projectId);
    assert.ok(data);
    adjust(data);
    assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  }
  return prepared.projectId;
}

function edit(ws: EditableProject, key: string, content: string | Uint8Array | null) {
  ws.draft.edit(key, content, ws.draft.capture().version(key));
}

/** Add a kept SOUND 42 to the project through a real Keep. */
async function keepSound(ws: EditableProject, num = 42) {
  const doc = ws.draft.capture().read(`sound:${num}`);
  if (doc !== undefined) return;
  ws.draft.edit(
    `sound:${num}`,
    createSoundDocument().encode(),
    ws.draft.capture().version(`sound:${num}`),
  );
  await ws.keepCandidate(ws.buildSelected([`sound:${num}`]));
}

function soundBytes(data: { files: Record<string, Uint8Array> }, num: number) {
  return openContainer(new Map(Object.entries(data.files))).getResource("sound", num);
}

function pictureBytes(data: { files: Record<string, Uint8Array> }, num: number) {
  return openContainer(new Map(Object.entries(data.files))).getResource("picture", num);
}

/** A tiny original/canonical source plus an underlay recipe targeting `picture:<num>`. */
function underlayRecipe(num: number) {
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  const source: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id: "source", incarnation: "original", revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
      blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
    },
    origin: { kind: "import", title: "Red reference" },
  };
  const recipe: CreativeRecipe = {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: { id: "room-reference", incarnation: "recipe", revision: 0 },
    sources: [source.identity],
    algorithm: "manual-picture-underlay-v1",
    preparation: {
      kind: "picture-underlay",
      source: source.identity,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      destination: { x: 0, y: 0, width: 160, height: 168 },
      fit: "contain",
      intendedAspect: "native",
      sample: "nearest-centre-v1",
      opacity: 0.5,
      palette: "ega-weighted-243-v1",
      alpha: { threshold: 128, matte: 0 },
      scope: "art",
    },
    destination: { kind: "picture", resourceId: num },
  };
  return { source, recipe, encoded, raster };
}

async function stageUnderlay(ws: EditableProject, num: number) {
  const { source, recipe, encoded, raster } = underlayRecipe(num);
  const lease = { id: "reference", owner: "editor", workspace: ws.workspaceId };
  const catalog = await loadCreativeCatalog(ws.projectId);
  const staged = await stageCreativeBlobs({
    projectId: ws.projectId,
    expectedHead: catalog.catalog?.head ?? 0,
    lease,
    staged: { sources: [source], recipes: [recipe] },
    blobs: [
      { hash: source.encoded.hash, mime: source.encoded.mime, bytes: encoded },
      { hash: source.normalized.blob.hash, mime: source.normalized.blob.mime, bytes: raster },
    ],
  });
  return { source, recipe, lease, staged };
}

/** Keep an underlay recipe targeting `picture:<num>` through the real publication path. */
async function keepPictureRecipe(ws: EditableProject, num: number) {
  const { source, recipe, lease, staged } = await stageUnderlay(ws, num);
  const data = await storedBody(ws.projectId);
  await storage.commitProject({
    projectId: ws.projectId,
    commitId: crypto.randomUUID(),
    workspaceId: ws.workspaceId,
    buildId: "a".repeat(64),
    expected: ws.savedIdentity(),
    documents: [],
    data,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease,
      keep: { sources: [source.identity], derivatives: [], recipes: [recipe.identity], board: [] },
    },
  });
}

test("the review list must name the candidate's exact removals, then retry admits", async () => {
  const projectId = await seedProject("rm-approval");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "sound:42", null);
  const candidate = ws.buildSelected(["sound:42"]);
  assert.deepEqual(candidate.removedResources, ["sound:42"]);

  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["sound:9"] }),
    /names no removal/,
  );
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["sound:42", "sound:42"] }),
    /twice/,
  );
  await assert.rejects(ws.keepCandidate(candidate, { reviewedRemovals: [] }), /missing/i);
  await assert.rejects(ws.keepCandidate(candidate), /requires review|reviewedRemovals/);

  // A refused admission leaves the candidate retriable under the right review.
  const review: EditableKeepReview = { reviewedRemovals: ["sound:42"] };
  const kept = await ws.keepCandidate(candidate, review);
  assert.equal(kept.commitId, candidate.commitId);
  assert.equal(soundBytes(await storedBody(projectId), 42), null);

  // Retry resolves the same durable receipt without re-running review.
  const replay = await ws.keepCandidate(candidate);
  assert.equal(replay.commitId, candidate.commitId);
});

test("a review list on a candidate that removes nothing is refused", async () => {
  const projectId = await seedProject("rm-empty-review");
  const ws = await openEditableProject(projectId);
  edit(ws, "logic:1", "return;");
  const candidate = ws.buildSelected(["logic:1"]);
  assert.deepEqual(candidate.removedResources, []);
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["view:1"] }),
    /no removal|removes no resources/i,
  );
  await ws.keepCandidate(candidate);
});

test("candidate fields cannot forge or remap the issued identity", async () => {
  const projectId = await seedProject("rm-forgery");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "sound:42", null);
  const candidate = ws.buildSelected(["sound:42"]);
  const detached = { ...candidate, removedResources: [] as string[] };
  await assert.rejects(
    ws.keepCandidate(detached, { reviewedRemovals: [] }),
    /another workspace|service/,
  );
});

test("a stale selection refuses even with a complete review", async () => {
  const projectId = await seedProject("rm-stale");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "sound:42", null);
  const candidate = ws.buildSelected(["sound:42"]);
  edit(ws, "logic:1", "return;");
  await assert.rejects(ws.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] }), /stale/i);
});

test("a pending Keep is idempotent: a second call joins it without a second review", async () => {
  const projectId = await seedProject("rm-pending");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "sound:42", null);
  const candidate = ws.buildSelected(["sound:42"]);
  const first = ws.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] });
  const second = ws.keepCandidate(candidate, { reviewedRemovals: ["sound:9"] });
  assert.equal(await first, await second);
  assert.equal(soundBytes(await storedBody(projectId), 42), null);
});

test("a surviving LOGIC use refuses with the use named and nothing written", async () => {
  const projectId = await seedProject("rm-definite");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "logic:7", "sound(42, f90); return;");
  await ws.keepCandidate(ws.buildSelected(["logic:7"]));
  const before = await storedBody(projectId);

  edit(ws, "sound:42", null);
  const candidate = ws.buildSelected(["sound:42"]);
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] }),
    /sound:42 is still used by logic:7/,
  );
  const after = await storedBody(projectId);
  assert.equal(after.generation, before.generation);
  assert.deepEqual(after.files["LOGDIR"], before.files["LOGDIR"]);
  assert.ok(soundBytes(after, 42) !== null);
});

test("a same-family unresolved operand blocks; an unrelated family does not", async () => {
  const projectId = await seedProject("rm-dynamic");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  // Blank logic:1 already reads a picture from v50; that must not gate SOUND.
  edit(ws, "sound:42", null);
  await ws.keepCandidate(ws.buildSelected(["sound:42"]), {
    reviewedRemovals: ["sound:42"],
  });

  // A variable-operand logic target keeps every LOGIC removal unsafe.
  edit(ws, "logic:9", "return;");
  await ws.keepCandidate(ws.buildSelected(["logic:9"]));
  edit(ws, "logic:9", null);
  const logicRemoval = ws.buildSelected(["logic:9"]);
  await assert.rejects(
    ws.keepCandidate(logicRemoval, { reviewedRemovals: ["logic:9"] }),
    /logic:9 may still be used: logic:0 .*v0/,
  );
});

test("an unselected dirty draft use blocks until the draft is repaired", async () => {
  const projectId = await seedProject("rm-dirty");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "logic:9", "return;");
  await ws.keepCandidate(ws.buildSelected(["logic:9"]));

  // Typing a use into an unselected draft is a potential use the candidate
  // did not compile; review must find it through the open draft.
  edit(ws, "logic:9", "sound(42, f90); return;");
  edit(ws, "sound:42", null);
  const blocked = ws.buildSelected(["sound:42"]);
  await assert.rejects(
    ws.keepCandidate(blocked, { reviewedRemovals: ["sound:42"] }),
    /still used by draft logic:9/,
  );

  edit(ws, "logic:9", "return;");
  const repaired = ws.buildSelected(["sound:42"]);
  await ws.keepCandidate(repaired, { reviewedRemovals: ["sound:42"] });
  assert.equal(soundBytes(await storedBody(projectId), 42), null);
});

test("a binding reservation blocks removal until the binding is reassigned", async () => {
  const projectId = await seedProject("rm-binding");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  const originalBindings = ws.draft.capture().read("bindings")!.content as string;
  edit(
    ws,
    "bindings",
    JSON.stringify({
      ...(JSON.parse(originalBindings) as Record<string, unknown>),
      cue: { kind: "sound", num: 42 },
    }),
  );
  await ws.keepCandidate(ws.buildSelected(["bindings"]));

  edit(ws, "sound:42", null);
  const blocked = ws.buildSelected(["sound:42"]);
  await assert.rejects(
    ws.keepCandidate(blocked, { reviewedRemovals: ["sound:42"] }),
    /reserved by binding 'cue'/,
  );

  edit(ws, "bindings", originalBindings);
  const repaired = ws.buildSelected(["sound:42"]);
  assert.ok(repaired.keys.includes("bindings"), "the repair selects the bindings edit");
  await ws.keepCandidate(repaired, { reviewedRemovals: ["sound:42"] });
  assert.equal(soundBytes(await storedBody(projectId), 42), null);
});

test("a planned world room blocks removing its LOGIC", async () => {
  const projectId = await seedProject("rm-world");
  const ws = await openEditableProject(projectId);
  edit(ws, "logic:9", "return;");
  await ws.keepCandidate(ws.buildSelected(["logic:9"]));
  edit(
    ws,
    "world",
    JSON.stringify({
      rooms: { "9": { title: "Tower", description: "", exits: {} } },
      facts: {},
      quests: {},
    }),
  );
  await ws.keepCandidate(ws.buildSelected(["world"]));

  edit(ws, "logic:9", null);
  const candidate = ws.buildSelected(["logic:9"]);
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["logic:9"] }),
    /planned room/,
  );
});

test("a stored test's room use blocks removing its LOGIC", async () => {
  const projectId = await seedProject("rm-tests", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({
      ...documents,
      tests: JSON.stringify({
        format: "monotio.agi.tests.v1",
        tests: [{ name: "tower", room: 9, steps: [], expect: { room: 9 } }],
      }),
    });
  });
  const ws = await openEditableProject(projectId);
  edit(ws, "logic:9", "return;");
  await ws.keepCandidate(ws.buildSelected(["logic:9"]));

  edit(ws, "logic:9", null);
  const candidate = ws.buildSelected(["logic:9"]);
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["logic:9"] }),
    /test 'tower' still enters logic:9/,
  );
});

test("reference-art metadata blocks removal of its LOGIC target", async () => {
  const projectId = await seedProject("rm-references", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({
      ...documents,
      references: JSON.stringify([
        { id: "r1", kind: "room", target: 9, brief: "tower", images: [], attachedAt: {} },
      ]),
    });
  });
  const ws = await openEditableProject(projectId);
  edit(ws, "logic:9", "return;");
  await ws.keepCandidate(ws.buildSelected(["logic:9"]));

  edit(ws, "logic:9", null);
  const candidate = ws.buildSelected(["logic:9"]);
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["logic:9"] }),
    /targets logic:9/,
  );
});

test("unrecognized reference metadata stays a named refusal, not silent loss", async () => {
  const projectId = await seedProject("rm-references-opaque", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({ ...documents, references: '[{"kind":"note"}]' });
  });
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  edit(ws, "sound:42", null);
  const candidate = ws.buildSelected(["sound:42"]);
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["sound:42"] }),
    /unrecognized shape|cannot be inventoried/,
  );
});

test("music intent blocks SOUND removal; a paired intent+resource removal stays coherent", async () => {
  const projectId = await seedProject("rm-music", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({
      ...documents,
      music: JSON.stringify({ "42": { revision: "1-00000000", tempo: 120 } }),
    });
  });
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  assert.equal(ws.draft.capture().read("music") !== undefined, true);

  edit(ws, "sound:42", null);
  const blocked = ws.buildSelected(["sound:42"]);
  await assert.rejects(
    ws.keepCandidate(blocked, { reviewedRemovals: ["sound:42"] }),
    /music intent/,
  );

  edit(ws, "music", null);
  const paired = ws.buildSelected(["sound:42", "music"]);
  await ws.keepCandidate(paired, { reviewedRemovals: ["sound:42"] });
  const data = await storedBody(projectId);
  assert.equal(soundBytes(data, 42), null);
  const authoring = data.authoringState!["authoring"] as { music?: unknown };
  assert.equal(authoring.music, undefined, "the deleted intent must not be resurrected");
  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.draft.capture().read("music"), undefined);
  assert.equal(reopened.draft.capture().read("sound:42"), undefined);
});

test("deleting only the music intent document is not a resource removal", async () => {
  const projectId = await seedProject("rm-music-only", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({
      ...documents,
      music: JSON.stringify({ "1": { revision: "1-00000000", tempo: 120 } }),
    });
  });
  const ws = await openEditableProject(projectId);
  assert.ok(ws.draft.capture().read("music") !== undefined);
  edit(ws, "music", null);
  const candidate = ws.buildSelected(["music"]);
  assert.deepEqual(candidate.removedResources, [], "music is intent, not a native resource");
  await ws.keepCandidate(candidate);
  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.draft.capture().read("music"), undefined);
});

test("LOGIC 0 stays required even when fully reviewed", async () => {
  const projectId = await seedProject("rm-logic0");
  const ws = await openEditableProject(projectId);
  edit(ws, "logic:0", null);
  const candidate = ws.buildSelected(["logic:0"]);
  assert.ok(candidate.removedResources.includes("logic:0"));
  await assert.rejects(
    ws.keepCandidate(candidate, { reviewedRemovals: ["logic:0"] }),
    /logic:0.*required|entry point/,
  );
});

test("removal preserves every unrelated resource byte-exact", async () => {
  const projectId = await seedProject("rm-preserve");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  await keepSound(ws, 43);
  const before = await storedBody(projectId);
  const sound43 = soundBytes(before, 43);
  assert.ok(sound43 !== null);

  edit(ws, "sound:42", null);
  await ws.keepCandidate(ws.buildSelected(["sound:42"]), {
    reviewedRemovals: ["sound:42"],
  });
  const after = await storedBody(projectId);
  assert.deepEqual(soundBytes(after, 43), sound43, "an unrelated SOUND is byte-exact");
  assert.deepEqual(
    readProjectWorkspace(after.workspace)["logic:1"],
    readProjectWorkspace(before.workspace)["logic:1"],
  );
});

test("an unrelated removal still works beside a kept picture recipe", async () => {
  const projectId = await seedProject("rm-creative-unrelated");
  const ws = await openEditableProject(projectId);
  edit(ws, "picture:42", Uint8Array.of(0xff));
  await ws.keepCandidate(ws.buildSelected(["picture:42"]));
  await keepPictureRecipe(ws, 42);
  const reopened = await openEditableProject(projectId);
  await keepSound(reopened);
  const generation = reopened.savedIdentity().generation;

  edit(reopened, "sound:42", null);
  const removal = reopened.buildSelected(["sound:42"]);
  assert.deepEqual(removal.removedResources, ["sound:42"]);
  await reopened.keepCandidate(removal, { reviewedRemovals: ["sound:42"] });

  const after = await storedBody(projectId);
  assert.equal(after.generation, generation + 1);
  assert.equal(soundBytes(after, 42), null);
  assert.ok(pictureBytes(after, 42) !== null, "the recipe's destination is untouched");
  const catalog = await loadCreativeCatalog(projectId);
  assert.equal(catalog.catalog?.recipes[0]?.destination.resourceId, 42);
});

test("a staged-only recipe is not a kept association and does not block removal", async () => {
  const projectId = await seedProject("rm-creative-staged");
  const ws = await openEditableProject(projectId);
  // Blank logic:1 reads a picture from v50; repair it so the same-family
  // unresolved rule does not gate this PICTURE removal.
  edit(ws, "logic:1", "return;");
  edit(ws, "picture:42", Uint8Array.of(0xff));
  await ws.keepCandidate(ws.buildSelected(["logic:1", "picture:42"]));
  await stageUnderlay(ws, 42);
  assert.equal(
    (await loadCreativeCatalog(projectId)).catalog?.recipes.length,
    0,
    "staging alone keeps no recipe",
  );

  const reopened = await openEditableProject(projectId);
  edit(reopened, "picture:42", null);
  const removal = reopened.buildSelected(["picture:42"]);
  await reopened.keepCandidate(removal, { reviewedRemovals: ["picture:42"] });
  assert.equal(pictureBytes(await storedBody(projectId), 42), null);
});

test("a recipe published between candidate build and keep refuses the removal", async () => {
  const projectId = await seedProject("rm-creative-race");
  const ws = await openEditableProject(projectId);
  edit(ws, "logic:1", "return;");
  edit(ws, "picture:42", Uint8Array.of(0xff));
  await ws.keepCandidate(ws.buildSelected(["logic:1", "picture:42"]));
  const reopened = await openEditableProject(projectId);
  edit(reopened, "picture:42", null);
  const removal = reopened.buildSelected(["picture:42"]);
  const generation = reopened.savedIdentity().generation;

  // Another window's publication lands first: the moved generation and the
  // now-kept destination both refuse the stale removal, stranding nothing.
  await keepPictureRecipe(reopened, 42);
  await assert.rejects(
    reopened.keepCandidate(removal, { reviewedRemovals: ["picture:42"] }),
    /modified by another window|conflict|recipe/i,
  );
  const after = await storedBody(projectId);
  assert.equal(after.generation, generation + 1, "only the publication landed");
  assert.ok(pictureBytes(after, 42) !== null);
  const catalog = await loadCreativeCatalog(projectId);
  assert.equal(catalog.catalog?.recipes[0]?.destination.resourceId, 42);
});

test("a corrupt creative catalog refuses removal honestly", async () => {
  const projectId = await seedProject("rm-creative-corrupt");
  const ws = await openEditableProject(projectId);
  await keepSound(ws);
  const generation = ws.savedIdentity().generation;
  await storage.bodyTransaction("readwrite", (store) =>
    store.put({ projectId: creativeCatalogKey(projectId), format: "bogus", version: 99 }),
  );

  edit(ws, "sound:42", null);
  const removal = ws.buildSelected(["sound:42"]);
  await assert.rejects(
    ws.keepCandidate(removal, { reviewedRemovals: ["sound:42"] }),
    /creative catalog|Invalid creative catalog/i,
  );
  const after = await storedBody(projectId);
  assert.equal(after.generation, generation);
  assert.ok(soundBytes(after, 42) !== null);
});
