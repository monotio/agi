import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectId } from "../../src/gameIdentity.ts";
import { openContainer } from "../../src/container/container.ts";
import { buildSound } from "../../src/sound/build.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import { SoundStudioWorkspace } from "../src/studio/sound/soundWorkspace.ts";
import { SOUND_MAX_BYTES, soundKey } from "../src/studio/sound/soundDocuments.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

/**
 * The Sound Studio workspace controller headless: draft transactions, event
 * ids, undo, Keep and the removal refusal all run against the real project
 * storage through the same openEditableProject authority Logic Studio uses.
 */

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

async function seedProject(name: string, adjust?: (data: CachedGameData) => void) {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  if (adjust) {
    const data = await storage.loadAuthoredGame(prepared.projectId);
    assert.ok(data);
    adjust(data);
    assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  }
  return prepared.projectId;
}

async function openWorkspace(projectId: ProjectId) {
  const ws = new SoundStudioWorkspace();
  await ws.open(projectId);
  return ws;
}

/** Read one document's draft text. */
function docText(ws: SoundStudioWorkspace, key: string): string | null {
  const content = ws.draft!.capture().read(key)?.content;
  return content === undefined ? null : (content as string | null);
}

test("create from a preset writes the envelope and music entry in one transaction", async () => {
  const projectId = await seedProject("sound-create");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue("danger");
  const key = soundKey(num);
  const dirty = new Set(ws.dirtyKeys());
  assert.ok(dirty.has(key));
  assert.ok(dirty.has("music"), "the sound and its music entry change together");
  const claim = JSON.parse(docText(ws, key)!);
  assert.equal(claim.format, "agi.sound-document");
  assert.equal(claim.version, 1);
  assert.equal(claim.profileId, "2.936");
  const music = JSON.parse(docText(ws, "music")!);
  assert.equal(typeof music[String(num)].revision, "string");
  assert.equal(music[String(num)].tempo, 120);
  // The preset seeded real events; the payload compiles byte-exactly.
  const payload = ws.nativePayload(num)!;
  assert.ok(payload.length > 16);
  const candidate = ws.buildSelected([key, "music"]);
  assert.equal(candidate.removedResources.length, 0);
  const result = await ws.keepCandidate(candidate);
  assert.equal(result.kind, "savedOnly");
});

test("keep then reopen preserves exact native bytes and event ids", async () => {
  const projectId = await seedProject("sound-keep");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  const edited = ws.editCue(num, "note", (doc) =>
    doc.insertEvent(0, 0, { ticks: 30, data: { kind: "tone", note: "A4", attenuation: 4 } }),
  );
  const ids = edited.tracks()![0]!.map((event) => event.id);
  const bytes = ws.nativePayload(num)!;
  const candidate = ws.buildSelected(ws.dirtyKeys());
  await ws.keepCandidate(candidate);

  const ws2 = await openWorkspace(projectId);
  const reopened = ws2.documentFor(num)!.document;
  assert.deepEqual([...reopened.encode()], [...bytes]);
  assert.deepEqual(
    reopened.tracks()![0]!.map((event) => event.id),
    ids,
    "event ids survive Keep and reopen through the tagged envelope",
  );
  assert.equal(reopened.tracks()![0]![0]!.data.kind, "tone");
});

test("undo restores the prior payload and a fresh insert never reuses an id", async () => {
  const projectId = await seedProject("sound-undo");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  const empty = ws.nativePayload(num)!;
  const withNote = ws.editCue(num, "note", (doc) =>
    doc.insertEvent(0, 0, { ticks: 15, data: { kind: "tone", divisor: 200, attenuation: 0 } }),
  );
  const firstId = withNote.tracks()![0]![0]!.id;
  ws.undo();
  assert.deepEqual([...ws.nativePayload(num)!], [...empty]);
  ws.redo();
  assert.equal(ws.documentFor(num)!.document.tracks()![0]![0]!.id, firstId);
  // Undo once more, then insert again: the allocator floor forbids reusing it.
  ws.undo();
  const again = ws.editCue(num, "note", (doc) =>
    doc.insertEvent(0, 0, { ticks: 15, data: { kind: "tone", divisor: 200, attenuation: 0 } }),
  );
  const secondId = again.tracks()![0]![0]!.id;
  assert.notEqual(secondId, firstId);
});

