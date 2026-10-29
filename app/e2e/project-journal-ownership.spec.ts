import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";
import type * as ProjectDocumentsModule from "../../src/authoring/projectDocuments.ts";
import type * as ProjectWorkspaceModule from "../../src/authoring/projectWorkspace.ts";
import type * as ContainerModule from "../../src/container/container.ts";
import { releasedTemplates } from "../../test/released-template-fixtures.ts";
import type { ProjectCommitRequest } from "../src/project/gameStorage.ts";

for (const mode of ["locks", "without-locks"] as const) {
  test(`two pages preserve a live writer's newest journal (${mode})`, async ({ page, context }) => {
    await isolateStorage(page);
    await page.goto("/");
    const recovery = await context.newPage();
    await recovery.goto("/");
    if (mode !== "locks")
      await recovery.evaluate(() =>
        Object.defineProperty(navigator, "locks", { value: undefined }),
      );
    const key = await page.evaluate(async () => {
      const { claimProjectSaveJournal, projectSaveJournalKey, writeProjectSaveJournal } =
        await import("/src/project/projectSaveJournal.ts");
      const request: ProjectCommitRequest = {
        projectId: "journal-two-pages" as never,
        commitId: "first",
        workspaceId: "writer",
        buildId: "a".repeat(64),
        expected: null,
        documents: [],
        data: { title: "First", files: { "VOL.0": Uint8Array.of(1) }, words: [] },
      };
      const key = projectSaveJournalKey(request.projectId, "owner");
      const ownership = claimProjectSaveJournal(key);
      await ownership.ready;
      const release = ownership.release;
      (
        window as unknown as {
          journalWriter: { request: ProjectCommitRequest; key: string; release(): void };
        }
      ).journalWriter = { request, key, release };
      writeProjectSaveJournal(localStorage, key, [{ request, attempted: false }]);
      // Establish that the real cross-page owner lock is held.
      await navigator.locks.query();
      return key;
    });
    const begin = recovery.evaluate(async () => {
      const { resumeProjectSaveJournals } = await import("/src/project/projectSaveJournal.ts");
      const { commitProject } = await import("/src/project/gameStorage.ts");
      const surface = window as unknown as {
        recoveryEntered?: boolean;
      };
      await resumeProjectSaveJournals(
        localStorage,
        "journal-two-pages" as never,
        async (request) => {
          surface.recoveryEntered = true;
          return commitProject(request);
        },
      );
      return surface.recoveryEntered === true;
    });
    expect(await begin).toBe(false);
    await page.evaluate(async () => {
      const { writeProjectSaveJournal } = await import("/src/project/projectSaveJournal.ts");
      const writer = (
        window as unknown as { journalWriter: { request: ProjectCommitRequest; key: string } }
      ).journalWriter;
      writeProjectSaveJournal(localStorage, writer.key, [
        { request: writer.request, attempted: false },
        {
          request: {
            ...writer.request,
            commitId: "newest",
            data: { ...writer.request.data, title: "Newest" },
          },
          attempted: false,
        },
      ]);
    });
    await expect
      .poll(() => recovery.evaluate((key) => localStorage.getItem(key), key))
      .toContain("newest");
    await page.close();
    // Page close precedes the lock manager's lifetime cleanup; await that actual release.
    if (mode === "locks")
      await recovery.evaluate((key) => navigator.locks.request(key, () => {}), key);
    const reopened = await recovery.evaluate(async () => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      const saved = await loadAuthoredGame("journal-two-pages" as never);
      return { title: saved?.title, generation: saved?.generation };
    });
    if (mode === "locks") {
      expect(reopened).toEqual({ title: "Newest", generation: 2 });
      expect(await recovery.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    } else {
      expect(reopened.title).toBeUndefined();
      expect(await recovery.evaluate((key) => localStorage.getItem(key), key)).toContain("newest");
    }
  });
}

