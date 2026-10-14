import assert from "node:assert/strict";
import { test } from "node:test";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { bytesToBase64, base64ToBytes } from "../src/project/bytes.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  commitProject,
  loadAuthoredGameWithHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { resolveProgressTarget } from "../src/project/progressBinding.ts";
import { readAutosave, useAutosaveController } from "../src/saves/useAutosaveController.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { testProjectId } from "./identity.ts";

installIndexedDbFixture();
installWebLocksFixture();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});
const host = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

for (const scenario of ["chat", "notes", "rejected write", "second tab", "closed page"] as const) {
  test(`a checkpoint refused during a ${scenario} save preserves the player's progress`, async () => {
    const starter = createStarterProject("starter");
    const files = Object.fromEntries(starter.files());
    const id = testProjectId(`checkpoint-ready-${scenario.replaceAll(" ", "-")}`);
    await saveAuthoredGame(id, { title: "Checkpoint", files, words: [...starter.sources.words] });
    const held = (await loadAuthoredGameWithHistoryLifetime(id))!;
    const game: BootedGame = {
      installed: false,
      projectId: id,
      title: "Checkpoint",
      files,
      words: [...starter.sources.words],
      revision: await gameRevision(files),
      historyLifetime: held.lifetime!,
    };
    const engine = new Engine(
      openContainer(new Map(Object.entries(files)), { profile: starter.profileId }),
      host,
      new Map(starter.sources.words),
      { profile: starter.profileId },
    );
    for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
    assert.ok(engine.autosaveImage(), "the player's room is resumable");
    engine.vars[80] = 17;
    let cycle = 1;
    let requests = 0;
    let pausedWrite = false;
    let rejectWrite = scenario === "rejected write";
    const entered = Promise.withResolvers<Parameters<typeof commitProject>[0]>();
    const release = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<boolean>();
    const worker = {
      postMessage(message: { type: string; id: number }) {
        assert.equal(message.type, "flush");
        requests++;
        const image = engine.autosaveImage();
        assert.ok(image);
        controller.handleAutosave({
          image: bytesToBase64(image),
          revision: game.revision,
          cycle,
          room: engine.vars[0]!,
        });
        controller.handleFlushed({ id: message.id, taken: true, cycle });
      },
    } as unknown as Worker;
    const session = openProjectSession({
      data: held.data,
      lifetime: held.lifetime!,
      admission: {
        runToken: `checkpoint-${scenario.replaceAll(" ", "-")}`,
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 0,
        }),
      },
      async write(request) {
        if (pausedWrite) {
          entered.resolve(request);
          await release.promise;
          if (rejectWrite) throw new Error("Browser storage rejected the document write");
        }
        return (await commitProject(request)).receipt;
      },
      checkpointReady() {
        void controller.flushAutosave().then(retried.resolve);
      },
    });
    const controller = useAutosaveController({
      state: { resumed: false },
      getBootedGame: () => game,
      getWorker: () => worker,
      getRunScope: () => session.runToken,
      async prepareCheckpoint(_game, _files, revision) {
        return (await session.prepareCheckpoint(revision)) === "ready" ? "owned" : "not_ready";
      },
      logAgent() {},
      isInstalledGame: () => false,
      bootGame: async () => {},
      bootAuthoredGame: async () => {},
      configForGame: (_project, config) => config,
      retireFailedRecovery() {},
    });
    try {
      await session.flush();
      assert.equal((await controller.flushAutosaveDetailed()).status, "saved");
      const locator = resolveProgressTarget(game)!.locator;
      const original = readAutosave(locator)!.image;
      pausedWrite = true;
      if (scenario === "notes") {
        await session.submit({
          proposal: session.model.propose(session.model.capture(), "Note", [
            { key: "notes", content: "Remember the garden" },
          ]),
          label: "Note",
          origin: "logic",
          author: "creator",
        });
      } else await session.saveChats(session.chats());
      const saving = session.flush();
      // Observe rejections immediately; the held transaction settles later.
      const settled = saving.then(
        () => null,
        (error: unknown) => error,
      );
      const request = await entered.promise;
      engine.vars[80] = 42;
      cycle = 2;
      assert.equal((await controller.flushAutosaveDetailed()).status, "not_ready");
      assert.equal((await controller.flushAutosaveDetailed()).status, "not_ready");
      const refusedRequests = requests;
      assert.equal(readAutosave(locator)!.image, original);
      if (scenario === "second tab") {
        // A separate storage client wins while this page's write is held.
        await commitProject({
          ...request,
          commitId: testProjectId("other-tab-commit"),
          workspaceId: testProjectId("other-tab-workspace"),
        });
        // The blocked session cannot publish; a second page writes its own checkpoint.
        const { writeAutosave } = await import("../src/saves/gameProgress.ts");
        const record = readAutosave(locator)!;
        assert.ok(
          writeAutosave(localStorage, resolveProgressTarget(game)!, {
            ...record,
            image: "other-tab-progress",
            cycle: 3,
          }),
        );
      }
      if (scenario === "closed page") session.dispose();
      release.resolve();
      const error = await settled;
      if (scenario === "second tab") {
        assert.ok(error instanceof Error);
        assert.equal(session.saveStatus().state, "conflict", String(session.saveStatus().cause));
        assert.equal(requests, refusedRequests);
        assert.equal(readAutosave(locator)!.image, "other-tab-progress");
      } else if (scenario === "closed page") {
        assert.equal(requests, refusedRequests);
        assert.equal(readAutosave(locator)!.image, original);
      } else {
        if (scenario === "rejected write") {
          assert.ok(error instanceof Error);
          assert.equal(requests, refusedRequests);
          assert.equal(readAutosave(locator)!.image, original);
          rejectWrite = false;
          await session.retry();
        } else assert.equal(error, null);
        assert.equal(requests, refusedRequests + 1, "readiness takes one fresh checkpoint");
        assert.equal(await retried.promise, true);
        const saved = readAutosave(locator)!;
        engine.restoreImage(base64ToBytes(saved.image));
        assert.equal(engine.vars[80], 42, "Resume keeps the progress made during the save");
        assert.equal(saved.cycle, 2);
        await session.flush();
        assert.equal(requests, refusedRequests + 1, "an already saved document needs no retry");
      }
    } finally {
      release.resolve();
      session.dispose();
      controller.drainFlushWaiters();
      await controller.getAutosaveWrite();
    }
  });
}

