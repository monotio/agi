import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import {
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  type CreativeBoardEntry,
  type CreativeRecipe,
  type CreativeSource,
  type VersionRef,
} from "../../src/creative/catalog.ts";
import { sha256Hex } from "../../src/crypto.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import {
  resolveWorkspaceCreativeKeep,
  type CreativeKeepPreparation,
} from "../src/project/creativeWorkspaceKeep.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import {
  loadCreativeCatalog,
  readCreativeBlob,
  renewCreativeLease,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import * as storage from "../src/project/gameStorage.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const records = installIndexedDbFixture();
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

async function seed(name: string): Promise<EditableProject> {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  return openEditableProject(prepared.projectId);
}

async function storedBody(projectId: ProjectId) {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

function editSource(ws: EditableProject, key: string, content: string | Uint8Array | null) {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

const PICTURE_ALT = "# redrawn room\nvis 6\nline 0,0 40,40\nend";
const PROFILE = PROFILES["2.936"]!;
const SOURCE_RASTER = Uint8Array.of(255, 0, 0, 255);
const SOURCE_ENCODED = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));

function source(id: string, title = "Red reference"): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id, incarnation: "original", revision: 0 },
    encoded: {
      hash: sha256Hex(SOURCE_ENCODED),
      byteLength: SOURCE_ENCODED.length,
      mime: "image/png",
    },
    availability: "original",
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
      blob: {
        hash: sha256Hex(SOURCE_RASTER),
        byteLength: SOURCE_RASTER.length,
        mime: "application/x-rgba8",
      },
    },
    origin: { kind: "import", title },
  };
}

function sourceBlobs() {
  return [
    { hash: sha256Hex(SOURCE_ENCODED), mime: "image/png", bytes: SOURCE_ENCODED },
    {
      hash: sha256Hex(SOURCE_RASTER),
      mime: "application/x-rgba8",
      bytes: SOURCE_RASTER,
    },
  ];
}

