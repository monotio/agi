import { drainProjectNotices } from "./projectNotices.ts";
/**
 * Two tabs on one project, each with a warm session. Tab A keeps an edit
 * that leaves the bytes alone — a label, a lock, a binding — so the
 * resource revision stays where both tabs booted it. Tab B's stale session
 * must never write its older authoring content over A's: B's authoring
 * saves refuse and offer a reload, while its conversation still saves
 * beside A's edit. A's own writes never conflict with themselves.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import { gameContainer } from "./worker-ctx.ts";
import {
  STALE_SAVE_MESSAGE,
  useAuthoringController,
  type PowerUpUiState,
} from "../src/authoring/useAuthoringController.ts";
import {
  openDraft,
  ResourceCommitError,
  watchProjectWrites,
} from "../src/project/projectTransaction.ts";
import { PROJECT_CHANNEL, type NoticeChannel } from "../src/project/projectBroadcast.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  authoringFingerprint,
  clearCachedGame,
  loadAuthoredGame,
  readHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import type { BootedGame, ProjectId } from "../src/project/gameTypes.ts";
import type { AwaitPatchedFn } from "../src/engine/workerQueries.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";
import { openContainer } from "../../src/container/container.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

installIndexedDbFixture();

const localValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => void localValues.set(key, value),
    removeItem: (key: string) => void localValues.delete(key),
    clear: () => localValues.clear(),
  },
});

const STUB: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };
const ackPatch: AwaitPatchedFn = async (resources) => ({ resources, patchGen: 1 });

/** Room 1's picture: one labelled sky. The label and the lock are annotations only. */
const sky = (label: string, locked = false) =>
  [
    `# @item sky "${label}" art${locked ? " locked" : ""}`,
    "vis 4",
    "fill 80,80",
    "# @end",
    "end",
  ].join("\n");
const ROOM_LOGIC = "if (isset(f5)) { load.pic(v50); draw.pic(v50); show.pic(); } return;";
const PICTURE = compilePictureSource(sky("Sky"), { profile: DEFAULT_V2_PROFILE }).bytes;

function projectFiles(): Record<string, Uint8Array> {
  return Object.fromEntries(
    gameContainer(["if (equaln(v0,0)) { new.room(1); } call.v(v0); return;", ROOM_LOGIC], (c) =>
      c.putResource("picture", 1, PICTURE),
    ).files,
  );
}

async function storeProject(t: TestContext, name: string) {
  const projectId = testProjectId(name);
  const files = projectFiles();
  await saveAuthoredGame(projectId, {
    title: "Two tabs",
    provider: "stub",
    model: "offline-stub",
    files,
    words: [],
    authoringState: {
      authoring: { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } },
      sources: { logics: [[1, ROOM_LOGIC]], pictures: [[1, sky("Sky")]] },
    },
  });
  t.after(() => clearCachedGame(projectId));
  return { projectId, files, revision: await gameRevision(files) };
}

function powerUp(): PowerUpUiState {
  return {
    mode: "remix",
    messages: [],
    open: false,
    needsConfig: false,
    busy: false,
    feedStart: 0,
    reply: "",
    room: 1,
    error: "",
  };
}

/**
 * One tab: the project booted from its stored record and, when `warm`, a
 * session hydrated from it, the assistant closed again.
 */
