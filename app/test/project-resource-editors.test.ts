import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildView, parseView, type BuildViewInput } from "../../src/view/view.ts";
import { flipHorizontal, viewSpec } from "../../src/view/celEdit.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { ResourceCommitError } from "../src/project/projectTransaction.ts";
import type { PictureEdit, ViewEdit } from "../src/project/resourceCommit.ts";
import { openProjectResourceEditor } from "../src/studio/project/projectResourceEdits.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

/**
 * The Logic Studio resource-editor seam, without a key, worker or network:
 * the adapter opens a draft resource in the existing Room/Sprite Studio
 * contracts and its Keep lands through the shared EditableProject. Storage
 * is the IndexedDB fixture; every byte assertion is computed here, in the
 * test, from the real compilers and decoders.
 */
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

const PROFILE = PROFILES["2.936"]!;

async function seedProject(
  name: string,
  kind: "blank" | "starter" = "starter",
  adjust?: (data: CachedGameData) => void,
): Promise<ProjectId> {
  const prepared = prepareLocalProject({ title: name, kind });
  await prepared.save();
  if (adjust) {
    const data = await storage.loadAuthoredGame(prepared.projectId);
    assert.ok(data);
    adjust(data);
    assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  }
  return prepared.projectId;
}

async function storedBody(projectId: ProjectId): Promise<CachedGameData> {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

function storedResource(data: CachedGameData, kind: "picture" | "view", num: number) {
  return openContainer(new Map(Object.entries(data.files)), { profile: PROFILE }).getResource(
    kind,
    num,
  );
}

function editDoc(ws: EditableProject, key: string, content: string | Uint8Array): void {
  ws.draft.edit(key, content, ws.draft.capture().version(key));
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

function pictureEdit(ws: EditableProject, source: string, num = 1): PictureEdit {
  return {
    pictureNumber: num,
    bytes: compilePictureSource(source, { profile: PROFILE }).bytes,
    source,
    baseRevision: ws.savedIdentity().revision,
    reason: "test edit",
  };
}

/** The starter picture's own source, drawn on: a colour-4 rect in the open ground. */
function drawnPictureSource(ws: EditableProject): string {
  const base = ws.draft.capture().read("picture:1")!.content;
  assert.equal(typeof base, "string");
  return `${(base as string).replace(/end\s*$/, "")}vis 4\nrect 10,60 30,80\nend\n`;
}

/** A view like the starter ego's: own cels in loop 0, loop 1 mirroring them. */
const MIRRORED_VIEW: BuildViewInput = {
  loops: [
    {
      cels: [
        { width: 2, height: 2, transparentColor: 15, pixels: [4, 5, 6, 7], mirror: true },
        { width: 1, height: 1, transparentColor: 15, pixels: [9], mirror: true },
      ],
    },
    { mirrorLoop: 0 },
  ],
};

/** The same change the sprite kernel would write: one pixel recoloured, bytes rebuilt. */
function recolouredView(payload: Uint8Array, colour: number): Uint8Array {
  const spec = viewSpec(payload, PROFILE);
  const cel = spec.loops[0]!.cels![0]!;
  const pixels = [...cel.pixels];
  assert.notEqual(pixels[0], colour);
  pixels[0] = colour;
  const loops = spec.loops.map((loop, index) =>
    index === 0
      ? { ...loop, cels: loop.cels!.map((c, i) => (i === 0 ? { ...c, pixels } : { ...c })) }
      : loop,
  );
  return buildView({ ...spec, loops }, PROFILE);
}

function viewEdit(ws: EditableProject, bytes: Uint8Array, num = 0): ViewEdit {
  return {
    viewNumber: num,
    bytes,
    baseRevision: ws.savedIdentity().revision,
    reason: "test recolour",
  };
}

/** The refusals a child shows come through the Keep contract's typed error. */
function expectCommitError(error: unknown, code: string): true {
  assert.ok(error instanceof ResourceCommitError, `expected ResourceCommitError, got ${error}`);
  assert.equal(error.code, code);
  return true;
}

test("opens a starter PIC from the draft and keeps a drawing through EditableProject", async () => {
  const projectId = await seedProject("res-pic-keep");
  const ws = await openEditableProject(projectId);
  const resynced: string[][] = [];
  const kept: [string, string | Uint8Array][] = [];
  const session = openProjectResourceEditor(ws, "picture:1", {
    onDraftChanged: (keys) => resynced.push([...keys]),
    onKept: (key, content) => kept.push([key, content]),
  });
  try {
    assert.equal(session.kind, "picture");
    assert.equal(session.number, 1);
    // The opened bytes are the draft's, proven by this test's own compile.
    const doc = ws.draft.capture().read("picture:1")!;
    assert.equal(typeof doc.content, "string");
    const expected = compilePictureSource(doc.content as string, { profile: PROFILE }).bytes;
    assert.ok(sameBytes(session.bytes, expected));
    assert.equal(session.authoredSource, doc.content);

    const base = ws.savedIdentity();
    // A drawing arrives through the child's Keep contract — no engine, no key.
    const edit = pictureEdit(ws, drawnPictureSource(ws));
    const result = await session.keepPicture(edit);
    assert.equal(result.status, "committed");
    assert.equal(result.projectId, projectId);
    assert.notEqual(result.revision, base.revision);
    // Only the durable receipt rebases: the workspace's saved identity moved with it.
    assert.equal(ws.savedIdentity().revision, result.revision);
    assert.deepEqual(resynced, [["picture:1"]]);
    assert.deepEqual(kept, [["picture:1", edit.source]]);

    // The draft document is the annotated source; storage holds its bytes.
    assert.equal(ws.draft.capture().read("picture:1")!.content, edit.source);
    const data = await storedBody(projectId);
    const stored = storedResource(data, "picture", 1);
    assert.ok(stored);
    assert.ok(sameBytes(stored, edit.bytes), "stored PIC bytes are the reviewed bytes");
    assert.equal(readProjectWorkspace(data.workspace)["picture:1"], edit.source);
    const sources = data.authoringState!["sources"] as { pictures: [number, string][] };
    assert.ok(sources.pictures.some(([num, source]) => num === 1 && source === edit.source));
    // The new pixels decode: colour 4 fills the drawn rect.
    const surface = createPictureSurface();
    renderPicture(stored, surface, { profile: PROFILE });
    assert.equal(surface.visual[60 * 160 + 10], 4);
    assert.equal(surface.visual[80 * 160 + 30], 4);

    // Cold reopen sees the kept document.
    const reopened = await openEditableProject(projectId);
    assert.equal(reopened.draft.capture().read("picture:1")!.content, edit.source);
  } finally {
    session.close();
  }
});

test("a recoloured VIEW keeps exact native bytes and drops the stale source claim", async () => {
  const projectId = await seedProject("res-view-keep");
  const ws = await openEditableProject(projectId);
  const session = openProjectResourceEditor(ws, "view:0");
  try {
    assert.equal(session.kind, "view");
    assert.equal(session.number, 0);
    const storedBefore = storedResource(await storedBody(projectId), "view", 0)!;
    assert.ok(sameBytes(session.bytes, storedBefore));
    assert.equal(session.authoredSource, undefined);

    const edit = viewEdit(ws, recolouredView(session.bytes, 6));
    const result = await session.keepView(edit, undefined);
    assert.equal(result.status, "committed");

    // The draft document is the exact reviewed bytes — never a source claim
    // left pointing at old bytes.
    const doc = ws.draft.capture().read("view:0")!;
    assert.ok(doc.content instanceof Uint8Array);
    assert.ok(sameBytes(doc.content, edit.bytes));
    const data = await storedBody(projectId);
    assert.ok(sameBytes(storedResource(data, "view", 0)!, edit.bytes));
    const sources = data.authoringState!["sources"] as { views: [number, unknown][] };
    assert.equal(
      sources.views.some(([num]) => num === 0),
      false,
      "the byte-only view keeps no source claim",
    );

    // Cold reopen carries the bytes, still editable, display identical to review.
    const reopened = await openEditableProject(projectId);
    const reopenedDoc = reopened.draft.capture().read("view:0")!;
    assert.ok(reopenedDoc.content instanceof Uint8Array);
    assert.ok(sameBytes(reopenedDoc.content, edit.bytes));
    assert.deepEqual(parseView(reopenedDoc.content, PROFILE), parseView(edit.bytes, PROFILE));
  } finally {
    session.close();
  }
});

test("a mirrored cel survives a recolour: loop 1 still shows loop 0 flipped", async () => {
  const projectId = await seedProject("res-view-mirror", "blank");
  const ws = await openEditableProject(projectId);
  // A VIEW never shipped by the starter: arbitrary id 7, mirrored loop.
  editDoc(ws, "view:7", buildView(MIRRORED_VIEW, PROFILE));
  const session = openProjectResourceEditor(ws, "view:7");
  try {
    const before = parseView(session.bytes, PROFILE);
    assert.equal(before.loops.length, 2);
    assert.equal(before.loops[1]!.cels[0]!.mirrored, true);
    // Loop 1 shows loop 0's cel flipped: hand-computed horizontal flip.
    const flipped = flipHorizontal({
      width: 2,
      height: 2,
      transparentColor: 15,
      pixels: [4, 5, 6, 7],
    });
    assert.deepEqual([...before.loops[1]!.cels[0]!.pixels], [...flipped.pixels]);

    const edit = viewEdit(ws, recolouredView(session.bytes, 9), 7);
    const result = await session.keepView(edit, undefined);
    assert.equal(result.status, "committed");
    const kept = parseView(storedResource(await storedBody(projectId), "view", 7)!, PROFILE);
    assert.equal(kept.loops[1]!.cels[0]!.mirrored, true);
    const flippedAfter = flipHorizontal({
      width: 2,
      height: 2,
      transparentColor: 15,
      pixels: [9, 5, 6, 7],
    });
    assert.deepEqual([...kept.loops[1]!.cels[0]!.pixels], [...flippedAfter.pixels]);
    assert.deepEqual([...kept.loops[0]!.cels[0]!.pixels], [9, 5, 6, 7]);
  } finally {
    session.close();
  }
});

test("a picture Keep saves while unrelated dirty LOGIC — valid or broken — stays dirty", async () => {
  const projectId = await seedProject("res-pic-unrelated");
  const ws = await openEditableProject(projectId);
  const originalLogic = ws.draft.capture().read("logic:1")!.content;
  editDoc(ws, "logic:1", "if (broken"); // does not compile at all
  const session = openProjectResourceEditor(ws, "picture:1");
  try {
    const edit = pictureEdit(ws, drawnPictureSource(ws));
    const result = await session.keepPicture(edit);
    assert.equal(result.status, "committed");
    // The broken draft text is preserved, still dirty, never compiled away.
    assert.ok(ws.draft.dirtyKeys().includes("logic:1"));
    assert.equal(ws.draft.capture().read("logic:1")!.content, "if (broken");
    // Storage still holds the original room.
    const data = await storedBody(projectId);
    assert.equal(readProjectWorkspace(data.workspace)["logic:1"], originalLogic);
    const reopened = await openEditableProject(projectId);
    assert.equal(reopened.draft.capture().read("logic:1")!.content, originalLogic);
    // And a valid unkept edit behaves identically.
    editDoc(ws, "logic:1", "// typed\nreturn;");
    const second = await session.keepPicture(
      pictureEdit(ws, drawnPictureSource(ws).replace("vis 4", "vis 9")),
    );
    assert.equal(second.status, "committed");
    assert.ok(ws.draft.dirtyKeys().includes("logic:1"));
    assert.equal(ws.draft.capture().read("logic:1")!.content, "// typed\nreturn;");
  } finally {
    session.close();
  }
});

test("opening a resource refuses precisely: missing doc, wrong kind, broken source or bytes", async () => {
  const projectId = await seedProject("res-open-refuse");
  const ws = await openEditableProject(projectId);
  assert.throws(() => openProjectResourceEditor(ws, "sound:0"), /picture|view/i);
  assert.throws(() => openProjectResourceEditor(ws, "picture:9"), /picture:9/);
  editDoc(ws, "picture:1", "vis 4\nrect 10,10\nend"); // malformed: rect needs two corners
  assert.throws(() => openProjectResourceEditor(ws, "picture:1"));
  // Native PIC bytes are openable regardless — the renderer tolerates a short
  // arg stream the same way the interpreter does, so opaque PICs stay editable.
  editDoc(ws, "picture:1", new Uint8Array([0xfa, 0xf0]));
  const opaque = openProjectResourceEditor(ws, "picture:1");
  assert.equal([...opaque.bytes].join(","), "250,240");
  assert.equal(opaque.authoredSource, undefined);
  opaque.close();
  editDoc(ws, "view:0", "{ not json"); // invalid view document
  assert.throws(() => openProjectResourceEditor(ws, "view:0"));
  editDoc(ws, "view:0", new Uint8Array([0, 0])); // below the 5-byte header
  assert.throws(() => openProjectResourceEditor(ws, "view:0"));
});

test("a closed session or swapped workspace refuses a late Keep without touching the draft", async () => {
  const projectId = await seedProject("res-late-keep");
  const ws = await openEditableProject(projectId);
  const doc = ws.draft.capture().read("picture:1")!;
  const before = await storedBody(projectId);

  const closed = openProjectResourceEditor(ws, "picture:1");
  closed.close();
  await assert.rejects(closed.keepPicture(pictureEdit(ws, drawnPictureSource(ws))), (error) =>
    expectCommitError(error, "stale"),
  );

  let mounted: EditableProject | undefined = ws;
  const swapped = openProjectResourceEditor(ws, "picture:1", {
    isCurrent: () => mounted === ws,
  });
  mounted = undefined; // the host mounted another workspace
  await assert.rejects(swapped.keepPicture(pictureEdit(ws, drawnPictureSource(ws))), (error) =>
    expectCommitError(error, "stale"),
  );
  swapped.close();

  assert.equal(ws.draft.capture().read("picture:1")!.content, doc.content);
  const after = await storedBody(projectId);
  assert.equal(after.library!.revision, before.library!.revision);
});

test("an external write to the same document refuses the Keep atomically", async () => {
  const projectId = await seedProject("res-stale-doc");
  const ws = await openEditableProject(projectId);
  const session = openProjectResourceEditor(ws, "picture:1");
  try {
    const external = "# someone redrew it\nvis 8\nfill 0,0\nend\n";
    editDoc(ws, "picture:1", external);
    await assert.rejects(session.keepPicture(pictureEdit(ws, drawnPictureSource(ws))), (error) =>
      expectCommitError(error, "stale"),
    );
    // The newer text stands; storage is untouched.
    assert.equal(ws.draft.capture().read("picture:1")!.content, external);
    const data = await storedBody(projectId);
    const stored = storedResource(data, "picture", 1)!;
    assert.ok(
      sameBytes(
        stored,
        compilePictureSource(readProjectWorkspace(data.workspace)["picture:1"] as string, {
          profile: PROFILE,
        }).bytes,
      ),
    );
  } finally {
    session.close();
  }
});

test("a Keep concurrent with itself refuses busy; a durable failure retries cleanly", async () => {
  const projectId = await seedProject("res-keep-retry");
  const ws = await openEditableProject(projectId);
  const session = openProjectResourceEditor(ws, "picture:1");
  try {
    const edit = pictureEdit(ws, drawnPictureSource(ws));
    const versionBefore = ws.draft.capture().version("picture:1");

    // One Keep is already in flight: a second is a refusal, not a second write.
    const first = session.keepPicture(edit);
    await assert.rejects(session.keepPicture(edit), (error) => expectCommitError(error, "busy"));
    assert.equal((await first).status, "committed");

    // A durable failure: the commit-time apply faults once, the draft write stands.
    const editTwo = pictureEdit(ws, drawnPictureSource(ws).replace("vis 4", "vis 9"));
    const realSet = records.set.bind(records);
    let armed = true;
    records.set = ((key: IDBValidKey, value: unknown) => {
      if (armed) {
        armed = false;
        throw new Error("Injected storage failure.");
      }
      return realSet(key, value);
    }) as typeof records.set;
    await assert.rejects(session.keepPicture(editTwo), (error) =>
      expectCommitError(error, "storage"),
    );
    records.set = realSet;

    // Recoverable pending edit: the draft carries the source, still dirty.
    assert.equal(ws.draft.capture().read("picture:1")!.content, editTwo.source);
    assert.ok(ws.draft.dirtyKeys().includes("picture:1"));

    // Retry: no second draft write (the content already matches), one commit.
    const versionAfterFail = ws.draft.capture().version("picture:1");
    const result = await session.keepPicture(editTwo);
    assert.equal(result.status, "committed");
    assert.equal(ws.draft.capture().version("picture:1"), versionAfterFail);
    assert.ok(versionAfterFail > versionBefore);
    assert.ok(sameBytes(storedResource(await storedBody(projectId), "picture", 1)!, editTwo.bytes));
  } finally {
    session.close();
  }
});

test("a pending assistant proposal goes stale when a visual Keep lands on the shared draft", async () => {
  const projectId = await seedProject("res-assist-stale");
  const ws = await openEditableProject(projectId);
  const originalLogic = ws.draft.capture().read("logic:1")!.content;
  // The proposal primitive the panel holds: captured over the current draft.
  const base = ws.draft.capture();
  const proposal = ws.draft.propose(base, "Assistant edit", [
    { key: "logic:1", content: "// proposal\nreturn;" },
  ]);

  const session = openProjectResourceEditor(ws, "picture:1");
  try {
    const result = await session.keepPicture(pictureEdit(ws, drawnPictureSource(ws)));
    assert.equal(result.status, "committed");
    // The same-draft write moved the revision the proposal was captured on:
    // apply refuses rather than silently landing it.
    assert.throws(() => ws.draft.apply(proposal), /stale/i);
    assert.equal(ws.draft.capture().read("logic:1")!.content, originalLogic);
  } finally {
    session.close();
  }
});