function underlayRecipe(id: string, src: CreativeSource, resourceId: number): CreativeRecipe {
  return {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: { id, incarnation: "recipe", revision: 0 },
    sources: [src.identity],
    algorithm: "manual-picture-underlay-v1",
    preparation: {
      kind: "picture-underlay",
      source: src.identity,
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
    destination: { kind: "picture", resourceId },
  };
}

const VIEW_SPEC: BuildViewInput = {
  loops: [{ cels: [{ width: 2, height: 2, transparentColor: 15, pixels: [4, 5, 6, 7] }] }],
};

function viewRecipe(
  id: string,
  src: CreativeSource,
  resourceId: number,
  outputPayloadHash?: string,
): CreativeRecipe {
  return {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: { id, incarnation: "recipe", revision: 0 },
    sources: [src.identity],
    algorithm: "manual-view-preparation-v1",
    preparation: {
      format: CREATIVE_RECIPE_FORMAT,
      version: 1,
      kind: "view",
      algorithm: "manual-view-preparation-v1",
      sources: [src.identity],
      palette: "ega-weighted-243-v1",
      mask: { alphaThreshold: 128, key: null },
      frames: [
        {
          id: "f0",
          source: src.identity,
          region: { x: 0, y: 0, width: 1, height: 1 },
          outputWidth: 2,
          outputHeight: 2,
          sourceAnchor: { x: 0, baselineEdgeY: 1 },
          outputAnchorX: 0,
          sample: "nearest-centre-v1",
          allowCropBelowBaseline: false,
          allowCropOutsideCanvas: false,
        },
      ],
      loops: [{ id: "l0", frameIds: ["f0"], facing: "right" }],
    },
    destination: { kind: "view", resourceId },
    ...(outputPayloadHash === undefined ? {} : { outputPayloadHash }),
  };
}

function boardEntry(id: string, src: CreativeSource): CreativeBoardEntry {
  return {
    identity: { id, incarnation: "board", revision: 0 },
    source: src.identity,
    roles: ["style"],
    approval: "approved",
    notes: "inspiration",
  };
}

async function stage(
  ws: EditableProject,
  leaseId: string,
  staged: {
    readonly sources?: readonly CreativeSource[];
    readonly derivatives?: readonly unknown[];
    readonly recipes?: readonly CreativeRecipe[];
  },
  blobs: readonly { hash: string; mime: string; bytes: Uint8Array }[] = sourceBlobs(),
  workspace = ws.workspaceId,
) {
  const head = (await loadCreativeCatalog(ws.projectId)).catalog?.head ?? 0;
  return stageCreativeBlobs({
    projectId: ws.projectId,
    expectedHead: head,
    lease: { id: leaseId, owner: "editor", workspace },
    staged,
    blobs,
  });
}

function intent(
  leaseId: string,
  keep: CreativeKeepPreparation["keep"],
  options?: {
    readonly destinations?: CreativeKeepPreparation["destinations"];
    readonly reviewedCreativeRemovals?: readonly VersionRef[];
  },
): CreativeKeepPreparation {
  return {
    lease: { id: leaseId, owner: "editor" },
    keep,
    ...(options?.destinations === undefined ? {} : { destinations: options.destinations }),
    ...(options?.reviewedCreativeRemovals === undefined
      ? {}
      : { reviewedCreativeRemovals: options.reviewedCreativeRemovals }),
  };
}

test("a picture edit and its underlay recipe Keep through one candidate commits body and catalog together", async () => {
  const ws = await seed("creative-keep-picture");
  const src = source("red-ref");
  const recipe = underlayRecipe("room-underlay", src, 1);
  const staged = await stage(ws, "art", { sources: [src], recipes: [recipe] });
  assert.equal(staged.head, 1);

  editSource(ws, "picture:1", PICTURE_ALT);
  const candidate = ws.buildSelected(["picture:1"]);
  const keep = await ws.prepareCreativeKeep(
    candidate,
    intent(
      "art",
      { sources: [src.identity], recipes: [recipe.identity] },
      {
        destinations: [{ kind: "picture", resourceId: 1 }],
      },
    ),
  );
  assert.equal(keep.expectedHead, staged.head);

  const result = await ws.keepCandidate(candidate, { creative: keep });
  assert.equal(result.kind, "savedOnly");
  assert.equal(result.commitId, candidate.commitId);
  assert.deepEqual(result.creative, { kept: 1, head: 2 });
  assert.equal(ws.draft.dirtyKeys().length, 0);

  // One transaction: body marker, receipt, catalog kept set and the
  // consumed lease all moved together.
  assert.ok(records.has(`commit/${ws.projectId}/${candidate.commitId}`));
  const data = await storedBody(ws.projectId);
  assert.deepEqual(data.creative, { kept: 1 });
  const { catalog, marker } = await loadCreativeCatalog(ws.projectId);
  assert.deepEqual(marker, { kept: 1 });
  assert.equal(catalog!.head, 2);
  assert.equal(catalog!.kept, 1);
  assert.equal(catalog!.recipes.length, 1);
  assert.equal(catalog!.sources.length, 1);
  assert.equal(catalog!.leases.length, 0);
  const blob = await readCreativeBlob(ws.projectId, src.encoded.hash);
  assert.deepEqual([...blob.bytes], [...SOURCE_ENCODED]);
});

test("a staged view conversion keeps its prepared native destination and original", async () => {
  const ws = await seed("creative-keep-view");
  const payload = buildView(VIEW_SPEC, PROFILE);
  editSource(ws, "view:7", payload);
  const candidate = ws.buildSelected(["view:7"]);
  const committed = openContainer(new Map(Object.entries(candidate.files())));
  assert.deepEqual([...committed.getResource("view", 7)!], [...payload]);

  const src = source("ego-sheet");
  const recipe = viewRecipe("ego-prep", src, 7, sha256Hex(payload));
  await stage(ws, "sprites", { sources: [src], recipes: [recipe] });
  const keep = await ws.prepareCreativeKeep(
    candidate,
    intent(
      "sprites",
      { sources: [src.identity], recipes: [recipe.identity] },
      {
        destinations: [{ kind: "view", resourceId: 7 }],
      },
    ),
  );
  const result = await ws.keepCandidate(candidate, { creative: keep });
  assert.deepEqual(result.creative, { kept: 1, head: 2 });

  const data = await storedBody(ws.projectId);
  assert.deepEqual(data.creative, { kept: 1 });
  const image = openContainer(new Map(Object.entries(data.files)));
  assert.deepEqual([...image.getResource("view", 7)!], [...payload]);
});

test("a prepared payload hash that does not match the candidate's resource refuses", async () => {
  const ws = await seed("creative-keep-view-mismatch");
  editSource(ws, "view:7", buildView(VIEW_SPEC, PROFILE));
  const candidate = ws.buildSelected(["view:7"]);
  const src = source("ego-sheet");
  const recipe = viewRecipe("ego-prep", src, 7, "0".repeat(64));
  await stage(ws, "sprites", { sources: [src], recipes: [recipe] });
  await assert.rejects(
    ws.prepareCreativeKeep(
      candidate,
      intent(
        "sprites",
        { sources: [src.identity], recipes: [recipe.identity] },
        {
          destinations: [{ kind: "view", resourceId: 7 }],
        },
      ),
    ),
    /match|prepared/i,
  );
});

test("a board-only Keep publishes inspiration without inventing a native change", async () => {
  const ws = await seed("creative-keep-board");
  const src = source("mood");
  const board = boardEntry("mood-pin", src);
  await stage(ws, "board", { sources: [src] });
  const base = ws.savedIdentity();

  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(
    candidate,
    intent("board", { sources: [src.identity], board: [board] }),
  );
  const result = await ws.keepCandidate(candidate, { creative: keep });
  assert.deepEqual(result.creative, { kept: 1, head: 2 });
  // The saved identity advances through the same atomic commit while the
  // native resource revision and authoring fingerprint stay unchanged.
  assert.equal(result.saved.generation, base.generation + 1);
  assert.equal(result.saved.revision, base.revision);
  assert.equal(result.saved.authoring, base.authoring);
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.board.length, 1);
  assert.equal(catalog!.board[0]!.notes, "inspiration");
});

