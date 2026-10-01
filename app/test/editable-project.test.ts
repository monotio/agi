import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { writeProjectRecovery } from "../../src/authoring/projectRecovery.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import type { StarterKind } from "../../src/authoring/starterProject.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import {
  openEditableProject,
  type EditableCandidate,
  type EditableKeepResult,
  type EditableSavedIdentity,
} from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testRevision } from "./identity.ts";

async function storedBody(projectId: ProjectId) {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

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

async function seedProject(
  name: string,
  kind: StarterKind = "blank",
  adjust?: (data: CachedGameData) => void,
) {
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

function editSource(
  ws: Awaited<ReturnType<typeof openEditableProject>>,
  key: string,
  content: string,
) {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

const ROOM1_REDRAW = "// Room 1\nif (isset(f5)) {\n  accept.input();\n}\nreturn;";
const ROOM1_ALT = "// Room 1 variant\nif (isset(f5)) {\n  show.pic();\n}\nreturn;";
const PICTURE_LINE = "# a drawn line\nvis 6\nline 0,0 20,20\nend";

test("a blank project opens, keeps a source edit and reopens it byte-exact, without a key or worker", async () => {
  const projectId = await seedProject("ws-blank-cycle");
  const ws = await openEditableProject(projectId);
  assert.equal(ws.profileId, "2.936");
  assert.equal(ws.inspection.requiresSourceReview, false);
  assert.equal(ws.inspection.rejectedSources["logic:1"], undefined);
  const base: EditableSavedIdentity = ws.savedIdentity();

  editSource(ws, "logic:1", ROOM1_REDRAW);
  const candidate = ws.buildSelected(["logic:1"]);
  assert.ok(candidate.keys.includes("logic:1"));
  const kept: EditableKeepResult = await ws.keepCandidate(candidate);
  assert.equal(kept.kind, "savedOnly");
  assert.equal(kept.commitId, candidate.commitId);
  assert.equal(kept.saved.generation, base.generation + 1);
  assert.notEqual(kept.saved.revision, base.revision);
  assert.equal(ws.draft.dirtyKeys().length, 0);

  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.draft.capture().read("logic:1")!.content, ROOM1_REDRAW);
  const data = await storedBody(projectId);
  assert.equal(readProjectWorkspace(data.workspace)["logic:1"], ROOM1_REDRAW);
  const sources = data.authoringState!["sources"] as { logics: [number, string][] };
  assert.ok(
    sources.logics.some(([num, source]) => num === 1 && source === ROOM1_REDRAW),
    "the kept source claim holds the exact edited text",
  );
});

test("a picture-only Keep excludes an unrelated malformed logic draft", async () => {
  const projectId = await seedProject("ws-picture-only");
  const ws = await openEditableProject(projectId);
  const original = ws.draft.capture().read("logic:1")!.content;
  assert.equal(typeof original, "string");

  editSource(ws, "logic:1", "if (broken");
  editSource(ws, "picture:1", PICTURE_LINE);
  const candidate = ws.buildSelected(["picture:1"]);
  assert.ok(candidate.keys.includes("picture:1"));
  assert.equal(candidate.keys.includes("logic:1"), false);
  await ws.keepCandidate(candidate);

  const data = await storedBody(projectId);
  const documents = readProjectWorkspace(data.workspace);
  assert.equal(documents["logic:1"], original);
  assert.equal(documents["picture:1"], PICTURE_LINE);
  // The unkept edit is still draft typing: the reopened workspace kept the old room.
  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.draft.capture().read("logic:1")!.content, original);
});

test("a vocabulary edit pulls the needing source into the kept closure", async () => {
  const projectId = await seedProject("ws-vocabulary");
  const ws = await openEditableProject(projectId);
  const said = (word: string) =>
    `// room\nif (isset(f5)) {\n  accept.input();\n}\nif (said("${word}")) { set(f100); }\nreturn;`;

  editSource(ws, "words", '[["look",100]]');
  editSource(ws, "logic:1", said("look"));
  await ws.keepCandidate(ws.buildSelected(["words", "logic:1"]));

  editSource(ws, "words", '[["unlock",100]]');
  editSource(ws, "logic:1", said("unlock"));
  const candidate = ws.buildSelected(["words"]);
  assert.ok(
    candidate.keys.includes("logic:1"),
    "the kept source cannot compile without the draft repair, so the closure pulls it",
  );
  await ws.keepCandidate(candidate);

  const data = await storedBody(projectId);
  assert.deepEqual(data.words, [["unlock", 100]]);
  const documents = readProjectWorkspace(data.workspace);
  assert.equal(documents["words"], '[["unlock",100]]');
  assert.equal(documents["logic:1"], said("unlock"));
});

test("a kept music document stores the authored tempo and reopening recovers it", async () => {
  const projectId = await seedProject("ws-music");
  const ws = await openEditableProject(projectId);
  // The exact SOUND payload write_music builds for one A4 beat at tempo 120.
  const sound = Uint8Array.of(
    8,
    0,
    15,
    0,
    17,
    0,
    19,
    0,
    30,
    0,
    14,
    130,
    144,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
  );
  const snapshot = ws.draft.capture();
  ws.draft.edit("sound:9", sound, snapshot.version("sound:9"));
  const music = '{"9":{"revision":"21-12345678","tempo":120}}';
  editSource(ws, "music", music);
  await ws.keepCandidate(ws.buildSelected(["music", "sound:9"]));

  const data = await storedBody(projectId);
  const authoring = data.authoringState!["authoring"] as {
    music?: Record<string, { revision: string; tempo: number }>;
  };
  assert.equal(authoring.music?.["9"]?.tempo, 120);
  assert.equal(readProjectWorkspace(data.workspace)["music"], music);

  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.draft.capture().read("music")!.content, music);
});

