import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { buildSyntheticGame } from "../../src/games/syntheticGame.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { stampBoot } from "../../src/agent/history.ts";
import { addLibraryGame } from "../src/library/gameLibrary.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { resolveProgressTarget } from "../src/project/progressBinding.ts";
import { clearCachedGame, readHistoryLifetime } from "../src/project/gameStorage.ts";
import { useSaveSlotController } from "../src/saves/useSaveSlotController.ts";
import { appendHistoryBatch, loadGameHistory } from "../src/history/historyStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();

const importedProjects = new WeakMap<TestContext, ProjectId[]>();

function storageFixture(t: TestContext): Storage {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const projects: ProjectId[] = [];
  importedProjects.set(t, projects);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(async () => {
    for (const project of projects) await clearCachedGame(project);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return storage;
}

async function importedBuild(t: TestContext): Promise<{
  installed: BootedGame;
  saved: BootedGame;
}> {
  const original = buildSyntheticGame();
  const container = openContainer(new Map(Object.entries(original.files)));
  container.putResource(
    "logic",
    0,
    assembleLogic('display(1, 1, "A remixed room"); return;', {
      dictionary: new Map(original.words),
    }).payload,
  );
  const edited = { ...original.files, ...Object.fromEntries(container.files) };
  const savedId = await addLibraryGame(
    { files: edited, words: original.words },
    "Remixed chamber",
    "folder",
    {
      status: "ready",
      message: "Opening checked.",
      profile: "2.936",
      preview: "data:image/png;base64,iVBORw0KGgo=",
    },
  );
  importedProjects.get(t)!.push(savedId);
  assert.equal(savedId, "synthetic", "the real import allocator uses the recognised alias");
  const revision = await gameRevision(original.files);
  const changedRevision = await gameRevision(edited);
  assert.notEqual(revision, changedRevision, "the playable builds are distinct");
  return {
    installed: {
      installed: true,
      folder: "synthetic",
      alias: "synthetic",
      title: "Original chamber",
      files: original.files,
      words: original.words,
      revision,
    },
    saved: {
      installed: false,
      projectId: savedId,
      title: "Remixed chamber",
      files: edited,
      words: original.words,
      revision: changedRevision,
      historyLifetime: await readHistoryLifetime(savedId),
    },
  };
}

test("installed and imported builds keep independent numbered save slots", async (t) => {
  const storage = storageFixture(t);
  const { installed, saved } = await importedBuild(t);
  let booted = installed;
  const slots = useSaveSlotController({ getBootedGame: () => booted, storage });
  const originalImage = btoa("Original installation slot one");
  const remixImage = btoa("Imported remix slot one");
  assert.equal(slots.handleSaveSlotRequest("saveWrite", { slot: 1, image: originalImage }), "true");
  booted = saved;
  assert.equal(slots.handleSaveSlotRequest("saveWrite", { slot: 1, image: remixImage }), "true");
  booted = installed;
  assert.equal(await slots.handleSaveSlotRequest("restore", { slot: 1 }), originalImage);
  booted = saved;
  assert.equal(await slots.handleSaveSlotRequest("restore", { slot: 1 }), remixImage);
});

test("space and Unicode installation folders sharing vocabulary keep separate slots", async (t) => {
  const storage = storageFixture(t);
  const original = buildSyntheticGame();
  const revision = await gameRevision(original.files);
  const first: BootedGame = {
    installed: true,
    folder: "My first adventure",
    hash: "a".repeat(64),
    alias: "synthetic",
    title: "First",
    files: original.files,
    words: original.words,
    revision,
  };
  const second = { ...first, folder: "Mitt äventyr", title: "Second" };
  let booted = first;
  const slots = useSaveSlotController({ getBootedGame: () => booted, storage });
  const firstImage = btoa("First installation slot one");
  const secondImage = btoa("Second installation slot one");
  assert.equal(slots.handleSaveSlotRequest("saveWrite", { slot: 1, image: firstImage }), "true");
  booted = second;
  assert.equal(slots.handleSaveSlotRequest("saveWrite", { slot: 1, image: secondImage }), "true");
  booted = first;
  assert.equal(await slots.handleSaveSlotRequest("restore", { slot: 1 }), firstImage);
  booted = second;
  assert.equal(await slots.handleSaveSlotRequest("restore", { slot: 1 }), secondImage);
});

test("removing an imported project preserves the local installation's history lifetime", async (t) => {
  storageFixture(t);
  const { installed, saved } = await importedBuild(t);
  const target = resolveProgressTarget(installed);
  assert.ok(target);
  const lifetime = await readHistoryLifetime(target.locator);
  const boot = stampBoot({
    files: Object.fromEntries(
      Object.entries(installed.files).map(([name, bytes]) => [
        name,
        btoa(String.fromCharCode(...bytes)),
      ]),
    ),
    dictionary: installed.words,
    authorRooms: false,
    rng: 7,
    soundDevice: 1,
    resourceSet: installed.revision,
    requestSerial: 0,
  });
  assert.equal(
    await appendHistoryBatch(
      target,
      {
        segment: "s-installed.1",
        batch: 1,
        seqStart: 0,
        seqEnd: 1,
        events: [],
        marks: [],
        sync: [],
        boot,
      },
      "2.936",
      lifetime,
    ),
    true,
  );
  assert.ok(await loadGameHistory(target.locator));
  await clearCachedGame(saved.projectId!);
  assert.ok(await loadGameHistory(target.locator), "the installation retains its own tape");
  assert.equal(await readHistoryLifetime(target.locator), lifetime);
});