test("a candidate seals exactly one creative publication", async () => {
  const ws = await seed("creative-keep-sealed");
  const src = source("seal");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));

  // Without the prepared handle, with a lookalike, with another candidate's
  // handle, or a second preparation — all refuse.
  await assert.rejects(ws.keepCandidate(candidate), /creative publication/i);
  await assert.rejects(
    ws.keepCandidate(candidate, {
      creative: { ...keep } as typeof keep,
    }),
    /not prepared|another candidate|sealed/i,
  );
  await assert.rejects(
    ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] })),
    /already sealed/,
  );
  const other = ws.buildSelected([]);
  const foreign = await ws.prepareCreativeKeep(other, intent("art", { sources: [src.identity] }));
  await assert.rejects(ws.keepCandidate(candidate, { creative: foreign }), /another candidate/i);
  await assert.rejects(ws.keepCandidate(other, { creative: keep }), /another candidate/i);

  const result = await ws.keepCandidate(candidate, { creative: keep });
  assert.deepEqual(result.creative, { kept: 1, head: 2 });
  // The exact same replay resolves the same receipt; dropping the sealed
  // intent on replay refuses instead of silently answering differently.
  const replay = await ws.keepCandidate(candidate, { creative: keep });
  assert.equal(replay.commitId, result.commitId);
  assert.deepEqual(replay.saved, result.saved);
  assert.deepEqual(replay.creative, result.creative);
  await assert.rejects(ws.keepCandidate(candidate), /creative publication/i);
  assert.equal((await loadCreativeCatalog(ws.projectId)).catalog!.head, 2);
});

test("a foreign workspace's lease cannot publish through this candidate", async () => {
  const ws = await seed("creative-keep-foreign-lease");
  const src = source("foreign");
  await stage(ws, "alien", { sources: [src] }, sourceBlobs(), "another-workspace");
  const candidate = ws.buildSelected([]);
  await assert.rejects(
    ws.prepareCreativeKeep(candidate, intent("alien", { sources: [src.identity] })),
    /owner|workspace/i,
  );
});