test("removal clears ended journals before a recreated project opens", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  const original = await page.evaluate(async () => {
    const { commitProject } = await import("/src/project/gameStorage.ts");
    const { projectSaveJournalKey, writeProjectSaveJournal } =
      await import("/src/project/projectSaveJournal.ts");
    const request: ProjectCommitRequest = {
      projectId: "journal-lifetime" as never,
      commitId: "initial",
      workspaceId: "writer",
      buildId: "a".repeat(64),
      expected: null,
      documents: [],
      data: { title: "Original", files: { "VOL.0": Uint8Array.of(1) }, words: [] },
    };
    const receipt = (await commitProject(request)).receipt;
    const key = projectSaveJournalKey(request.projectId, "closed-owner");
    writeProjectSaveJournal(localStorage, key, [
      { request: { ...request, commitId: "unsaved", expected: receipt.saved }, attempted: false },
    ]);
    const pending = { ...request, commitId: "late-owner", expected: receipt.saved };
    const { claimProjectSaveJournal } = await import("/src/project/projectSaveJournal.ts");
    const release = claimProjectSaveJournal(key).release;
    Object.assign(window, {
      rewriteRemovedJournal: () => {
        writeProjectSaveJournal(localStorage, key, [{ request: pending, attempted: false }]);
        release();
      },
    });
    return { key, raw: localStorage.getItem(key) };
  });
  await other.evaluate(async () => {
    const { clearCachedGame, commitProject } = await import("/src/project/gameStorage.ts");
    await clearCachedGame("journal-lifetime" as never);
    await commitProject({
      projectId: "journal-lifetime" as never,
      commitId: "replacement",
      workspaceId: "other",
      buildId: "b".repeat(64),
      expected: null,
      documents: [],
      data: { title: "Recreated", files: {}, words: [] },
    });
  });
  await page.evaluate(() =>
    (window as unknown as { rewriteRemovedJournal(): void }).rewriteRemovedJournal(),
  );
  const result = await page.evaluate(async (key) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    return {
      title: (await loadAuthoredGame("journal-lifetime" as never))?.title,
      raw: localStorage.getItem(key),
    };
  }, original.key);
  expect(result).toEqual({ title: "Recreated", raw: null });
});

