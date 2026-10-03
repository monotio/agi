/**
 * Installed progress addressing: one served folder running different
 * playable bytes owns independent save slots, autosaves, room maps and
 * session histories. The physical locator binds the folder's exact UTF-8
 * digest to the full resource revision, so a replaced build never reads or
 * overwrites the previous build's records — and returning to the previous
 * build finds them intact. A deliberately edited saved body keeps its
 * single ProjectId+epoch address.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildSyntheticGame } from "../../src/games/syntheticGame.ts";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { stampBoot } from "../../src/agent/history.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { bindSavedProgressTarget, resolveProgressTarget } from "../src/project/progressBinding.ts";
import { readHistoryLifetime, saveAuthoredGame } from "../src/project/gameStorage.ts";
import { installedProgressTarget, type ProgressTarget } from "../src/project/progressTarget.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { addLibraryGame } from "../src/library/gameLibrary.ts";
import { useSaveSlotController } from "../src/saves/useSaveSlotController.ts";
import {
  autosaveKey,
  readGameProgress,
  writeAutosave,
  type AutosaveRecord,
} from "../src/saves/gameProgress.ts";
import { emptyMapSidecar, readMapSidecar, writeMapSidecar } from "../src/world/roomMapStore.ts";
import { appendHistoryBatch, loadGameHistory } from "../src/history/historyStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();

/** A memory Storage standing in for browser localStorage. */
const raw = new Map<string, string>();
const storage = {
  getItem: (key: string) => raw.get(key) ?? null,
  setItem: (key: string, value: string) => {
    raw.set(key, value);
  },
  removeItem: (key: string) => {
    raw.delete(key);
  },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

/**
 * Two builds of one served folder: identical WORDS.TOK bytes, LOGIC 0
 * changed with the real assembler and container. Their full resource
 * revisions differ while the vocabulary digest stays identical — the
 * changed-installed-build case no released spelling can distinguish.
 */
const a = buildSyntheticGame();
const container = openContainer(new Map(Object.entries(a.files)));
container.putResource(
  "logic",
  0,
  assembleLogic('display(1, 1, "Changed playable bytes"); return;', {
    dictionary: new Map(a.words),
  }).payload,
);
const b = { files: { ...a.files, ...Object.fromEntries(container.files) }, words: a.words };
const revA = await gameRevision(a.files);
const revB = await gameRevision(b.files);
assert.notEqual(revA, revB);
assert.deepEqual(a.files["WORDS.TOK"], b.files["WORDS.TOK"]);

/** The autosave record a bound installed target writes: its own identity. */
function checkpoint(target: ProgressTarget, image: string): AutosaveRecord {
  return {
    format: "monotio.agi.autosave",
    version: 1,
    image,
    room: 1,
    cycle: 1,
    savedAt: 1,
    game: { installed: true, identity: target.identity },
  };
}

test("the same installed folder at A, then B, then A keeps slots, autosaves and map independent", async () => {
  const ga: BootedGame = {
    ...a,
    installed: true,
    folder: "revision-peer-slots",
    title: "A",
    revision: revA,
  };
  const gb: BootedGame = { ...b, installed: true, folder: ga.folder, title: "B", revision: revB };
  const ta = resolveProgressTarget(ga)!;
  const tb = resolveProgressTarget(gb)!;
  let booted: BootedGame | null = ga;
  const slots = useSaveSlotController({ getBootedGame: () => booted, storage });
  const imageA = btoa("slot from build A");
  const imageB = btoa("slot from build B");
  assert.equal(slots.handleSaveSlotRequest("saveWrite", { slot: 1, image: imageA }), "true");
  assert.ok(writeAutosave(storage, ta, checkpoint(ta, imageA)));
  const mapA = { ...emptyMapSidecar(), notes: { "1": "A's room" } };
  assert.equal(writeMapSidecar(storage, ta.locator, mapA), true);

  booted = gb;
  const observed = {
    distinctLocators: ta.locator !== tb.locator,
    bInitialSlot: await slots.handleSaveSlotRequest("restore", { slot: 1 }),
    bInitialAutosave: readGameProgress(storage, tb).autosave?.image ?? null,
    bInitialMapNotes: readMapSidecar(storage, tb.locator).notes,
    aSlotAfterBWrite: "",
    aAutosaveAfterBWrite: null as string | null,
    aMapAfterBWrite: {} as unknown,
    rawCheckpointRevisionAfterBWrite: "",
  };
  assert.equal(slots.handleSaveSlotRequest("saveWrite", { slot: 1, image: imageB }), "true");
  assert.ok(writeAutosave(storage, tb, checkpoint(tb, imageB)));
  assert.equal(
    writeMapSidecar(storage, tb.locator, { ...emptyMapSidecar(), notes: { "1": "B's room" } }),
    true,
  );

  booted = ga;
  observed.aSlotAfterBWrite = await slots.handleSaveSlotRequest("restore", { slot: 1 });
  observed.aAutosaveAfterBWrite = readGameProgress(storage, ta).autosave?.image ?? null;
  observed.aMapAfterBWrite = readMapSidecar(storage, ta.locator).notes;
  observed.rawCheckpointRevisionAfterBWrite = JSON.parse(
    storage.getItem(autosaveKey(ta.locator))!,
  ).game.identity.revision;
  assert.deepEqual(observed, {
    distinctLocators: true,
    bInitialSlot: "",
    bInitialAutosave: null,
    bInitialMapNotes: {},
    aSlotAfterBWrite: imageA,
    aAutosaveAfterBWrite: imageA,
    aMapAfterBWrite: mapA.notes,
    rawCheckpointRevisionAfterBWrite: revA,
  });
});

test("the same installed folder at a changed revision receives an independent history", async () => {
  const ta = installedProgressTarget({ folder: "revision-peer-history" }, revA)!;
  const tb = installedProgressTarget({ folder: "revision-peer-history" }, revB)!;
  const la = await readHistoryLifetime(ta.locator);
  const lb = await readHistoryLifetime(tb.locator);
  for (const [target, game, segment, lifetime] of [
    [ta, a, "s-peer-a.1", la],
    [tb, b, "s-peer-b.1", lb],
  ] as const) {
    const boot = stampBoot({
      files: Object.fromEntries(
        Object.entries(game.files).map(([name, bytes]) => [
          name,
          btoa(String.fromCharCode(...bytes)),
        ]),
      ),
      dictionary: game.words,
      authorRooms: false,
      rng: 7,
      soundDevice: 1,
      resourceSet: target.identity.revision,
      requestSerial: 0,
    });
    assert.equal(
      await appendHistoryBatch(
        target,
        { segment, batch: 1, seqStart: 0, seqEnd: 1, events: [], marks: [], sync: [], boot },
        "2.936",
        lifetime,
      ),
      true,
    );
  }
  const ha = await loadGameHistory(ta.locator);
  const hb = await loadGameHistory(tb.locator);
  assert.deepEqual(
    {
      aRevision: ha?.identity.revision,
      bRevision: hb?.identity.revision,
      aSegments: ha?.segments.map((s) => s.id),
      bSegments: hb?.segments.map((s) => s.id),
    },
    {
      aRevision: revA,
      bRevision: revB,
      aSegments: ["s-peer-a.1"],
      bSegments: ["s-peer-b.1"],
    },
  );
});

test("a qualified installed locator reads only a record of its own revision", () => {
  const ta = installedProgressTarget({ folder: "revision-peer-read" }, revA)!;
  const tb = installedProgressTarget({ folder: "revision-peer-read" }, revB)!;
  assert.notEqual(ta.locator, tb.locator);
  const imageA = btoa("checkpoint of build A");
  const imageB = btoa("checkpoint of build B");
  assert.ok(writeAutosave(storage, ta, checkpoint(ta, imageA)));
  // A string-addressed read at a qualified locator returns its own record.
  assert.equal(readGameProgress(storage, ta.locator).autosave?.image, imageA);
  // A record physically under B's address but stamped with A's revision is
  // foreign: the locator's revision wins over what a stray record claims.
  storage.setItem(autosaveKey(tb.locator), JSON.stringify(checkpoint(ta, imageA)));
  assert.equal(readGameProgress(storage, tb.locator).autosave, null);
  storage.setItem(autosaveKey(tb.locator), JSON.stringify(checkpoint(tb, imageB)));
  assert.equal(readGameProgress(storage, tb.locator).autosave?.image, imageB);
});

test("actual folder and ZIP imports allocate independent projects for changed bytes", async () => {
  const opening = {
    status: "ready" as const,
    message: "Checked",
    profile: "2.936",
    preview: "data:image/png;base64,iVBORw0KGgo=",
  };
  const first = await addLibraryGame(a, "Original", "folder", opening);
  const second = await addLibraryGame(b, "Changed", "zip", opening);
  assert.notEqual(first, second);
  const ta = await bindSavedProgressTarget(first);
  const tb = await bindSavedProgressTarget(second);
  assert.ok(ta);
  assert.ok(tb);
  assert.notEqual(ta.locator, tb.locator);
  assert.equal(ta.identity.revision, revA);
  assert.equal(tb.identity.revision, revB);
  // Deliberate editing of one owned saved body keeps its progress and body
  // epoch: saved progress belongs to ProjectId + captured epoch, and the
  // changed full revision rides inside the unchanged target identity.
  assert.equal(
    await saveAuthoredGame(first, {
      title: "Edited in place",
      files: b.files,
      words: b.words,
      imported: true,
    }),
    true,
  );
  const edited = await bindSavedProgressTarget(first);
  assert.ok(edited);
  assert.equal(edited.locator, ta.locator);
  assert.equal(edited.bodyEpoch, ta.bodyEpoch);
  assert.equal(edited.identity.revision, revB);
});
