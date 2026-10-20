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
import { claimProgressWriter } from "../src/saves/progressWriter.ts";
import { writeAutosave } from "../src/saves/gameProgress.ts";
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

for (const scenario of [
  "chat",
  "notes",
  "rejected write",
  "failed write",
  "second tab writer",
  "second tab revision",
  "stale write block",
  "closed page",
] as const) {
  test(`a progress entry during a ${scenario} document save preserves the player's progress`, async () => {
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
    let rejectWrite = scenario === "rejected write" || scenario === "failed write";
    const entered = Promise.withResolvers<Parameters<typeof commitProject>[0]>();
    const release = Promise.withResolvers<void>();
    let retries = 0;
    let writerGeneration: number | undefined;
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
        retries++;
        void controller.flushAutosave();
      },
    });
    const controller = useAutosaveController({
      state: { resumed: false },
      getBootedGame: () => game,
      getWorker: () => worker,
      getRunScope: () => session.runToken,
      getWriterGeneration: () => writerGeneration,
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
      const target = resolveProgressTarget(game)!;
      writerGeneration = claimProgressWriter(localStorage, target, "this-page").generation;
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
      if (scenario === "stale write block") session.stopWrites();
      if (scenario !== "failed write") {
        assert.equal(
          (await controller.flushAutosaveDetailed()).status,
          scenario === "stale write block" ? "not_ready" : "saved",
        );
      }
      const saved = readAutosave(locator)!;
      if (scenario === "stale write block" || scenario === "failed write")
        assert.equal(saved.image, original);
      else {
        assert.notEqual(saved.image, original, "progress is stored before the document commits");
        engine.restoreImage(base64ToBytes(saved.image));
        assert.equal(engine.vars[80], 42);
        assert.equal(saved.cycle, 2);
      }
      if (scenario === "second tab writer" || scenario === "second tab revision") {
        // The other page wins the document transaction and publishes progress.
        await commitProject({
          ...request,
          commitId: testProjectId(`other-tab-commit-${scenario.replaceAll(" ", "-")}`),
          workspaceId: testProjectId(`other-tab-workspace-${scenario.replaceAll(" ", "-")}`),
        });
        const otherWriter =
          scenario === "second tab writer"
            ? claimProgressWriter(localStorage, target, "other-page").generation
            : writerGeneration;
        if (scenario === "second tab revision") {
          const newer = compileProjectDocuments({
            files,
            documents: { "logic:99": "return;" },
            profileId: starter.profileId,
          });
          await saveAuthoredGame(id, { ...request.data, files: Object.fromEntries(newer.files()) });
        }
        assert.ok(
          writeAutosave(localStorage, target, {
            ...saved,
            writerGeneration: otherWriter,
            image: "other-tab-progress",
            cycle: 3,
          }),
        );
        assert.equal((await controller.flushAutosaveDetailed()).status, "storage_failure");
        assert.equal(readAutosave(locator)!.image, "other-tab-progress");
      }
      if (scenario === "closed page") session.dispose();
      const checkpointRequests = requests;
      release.resolve();
      const error = await settled;
      if (scenario === "second tab writer" || scenario === "second tab revision") {
        assert.ok(error instanceof Error);
        assert.equal(session.saveStatus().state, "conflict", String(session.saveStatus().cause));
        assert.equal(readAutosave(locator)!.image, "other-tab-progress");
      } else if (scenario === "rejected write" || scenario === "failed write") {
        assert.ok(error instanceof Error);
        assert.equal(
          session.saveStatus().state,
          "failed",
          "Create still shows the document failure",
        );
        if (scenario === "failed write") {
          assert.equal((await controller.flushAutosaveDetailed()).status, "saved");
          engine.restoreImage(base64ToBytes(readAutosave(locator)!.image));
          assert.equal(engine.vars[80], 42, "a failed document save still permits progress");
        }
        rejectWrite = false;
        await session.retry();
      } else if (scenario === "closed page") {
        assert.ok(error instanceof Error);
        assert.equal(readAutosave(locator)!.image, saved.image);
      } else if (scenario !== "stale write block") assert.equal(error, null);
      assert.equal(retries, 0, "document saves never owe a progress entry retry");
      assert.equal(requests, checkpointRequests + (scenario === "failed write" ? 1 : 0));
    } finally {
      release.resolve();
      session.dispose();
      controller.drainFlushWaiters();
      await controller.getAutosaveWrite();
    }
  });
}