test("a lease already expired refuses at preparation", async () => {
  const ws = await seed("creative-keep-expired");
  const src = source("expired");
  const head = (await loadCreativeCatalog(ws.projectId)).catalog?.head ?? 0;
  await stageCreativeBlobs({
    projectId: ws.projectId,
    expectedHead: head,
    lease: { id: "stale", owner: "editor", workspace: ws.workspaceId },
    staged: { sources: [src] },
    blobs: sourceBlobs(),
    ttlMs: 1,
    now: () => Date.now() - 60_000,
  });
  const candidate = ws.buildSelected([]);
  await assert.rejects(
    ws.prepareCreativeKeep(candidate, intent("stale", { sources: [src.identity] })),
    /expired/i,
  );
});

test("a catalog head that moved after preparation refuses the Keep, body and catalog unchanged", async () => {
  const ws = await seed("creative-keep-head-race");
  const src = source("raced");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));
  await renewCreativeLease({ projectId: ws.projectId, lease: { id: "art", owner: "editor" } });

  const before = structuredClone([...records]);
  await assert.rejects(ws.keepCandidate(candidate, { creative: keep }), /head|catalog/i);
  // The sealed intent cannot absorb the moved head: the same candidate and
  // handle retry under the captured base and refuse again.
  await assert.rejects(ws.keepCandidate(candidate, { creative: keep }), /head|catalog/i);
  assert.deepEqual([...records], before);
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.kept, 0);
  assert.equal(catalog!.leases.length, 1);
});

test("a body that moved between build and Keep refuses the creative publication", async () => {
  const ws = await seed("creative-keep-body-race");
  const src = source("late");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));

  const rival = await openEditableProject(ws.projectId);
  editSource(rival, "logic:1", "// rival\nreturn;");
  await rival.keepCandidate(rival.buildSelected(["logic:1"]));

  const before = structuredClone([...records]);
  await assert.rejects(
    ws.keepCandidate(candidate, { creative: keep }),
    /modified|removed|replaced/i,
  );
  assert.deepEqual([...records], before);
});

test("a recreated project lifetime refuses the sealed Keep", async () => {
  const ws = await seed("creative-keep-lifetime");
  const src = source("lifetime");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));

  const body = await storedBody(ws.projectId);
  await storage.clearCachedGame(ws.projectId);
  assert.equal(await storage.saveAuthoredGame(ws.projectId, body), true);

  await assert.rejects(
    ws.keepCandidate(candidate, { creative: keep }),
    /removed|replaced|lifetime/i,
  );
  // Deletion takes the catalog with the lifetime: nothing was published and
  // the sealed intent cannot rebase onto the replacement.
  assert.equal((await loadCreativeCatalog(ws.projectId)).catalog, null);
});

test("caller mutation and lazy access after preparation cannot change the sealed intent", async () => {
  const ws = await seed("creative-keep-detached");
  const src = source("detached");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);

  const sources = [src.identity];
  const board = boardEntry("pin", src);
  let reads = 0;
  const preparation: CreativeKeepPreparation = {
    lease: { id: "art", owner: "editor" },
    get keep() {
      reads += 1;
      if (reads > 1) throw new Error("the intent was read more than once");
      return { sources, board: [board] };
    },
  };
  const keep = await ws.prepareCreativeKeep(candidate, preparation);
  // Mutating the caller's arrays and records afterwards is invisible to the
  // sealed intent.
  sources.push({ id: "injected", incarnation: "x", revision: 0 });
  (board as { notes: string }).notes = "tampered";

  const result = await ws.keepCandidate(candidate, { creative: keep });
  assert.equal(reads, 1);
  assert.deepEqual(result.creative, { kept: 1, head: 2 });
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.sources.length, 1);
  assert.equal(catalog!.sources[0]!.identity.id, "detached");
  assert.equal(catalog!.board.length, 1);
  assert.equal(catalog!.board[0]!.notes, "inspiration");
});

