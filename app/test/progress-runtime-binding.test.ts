import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readAutosave,
  clearAutosave,
  lastGameKey,
  useAutosaveController,
  type AutosaveControllerContext,
} from "../src/saves/useAutosaveController.ts";
import { autosaveKey, writeAutosave, type AutosaveRecord } from "../src/saves/gameProgress.ts";
import {
  installedProgressLocator,
  installedProgressTarget,
  parseProgressLocator,
  projectProgressTarget,
} from "../src/project/progressTarget.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
  updateAuthoredGameFilesAt,
} from "../src/project/gameStorage.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { createProgressPreview } from "../src/saves/progressPreview.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { openContainer } from "../../src/container/container.ts";
import { Engine } from "../../src/runtime/engine.ts";
import type { ResourceRevision } from "../../src/gameIdentity.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";

installIndexedDbFixture();

const HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

interface Rig {
  readonly files: Record<string, Uint8Array>;
  readonly words: Map<string, number>;
  readonly profileId: ProfileId;
  readonly revision: ResourceRevision;
}

/** A detached native Starter build plus the revision its bytes hash to. */
async function starterRig(): Promise<Rig> {
  const starter = createStarterProject("starter");
  const files = Object.fromEntries(starter.files());
  return {
    files,
    words: new Map(starter.sources.words),
    profileId: starter.profileId,
    revision: await gameRevision(files),
  };
}

/** A real Engine checkpoint image: the starter's first resumable room. */
function starterCheckpoint(rig: Rig, extraTicks = 0): Uint8Array {
  const engine = new Engine(
    openContainer(new Map(Object.entries(rig.files)), { profile: rig.profileId }),
    HOST,
    rig.words,
    { profile: rig.profileId },
  );
  for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
  for (let i = 0; i < extraTicks; i++) engine.tick();
  for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image, "the starter draws a resumable room");
  return image;
}

function installLocalStorageMock(t: { after: (fn: () => void) => void }): Map<string, string> {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        values.set(key, value);
      },
      removeItem(key: string): void {
        values.delete(key);
      },
      clear(): void {
        values.clear();
      },
    },
  });
  return values;
}

const STUB_CONFIG = { provider: "stub" as const, apiKey: "", model: "offline-stub" };

/** The folder digest a qualified installed locator carries. */
function folderDigestOf(locator: string): string {
  const parsed = parseProgressLocator(locator);
  if (parsed?.kind !== "installed") assert.fail("expected an installed locator");
  return parsed.folderDigest;
}

function savedProjectBody(files: Record<string, Uint8Array>) {
  return {
    title: "Runtime binding",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [] as [string, number][],
  };
}

function controllerContext(
  game: () => BootedGame | null,
  over: Partial<AutosaveControllerContext> = {},
): AutosaveControllerContext {
  return {
    state: { resumed: false },
    getBootedGame: game,
    getWorker: () => null,
    logAgent: () => {},
    isInstalledGame: () => false,
    bootGame: async () => {},
    bootAuthoredGame: async () => {},
    configForGame: (_p, config) => config,
    retireFailedRecovery: () => {},
    ...over,
  };
}