test("legacy authored music hydrates as a document and survives an unrelated Keep", async () => {
  const projectId = await seedProject("ws-music-legacy", "blank", (data) => {
    (data.authoringState!["authoring"] as { music?: Record<string, unknown> }).music = {
      "9": { revision: "21-abcdef12", tempo: 90 },
    };
  });
  const musicDoc = JSON.stringify({ "9": { revision: "21-abcdef12", tempo: 90 } });
  const ws = await openEditableProject(projectId);
  assert.equal(ws.draft.capture().read("music")!.content, musicDoc);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  const data = await storedBody(projectId);
  const authoring = data.authoringState!["authoring"] as {
    music?: Record<string, { tempo: number }>;
  };
  assert.equal(authoring.music?.["9"]?.tempo, 90);
  const reopened = await openEditableProject(projectId);
  assert.equal(reopened.draft.capture().read("music")!.content, musicDoc);
});

test("a source-only Keep advances authoring identity and leaves the playable revision", async () => {
  const projectId = await seedProject("ws-source-only");
  const ws = await openEditableProject(projectId);
  const base = ws.savedIdentity();
  const snapshot = ws.draft.capture();
  const original = snapshot.read("logic:1")!.content;
  const commented = `${original}// an authoring note\n`;

  ws.draft.edit("logic:1", commented, snapshot.version("logic:1"));
  const kept = await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  assert.equal(kept.saved.revision, base.revision);
  assert.equal(kept.saved.generation, base.generation + 1);
  assert.notEqual(kept.saved.authoring, base.authoring);

  const data = await storedBody(projectId);
  assert.equal(data.library!.revision, base.revision);
  assert.equal(readProjectWorkspace(data.workspace)["logic:1"], commented);
});