async function openTab(projectId: ProjectId, files: Record<string, Uint8Array>, warm = true) {
  const game: BootedGame = {
    installed: false,
    projectId,
    title: "Two tabs",
    revision: await gameRevision(files),
    files,
    words: [],
    historyLifetime: await readHistoryLifetime(projectId),
    authoredGame: (await loadAuthoredGame(projectId))!,
  };
  const ui = {
    phase: "running" as const,
    powerUp: powerUp(),
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  const worker = { postMessage() {} } as unknown as Worker;
  const controller = useAuthoringController({
    state: ui,
    getWorker: () => worker,
    query: async <T>(type: string) =>
      (type === "exportFiles"
        ? files
        : type === "state"
          ? { room: 1, profile: "2.936" }
          : null) as T,
    awaitPatched: ackPatch,
    logAgent: () => {},
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => true,
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
  });
  if (warm) {
    await controller.openPowerUp(STUB);
    controller.closePowerUp();
    assert.ok(controller.getSession(), "the tab's session is warm");
  }
  return { game, ui, controller };
}

type Tab = Awaited<ReturnType<typeof openTab>>;

/** What each authoring-only edit keeps, and how to find it in the stored record. */
const EDITS = {
  label: {
    keep: (tab: Tab, revision: BootedGame["revision"]) =>
      tab.controller.commitPictureEdit({
        pictureNumber: 1,
        bytes: PICTURE,
        source: sky("Evening sky"),
        baseRevision: revision,
      }),
    kept: (authoringState: Record<string, unknown>) =>
      pictureSource(authoringState) === sky("Evening sky"),
  },
  lock: {
    keep: (tab: Tab, revision: BootedGame["revision"]) =>
      tab.controller.commitPictureEdit({
        pictureNumber: 1,
        bytes: PICTURE,
        source: sky("Sky", true),
        baseRevision: revision,
      }),
    kept: (authoringState: Record<string, unknown>) =>
      pictureSource(authoringState) === sky("Sky", true),
  },
  binding: {
    keep: (tab: Tab, revision: BootedGame["revision"]) =>
      tab.controller.commitRoomEdit({
        room: 1,
        logic: {
          bytes: openContainer(new Map(Object.entries(tab.game.files))).getResource("logic", 1)!,
          source: ROOM_LOGIC,
          newBindings: { door_open: { kind: "flag", num: 50 } },
        },
        baseRevision: revision,
      }),
    kept: (authoringState: Record<string, unknown>) =>
      JSON.stringify(
        (authoringState["authoring"] as { bindings: Record<string, unknown> }).bindings[
          "door_open"
        ],
      ) === JSON.stringify({ kind: "flag", num: 50 }),
  },
} as const;

function pictureSource(authoringState: Record<string, unknown>): string | undefined {
  const sources = authoringState["sources"] as { pictures: [number, string][] };
  return sources.pictures.find(([num]) => num === 1)?.[1];
}

test("the authoring fingerprint names the editable content only, keys in code-point order", () => {
  // SHA-256 of `{"a":"x","b":[1,2],"é":null}`: chat and undefined fields
  // left out, byte arrays as numbers, "é" (U+00E9) after the ASCII keys.
  assert.equal(
    authoringFingerprint({
      é: null,
      chat: [{ role: "user", text: "hello" }],
      b: Uint8Array.of(1, 2),
      skipped: undefined,
      a: "x",
    }),
    "5af1742e35cb2a01d178b599a651802adec8a283a973aaf75f6dc7ce7fae22d6",
  );
  // No authoring state and one holding only chat are the same empty content: `{}`.
  const empty = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
  assert.equal(authoringFingerprint(undefined), empty);
  assert.equal(authoringFingerprint({ chat: [] }), empty);
});

const staleSave = (error: unknown) =>
  error instanceof ResourceCommitError &&
  error.code === "stale" &&
  error.behindStorage &&
  error.message === STALE_SAVE_MESSAGE;

for (const [kind, edit] of Object.entries(EDITS)) {
  test(`another tab's stale session never writes over a kept ${kind}`, async (t) => {
    const { projectId, files, revision } = await storeProject(t, `two-tab-${kind}`);
    const a = await openTab(projectId, files);
    const b = await openTab(projectId, files);
    // Without BroadcastChannel B hears nothing; storage alone must refuse.
    let told = 0;
    const stop = watchProjectWrites(
      { getBootedGame: () => b.game, onBehindStorage: () => told++, onRemoved: () => {} },
      null,
    );
    t.after(stop);

    const kept = await edit.keep(a, revision);
    assert.equal(kept.status, "committed");
    assert.equal(kept.revision, revision, "the bytes and their revision stay as booted");
    // A's own writes build on its edit and never conflict with it.
    assert.equal(await a.controller.persistSessionState(), true);
    assert.ok(edit.kept((await loadAuthoredGame(projectId))!.authoringState!));

    // B's session still holds the authoring content both tabs booted on.
    await assert.rejects(b.controller.persistSessionState(), staleSave);
    await b.controller.updateAiConfig({ ...STUB, model: "another-stub" });
    assert.equal(b.ui.powerUp.error, "", "a settings change writes no authoring content");
    b.ui.powerUp.mode = "ask";
    await b.controller.openPowerUp(STUB);
    await b.controller.submitPowerUp("What is this room?");
    assert.equal(b.ui.powerUp.error, "", "an Ask writes only its conversation");

    const stored = (await loadAuthoredGame(projectId))!;
    assert.ok(edit.kept(stored.authoringState!), `A's ${kind} survives B's saves`);
    assert.equal(stored.model, "another-stub", "B's settings were saved");
    assert.deepEqual(
      (stored.authoringState!["chat"] as { role: string }[]).map(({ role }) => role),
      ["user", "assistant"],
      "B's Ask was saved beside A's edit",
    );
    assert.equal(told, 0);

    // A keeps editing on its own base.
    const again = await a.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: PICTURE,
      source: sky("Night sky"),
      baseRevision: revision,
    });
    assert.equal(again.status, "committed");
  });
}