test("a target-only boot writes nothing after its body was deleted and recreated", async (t) => {
  const id = testProjectId("target-only-recreated");
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const files = { "WORDS.TOK": Uint8Array.of(1, 2) };
  assert.equal(await saveAuthoredGame(id, savedProjectBody(files)), true);
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  // A boot that carried only its bound target — no historyLifetime field —
  // still answers to the body's live epoch through the binding.
  const game: BootedGame = {
    installed: false,
    projectId: id,
    title: "Runtime binding",
    revision,
    files,
    words: [],
    progressTarget: projectProgressTarget(id, revision, epoch)!,
  };
  let removed = 0;
  const controller = useAutosaveController(
    controllerContext(() => game, { onRemoved: () => removed++ }),
  );
  // Recreated under the same id and bytes in another tab: a fresh epoch owns
  // the body, and this incarnation's writes belong to the removed one.
  await clearCachedGame(id);
  assert.equal(await saveAuthoredGame(id, savedProjectBody(files)), true);
  const recreatedEpoch = await readHistoryLifetime(id);
  assert.notEqual(recreatedEpoch, epoch);

  controller.handleAutosave({ image: "late", cycle: 5, room: 1 });
  assert.equal(
    await controller.getAutosaveWrite(),
    false,
    "the stale incarnation writes no record",
  );
  assert.equal(game.removed, true);
  assert.equal(removed, 1);
  assert.equal(readAutosave(`project:${id}:${epoch}`), null, "the old address stays empty");
  assert.equal(
    readAutosave(`project:${id}:${recreatedEpoch}`),
    null,
    "the new body keeps nothing of it",
  );
  assert.equal(lastGameKey(), null, "the resume pointer never moved to a dead address");
  assert.deepEqual(
    (await loadAuthoredGame(id))!.files["WORDS.TOK"],
    files["WORDS.TOK"],
    "the recreated body is untouched",
  );

  // The msg.files write rides the same captured epoch: the conditional
  // expectation the controller passes is the bound target's.
  controller.handleAutosave({
    image: "late-files",
    cycle: 6,
    room: 1,
    files: { "WORDS.TOK": Uint8Array.of(9, 9), OBJECT: Uint8Array.of(3) },
  });
  assert.equal(
    await controller.getAutosaveWrite(),
    false,
    "msg.files for the old epoch is refused",
  );
  assert.deepEqual(
    Object.keys((await loadAuthoredGame(id))!.files),
    Object.keys(files),
    "the stored body kept the recreated bytes",
  );
  // The conditional write the controller issues answers to the epoch:
  // storage itself refuses a writer holding the removed one.
  const direct = await updateAuthoredGameFilesAt(
    id,
    { "WORDS.TOK": Uint8Array.of(9, 9), OBJECT: Uint8Array.of(3) },
    {
      revision,
      current: await gameRevision({ "WORDS.TOK": Uint8Array.of(9, 9), OBJECT: Uint8Array.of(3) }),
      lifetime: epoch,
    },
  );
  assert.equal(direct, "stale", "the captured epoch is the conditional expectation");
});

test("two installed folders sharing one hash keep their checkpoint pictures independent", async (t) => {
  installLocalStorageMock(t);
  const sharedHash = "a".repeat(64);
  const revision = testRevision("shared-rev");
  const folderA = "games/kq1";
  const folderB = "games/kq1 second edition";
  const locatorA = installedProgressLocator(folderA, revision)!;
  const locatorB = installedProgressLocator(folderB, revision)!;
  assert.notEqual(locatorA, locatorB);
  const gameA: BootedGame = {
    installed: true,
    title: "KQ1 A",
    revision,
    files: { "WORDS.TOK": Uint8Array.of(1) },
    words: [],
    folder: folderA,
    hash: sharedHash,
    alias: "kq1",
  };
  const gameB: BootedGame = { ...gameA, title: "KQ1 B", folder: folderB };
  // A released record squats under the shared hash spelling with a picture.
  const sharedRecord: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: "shared-image",
    preview: createProgressPreview({
      visual: new Uint8Array(160 * 168).fill(9),
      text: new Uint8Array(2000),
      picRow: 1,
    }),
    cycle: 8,
    room: 4,
    savedAt: 1,
    game: {
      installed: true,
      identity: { project: testProjectId(sharedHash), revision },
    },
  };
  localStorage.setItem(autosaveKey(sharedHash), JSON.stringify(sharedRecord));

  const controllerA = useAutosaveController(controllerContext(() => gameA));
  const controllerB = useAutosaveController(controllerContext(() => gameB));
  // Black frames: neither worker sends a picture with its snapshot.
  controllerA.handleAutosave({ image: "a-1", cycle: 1, room: 1 });
  assert.equal(await controllerA.getAutosaveWrite(), true);
  controllerB.handleAutosave({ image: "b-1", cycle: 1, room: 1 });
  assert.equal(await controllerB.getAutosaveWrite(), true);
  assert.equal(
    readAutosave(locatorA)?.preview,
    undefined,
    "the shared-hash legacy picture is not A's",
  );
  assert.equal(
    readAutosave(locatorB)?.preview,
    undefined,
    "the shared-hash legacy picture is not B's",
  );
  assert.equal(
    readAutosave(sharedHash)?.preview,
    sharedRecord.preview,
    "the legacy record is untouched",
  );
  // The bound targets keep the released embedded identity — never a locator.
  assert.equal(
    readAutosave(locatorA)?.game.identity.project,
    `installed-${folderDigestOf(locatorA)}`,
  );
  assert.equal(
    readAutosave(locatorB)?.game.identity.project,
    `installed-${folderDigestOf(locatorB)}`,
  );

  // Positive retention: A's next real picture is kept by A's own record on
  // the following black frame; B never sees it.
  const previewA = createProgressPreview({
    visual: new Uint8Array(160 * 168).fill(3),
    text: new Uint8Array(2000),
    picRow: 1,
  });
  controllerA.handleAutosave({ image: "a-2", preview: previewA, cycle: 2, room: 2 });
  assert.equal(await controllerA.getAutosaveWrite(), true);
  controllerA.handleAutosave({ image: "a-3", cycle: 3, room: 3 });
  assert.equal(await controllerA.getAutosaveWrite(), true);
  assert.equal(readAutosave(locatorA)?.preview, previewA, "A keeps its own last picture");
  assert.equal(readAutosave(locatorB)?.preview, undefined, "B stays independent");
});

