import test from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import {
  PROFILE_GROUPS,
  createProfileChoiceController,
  describeGameProfile,
  formatProfileResolution,
  type ProfileChoiceControllerDeps,
} from "../src/profileChoice.ts";
import { addLibraryGame, copyLibraryGame } from "../src/gameLibrary.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  clearCachedGame,
  setLibraryGameProfile,
  type CachedGameMeta,
} from "../src/gameStorage.ts";
import { normalizeLibraryMetadata } from "../src/gameMetadata.ts";
import { inspectGame } from "../src/gameInspection.ts";
import { testRevision } from "./identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES, type ProfileDetectionKind } from "../../src/runtime/profile.ts";
import type { OpenedGame } from "../src/gameZip.ts";
import type { ProjectId } from "../src/gameTypes.ts";

installIndexedDbFixture();

function installLocalStorage(t: { after(callback: () => void): void }): void {
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
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
      removeItem(key: string): void {
        values.delete(key);
        Reflect.deleteProperty(this, key);
      },
    },
  });
}

const PREVIEW =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** An unidentified edition: the opening check fell back to the container default. */
async function importUnidentified(
  seed: number,
  kind: ProfileDetectionKind = "default",
): Promise<CachedGameMeta> {
  const game: OpenedGame = {
    files: { LOGDIR: new Uint8Array([seed, 0, 0]), "WORDS.TOK": new Uint8Array(52) },
    words: [],
  };
  const id = await addLibraryGame(game, `Unidentified ${seed}`, "zip", {
    preview: PREVIEW,
    status: "ready",
    message: "Opening checked",
    profile: "2.936",
    kind,
  });
  const meta = getCachedGameMeta(id);
  assert.ok(meta);
  return meta;
}

function controller(running?: ProjectId) {
  const calls = { flushed: 0, refreshed: 0, played: [] as ProjectId[], errors: [] as string[] };
  const deps: ProfileChoiceControllerDeps = {
    runningProjectId: () => running,
    flushAutosave: async () => {
      calls.flushed++;
      return true;
    },
    refreshLibrary: () => {
      calls.refreshed++;
    },
    onPlayLibraryGame: async (game) => {
      calls.played.push(game.projectId);
    },
    reportError: (message) => calls.errors.push(message),
  };
  return { ...createProfileChoiceController(deps), calls };
}

test("formatProfileResolution names the profile, its source and an unpromoted build", () => {
  assert.equal(formatProfileResolution("2.936", "default"), "2.936 (container default)");
  assert.equal(formatProfileResolution("2.411", "override"), "2.411 (your override)");
  assert.equal(
    formatProfileResolution("2.001", "binary", "2.001"),
    "2.001 (identified from interpreter files)",
  );
  assert.equal(
    formatProfileResolution("2.440", "catalog"),
    "2.440 (identified from the game catalog)",
  );
  assert.equal(
    formatProfileResolution("2.936", "binary", "2.903"),
    "2.936 (build 2.903, no dedicated profile; identified from interpreter files)",
  );
});

test("the picker groups every profile once under its platform", () => {
  assert.deepEqual(
    PROFILE_GROUPS.map((group) => group.label),
    ["PC v2", "PC v3", "Amiga", "Apple IIgs"],
  );
  const ids = PROFILE_GROUPS.flatMap((group) => group.options.map((option) => option.id));
  assert.deepEqual([...ids].sort(), Object.keys(PROFILES).sort());
  const group = (id: string) =>
    PROFILE_GROUPS.find((g) => g.options.some((option) => option.id === id))?.label;
  assert.equal(group("2.936"), "PC v2");
  assert.equal(group("3.002.149"), "PC v3");
  assert.equal(group("amiga-2.333"), "Amiga");
  assert.equal(group("iigs-1.014"), "Apple IIgs");
});

test("stored library metadata keeps only known profile ids", () => {
  const revision = testRevision("normalize");
  const read = (profile: unknown) =>
    normalizeLibraryMetadata({ version: 1, revision, profile }, { revision, source: "zip" })
      .profile;
  assert.equal(read("2.411"), "2.411");
  assert.equal(read("9.999"), undefined);
  assert.equal(read("toString"), undefined);
  assert.equal(read(2411), undefined);
});

test("setLibraryGameProfile persists and clears the override under the write lock", async (t) => {
  installLocalStorage(t);
  const game = await importUnidentified(1);
  assert.equal(await setLibraryGameProfile(game.projectId, "2.411"), true);
  assert.equal((await loadAuthoredGame(game.projectId))?.library?.profile, "2.411");
  assert.equal(await setLibraryGameProfile(game.projectId, undefined), true);
  assert.equal((await loadAuthoredGame(game.projectId))?.library?.profile, undefined);
  // A stale generation or an unknown id is refused and leaves the entry alone.
  assert.equal(await setLibraryGameProfile(game.projectId, "2.411", -1), false);
  assert.equal(await setLibraryGameProfile(game.projectId, "9.999" as never), false);
  assert.equal((await loadAuthoredGame(game.projectId))?.library?.profile, undefined);
});