test("a tab that hears another tab's authoring edit is stale for authoring at once", async (t) => {
  const { projectId, files, revision } = await storeProject(t, "two-tab-heard");
  const a = await openTab(projectId, files);
  const b = await openTab(projectId, files);
  // B's own channel object: BroadcastChannel delivers A's notices to it.
  const channel = new BroadcastChannel(PROJECT_CHANNEL);
  (channel as { unref?: () => void }).unref?.();
  let told = 0;
  const stop = watchProjectWrites(
    { getBootedGame: () => b.game, onBehindStorage: () => told++, onRemoved: () => {} },
    channel as unknown as NoticeChannel,
  );
  t.after(() => {
    stop();
    channel.close();
  });

  await EDITS.label.keep(a, revision);
  await a.controller.persistSessionState();
  await drainProjectNotices(channel);
  assert.equal(told, 1, "B heard it once");
  assert.equal(
    b.game.behindStorage,
    undefined,
    "B's bytes are still current: it keeps its checkpoints",
  );
  await b.controller.openPowerUp(STUB);
  assert.equal(b.ui.powerUp.error, STALE_SAVE_MESSAGE);
  assert.equal(b.ui.powerUp.offerReload, true);
  await assert.rejects(b.controller.persistSessionState(), staleSave);
  assert.ok(EDITS.label.kept((await loadAuthoredGame(projectId))!.authoringState!));
});

test("a Studio draft keeps against the authoring it opened on, even after a session hydrates newer", async (t) => {
  const { projectId, files, revision } = await storeProject(t, "two-tab-draft");
  // B opens Room Studio on the sky with no session live: the booted record's text.
  const b = await openTab(projectId, files, false);
  const opened = { revision: b.game.revision, authoring: openDraft(b.game) };
  // A renames the sky; then B's first AI request hydrates a session from storage.
  const a = await openTab(projectId, files);
  await EDITS.label.keep(a, revision);
  await b.controller.openPowerUp(STUB);
  b.controller.closePowerUp();

  // B's draft, made on the old text, locks the sky: Keep must not drop A's label.
  await assert.rejects(
    b.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: PICTURE,
      source: sky("Sky", true),
      baseRevision: opened.revision,
      baseAuthoring: opened.authoring,
    }),
    (error) =>
      error instanceof ResourceCommitError && error.code === "stale" && error.behindStorage,
  );
  assert.ok(EDITS.label.kept((await loadAuthoredGame(projectId))!.authoringState!));
});

test("a Studio draft's own Keeps move its base on, and a write elsewhere in the tab asks it to reopen", async (t) => {
  const { projectId, files, revision } = await storeProject(t, "draft-own-keeps");
  const tab = await openTab(projectId, files);
  let base = openDraft(tab.game);
  for (const label of ["Evening sky", "Night sky"]) {
    const kept = await tab.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: PICTURE,
      source: sky(label),
      baseRevision: revision,
      baseAuthoring: base,
    });
    assert.equal(kept.status, "committed");
    base = kept.authoring;
  }
  // The tab's own plan save moves its authoring past the draft: reopen on the running game.
  assert.equal(await tab.controller.persistSessionState(), true);
  const plan = tab.controller.getSession()!.state.authoring;
  plan.world.facts["weather"] = "rain";
  assert.equal(await tab.controller.persistSessionState(), true);
  await assert.rejects(
    tab.controller.commitPictureEdit({
      pictureNumber: 1,
      bytes: PICTURE,
      source: sky("Dawn sky"),
      baseRevision: revision,
      baseAuthoring: base,
    }),
    (error) =>
      error instanceof ResourceCommitError && error.code === "stale" && !error.behindStorage,
  );
});