test("an old tab's lastGame write never moves the resume pointer", async (t) => {
  installLocalStorageMock(t);
  const game: BootedGame = {
    installed: true,
    title: "KQ1",
    revision: testRevision("pointer-rev"),
    files: { "WORDS.TOK": Uint8Array.of(1) },
    words: [],
    folder: "games/kq1",
    hash: "b".repeat(64),
    alias: "kq1",
  };
  const locator = installedProgressLocator("games/kq1", game.revision)!;
  const controller = useAutosaveController(controllerContext(() => game));
  controller.handleAutosave({ image: "img", cycle: 1, room: 1 });
  assert.equal(await controller.getAutosaveWrite(), true);
  assert.equal(lastGameKey(), locator);

  // An older release writes the released key for another game: the physical
  // pointer still wins.
  localStorage.setItem("monotio_agi.lastGame", "old-tab-pick");
  assert.equal(lastGameKey(), locator);
  assert.equal(localStorage.getItem("monotio_agi.lastGame"), "old-tab-pick");

  // Once the physical pointer is cleared by its own checkpoint's removal,
  // the released value reads as legacy context again.
  await clearAutosave(locator);
  assert.equal(lastGameKey(), "old-tab-pick");

  // A stored physical pointer that names a folder nothing serves refuses;
  // it does not fall back to the legacy value.
  localStorage.setItem(
    "monotio_agi.resumeTarget",
    installedProgressLocator("games/no-such-edition", game.revision)!,
  );
  const resumed = await controller.resumeLastGame(STUB_CONFIG);
  assert.equal(resumed, false, "an unresolved physical pointer boots nothing");
});

test("a supplied unresolved installed locator never falls through to the record's alias", async (t) => {
  installLocalStorageMock(t);
  const rig = await starterRig();
  const checkpointImage = bytesToBase64(starterCheckpoint(rig));
  const sharedHash = "c".repeat(64);
  const descriptor = {
    hash: sharedHash,
    alias: "kq1",
    title: "King's Quest I",
    folder: "games/kq1",
  };
  const target = installedProgressTarget({ folder: "games/kq1" }, rig.revision)!;
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: checkpointImage,
    cycle: 3,
    room: 1,
    savedAt: 1,
    game: { installed: true, identity: target.identity },
  };
  let booted: string | null = null;
  let running: BootedGame | null = null;
  // The resume's success is the armed candidate's own restored:true.
  let armed!: () => void;
  const armedGate = new Promise<void>((resolve) => (armed = resolve));
  const controller = useAutosaveController(
    controllerContext(() => running, {
      state: { resumed: false, installedGames: [descriptor] },
      isInstalledGame: (target) => target === "kq1",
      bootGame: async (folder, carrier) => {
        booted = folder;
        // The production order: the resume gate answers first, then the
        // landed candidate admits the armed intent and only an un-aborted
        // admission installs into the slot.
        if (!controller.beginResumeBoot(carrier)) return;
        const next: BootedGame = {
          installed: true,
          title: "King's Quest I",
          revision: rig.revision,
          files: rig.files,
          words: [],
          folder,
          hash: sharedHash,
          alias: "kq1",
        };
        const admission = await controller.takeResumeState(
          { game: next, files: rig.files, profile: rig.profileId },
          carrier,
        );
        if (admission.status !== "aborted") running = next;
        armed();
      },
    }),
  );
  // The locator names a folder nothing serves; the embedded project's alias
  // would resolve one — an explicit physical address never follows it.
  const missing = installedProgressLocator("games/kq1-other-edition", rig.revision)!;
  assert.equal(
    await controller.resumeFromRecord(record, STUB_CONFIG, missing),
    false,
    "an unresolved physical installed locator refuses",
  );
  assert.equal(booted, null, "no convenience-resolution boot ran");

  // The same record read through the pointer with a resolvable locator boots
  // that locator's exact folder.
  const resolved = installedProgressLocator("games/kq1", rig.revision)!;
  localStorage.setItem(autosaveKey(resolved), JSON.stringify(record));
  localStorage.setItem("monotio_agi.resumeTarget", resolved);
  const resuming = controller.resumeLastGame(STUB_CONFIG);
  await armedGate;
  controller.handleRestored({ ok: true, room: 1, egoX: 0, egoY: 0 });
  assert.equal(await resuming, true);
  assert.equal(booted, "games/kq1", "the pointer's own folder boots, nothing else");
});

