import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";
import type { ProjectCommitRequest } from "../src/project/gameStorage.ts";

for (const mode of ["locks", "fallback-success", "fallback-conflict"] as const) {
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
      const release = claimProjectSaveJournal(key);
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
    const begin = recovery.evaluate(
      async ({ mode }) => {
        const { resumeProjectSaveJournals } = await import("/src/project/projectSaveJournal.ts");
        const { commitProject } = await import("/src/project/gameStorage.ts");
        const surface = window as unknown as {
          recoveryEntered?: boolean;
          releaseRecovery?: () => void;
        };
        await resumeProjectSaveJournals(
          localStorage,
          "journal-two-pages" as never,
          async (request) => {
            surface.recoveryEntered = true;
            if (mode !== "locks")
              await new Promise<void>((resolve) => {
                surface.releaseRecovery = resolve;
              });
            if (mode === "fallback-conflict")
              throw Object.assign(new Error("conflict"), { name: "ConcurrencyConflictError" });
            return commitProject(request);
          },
        );
        return surface.recoveryEntered === true;
      },
      { mode },
    );
    if (mode === "locks") expect(await begin).toBe(false);
    else
      await expect
        .poll(() =>
          recovery.evaluate(
            () => (window as unknown as { recoveryEntered?: boolean }).recoveryEntered,
          ),
        )
        .toBe(true);
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
    if (mode !== "locks") {
      await recovery.evaluate(() =>
        (window as unknown as { releaseRecovery(): void }).releaseRecovery(),
      );
      expect(await begin).toBe(true);
    }
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
    expect(reopened).toEqual({ title: "Newest", generation: 2 });
    expect(await recovery.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
  });
}

test("a journal from a deleted lifetime preserves its bytes beside a recreated project", async ({
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
  const result = await page.evaluate(async (key) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    return {
      title: (await loadAuthoredGame("journal-lifetime" as never))?.title,
      raw: localStorage.getItem(key),
    };
  }, original.key);
  expect(result).toEqual({ title: "Recreated", raw: original.raw });
});

test("a terminal journal offers its exact pending bytes in Create and Home", async ({ page }) => {
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
    const key = projectSaveJournalKey(id, "ended-owner");
    writeProjectSaveJournal(localStorage, key, [
      {
        attempted: false,
        request: {
          projectId: id,
          commitId: "pending",
          workspaceId: "ended",
          buildId: "a".repeat(64),
          documents: [],
          expected: {
            projectId: id,
            lifetime: "ended-lifetime",
            generation: stored.data.generation!,
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
  await expect(notice).toContainText("Pending edits need recovery");
  const pending = page.waitForEvent("download");
  await notice.getByRole("button", { name: "Download edits" }).click();
  const download = await pending;
  const { readFile } = await import("node:fs/promises");
  const body = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(body.journals[0]).toMatchObject({ key: original.key, raw: original.raw });
  await page.screenshot({ path: test.info().outputPath("pending-recovery.png") });
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect(
    page.getByTestId(`saved-game-card-${original.id}`).getByTestId("pending-edit-recovery"),
  ).toBeVisible();
});