test("a storage-waiting Keep still lets newer typing through and leaves it dirty", async () => {
  const projectId = await seedProject("ws-inflight-typing");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const candidate = ws.buildSelected(["logic:1"]);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = storage.serializeWrite(projectId, () => gate);
  const keeping = ws.keepCandidate(candidate);
  editSource(ws, "logic:1", ROOM1_ALT);
  release();
  await blocker;
  await keeping;

  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
  const data = await storedBody(projectId);
  assert.equal(readProjectWorkspace(data.workspace)["logic:1"], ROOM1_REDRAW);
  assert.equal(ws.draft.capture().read("logic:1")!.content, ROOM1_ALT);
});

test("a candidate goes stale when the draft or kept base moves on", async () => {
  const projectId = await seedProject("ws-stale-candidate");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const candidate = ws.buildSelected(["logic:1"]);
  editSource(ws, "logic:1", ROOM1_ALT);
  await assert.rejects(ws.keepCandidate(candidate), /stale|moved/i);
});

test("a forged or foreign candidate holds no authority", async () => {
  const projectId = await seedProject("ws-forged-candidate");
  const ws = await openEditableProject(projectId);
  const forged = {
    commitId: "forged-commit",
    keys: Object.freeze([]),
  } as unknown as EditableCandidate;
  await assert.rejects(ws.keepCandidate(forged), /another workspace|authority|candidate/i);

  const other = await openEditableProject(projectId);
  const foreign = other.buildSelected(["logic:1"]);
  await assert.rejects(ws.keepCandidate(foreign), /another workspace|authority|candidate/i);
});

test("simultaneous candidates cannot publish competing bases", async () => {
  const projectId = await seedProject("ws-simultaneous");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const first = ws.buildSelected(["logic:1"]);
  const second = ws.buildSelected(["logic:1"]);
  assert.notEqual(first.commitId, second.commitId);

  const results = await Promise.allSettled([ws.keepCandidate(first), ws.keepCandidate(second)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )!;
  assert.match(rejected.reason.message, /modified|removed|replaced/i);
});

test("a second open workspace conflicts through the durable check", async () => {
  const projectId = await seedProject("ws-two-workspaces");
  const first = await openEditableProject(projectId);
  const second = await openEditableProject(projectId);
  editSource(first, "logic:1", ROOM1_REDRAW);
  await first.keepCandidate(first.buildSelected(["logic:1"]));

  editSource(second, "picture:1", PICTURE_LINE);
  await assert.rejects(
    second.keepCandidate(second.buildSelected(["picture:1"])),
    /modified|removed|replaced/i,
  );
  const data = await storedBody(projectId);
  assert.equal(readProjectWorkspace(data.workspace)["logic:1"], ROOM1_REDRAW);
});

test("a workspace opened before deletion and recreation refuses its stale lifetime", async () => {
  const projectId = await seedProject("ws-recreated");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const candidate = ws.buildSelected(["logic:1"]);

  const body = await storedBody(projectId);
  await storage.clearCachedGame(projectId);
  assert.equal(await storage.saveAuthoredGame(projectId, body), true);

  await assert.rejects(ws.keepCandidate(candidate), /removed|replaced|lifetime/i);
});

test("a failed storage write retries the same candidate and receipt, then replays without regressing", async () => {
  const projectId = await seedProject("ws-retry");
  const ws = await openEditableProject(projectId);
  const original = ws.draft.capture().read("logic:1")!.content;
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const candidate = ws.buildSelected(["logic:1"]);

  const realSet = records.set.bind(records);
  let fail = true;
  records.set = (key, value) => {
    if (fail && key === projectId) throw new Error("quota");
    return realSet(key, value);
  };
  try {
    await assert.rejects(ws.keepCandidate(candidate), /quota/);
    const unchanged = await storedBody(projectId);
    assert.equal(unchanged.generation, 1);
    assert.equal(readProjectWorkspace(unchanged.workspace)["logic:1"], original);
    fail = false;
    const retry = await ws.keepCandidate(candidate);
    assert.equal(retry.commitId, candidate.commitId);
    assert.equal(retry.saved.generation, 2);

    const replay = await ws.keepCandidate(candidate);
    assert.deepEqual(replay.saved, retry.saved);
    assert.equal((await storedBody(projectId)).generation, 2);
  } finally {
    records.set = realSet;
  }
});

test("replaying a finished candidate returns its receipt without rolling a newer save back", async () => {
  const projectId = await seedProject("ws-replay");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const first = ws.buildSelected(["logic:1"]);
  const firstKeep = await ws.keepCandidate(first);

  editSource(ws, "logic:1", ROOM1_ALT);
  const secondKeep = await ws.keepCandidate(ws.buildSelected(["logic:1"]));

  const replay = await ws.keepCandidate(first);
  assert.equal(replay.commitId, first.commitId);
  assert.equal(replay.saved.generation, firstKeep.saved.generation);
  assert.equal(ws.savedIdentity().generation, secondKeep.saved.generation);
  assert.deepEqual(ws.draft.dirtyKeys(), []);
  assert.equal(readProjectWorkspace((await storedBody(projectId)).workspace)["logic:1"], ROOM1_ALT);
});

test("a refused source claim blocks build and Keep without touching storage", async () => {
  const projectId = await seedProject("ws-source-review", "blank", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({ ...documents, "logic:1": "if (broken" });
  });
  const ws = await openEditableProject(projectId);
  assert.equal(ws.inspection.requiresSourceReview, true);
  assert.ok("logic:1" in ws.inspection.rejectedSources);
  assert.throws(() => ws.buildSelected(["logic:1"]), /review|refused/i);

  const data = await storedBody(projectId);
  assert.equal(readProjectWorkspace(data.workspace)["logic:1"], "if (broken");
});