test("a project pointer's old epoch cannot resume a deleted-and-recreated body", async (t) => {
  const id = testProjectId("stale-epoch-resume");
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const rig = await starterRig();
  const files = rig.files;
  assert.equal(await saveAuthoredGame(id, savedProjectBody(files)), true);
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  const target = projectProgressTarget(id, revision, epoch)!;
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    // A perfectly valid checkpoint of those bytes: the refusal is the dead
    // epoch's alone, never a decoding shortcut.
    image: bytesToBase64(starterCheckpoint(rig)),
    cycle: 7,
    room: 2,
    savedAt: 1,
    game: { installed: false, identity: target.identity },
  };
  assert.notEqual(writeAutosave(localStorage, target, record), null);
  const storedBytes = localStorage.getItem(autosaveKey(target.locator));
  const locator = target.locator;

  // Deleted and recreated under the same id and bytes: a new epoch owns it.
  await clearCachedGame(id);
  assert.equal(await saveAuthoredGame(id, savedProjectBody(files)), true);
  assert.notEqual(await readHistoryLifetime(id), epoch);

  let bootedProjectId: string | null = null;
  const controller = useAutosaveController(
    controllerContext(() => null, {
      bootAuthoredGame: async (_p, _c, options) => {
        bootedProjectId = options?.projectId ?? null;
      },
    }),
  );
  assert.equal(
    await controller.resumeFromRecord(record, STUB_CONFIG, locator),
    false,
    "the old epoch's address names the removed incarnation",
  );
  assert.equal(bootedProjectId, null, "no boot ran for the removed body");

  // resumeLastGame reads the stored record, sees the dead epoch and refuses
  // the leftover — it keeps the record byte-exact and never boots the
  // recreated body into it.
  localStorage.setItem("monotio_agi.resumeTarget", locator);
  assert.equal(await controller.resumeLastGame(STUB_CONFIG), false);
  assert.equal(
    localStorage.getItem(autosaveKey(locator)),
    storedBytes,
    "the stale checkpoint's bytes are kept exactly, never erased or adopted",
  );
  assert.deepEqual(readAutosave(locator), record, "the stored record is untouched");
  assert.equal(lastGameKey(), locator, "the pointer still names the checkpoint it selected");
  assert.equal(bootedProjectId, null);
});