test("a resolved request or handle inspection cannot reach the sealed intent", async () => {
  const ws = await seed("creative-keep-resolve-alias");
  const src = source("alias");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));

  // Resolving exposes a detached request: rewriting its lease claim and keep
  // lists changes nothing the candidate seals.
  const resolved = resolveWorkspaceCreativeKeep(candidate, keep);
  (resolved.lease as { owner: string }).owner = "intruder";
  (resolved.keep.sources as VersionRef[]).push({
    id: "injected",
    incarnation: "x",
    revision: 0,
  });

  const result = await ws.keepCandidate(candidate, { creative: keep });
  assert.deepEqual(result.creative, { kept: 1, head: 2 });
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.leases.length, 0);
  assert.equal(catalog!.sources.length, 1);
  assert.equal(catalog!.sources[0]!.identity.id, "alias");
});

test("an atomic write failure keeps staged work and the same candidate retries to one receipt", async () => {
  const ws = await seed("creative-keep-atomic-fail");
  const src = source("atomic");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));

  const realSet = records.set.bind(records);
  let fail = true;
  records.set = (key, value) => {
    if (fail && key === ws.projectId) throw new Error("quota");
    return realSet(key, value);
  };
  try {
    await assert.rejects(ws.keepCandidate(candidate, { creative: keep }), /quota/);
    const { catalog } = await loadCreativeCatalog(ws.projectId);
    assert.equal(catalog!.kept, 0);
    assert.equal(catalog!.leases.length, 1);
    fail = false;
    const retry = await ws.keepCandidate(candidate, { creative: keep });
    assert.equal(retry.commitId, candidate.commitId);
    assert.deepEqual(retry.creative, { kept: 1, head: 2 });
    const replay = await ws.keepCandidate(candidate, { creative: keep });
    assert.deepEqual(replay.saved, retry.saved);
    assert.equal((await loadCreativeCatalog(ws.projectId)).catalog!.head, 2);
  } finally {
    records.set = realSet;
  }
});

test("newer typing during the creative Keep stays a pending edit", async () => {
  const ws = await seed("creative-keep-inflight");
  const src = source("inflight");
  await stage(ws, "art", { sources: [src] });
  editSource(ws, "picture:1", PICTURE_ALT);
  const candidate = ws.buildSelected(["picture:1"]);
  const keep = await ws.prepareCreativeKeep(candidate, intent("art", { sources: [src.identity] }));

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = storage.serializeWrite(ws.projectId, () => gate);
  const keeping = ws.keepCandidate(candidate, { creative: keep });
  editSource(ws, "logic:1", "// typed during keep\nreturn;");
  release();
  await blocker;
  await keeping;

  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.kept, 1);
});

test("a kept recipe's destination cannot be removed until the recipe is reviewed out of the kept set", async () => {
  const ws = await seed("creative-keep-removal");
  // First Keep: add picture:42 and stage+keep its underlay recipe together.
  editSource(ws, "logic:1", "return;");
  ws.draft.edit("picture:42", Uint8Array.of(0xff), ws.draft.capture().version("picture:42"));
  const first = ws.buildSelected(["logic:1", "picture:42"]);
  const src = source("room-ref");
  const recipe = underlayRecipe("room-underlay", src, 42);
  await stage(ws, "art", { sources: [src], recipes: [recipe] });
  const keep = await ws.prepareCreativeKeep(
    first,
    intent(
      "art",
      { sources: [src.identity], recipes: [recipe.identity] },
      {
        destinations: [{ kind: "picture", resourceId: 42 }],
      },
    ),
  );
  await ws.keepCandidate(first, { creative: keep });
  assert.equal((await loadCreativeCatalog(ws.projectId)).catalog!.recipes.length, 1);

  // A candidate that removes the destination while retaining the recipe
  // refuses at preparation: the kept recipe is a surviving association.
  editSource(ws, "picture:42", null);
  const removing = ws.buildSelected(["picture:42"]);
  assert.deepEqual(removing.removedResources, ["picture:42"]);
  await stage(ws, "second", {}, []);
  await assert.rejects(
    ws.prepareCreativeKeep(
      removing,
      intent("second", { sources: [src.identity], recipes: [recipe.identity] }),
    ),
    /removed by this candidate|does not exist/i,
  );
  // Even without creative intent the storage guard still applies through
  // this service: the kept recipe strands the removed destination. The
  // admitted request also seals the candidate — a different creative intent
  // cannot be attached afterwards.
  await assert.rejects(
    ws.keepCandidate(removing, { reviewedRemovals: ["picture:42"] }),
    /recipe|destination|stranded/i,
  );
  await assert.rejects(
    ws.prepareCreativeKeep(removing, intent("second", { sources: [src.identity] })),
    /already sealed/i,
  );

  // Reviewing the recipe drop plus the native removal lands both in one
  // commit: the kept set no longer strands the destination.
  const retrying = ws.buildSelected(["picture:42"]);
  const drop = await ws.prepareCreativeKeep(
    retrying,
    intent(
      "second",
      { sources: [src.identity] },
      {
        reviewedCreativeRemovals: [recipe.identity],
      },
    ),
  );
  const result = await ws.keepCandidate(retrying, {
    reviewedRemovals: ["picture:42"],
    creative: drop,
  });
  assert.deepEqual(result.creative, { kept: 2, head: 4 });
  const { catalog } = await loadCreativeCatalog(ws.projectId);
  assert.equal(catalog!.recipes.length, 0);
  assert.equal(catalog!.sources.length, 1);
  const image = openContainer(new Map(Object.entries((await storedBody(ws.projectId)).files)));
  assert.equal(image.getResource("picture", 42), null);
});

