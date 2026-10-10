import { readFile } from "node:fs/promises";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";
import {
  configureAi,
  enterCreateMode,
  isolateStorage,
  openGameOptions,
  openWorkspaceAgent,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

test("Download project resumes private history in a fresh browser; Download game has only playable resources", async ({
  page,
  browser,
}) => {
  const game = createContainer();
  game.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const files = { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) };
  const transcript = [
    { role: "user", content: "Private genesis idea: a garden of clocks." },
    { role: "assistant", content: "The garden is ready." },
  ];
  const context = {
    format: "monotio.agi.project",
    version: 1,
    provider: "anthropic",
    model: "claude-opus-5-5",
    conversation: { formatVersion: 1, messages: transcript },
    authoringState: {
      sources: { logics: [[0, "return;"]] },
      authoring: {
        version: 1,
        bindings: {},
        world: { rooms: {}, facts: { theme: "clocks" }, quests: {} },
      },
    },
  };
  const archive = buildZip([
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    {
      name: "GAME.JSON",
      data: JSON.stringify({ format: "monotio.agi", version: 1, title: "Clock Garden" }),
    },
    { name: "PROJECT.JSON", data: JSON.stringify(context) },
  ]);
  await isolateStorage(page);
  let calls = 0;
  await page.route("**/api/**", (route) => {
    calls++;
    return route.abort();
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "clock-project.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await page.getByTestId("btn-resume-cached").click();
  await openGameOptions(page, "settings-menu");
  await expect(page.getByTestId("btn-download-game")).toBeVisible();
  await openGameOptions(page, "settings-menu");
  await expect(page.getByTestId("btn-download-game")).toBeEnabled();
  const projectDownload = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-download-game").click();
  const projectDialog = page.getByTestId("settings-download-dialog");
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByTestId("download-library-game").click();
  // This authoring-only fixture has no drawn room or resumable player state.
  await expect(page.getByTestId("export-refusal")).toContainText(
    "download again to include the newest one",
  );
  const saved = await projectDownload;
  expect(saved.suggestedFilename()).toMatch(/-project.zip$/);
  const data = await readGameZip(new Uint8Array(await readFile((await saved.path())!)));
  expect(data.project?.transcript).toEqual(transcript);
  // A private backup preserves the exact resource revision, including absence.
  // Only the public Game export below supplies a missing inventory file.
  expect(data.files).toEqual(files);
  expect(data.project?.authoringState).toEqual(context.authoringState);
  const publicDownload = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-download-game").click();
  const publicDialog = page.getByTestId("settings-download-dialog");
  await expect(publicDialog).toBeVisible();
  await publicDialog.getByTestId("export-library-game").click();
  const published = await publicDownload;
  const publicBytes = new Uint8Array(await readFile((await published.path())!));
  expect(new TextDecoder().decode(publicBytes)).not.toContain("Private genesis idea");
  const publicGame = await readGameZip(publicBytes);
  expect(publicGame.project).toBeUndefined();
  expect(publicGame.files["OBJECT"]).toEqual(Uint8Array.of(65, 118, 150));
  expect(calls).toBe(0);
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.route("**/api/**", (route) => {
      calls++;
      return route.abort();
    });
    await other.goto(page.url());
    await other.getByTestId("game-zip-input").setInputFiles((await saved.path())!);
    await other.getByTestId("btn-resume-cached").click();
    await openGameOptions(other, "settings-menu");
    await expect(other.getByTestId("btn-download-game")).toBeVisible();
    await other.reload();
    await expect(other.getByTestId("btn-resume-cached")).toBeVisible();
    const restored = await other.evaluate(async () => {
      const path = "/src/project/gameStorage.ts";
      const store = await import(path);
      const meta = store.listCachedGames()[0];
      const body = await store.loadAuthoredGame(meta.projectId);
      return {
        transcript: body.transcript,
        authoringState: body.authoringState,
        index: JSON.parse(localStorage.getItem(store.getStorageKey(meta.projectId))!),
      };
    });
    expect(restored.transcript).toEqual(transcript);
    expect(restored.authoringState).toEqual(context.authoringState);
    expect(restored.index.storage).toBe("indexeddb");
    expect(restored.index.transcript).toBeUndefined();
    expect(await other.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBeNull();
    expect(calls).toBe(0);
    await other.screenshot({ path: test.info().outputPath("project-ready.png") });
    await other.getByTestId("btn-resume-cached").click();
    // Keep interception enabled while the worker imports its modules. The
    // specific mock below overrides the API-blocking fallback without a gap.
    const requests: Record<string, unknown>[] = [];
    await other.route("**/api/openai/v1/responses", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill(
        providerReply("openai", {
          id: `continued-${requests.length}`,
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Ready to continue the garden." }],
            },
          ],
        }),
      );
    });
    await enterCreateMode(other);
    await openWorkspaceAgent(other);
    await configureAi(other, { provider: "openai", key: "test-placeholder" });
    await expect(other.getByTestId("agent-message")).toBeEnabled();
    expect(requests).toHaveLength(0);
    await other.getByTestId("agent-message").fill("Continue our garden.");
    await other.getByRole("button", { name: "Send", exact: true }).click();
    await expect(other.getByTestId("agent-conversation")).toContainText(
      "Ready to continue the garden.",
    );
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain("Private genesis idea");
    expect(JSON.stringify(requests[0])).toContain("Continue our garden.");
    expect(requests[1]?.["model"]).toBe("gpt-6.1-sol");
    const continuationDownload = other.waitForEvent("download");
    await openGameOptions(other, "settings-menu");
    await other.getByTestId("btn-download-game").click();
    const continuationDialog = other.getByTestId("settings-download-dialog");
    await expect(continuationDialog).toBeVisible();
    await continuationDialog.getByTestId("download-library-game").click();
    await expect(other.getByTestId("export-refusal")).toContainText(
      "download again to include the newest one",
    );
    const continued = await continuationDownload;
    const continuation = await readGameZip(
      new Uint8Array(await readFile((await continued.path())!)),
    );
    // Legacy fields retain their original conversation provenance; canonical chats carry the resumed owner.
    expect(continuation.project?.provider).toBe(context.provider);
    expect(continuation.project?.transcript).toEqual(transcript);
    const resumedChats = continuation.project?.chats;
    expect(resumedChats?.chats.find((chat) => chat.id === resumedChats.active)?.provider).toBe(
      "openai",
    );
    expect(resumedChats?.chats.find((chat) => chat.archived)?.transcript).toEqual(transcript);
    expect(JSON.stringify(continuation.project?.chats)).toContain("Continue our garden.");
    expect(
      new TextDecoder().decode(new Uint8Array(await readFile((await continued.path())!))),
    ).not.toContain("test-placeholder");
  } finally {
    await fresh.close();
  }
});

test("unavailable project storage cannot publish a library index", async ({ page }) => {
  await isolateStorage(page);
  await page.addInitScript(() => {
    // Patch the factory prototype: an instance override did not consistently
    // intercept WebKit's opens. Count failures so the test proves injection.
    const failures = { opens: 0 };
    Object.assign(window, { __projectStorageFailures: failures });
    IDBFactory.prototype.open = () => {
      failures.opens++;
      throw new Error("Storage unavailable");
    };
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/project/gameStorage.ts";
    const storage = await import(path);
    const saved = await storage.saveAuthoredGame("blocked", {
      title: "Cannot save",
      provider: "stub",
      model: "offline-stub",
      files: { "VOL.0": new Uint8Array([1, 2, 3]) },
      words: [],
    });
    const failures = (window as unknown as { __projectStorageFailures: { opens: number } })
      .__projectStorageFailures;
    return {
      saved,
      index: localStorage.getItem(storage.getStorageKey("blocked")),
      failedOpens: failures.opens,
    };
  });
  expect(result.failedOpens).toBeGreaterThan(0);
  expect({ saved: result.saved, index: result.index }).toEqual({ saved: false, index: null });
});