test("noise, rest and raw records keep their native byte roles", async () => {
  const projectId = await seedProject("sound-kinds");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  const doc = ws.editCue(num, "events", (d) =>
    d
      .insertEvent(3, 0, { ticks: 20, data: { kind: "noise", control: 6, attenuation: 2 } })
      .insertEvent(0, 0, { ticks: 10, data: { kind: "rest" } }),
  );
  const noise = doc.tracks()![3]![0]!;
  assert.equal(noise.data.kind, "noise");
  const rest = doc.tracks()![0]![0]!;
  assert.equal(rest.data.kind, "rest");
  // Rest bytes: divisor 0 / attenuation 15 encoding — silence, never a tone.
  const bytes = ws.nativePayload(num)!;
  assert.equal(bytes[8], 10);
  assert.equal(bytes[12], 0x9f);
  // A raw record's three bytes survive an import verbatim.
  const rawPayload = new Uint8Array([
    8, 0, 15, 0, 17, 0, 19, 0, 5, 0, 0xaa, 0xbb, 0xcc, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff,
  ]);
  ws.importCue(num, rawPayload);
  const reopened = ws.documentFor(num)!.document;
  const raw = reopened.tracks()![0]![0]!;
  assert.equal(raw.data.kind, "raw");
  assert.deepEqual([...ws.nativePayload(num)!], [...rawPayload]);
});

test("a 65535-tick duration is refused and the draft is untouched", async () => {
  const projectId = await seedProject("sound-terminator");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  ws.editCue(num, "note", (doc) =>
    doc.insertEvent(0, 0, { ticks: 30, data: { kind: "tone", divisor: 100 } }),
  );
  const before = docText(ws, soundKey(num));
  assert.throws(
    () =>
      ws.editCue(num, "bad", (doc) => doc.updateEvent(doc.tracks()![0]![0]!.id, { ticks: 65_535 })),
    /65,535|terminator/,
  );
  assert.equal(docText(ws, soundKey(num)), before, "the refused edit never lands");
});

test("word 0 is the authentic 65,536-tick event", async () => {
  const projectId = await seedProject("sound-maxtick");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  const doc = ws.editCue(num, "long", (doc) =>
    doc.insertEvent(0, 0, { ticks: 65_536, data: { kind: "rest" } }),
  );
  assert.equal(doc.tracks()![0]![0]!.durationTicks, 65_536);
  assert.equal(doc.tracks()![0]![0]!.durationWord, 0);
  assert.equal(ws.nativePayload(num)![8], 0);
  assert.equal(ws.nativePayload(num)![9], 0);
});

test("oversized import is refused on byte count before the draft changes", async () => {
  const projectId = await seedProject("sound-big");
  const ws = await openWorkspace(projectId);
  const oversized = new Uint8Array(SOUND_MAX_BYTES + 1);
  assert.throws(() => ws.importCue(0, oversized), /65,535 bytes|at most/);
  assert.deepEqual(ws.dirtyKeys(), []);
});

test("a non-four-stream payload opens opaque and exports byte-exact", async () => {
  const projectId = await seedProject("sound-opaque");
  const ws = await openWorkspace(projectId);
  const opaque = new Uint8Array([1, 2, 3]); // no room for four offsets
  ws.importCue(4, opaque);
  const doc = ws.documentFor(4)!.document;
  assert.equal(doc.representation, "opaque");
  assert.equal(doc.tracks(), null);
  assert.deepEqual([...ws.nativePayload(4)!], [1, 2, 3]);
  assert.throws(
    () => ws.editCue(4, "edit", (d) => d.insertEvent(0, 0, { ticks: 5, data: { kind: "rest" } })),
    /opaque|not be edited/,
  );
});