for (const [changedResources, refusedCheckpoint] of [
  [true, true],
  [false, true],
  [true, false],
] as const) {
  test(
    !refusedCheckpoint
      ? "a restarted room requests progress even without an earlier refused progress entry"
      : changedResources
        ? "a refused progress entry waits for the required restart before requesting fresh progress"
        : "a matching progress entry stores immediately while a restart is optional",
    async () => {
      const compiled = compileProjectDocuments({
        files: Object.fromEntries(createContainer().files),
        documents: { "logic:0": "return;" },
        profileId: "2.936",
      });
      const files = Object.fromEntries(compiled.files());
      const id = testProjectId(
        `checkpoint-required-restart-${changedResources}-${refusedCheckpoint}`,
      );
      await saveAuthoredGame(id, { title: "Restart", files, words: [] });
      const held = (await loadAuthoredGameWithHistoryLifetime(id))!;
      let captures = 0;
      const session = openProjectSession({
        data: held.data,
        lifetime: held.lifetime!,
        admission: {
          runToken: `checkpoint-required-restart-${changedResources}-${refusedCheckpoint}`,
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
        if (refusedCheckpoint)
          assert.equal(
            await session.prepareCheckpoint(oldRevision),
            changedResources ? "not_ready" : "ready",
          );
        await session.flush();
        assert.ok(session.pendingRestart);
        assert.equal(
          captures,
          0,
          "matching bytes can be progress entryed before an optional restart",
        );
        if (refusedCheckpoint)
          for (let i = 0; i < 3; i++)
            assert.equal(
              await session.prepareCheckpoint(oldRevision),
              changedResources ? "not_ready" : "ready",
            );
        await session.tag("Before restart");
        await session.flush();
        assert.equal(captures, 0, "document notifications cannot loop captures of the old build");
        await session.restartWithChanges();
        await session.flush();
        assert.equal(session.pendingRestart, null);
        assert.equal(await session.prepareCheckpoint(), "ready");
        assert.equal(
          captures,
          1,
          "successful activation requests one progress entry for the restarted room",
        );
      } finally {
        session.dispose();
      }
    },
  );
}

for (const failed of [false, true]) {
  test(`a ${failed ? "failed" : "pending"} resource write refuses checkpoints until its revision commits`, async () => {
    const starter = createStarterProject("starter");
    const files = Object.fromEntries(starter.files());
    const id = testProjectId(`resource-checkpoint-${failed}`);
    await saveAuthoredGame(id, {
      title: "Resources",
      files,
      words: [...starter.sources.words],
    });
    const held = (await loadAuthoredGameWithHistoryLifetime(id))!;
    let pause = false;
    let reject = failed;
    let captures = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<boolean>();
    const game: BootedGame = {
      installed: false,
      projectId: id,
      title: "Resources",
      files,
      words: [...starter.sources.words],
      revision: await gameRevision(files),
      historyLifetime: held.lifetime!,
    };
    let engine: Engine;
    const worker = {
      postMessage(message: { type: string; id: number }) {
        assert.equal(message.type, "flush");
        const image = engine.autosaveImage();
        assert.ok(image);
        controller.handleAutosave({
          image: bytesToBase64(image),
          revision: game.revision,
          cycle: 2,
          room: engine.vars[0]!,
        });
        controller.handleFlushed({ id: message.id, taken: true, cycle: 2 });
      },
    } as unknown as Worker;
    const session = openProjectSession({
      data: held.data,
      lifetime: held.lifetime!,
      admission: {
        runToken: `resource-checkpoint-${failed}`,
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        }),
      },
      async write(request) {
        if (pause) {
          entered.resolve();
          await release.promise;
          if (reject) throw new Error("Resource write rejected");
        }
        return (await commitProject(request)).receipt;
      },
      checkpointReady() {
        captures++;
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
      pause = true;
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Room", [
          { key: "logic:99", content: "return;" },
        ]),
        label: "Room",
        origin: "logic",
        author: "creator",
      });
      const build = session.model.capture().lastAdmissibleBuild!;
      const revision = build.identity.revision;
      game.files = Object.fromEntries(build.files());
      game.revision = revision;
      engine = new Engine(
        openContainer(new Map(Object.entries(game.files)), { profile: starter.profileId }),
        host,
        new Map(starter.sources.words),
        { profile: starter.profileId },
      );
      for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
      engine.vars[80] = 42;
      const locator = resolveProgressTarget(game)!.locator;
      const saving = session.flush().then(
        () => null,
        (error: unknown) => error,
      );
      await entered.promise;
      assert.equal(await session.prepareCheckpoint(revision), "not_ready");
      assert.equal(await session.prepareCheckpoint(), "not_ready");
      assert.equal((await controller.flushAutosaveDetailed()).status, "not_ready");
      assert.equal(readAutosave(locator), null, "uncommitted resources cannot publish progress");
      assert.equal(captures, 0);
      release.resolve();
      const error = await saving;
      if (failed) {
        assert.ok(error instanceof Error);
        await assert.rejects(session.prepareCheckpoint(revision), /Could not save/);
        assert.equal(captures, 0);
        reject = false;
        await session.retry();
      } else assert.equal(error, null);
      assert.equal(await retried.promise, true);
      const saved = readAutosave(locator)!;
      assert.ok(saved, "the owed retry stores progress after the resources commit");
      engine.restoreImage(base64ToBytes(saved.image));
      assert.equal(engine.vars[80], 42);
      assert.equal(
        captures,
        1,
        "the committed resource revision requests one fresh progress entry",
      );
      assert.equal(await session.prepareCheckpoint(revision), "ready");
    } finally {
      release.resolve();
      session.dispose();
      controller.drainFlushWaiters();
      await controller.getAutosaveWrite();
    }
  });
}