for (const changedResources of [true, false]) {
  test(
    changedResources
      ? "a refused checkpoint waits for the required restart before requesting fresh progress"
      : "a matching checkpoint retries after a document save while a restart is optional",
    async () => {
      const compiled = compileProjectDocuments({
        files: Object.fromEntries(createContainer().files),
        documents: { "logic:0": "return;" },
        profileId: "2.936",
      });
      const files = Object.fromEntries(compiled.files());
      const id = testProjectId(`checkpoint-required-restart-${changedResources}`);
      await saveAuthoredGame(id, { title: "Restart", files, words: [] });
      const held = (await loadAuthoredGameWithHistoryLifetime(id))!;
      let captures = 0;
      const session = openProjectSession({
        data: held.data,
        lifetime: held.lifetime!,
        admission: {
          runToken: `checkpoint-required-restart-${changedResources}`,
          admit: async () => ({
            status: "restartRequired",
            expected: null,
            current: null,
            patchGeneration: 0,
            reason: "The game needs a restart.",
          }),
          restart: async () => ({
            status: "committed",
            expected: null,
            current: null,
            patchGeneration: 1,
          }),
        },
        write: async (request) => (await commitProject(request)).receipt,
        checkpointReady() {
          captures++;
        },
      });
      try {
        await session.flush();
        const oldRevision = session.model.capture().lastAdmissibleBuild!.identity.revision;
        await session.submit({
          proposal: session.model.propose(session.model.capture(), "Change room", [
            {
              key: "logic:0",
              content: changedResources
                ? 'display(4, 2, "Changed room"); return;'
                : "// A room note\nreturn;",
            },
          ]),
          label: "Change room",
          origin: "logic",
          author: "creator",
        });
        assert.equal(await session.prepareCheckpoint(oldRevision), "not_ready");
        await session.flush();
        assert.ok(session.pendingRestart);
        assert.equal(
          captures,
          changedResources ? 0 : 1,
          "matching bytes can be checkpointed before an optional restart",
        );
        for (let i = 0; i < 3; i++)
          assert.equal(
            await session.prepareCheckpoint(oldRevision),
            changedResources ? "not_ready" : "ready",
          );
        await session.tag("Before restart");
        await session.flush();
        assert.equal(
          captures,
          changedResources ? 0 : 1,
          "document notifications cannot loop captures of the old build",
        );
        await session.restartWithChanges();
        await session.flush();
        assert.equal(session.pendingRestart, null);
        assert.equal(await session.prepareCheckpoint(), "ready");
        assert.equal(captures, 1, "the admitted restart releases one owed checkpoint");
      } finally {
        session.dispose();
      }
    },
  );
}