test("a pending portable recovery draft is carried through every saved body", async () => {
  const projectId = await seedProject("ws-recovery");
  const seeded = await storedBody(projectId);
  const recovery = writeProjectRecovery(
    {
      revision: seeded.library!.revision,
      authoring: testRevision("workspace-draft"),
      profileId: "2.936",
    },
    {
      changes: [{ key: "logic:1", version: 1, content: "return; // unfinished" }],
      groups: [],
    },
  );
  seeded.recoveryDraft = recovery;
  assert.equal(await storage.saveAuthoredGame(projectId, seeded), true);

  const ws = await openEditableProject(projectId);
  assert.deepEqual(ws.storedData().recoveryDraft, recovery);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  assert.deepEqual((await storedBody(projectId)).recoveryDraft, recovery);
});

test("tests and references documents pass through unchanged but refuse edits and removal", async () => {
  const projectId = await seedProject("ws-metadata", "blank", (data) => {
    const documents = readProjectWorkspace(data.workspace);
    data.workspace = writeProjectWorkspace({
      ...documents,
      tests: '[{"name":"smoke"}]',
      references: '[{"kind":"note"}]',
    });
  });
  const ws = await openEditableProject(projectId);
  editSource(ws, "tests", "[]");
  await assert.rejects(ws.keepCandidate(ws.buildSelected(["tests"])), /tests|metadata|preserved/i);
  const snapshot = ws.draft.capture();
  ws.draft.edit("references", null, snapshot.version("references"));
  await assert.rejects(
    ws.keepCandidate(ws.buildSelected(["references"])),
    /references|metadata|preserved/i,
  );

  // The unchanged documents ride along with an unrelated Keep byte-exact.
  const current = ws.draft.capture();
  ws.draft.edit("logic:1", ROOM1_REDRAW, current.version("logic:1"));
  await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  const data = await storedBody(projectId);
  const documents = readProjectWorkspace(data.workspace);
  assert.equal(documents["tests"], '[{"name":"smoke"}]');
  assert.equal(documents["references"], '[{"kind":"note"}]');
});