for (const ending of ["saved", "failed", "closed", "debounced"] as const) {
  test(`undo to stored resources waits for intervening writes (${ending})`, async () => {
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents: { "logic:0": "return;" },
      profileId: "2.936",
    });
    const id = testProjectId(`checkpoint-undo-${ending}`);
    await saveAuthoredGame(id, {
      title: "Undo",
      files: Object.fromEntries(compiled.files()),
      words: [],
    });
    const held = (await loadAuthoredGameWithHistoryLifetime(id))!;
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    let hold = false;
    let writes = 0;
    let reject = ending === "failed";
    let captures = 0;
    const readiness: Promise<string>[] = [];
    const session = openProjectSession({
      data: held.data,
      lifetime: held.lifetime!,
      admission: {
        runToken: `checkpoint-undo-${ending}`,
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        }),
      },
      async write(request) {
        if (hold) {
          writes++;
          if (ending !== "debounced") {
            if (writes === 1) {
              firstEntered.resolve();
              await firstRelease.promise;
            } else {
              secondEntered.resolve();
              await secondRelease.promise;
              if (ending === "closed" && session.closed)
                throw new Error("Page closed before commit");
              if (reject) throw new Error("Undo write rejected");
            }
          }
        }
        return (await commitProject(request)).receipt;
      },
      checkpointReady() {
        captures++;
        readiness.push(session.prepareCheckpoint());
      },
    });
    try {
      await session.flush();
      const original = session.model.capture().lastAdmissibleBuild!.identity.revision;
      hold = true;
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Room", [
          { key: "logic:0", content: 'display(4, 2, "New room"); return;' },
        ]),
        label: "Room",
        origin: "logic",
        author: "creator",
      });
      const changed = session.model.capture().lastAdmissibleBuild!.identity.revision;
      assert.notEqual(changed, original);
      const saving =
        ending === "debounced"
          ? undefined
          : session.flush().then(
              () => null,
              (error: unknown) => error,
            );
      if (saving) await firstEntered.promise;
      await session.undo();
      assert.equal(session.model.capture().lastAdmissibleBuild!.identity.revision, original);
      if (ending === "debounced") {
        assert.equal(
          captures,
          1,
          "coalescing away the intervening revision requests one progress entry",
        );
        assert.equal(await session.prepareCheckpoint(original), "ready");
        await session.flush();
        assert.equal(writes, 1, "only the restored resource revision reaches storage");
      } else {
        assert.equal(
          await session.prepareCheckpoint(original),
          "not_ready",
          "an in-flight different revision can still replace the body",
        );
        assert.equal(await session.prepareCheckpoint(), "not_ready");
        assert.equal(
          captures,
          0,
          "Undo cannot consume the owed progress entry before its write commits",
        );
        firstRelease.resolve();
        await secondEntered.promise;
        assert.equal(
          (await loadAuthoredGameWithHistoryLifetime(id))!.data.library!.revision,
          changed,
        );
        assert.equal(await session.prepareCheckpoint(original), "not_ready");
        if (ending === "closed") session.dispose();
        secondRelease.resolve();
        const error = await saving;
        if (ending === "failed") {
          assert.ok(error instanceof Error);
          await assert.rejects(session.prepareCheckpoint(original), /Could not save/);
          assert.equal(captures, 0);
          reject = false;
          await session.retry();
        } else if (ending === "closed") {
          assert.ok(error instanceof Error);
          assert.equal(
            captures,
            0,
            "closing leaves the earlier revision's progress entry untouched",
          );
          assert.equal(
            (await loadAuthoredGameWithHistoryLifetime(id))!.data.library!.revision,
            changed,
          );
          return;
        } else assert.equal(error, null);
        assert.equal(await session.prepareCheckpoint(original), "ready");
        assert.equal(
          captures,
          1,
          "the final committed revision receives exactly one owed progress entry",
        );
      }
      assert.deepEqual(await Promise.all(readiness), ["ready"]);
      await session.saveChats(session.chats());
      await session.flush();
      assert.equal(captures, 1, "later document writes cannot repeat the capture");
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      session.dispose();
    }
  });
}