test("a newer resume's pending intent is never consumed or cleared by an older boot", async (t) => {
  installLocalStorageMock(t);
  const rig = await starterRig();
  const revision = rig.revision;
  const firstImage = bytesToBase64(starterCheckpoint(rig));
  const secondImage = bytesToBase64(starterCheckpoint(rig, 4));
  assert.notEqual(secondImage, firstImage, "the two checkpoints are distinct real images");
  const descriptors = [
    {
      folder: "games/kq1",
      hash: "a".repeat(64),
      alias: "kq1",
      title: "KQ1",
      revision,
      profile: rig.profileId,
    },
    {
      folder: "games/sq1",
      hash: "b".repeat(64),
      alias: "sq1",
      title: "SQ1",
      revision,
      profile: rig.profileId,
    },
  ];
  const recordFor = (project: string, image: string): AutosaveRecord => ({
    format: "monotio.agi.autosave",
    version: 1,
    image,
    cycle: 1,
    room: 1,
    savedAt: 1,
    game: { installed: true, identity: { project: testProjectId(project), revision } },
  });
  const gates: (() => void)[] = [];
  const restores: string[] = [];
  // A boot's resume admission resolved — the point a worker answer may land.
  const armedResolvers: (() => void)[] = [];
  let running: BootedGame | null = null;
  const controller = useAutosaveController(
    controllerContext(() => running, {
      state: { resumed: false, installedGames: descriptors },
      isInstalledGame: (target) => descriptors.some((d) => d.alias === target),
      bootGame: async (folder, carrier) => {
        // The real boot's order: the resume gate answers first, the boot
        // parks until released, then its landed candidate admits the armed
        // intent — only an un-aborted admission installs into the slot.
        if (!controller.beginResumeBoot(carrier)) return;
        await new Promise<void>((resolve) => gates.push(resolve));
        const next: BootedGame = {
          installed: true,
          title: folder,
          revision,
          files: rig.files,
          words: [],
          folder,
          hash: folder,
        };
        const admission = await controller.takeResumeState(
          { game: next, files: rig.files, profile: rig.profileId },
          carrier,
        );
        restores.push(admission.status === "restore" ? admission.restoreImage : "");
        if (admission.status !== "aborted") running = next;
        armedResolvers.shift()?.();
      },
    }),
  );
  const first = controller.resumeFromRecord(recordFor("kq1", firstImage), STUB_CONFIG);
  const second = controller.resumeFromRecord(recordFor("sq1", secondImage), STUB_CONFIG);
  // The older boot finishes while the newer still holds its intent: its
  // admission answers superseded — it cannot take or clear what is not its
  // own, and it never installs.
  gates.shift()!();
  await new Promise<void>((resolve) => armedResolvers.push(resolve));
  assert.equal(await first, false, "the superseded resume reports no restore");
  gates.shift()!();
  // The newer intent's own boot admitted it; its worker answers restored.
  await new Promise<void>((resolve) => armedResolvers.push(resolve));
  controller.handleRestored({ ok: true, room: 1, egoX: 0, egoY: 0 });
  assert.equal(await second, true);
  assert.deepEqual(
    restores,
    ["", secondImage],
    "the newer resume's record reached only its own game's boot",
  );
});

test("a resume validated before the boot is checked again against the bound target", async (t) => {
  const id = testProjectId("resume-toctou");
  t.after(() => clearCachedGame(id));
  installLocalStorageMock(t);
  const rig = await starterRig();
  const files = rig.files;
  assert.equal(await saveAuthoredGame(id, savedProjectBody(files)), true);
  const epoch = await readHistoryLifetime(id);
  const revision = await gameRevision(files);
  const target = projectProgressTarget(id, revision, epoch)!;
  const record: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: bytesToBase64(starterCheckpoint(rig)),
    cycle: 9,
    room: 3,
    savedAt: 1,
    game: { installed: false, identity: target.identity },
  };
  assert.notEqual(writeAutosave(localStorage, target, record), null);
  const storedBytes = localStorage.getItem(autosaveKey(target.locator));

  let restoredImage = "unset";
  let bootedProjectId: string | null = null;
  let running: BootedGame | null = null;
  const controller = useAutosaveController(
    controllerContext(() => running, {
      bootAuthoredGame: async (_p, _c, options) => {
        const { resumeCarrier, ...rest } = options ?? {};
        assert.deepEqual(rest, { projectId: id, useCached: true });
        bootedProjectId = options?.projectId ?? null;
        if (!controller.beginResumeBoot(resumeCarrier)) return;
        // The body was recreated between the resume's validation and this
        // boot's load: storage now answers with a different epoch, and the
        // boot binds that epoch — the pending record belongs to the removed
        // incarnation and must not ride in.
        await clearCachedGame(id);
        assert.equal(await saveAuthoredGame(id, savedProjectBody(files)), true);
        const recreated = await readHistoryLifetime(id);
        const next: BootedGame = {
          installed: false,
          projectId: id,
          title: "Runtime binding",
          revision,
          files,
          words: [],
          historyLifetime: recreated,
        };
        const admission = await controller.takeResumeState(
          { game: next, files, profile: rig.profileId },
          resumeCarrier,
        );
        restoredImage = admission.status === "restore" ? admission.restoreImage : "";
        if (admission.status !== "aborted") running = next;
      },
    }),
  );
  // The record was written under the old epoch's address, which is still
  // live when the resume validates it — but the boot binds the recreated
  // body, so the intent aborts before a byte of it can restore.
  assert.equal(
    await controller.resumeFromRecord(record, STUB_CONFIG, target.locator),
    false,
    "the dead incarnation's resume refuses",
  );
  assert.equal(bootedProjectId, id, "the boot itself ran");
  assert.equal(restoredImage, "", "the dead incarnation's checkpoint is dropped, not restored");
  assert.equal(running, null, "an aborted admission installs no candidate");
  assert.equal(
    localStorage.getItem(autosaveKey(target.locator)),
    storedBytes,
    "the old epoch's checkpoint bytes are kept exactly",
  );
});
