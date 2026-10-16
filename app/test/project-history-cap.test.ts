import assert from "node:assert/strict";
import { test } from "node:test";
import { largeProjectHistory } from "../../test/projectHistoryCapFixture.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { writeProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { createContainer } from "../../src/container/container.ts";
import {
  authoringFingerprint,
  commitProject,
  loadAuthoredGame,
  loadAuthoredGameWithHistoryLifetime,
} from "../src/project/gameStorage.ts";
import {
  decodeJournalValue,
  type ProjectJournalCapture,
} from "../src/project/projectJournalCapture.ts";
import { rebuildProjectJournal } from "../src/project/projectSessionCore.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { testProjectId } from "./identity.ts";

installIndexedDbFixture();
installWebLocksFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});
const frames = new Map<number, FrameRequestCallback>();
let frame = 0;
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: (id: number) => frames.delete(id),
});

async function storedProject(count: number, name: string) {
  const state = largeProjectHistory(count);
  const documents = Object.fromEntries(
    Object.entries(state.commits.at(-1)!.documents).map(([key, hash]) => [
      key,
      state.blobs[hash!]!,
    ]),
  );
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const projectId = testProjectId(name);
  await commitProject({
    projectId,
    workspaceId: "initial",
    commitId: "initial",
    expected: null,
    buildId: compiled.build.identity.buildId,
    documents: [],
    data: {
      title: "Long history",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
      projectHistory: writeProjectHistory(state, sha256Hex),
    },
  });
  return projectId;
}
let run = 0;
async function open(projectId: ReturnType<typeof testProjectId>) {
  const opened = (await loadAuthoredGameWithHistoryLifetime(projectId))!;
  return openProjectSession({
    data: opened.data,
    lifetime: opened.lifetime!,
    publish: () => {},
    admission: {
      runToken: `history-cap-${++run}`,
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
  });
}
async function edit(owner: ReturnType<typeof openProjectSession>, content: string) {
  return owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Next", [{ key: "logic:0", content }]),
    label: "Next",
    origin: "logic",
    author: "creator",
  });
}

test("a stored project beyond the old manifest ceiling opens and accepts its next edit", async () => {
  const projectId = await storedProject(417, "history-over-cap");
  const owner = await open(projectId);
  assert.equal((await edit(owner, "// Reopened\nreturn;")).status, "committed");
  await owner.flush();
  owner.dispose();
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(stored.projectHistory!.commits.length, 418);
  assert.equal(stored.projectHistory!.commits.at(-1)!.label, "Next");
});

test("closing before edit 417 commits replays its journal and the reopened project accepts edit 418", async () => {
  const projectId = await storedProject(416, "history-journal-cap");
  const owner = await open(projectId);
  assert.equal((await edit(owner, "// Pending 417\nreturn;")).status, "committed");
  for (const callback of [...frames.values()]) callback(0);
  frames.clear();
  assert.ok([...values.keys()].some((key) => key.startsWith("monotio_agi.project-writes.")));
  owner.dispose();
  const recovered = (await loadAuthoredGame(projectId))!;
  assert.equal(recovered.projectHistory!.commits.length, 417);
  assert.equal(recovered.projectHistory!.commits.at(-1)!.label, "Next");
  assert.equal(
    [...values.keys()].filter((key) => key.startsWith("monotio_agi.project-writes.")).length,
    0,
  );
  const reopened = await open(projectId);
  assert.equal((await edit(reopened, "// Recovered 418\nreturn;")).status, "committed");
  await reopened.flush();
  reopened.dispose();
  assert.equal((await loadAuthoredGame(projectId))!.projectHistory!.commits.length, 418);
});

test("reopening recognizes a durable receipt for edit 417 before clearing its journal", async () => {
  const projectId = await storedProject(416, "history-receipt-cap");
  const base = (await loadAuthoredGame(projectId))!;
  const owner = await open(projectId);
  assert.equal((await edit(owner, "// Receipt 417\nreturn;")).status, "committed");
  for (const callback of [...frames.values()]) callback(0);
  frames.clear();
  const raw = [...values.entries()].find(([key]) =>
    key.startsWith("monotio_agi.project-writes."),
  )![1];
  const envelope = JSON.parse(raw) as { entries: unknown };
  const capture = (decodeJournalValue(envelope.entries) as { capture: ProjectJournalCapture }[])[0]!
    .capture;
  const candidate = await rebuildProjectJournal(base, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  await commitProject(candidate, capture.hash);
  owner.dispose();
  assert.ok([...values.keys()].some((key) => key.startsWith("monotio_agi.project-writes.")));
  const recovered = (await loadAuthoredGame(projectId))!;
  assert.equal(recovered.projectHistory!.commits.length, 417);
  assert.equal(
    recovered.generation,
    base.generation! + 1,
    "receipt recovery must not append a duplicate edit",
  );
  assert.equal(
    [...values.keys()].filter((key) => key.startsWith("monotio_agi.project-writes.")).length,
    0,
  );
  const reopened = await open(projectId);
  assert.equal((await edit(reopened, "// After receipt\nreturn;")).status, "committed");
  await reopened.flush();
  reopened.dispose();
  assert.equal((await loadAuthoredGame(projectId))!.projectHistory!.commits.length, 418);
});

test("closing before edit 1,025 commits replays and prunes its journal, then accepts another edit", async () => {
  const projectId = await storedProject(1024, "history-journal-1025");
  const owner = await open(projectId);
  assert.equal((await edit(owner, "// Pending 1025\nreturn;")).status, "committed");
  for (const callback of [...frames.values()]) callback(0);
  frames.clear();
  assert.ok([...values.keys()].some((key) => key.startsWith("monotio_agi.project-writes.")));
  owner.dispose();
  const recovered = (await loadAuthoredGame(projectId))!;
  assert.equal(recovered.projectHistory!.commits.length, 1024);
  assert.deepEqual(
    recovered.projectHistory!.blobs[
      recovered.projectHistory!.commits.at(-1)!.documents["logic:0"]!
    ],
    { type: "text", text: "// Pending 1025\nreturn;" },
  );
  assert.equal(
    [...values.keys()].filter((key) => key.startsWith("monotio_agi.project-writes.")).length,
    0,
  );
  const reopened = await open(projectId);
  assert.equal((await edit(reopened, "// After 1025\nreturn;")).status, "committed");
  await reopened.flush();
  reopened.dispose();
  assert.equal((await loadAuthoredGame(projectId))!.projectHistory!.commits.length, 1024);
});