for (const [activation, restartRoom] of [
  ["restartRequired", true],
  ["deferred", true],
  ["launch", true],
  ["restartRequired", false],
  ["deferred", false],
] as const) {
  test(`Update resolves ${activation} with one progress entry at the same revision (restart=${restartRoom})`, async () => {
    const starter = createStarterProject("starter");
    const files = Object.fromEntries(starter.files());
    const id = testProjectId(`checkpoint-activation-${activation}-${restartRoom}`);
    await saveAuthoredGame(id, {
      title: "Activation",
      files,
      words: [...starter.sources.words],
    });
    const held = (await loadAuthoredGameWithHistoryLifetime(id))!;
    const boundary = Promise.withResolvers<void>();
    const launch = { room: 1, beginning: true };
    let captures = 0;
    const readiness: Promise<string>[] = [];
    const stored: Promise<boolean>[] = [];
    const game: BootedGame = {
      installed: false,
      projectId: id,
      title: "Activation",
      files,
      words: [...starter.sources.words],
      revision: await gameRevision(files),
      historyLifetime: held.lifetime!,
    };
    let engine: Engine;
    const worker = {
      postMessage(message: { type: string; id: number }) {
        assert.equal(message.type, "flush");
        const image = engine.autosaveImage();
        assert.ok(image);
        controller.handleAutosave({
          image: bytesToBase64(image),
          revision: game.revision,
          cycle: 2,
          room: engine.vars[0]!,
        });
        controller.handleFlushed({ id: message.id, taken: true, cycle: 2 });
      },
    } as unknown as Worker;
    async function activateEngine(compiled: ReturnType<typeof compileProjectDocuments>) {
      game.files = Object.fromEntries(compiled.files());
      game.revision = await gameRevision(game.files);
      engine = new Engine(
        openContainer(new Map(Object.entries(game.files)), { profile: starter.profileId }),
        host,
        new Map(starter.sources.words),
        { profile: starter.profileId },
      );
      for (let i = 0; i < 8 && !engine.autosaveImage(); i++) engine.tick();
      engine.vars[80] = 42;
    }
    let admissions = 0;
    const session = openProjectSession({
      data: held.data,
      lifetime: held.lifetime!,
      boundary: () => boundary.promise,
      admission: {
        runToken: `checkpoint-activation-${activation}-${restartRoom}`,
        admit: async (compiled) => {
          if (++admissions > 1) {
            await activateEngine(compiled);
            return { status: "committed", expected: null, current: null, patchGeneration: 2 };
          }
          return {
            status: activation === "deferred" ? "deferred" : "restartRequired",
            expected: null,
            current: null,
            patchGeneration: 1,
            reason: "Restart the room.",
          };
        },
        reenter: async (compiled, _versions, requested) => {
          assert.deepEqual(requested, launch);
          await activateEngine(compiled);
          return {
            status: activation === "launch" ? "unchanged" : "committed",
            expected: null,
            current: null,
            patchGeneration: 2,
          };
        },
      },
      write: async (request) => (await commitProject(request)).receipt,
      checkpointReady() {
        captures++;
        readiness.push(session.prepareCheckpoint());
        stored.push(controller.flushAutosave());
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
      if (activation !== "launch") {
        await session.submit({
          proposal: session.model.propose(session.model.capture(), "Room", [
            { key: "logic:99", content: "return;" },
          ]),
          label: "Room",
          origin: "logic",
          author: "creator",
        });
        await session.flush();
        assert.equal(session.capture().pendingAdmission, activation === "deferred");
        assert.equal(session.pendingRestart !== null, activation === "restartRequired");
      }
      assert.equal(captures, 0, "no earlier refusal or activation has requested a progress entry");
      const revision = session.model.capture().lastAdmissibleBuild!.identity.revision;
      const outcome = await session.update(
        activation === "launch" ? [{ key: "notes", content: "Room launch note" }] : [],
        restartRoom,
        restartRoom ? launch : undefined,
      );
      assert.equal(outcome.status, "committed");
      assert.equal(session.model.capture().lastAdmissibleBuild!.identity.revision, revision);
      assert.equal(session.pendingRestart, null);
      assert.equal(session.capture().pendingAdmission, false);
      assert.equal(captures, 1, "paused Play receives one post-activation progress entry request");
      assert.deepEqual(await Promise.all(readiness), ["ready"]);
      assert.deepEqual(await Promise.all(stored), [true]);
      const saved = readAutosave(resolveProgressTarget(game)!.locator)!;
      assert.ok(saved, "paused Play stores the progress entry without another worker event");
      engine!.restoreImage(base64ToBytes(saved.image));
      assert.equal(engine!.vars[80], 42, "the stored image holds the post-restart state");
      await session.flush();
      assert.equal(captures, 1, "saving the activation documents does not repeat the capture");
    } finally {
      session.dispose();
      boundary.resolve();
      controller.drainFlushWaiters();
      await controller.getAutosaveWrite();
    }
  });
}