test("world and bindings documents validate into the stored authoring state", async () => {
  const projectId = await seedProject("ws-world");
  const ws = await openEditableProject(projectId);
  editSource(ws, "world", "{not json");
  await assert.rejects(ws.keepCandidate(ws.buildSelected(["world"])), /world/i);

  const world = {
    rooms: { "1": { title: "Start", description: "A start.", exits: {} } },
    facts: {},
    quests: {},
  };
  const snapshot = ws.draft.capture();
  ws.draft.edit("world", JSON.stringify(world), snapshot.version("world"));
  await ws.keepCandidate(ws.buildSelected(["world"]));
  const data = await storedBody(projectId);
  const authoring = data.authoringState!["authoring"] as {
    world: { rooms: Record<string, { title: string }> };
  };
  assert.equal(authoring.world.rooms["1"]!.title, "Start");
});

test("a byte-only view document drops its stale source claim", async () => {
  const projectId = await seedProject("ws-byte-view", "starter");
  const ws = await openEditableProject(projectId);
  const seeded = await storedBody(projectId);
  const viewBytes = openContainer(new Map(Object.entries(seeded.files))).getResource("view", 1);
  assert.ok(viewBytes);
  const snapshot = ws.draft.capture();
  ws.draft.edit("view:1", new Uint8Array(viewBytes), snapshot.version("view:1"));
  await ws.keepCandidate(ws.buildSelected(["view:1"]));

  const data = await storedBody(projectId);
  const sources = data.authoringState!["sources"] as { views: [number, unknown][] };
  assert.equal(
    sources.views.some(([num]) => num === 1),
    false,
    "a byte-carried resource keeps no source claim",
  );
  assert.ok(openContainer(new Map(Object.entries(data.files))).getResource("view", 1) !== null);
});

test("removing a kept resource is refused at Keep", async () => {
  const projectId = await seedProject("ws-removal");
  const ws = await openEditableProject(projectId);
  const snapshot = ws.draft.capture();
  ws.draft.edit("picture:1", null, snapshot.version("picture:1"));
  const candidate = ws.buildSelected(["picture:1"]);
  assert.ok(candidate.removedResources.includes("picture:1"));
  await assert.rejects(ws.keepCandidate(candidate), /removes|removal/i);
});

test("a manual project refuses a missing static room; an explicit generation policy narrows it", async () => {
  const manual = await seedProject("ws-room-manual");
  const manualWs = await openEditableProject(manual);
  const original = manualWs.draft.capture().read("logic:1")!.content;
  editSource(manualWs, "logic:1", "new.room(9);\nreturn;");
  const blocked = manualWs.buildSelected(["logic:1"]);
  assert.ok(
    blocked.diagnostics.some(
      (entry) => entry.code === "missing-resource" && entry.severity === "error",
    ),
  );
  await assert.rejects(manualWs.keepCandidate(blocked), /absent|missing|reference/i);
  assert.equal(readProjectWorkspace((await storedBody(manual)).workspace)["logic:1"], original);

  const generated = await seedProject("ws-room-generated", "blank", (data) => {
    data.roomGeneration = true;
  });
  const generatedWs = await openEditableProject(generated);
  editSource(generatedWs, "logic:1", "new.room(9);\nreturn;");
  const allowed = generatedWs.buildSelected(["logic:1"]);
  assert.ok(
    allowed.diagnostics.some(
      (entry) => entry.code === "missing-resource" && entry.severity === "warning",
    ),
  );
  await generatedWs.keepCandidate(allowed);
  assert.equal(
    readProjectWorkspace((await storedBody(generated)).workspace)["logic:1"],
    "new.room(9);\nreturn;",
  );

  // The same policy still refuses any other missing resource.
  editSource(generatedWs, "logic:1", "new.room(9);\nload.view(9);\nreturn;");
  const missingView = generatedWs.buildSelected(["logic:1"]);
  await assert.rejects(generatedWs.keepCandidate(missingView), /absent|missing|reference/i);
});