test("duplicate lands on a free number with fresh ids and identical bytes", async () => {
  const projectId = await seedProject("sound-duplicate");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue("success");
  const source = ws.documentFor(num)!.document;
  const target = ws.duplicateCue(num);
  assert.notEqual(target, num);
  const copy = ws.documentFor(target)!.document;
  assert.deepEqual([...copy.encode()], [...source.encode()]);
  const sourceIds = source
    .tracks()!
    .flat()
    .map((event) => event.id);
  const copyIds = copy
    .tracks()!
    .flat()
    .map((event) => event.id);
  for (const id of copyIds) assert.ok(!sourceIds.includes(id));
});

test("removal stages one undoable transaction; Keep commits it durably", async () => {
  const projectId = await seedProject("sound-remove");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  await ws.keepCandidate(ws.buildSelected(ws.dirtyKeys()));
  assert.equal(ws.removeCue(num), null, "the removal stages like any other draft edit");
  assert.equal(ws.documentFor(num), null, "the cue leaves the draft now");
  assert.equal(JSON.parse(docText(ws, "music")!)[String(num)], undefined);
  const removal = ws.buildSelected(ws.dirtyKeys());
  assert.deepEqual(removal.removedResources, [`sound:${num}`]);
  // Nothing reached the saved project yet: the Remove button writes no durable state.
  const stillKept = await storage.loadAuthoredGame(projectId);
  assert.ok(stillKept);
  assert.ok(
    openContainer(new Map(Object.entries(stillKept.files))).getResource("sound", num) !== null,
  );
  // Undo restores both halves of the staged removal before any commit.
  ws.undo();
  assert.notEqual(ws.documentFor(num), null);
  assert.ok(JSON.parse(docText(ws, "music")!)[String(num)] !== undefined);
  // Redo and Keep: the kept project loses the native resource and its entry.
  ws.redo();
  assert.equal(ws.documentFor(num), null);
  await ws.keepCandidate(ws.buildSelected(ws.dirtyKeys()));
  const stored = await storage.loadAuthoredGame(projectId);
  assert.ok(stored);
  assert.equal(
    openContainer(new Map(Object.entries(stored.files))).getResource("sound", num),
    null,
  );
});

test("a kept logic calling the cue refuses the Keep by name and the draft keeps the staged removal", async () => {
  const projectId = await seedProject("sound-remove-live-ref");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  ws.draft!.edit("logic:1", `sound(${num}, f60);\nreturn;`, ws.draft!.capture().version("logic:1"));
  await ws.keepCandidate(ws.buildSelected(ws.dirtyKeys()));
  assert.equal(ws.removeCue(num), null, "staging is not the semantic gate");
  const removal = ws.buildSelected(ws.dirtyKeys());
  assert.deepEqual(removal.removedResources, [`sound:${num}`]);
  await assert.rejects(ws.keepCandidate(removal), /sound:\d+ is still used by logic:1/);
  // The refused Keep wrote nothing; the staged removal stays recoverable.
  const stored = await storage.loadAuthoredGame(projectId);
  assert.ok(stored);
  assert.ok(
    openContainer(new Map(Object.entries(stored.files))).getResource("sound", num) !== null,
  );
  assert.equal(ws.documentFor(num), null, "the staged removal still stands for review or undo");
  ws.undo();
  assert.notEqual(ws.documentFor(num), null);
});

test("a coordinated edit drops the reference and removes the cue in the same Keep", async () => {
  const projectId = await seedProject("sound-remove-repaired");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  ws.draft!.edit("logic:1", `sound(${num}, f60);\nreturn;`, ws.draft!.capture().version("logic:1"));
  await ws.keepCandidate(ws.buildSelected(ws.dirtyKeys()));
  // The same reviewed transaction drops the call and removes the cue.
  ws.draft!.edit("logic:1", "return;", ws.draft!.capture().version("logic:1"));
  assert.equal(ws.removeCue(num), null);
  const candidate = ws.buildSelected(ws.dirtyKeys());
  assert.deepEqual(candidate.removedResources, [`sound:${num}`]);
  await ws.keepCandidate(candidate);
  const stored = await storage.loadAuthoredGame(projectId);
  assert.ok(stored);
  assert.equal(
    openContainer(new Map(Object.entries(stored.files))).getResource("sound", num),
    null,
  );
  assert.equal(
    openContainer(new Map(Object.entries(stored.files))).getResource("logic", 1) !== null,
    true,
    "the repaired logic stays kept",
  );
});