test("only an unidentified import with no stored choice offers the picker", async (t) => {
  installLocalStorage(t);
  const plain = await importUnidentified(2);
  const identified = await importUnidentified(3, "binary");
  const chosen = await importUnidentified(4);
  assert.equal(await setLibraryGameProfile(chosen.projectId, "2.411"), true);

  const c = controller();
  // Read through a call so each check sees the live state, not a narrowed one.
  const open = () => c.profileChoiceState.value;
  assert.equal(c.offerImportProfileChoice(identified, false), false);
  assert.equal(c.offerImportProfileChoice(getCachedGameMeta(chosen.projectId)!, false), false);
  assert.equal(c.offerImportProfileChoice(plain, true), false, "a game made in the app");
  assert.equal(c.offerImportProfileChoice({ ...plain, roomGeneration: true }, false), false);
  assert.equal(open(), undefined);

  assert.equal(c.offerImportProfileChoice(plain, false), true);
  assert.equal(open()?.projectId, plain.projectId);
  assert.equal(open()?.detected, "2.936");

  // A second unidentified import waits its turn instead of replacing the first.
  const second = await importUnidentified(5);
  assert.equal(c.offerImportProfileChoice(second, false), true);
  assert.equal(open()?.projectId, plain.projectId);
  c.closeProfileChoice();
  assert.equal(open()?.projectId, second.projectId);
  c.closeProfileChoice();
  assert.equal(open(), undefined);
});

test("keeping or saving the detected profile at import stores no override", async (t) => {
  installLocalStorage(t);
  const game = await importUnidentified(6);
  const c = controller();
  c.offerImportProfileChoice(game, false);
  await c.applyProfileChoice("2.936");
  assert.equal(c.profileChoiceState.value, undefined);
  assert.equal((await loadAuthoredGame(game.projectId))?.library?.profile, undefined);

  c.offerImportProfileChoice(game, false);
  await c.applyProfileChoice("2.411");
  assert.equal((await loadAuthoredGame(game.projectId))?.library?.profile, "2.411");
  assert.deepEqual(c.calls.errors, []);
});

test("library Automatic clears an override and stores nothing otherwise", async (t) => {
  installLocalStorage(t);
  const game = await importUnidentified(7);
  const c = controller();
  c.openLibraryProfileChoice(game);
  assert.equal(c.profileChoiceState.value?.override, undefined);
  await c.applyProfileChoice(undefined);
  assert.equal((await loadAuthoredGame(game.projectId))?.library?.profile, undefined);
  assert.equal(c.calls.refreshed, 0, "nothing changed, nothing written");

  c.openLibraryProfileChoice(game);
  await c.applyProfileChoice("2.440");
  const overridden = getCachedGameMeta(game.projectId)!;
  assert.equal(overridden.library?.profile, "2.440");
  assert.equal(describeGameProfile(overridden), "2.440 (your override)");

  c.openLibraryProfileChoice(overridden);
  assert.equal(c.profileChoiceState.value?.override, "2.440");
  await c.applyProfileChoice(undefined);
  const automatic = getCachedGameMeta(game.projectId)!;
  assert.equal(automatic.library?.profile, undefined);
  assert.equal(describeGameProfile(automatic), "2.936 (container default)");
});

test("changing a copy's profile reboots only the running project itself", async (t) => {
  installLocalStorage(t);
  const original = await importUnidentified(8);
  const copyId = await copyLibraryGame(original.projectId);
  const copy = getCachedGameMeta(copyId)!;
  assert.equal(copy.library?.revision, original.library?.revision, "copies share a revision");

  const whileOriginalRuns = controller(original.projectId);
  whileOriginalRuns.openLibraryProfileChoice(copy);
  await whileOriginalRuns.applyProfileChoice("2.411");
  assert.deepEqual(whileOriginalRuns.calls.played, [], "the running original keeps playing");
  assert.equal(whileOriginalRuns.calls.flushed, 0);

  const whileCopyRuns = controller(copyId);
  whileCopyRuns.openLibraryProfileChoice(getCachedGameMeta(copyId)!);
  await whileCopyRuns.applyProfileChoice("2.440");
  assert.equal(whileCopyRuns.calls.flushed, 1);
  assert.deepEqual(whileCopyRuns.calls.played, [copyId]);
});

test("a profile write the storage refuses is reported, not dropped", async (t) => {
  installLocalStorage(t);
  const game = await importUnidentified(9);
  const c = controller();
  c.openLibraryProfileChoice(game);
  await clearCachedGame(game.projectId);
  await c.applyProfileChoice("2.411");
  assert.equal(c.calls.errors.length, 1);
  assert.match(c.calls.errors[0]!, /interpreter profile/);
});

test("the opening check runs under a requested override and reports the detection", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("accept.input(); return;", { dictionary: new Map() }).payload,
  );
  const files = Object.fromEntries(container.files);
  assert.throws(() => inspectGame({ files, words: [], profile: "9.999" as never }));
  const opening = inspectGame({ files, words: [], profile: "2.411" });
  assert.equal(opening.profile, "2.936", "the detected profile stays the automatic default");
  assert.equal(opening.kind, "default");
});