test("pending edits require a choice before irreversible discard @phone @webkit-desktop", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Pending recovery");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  const original = await page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGameWithHistoryLifetime, authoringFingerprint } =
      await import("/src/project/gameStorage.ts");
    const { projectSaveJournalKey, writeProjectSaveJournal } =
      await import("/src/project/projectSaveJournal.ts");

    const id = listCachedGames().find((game) => game.title === "Pending recovery")!.projectId;
    const stored = (await loadAuthoredGameWithHistoryLifetime(id))!;
    const key = projectSaveJournalKey(id, "stale-owner");
    writeProjectSaveJournal(localStorage, key, [
      {
        attempted: false,
        request: {
          projectId: id,
          commitId: "pending",
          workspaceId: "stale",
          buildId: "a".repeat(64),
          documents: [],
          expected: {
            projectId: id,
            lifetime: stored.lifetime!,
            generation: stored.data.generation! - 1,
            revision: stored.data.library!.revision,
            authoring: authoringFingerprint(stored.data.authoringState, stored.data.workspace),
            buildId: "a".repeat(64),
          },
          data: { title: "PENDING_SENTINEL", files: stored.data.files, words: stored.data.words },
        },
      },
    ]);
    return { key, raw: localStorage.getItem(key), id };
  });
  await page.reload();
  const notice = page.getByTestId("pending-edit-recovery").filter({ visible: true });
  await expect(notice).toContainText(
    "Some edits were not saved because this game changed in another tab or window.",
  );
  await page.screenshot({ path: test.info().outputPath("pending-recovery.png") });
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect(
    page.getByTestId(`saved-game-card-${original.id}`).getByTestId("pending-edit-recovery"),
  ).toBeVisible();
  await page
    .getByTestId(`saved-game-card-${original.id}`)
    .getByRole("button", { name: "Discard edits" })
    .click();
  const dialog = page.getByTestId("discard-edits-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This cannot be undone.");
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(original.raw);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`discard-edits-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(original.raw);
  const discard = page
    .getByTestId(`saved-game-card-${original.id}`)
    .getByRole("button", { name: "Discard edits", exact: true });
  await discard.click();
  await page.reload();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(original.raw);
  await discard.click();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download pending edits first", exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe("agi-unsaved-edits.zip");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await discard.click();
  // A second tab can add edits while the choice is open. Confirmation covers
  // only the bytes shown when the dialog opened.
  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate(async ({ key, raw }) => {
    const { markProjectSaveRecovery } = await import("/src/project/projectSaveJournal.ts");
    localStorage.setItem(key, raw + " ");
    markProjectSaveRecovery(localStorage, key, "Project changed in another tab");
  }, original);
  await dialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(
    original.raw + " ",
  );
  await other.evaluate(async ({ key, raw }) => {
    const { markProjectSaveRecovery } = await import("/src/project/projectSaveJournal.ts");
    localStorage.setItem(key, raw!);
    markProjectSaveRecovery(localStorage, key, "Project changed in another tab");
  }, original);
  await expect(discard).toBeVisible();
  await discard.click();
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith("monotio_agi.project-writes.")) throw new Error("Browser refused removal");
      return remove.call(this, key);
    };
    Object.assign(window, {
      restoreRemoval: () => {
        Storage.prototype.removeItem = remove;
      },
    });
  });
  await dialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Browser storage could not discard these edits. Try Discard edits again.",
  );
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.screenshot({ path: test.info().outputPath(`discard-edits-failed-${width}.png`) });
  }
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(original.raw);
  await page.evaluate(() => (window as unknown as { restoreRemoval(): void }).restoreRemoval());
  await dialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(page.getByTestId("pending-edit-recovery")).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBeNull();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.project-recovery.")),
    ),
  ).toEqual([]);
});

test("a queued automatic update yields to another page's closing journal", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const expected = await page.evaluate(
    async ({ engineRoot, logic0 }) => {
      const { compileProjectDocuments } = (await import(
        engineRoot + "authoring/projectDocuments.ts"
      )) as typeof ProjectDocumentsModule;
      const { writeProjectWorkspace } = (await import(
        engineRoot + "authoring/projectWorkspace.ts"
      )) as typeof ProjectWorkspaceModule;
      const { createContainer } = (await import(
        engineRoot + "container/container.ts"
      )) as typeof ContainerModule;
      const {
        commitProject,
        loadAuthoredGameWithHistoryLifetime,
        authoringFingerprint,
        serializeWriteAction,
      } = await import("/src/project/gameStorage.ts");
      const { openOwnedProjectSession } = await import("/src/project/projectSessionCore.ts");
      const projectId = "queued-automatic-update" as ProjectCommitRequest["projectId"];
      const documents = {
        "logic:0": logic0,
        "logic:1": "accept.input(); return;",
        words: "[]",
        inventory: "[]",
      };
      const compiled = compileProjectDocuments({
        files: Object.fromEntries(createContainer().files),
        documents,
        profileId: "2.936",
      });
      const initial = await commitProject({
        projectId,
        commitId: "initial",
        workspaceId: "initial",
        expected: null,
        buildId: compiled.build.identity.buildId,
        documents: [],
        data: {
          title: "Old saved title",
          files: Object.fromEntries(compiled.files()),
          words: [],
          workspace: writeProjectWorkspace(documents),
        },
      });
      const opened = (await loadAuthoredGameWithHistoryLifetime(projectId))!;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const queued = serializeWriteAction(projectId, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const committing = Promise.withResolvers<void>();
      const session = openOwnedProjectSession(
        {
          data: opened.data,
          lifetime: opened.lifetime!,
          publish: () => {},
          admission: {
            runToken: "automatic",
            admit: async () => ({
              status: "committed",
              expected: null,
              current: null,
              patchGeneration: 1,
            }),
          },
        },
        {
          fingerprint: authoringFingerprint,
          commit: ((...args: Parameters<typeof commitProject>) => {
            committing.resolve();
            return commitProject(...args);
          }) as typeof commitProject,
        },
      );
      const flushing = session.flush();
      Object.assign(window, {
        finishQueuedUpdate: async () => {
          release.resolve();
          await queued;
          await flushing;
          session.dispose();
        },
      });
      await committing.promise;
      return initial.receipt.saved;
    },
    {
      engineRoot: `/@fs${new URL("../../src/", import.meta.url).pathname}`,
      logic0: releasedTemplates.at(-1)!.source,
    },
  );
  expect(expected.generation).toBe(1);
  const writer = await context.newPage();
  await writer.goto("/");
  const pending = await writer.evaluate(async (expected) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const { claimProjectSaveJournal, projectSaveJournalKey, writeProjectSaveJournal } =
      await import("/src/project/projectSaveJournal.ts");
    const before = (await loadAuthoredGame(expected.projectId))!;
    const key = projectSaveJournalKey(expected.projectId, "closing-creator");
    const ownership = claimProjectSaveJournal(key);
    if (!(await ownership.ready)) throw new Error("Journal ownership unavailable");
    Object.assign(window, { journalOwnership: ownership });
    writeProjectSaveJournal(localStorage, key, [
      {
        attempted: false,
        request: {
          projectId: expected.projectId,
          workspaceId: "creator",
          commitId: "pending-title",
          expected,
          buildId: expected.buildId,
          documents: [],
          data: { ...before, title: "Creator pending title" },
        },
      },
    ]);
    return { key, raw: localStorage.getItem(key) };
  }, expected);
  await writer.close();
  await page.evaluate((key) => navigator.locks.request(key, () => {}), pending.key);
  const deferred = await page.evaluate(async ({ key }) => {
    await (window as unknown as { finishQueuedUpdate(): Promise<void> }).finishQueuedUpdate();
    const { bodyTransaction } = await import("/src/project/gameStorage.ts");
    const { readProjectSaveRecoveries } = await import("/src/project/projectSaveJournal.ts");
    const body = await bodyTransaction("readonly", (store) => store.get("queued-automatic-update"));
    return {
      generation: body.generation,
      title: body.title,
      conventions: body.authoringConventions ?? null,
      raw: localStorage.getItem(key),
      conflicts: readProjectSaveRecoveries(localStorage, body.projectId),
    };
  }, pending);
  expect(deferred).toEqual({
    generation: 1,
    title: "Old saved title",
    conventions: null,
    raw: pending.raw,
    conflicts: [],
  });
  const recovered = await page.evaluate(async (key) => {
    const { loadAuthoredGameWithHistoryLifetime, authoringFingerprint, commitProject } =
      await import("/src/project/gameStorage.ts");
    const { openOwnedProjectSession } = await import("/src/project/projectSessionCore.ts");
    const { readProjectSaveRecoveries } = await import("/src/project/projectSaveJournal.ts");
    const id = "queued-automatic-update" as ProjectCommitRequest["projectId"];
    for (const run of ["reopen", "again"]) {
      const loaded = (await loadAuthoredGameWithHistoryLifetime(id))!;
      const session = openOwnedProjectSession(
        {
          data: loaded.data,
          lifetime: loaded.lifetime!,
          publish: () => {},
          admission: {
            runToken: run,
            admit: async () => ({
              status: "committed",
              expected: null,
              current: null,
              patchGeneration: 1,
            }),
          },
        },
        { fingerprint: authoringFingerprint, commit: commitProject },
      );
      await session.flush();
      session.dispose();
    }
    const data = (await loadAuthoredGameWithHistoryLifetime(id))!.data;
    return {
      title: data.title,
      generation: data.generation,
      conventions: data.authoringConventions?.version,
      updates: data.projectHistory?.commits.filter((commit) => commit.label === "Updated for 1.2.5")
        .length,
      raw: localStorage.getItem(key),
      conflicts: readProjectSaveRecoveries(localStorage, id),
    };
  }, pending.key);
  expect(recovered).toEqual({
    title: "Creator pending title",
    generation: 3,
    conventions: 1,
    updates: 1,
    raw: null,
    conflicts: [],
  });
});