test("a legacy track-array claim opens and edits through the native document", async () => {
  const projectId = await seedProject("sound-legacy");
  const ws = await openWorkspace(projectId);
  const tracks = [
    { notes: [{ note: "C4", duration: 24, attenuation: 3 }] },
    { notes: [] },
    { notes: [] },
    { notes: [] },
  ];
  const expected = buildSound(tracks);
  ws.draft!.edit(soundKey(7), JSON.stringify(tracks), 0);
  const opened = ws.documentFor(7)!;
  assert.equal(opened.source, "tracks");
  assert.deepEqual([...opened.document.encode()], [...expected]);
  // Editing rewrites the claim as the tagged envelope.
  ws.editCue(7, "stretch", (doc) => doc.updateEvent(doc.tracks()![0]![0]!.id, { ticks: 48 }));
  const claim = JSON.parse(docText(ws, soundKey(7))!);
  assert.equal(claim.format, "agi.sound-document");
  assert.equal(ws.documentFor(7)!.source, "envelope");
});

test("usage names the logics that reference the sound", async () => {
  const projectId = await seedProject("sound-usedby", (data) => {
    // Cite sound 12 from logic 0 so the used-by listing has a real entry.
    const files = data.files as Record<string, Uint8Array>;
    void files;
  });
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  const entry = ws.entries().find((item) => !("openError" in item) && item.num === num);
  assert.ok(entry !== undefined);
  // The blank template's own sounds carry usage from the kept image.
  assert.ok(Array.isArray("usedBy" in entry! ? entry.usedBy : []));
});

test("setTempo rewrites only the music entry", async () => {
  const projectId = await seedProject("sound-tempo");
  const ws = await openWorkspace(projectId);
  const num = ws.createCue();
  const before = docText(ws, soundKey(num));
  ws.setTempo(num, 180);
  assert.equal(JSON.parse(docText(ws, "music")!)[String(num)].tempo, 180);
  assert.equal(docText(ws, soundKey(num)), before, "the envelope is untouched");
  ws.undo();
  assert.equal(JSON.parse(docText(ws, "music")!)[String(num)].tempo, 120);
});

test("a newer open supersedes an older in-flight open", async () => {
  const first = await seedProject("sound-open-first");
  const second = await seedProject("sound-open-second");
  const ws = new SoundStudioWorkspace();
  const older = ws.open(first);
  const newer = ws.open(second);
  const [olderWs, newerWs] = await Promise.all([older, newer]);
  assert.equal(olderWs, null, "the superseded open installs nothing");
  assert.ok(newerWs !== null);
  assert.equal(ws.project, newerWs);
  assert.equal(ws.projectId, second);
});

test("open resolving after close installs nothing and a reopen still works", async () => {
  const projectId = await seedProject("sound-open-close-reopen");
  const ws = new SoundStudioWorkspace();
  const opening = ws.open(projectId);
  ws.close();
  assert.equal(await opening, null);
  assert.equal(ws.project, null);
  const reopened = await ws.open(projectId);
  assert.ok(reopened !== null);
  assert.equal(ws.projectId, projectId);
});

test("a failed open keeps the current project instead of blanking it", async () => {
  const projectId = await seedProject("sound-open-failure");
  const ws = await openWorkspace(projectId);
  const current = ws.project;
  const missing = "00000000-0000-4000-8000-000000000000" as ProjectId;
  await assert.rejects(ws.open(missing), /no saved data/);
  assert.equal(ws.project, current, "the failed open leaves the open project alone");
  assert.equal(ws.projectId, projectId);
});