test("a kept identity that is neither kept nor staged refuses", async () => {
  const ws = await seed("creative-keep-unknown");
  const src = source("known");
  await stage(ws, "art", { sources: [src] });
  const candidate = ws.buildSelected([]);
  await assert.rejects(
    ws.prepareCreativeKeep(
      candidate,
      intent("art", {
        sources: [src.identity, { id: "never-staged", incarnation: "x", revision: 0 }],
      }),
    ),
    /neither kept nor staged/i,
  );
});

test("an unselected prepared destination refuses even when the resource exists", async () => {
  const ws = await seed("creative-keep-unselected");
  editSource(ws, "view:7", buildView(VIEW_SPEC, PROFILE));
  await ws.keepCandidate(ws.buildSelected(["view:7"]));

  const src = source("ego-sheet");
  const recipe = viewRecipe("ego-prep", src, 7);
  await stage(ws, "sprites", { sources: [src], recipes: [recipe] });
  // view:7 exists in the kept baseline but this candidate did not select it.
  const candidate = ws.buildSelected([]);
  await assert.rejects(
    ws.prepareCreativeKeep(
      candidate,
      intent(
        "sprites",
        { sources: [src.identity], recipes: [recipe.identity] },
        {
          destinations: [{ kind: "view", resourceId: 7 }],
        },
      ),
    ),
    /selected/i,
  );
});

test("an undeclared staged destination and a declared destination with no staged recipe both refuse", async () => {
  const ws = await seed("creative-keep-declaration");
  const src = source("declared");
  const recipe = underlayRecipe("room-underlay", src, 1);
  await stage(ws, "art", { sources: [src], recipes: [recipe] });
  const candidate = ws.buildSelected([]);
  await assert.rejects(
    ws.prepareCreativeKeep(
      candidate,
      intent("art", { sources: [src.identity], recipes: [recipe.identity] }),
    ),
    /does not declare|destinations/i,
  );
  await assert.rejects(
    ws.prepareCreativeKeep(
      candidate,
      intent(
        "art",
        { sources: [src.identity] },
        {
          destinations: [{ kind: "picture", resourceId: 1 }],
        },
      ),
    ),
    /no staged recipe|declares destination/i,
  );
  const missing = underlayRecipe("gone", src, 9);
  await stage(ws, "later", { sources: [src], recipes: [missing] });
  await assert.rejects(
    ws.prepareCreativeKeep(
      candidate,
      intent(
        "later",
        { sources: [src.identity], recipes: [missing.identity] },
        { destinations: [{ kind: "picture", resourceId: 9 }] },
      ),
    ),
    /does not exist/i,
  );
});
