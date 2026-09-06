import { providerReply } from "../../test/provider-stream.ts";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { readGameZip } from "../src/gameZip.ts";
import { configureAi, isolateStorage, openGameOptions } from "./engineProbe.ts";

test("Save project resumes private history in a fresh browser; Export game has only playable resources", async ({
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
    model: "claude-opus-5",
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
  await openGameOptions(page, "save-share-menu");
  await expect(page.getByTestId("btn-save-live-project")).toBeVisible();
  await openGameOptions(page, "save-share-menu");
  await expect(page.getByTestId("btn-save-live-project")).toBeEnabled();
  const projectDownload = page.waitForEvent("download");
  await openGameOptions(page, "save-share-menu");
  await page.getByTestId("btn-save-live-project").click();
  const saved = await projectDownload;
  expect(saved.suggestedFilename()).toMatch(/-project.zip$/);
  const data = await readGameZip(new Uint8Array(await readFile((await saved.path())!)));
  expect(data.project?.transcript).toEqual(transcript);
  expect(data.files["OBJECT"]).toEqual(Uint8Array.of(65, 118, 150));
  expect(data.project?.authoringState).toEqual(context.authoringState);
  const publicDownload = page.waitForEvent("download");
  await openGameOptions(page, "save-share-menu");
  await page.getByTestId("btn-export-live-zip").click();
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
    await openGameOptions(other, "save-share-menu");
    await expect(other.getByTestId("btn-save-live-project")).toBeVisible();
    await other.reload();
    await expect(other.getByTestId("btn-resume-cached")).toBeVisible();
    const restored = await other.evaluate(async () => {
      const path = "/src/cartridgeStorage.ts";
      const store = await import(path);
      const meta = store.listCachedCartridges()[0];
      const body = await store.loadAuthoredCartridge(meta.slug);
      return {
        transcript: body.transcript,
        authoringState: body.authoringState,
        index: JSON.parse(localStorage.getItem(store.getStorageKey(meta.slug))!),
      };
    });
    expect(restored.transcript).toEqual(transcript);
    expect(restored.authoringState).toEqual(context.authoringState);
    expect(restored.index.storage).toBe("indexeddb");
    expect(restored.index.transcript).toBeUndefined();
    expect(await other.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBeNull();
    expect(calls).toBe(0);
    await other.screenshot({ path: "test-results/project-ready.png" });
    await other.getByTestId("btn-resume-cached").click();
    await other.unroute("**/api/**");
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
    await other.getByTestId("power-up").click();
    await configureAi(other, { provider: "openai", key: "test-placeholder" });
    await expect(other.getByTestId("agent-bubble-input")).toBeEnabled();
    expect(requests).toHaveLength(0);
    await other.getByTestId("agent-bubble-input").fill("Continue our garden.");
    await other.getByTestId("agent-bubble-send").click();
    await expect(other.getByTestId("agent-bubble")).toBeHidden();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("Private genesis idea");
    expect(JSON.stringify(requests[0])).toContain("Continue our garden.");
    expect(requests[0]?.["model"]).toBe("gpt-6-astra");
    const continuationDownload = other.waitForEvent("download");
    await openGameOptions(other, "save-share-menu");
    await other.getByTestId("btn-save-live-project").click();
    const continued = await continuationDownload;
    const continuation = await readGameZip(
      new Uint8Array(await readFile((await continued.path())!)),
    );
    expect(continuation.project?.provider).toBe("openai");
    expect(continuation.project?.conversationHistory?.[0]?.transcript).toEqual(transcript);
    expect(JSON.stringify(continuation.project?.transcript)).toContain("Continue our garden.");
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
    indexedDB.open = () => {
      throw new Error("Storage unavailable");
    };
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/cartridgeStorage.ts";
    const storage = await import(path);
    const saved = await storage.saveAuthoredCartridge("blocked", {
      title: "Cannot save",
      provider: "stub",
      model: "offline-stub",
      files: { "VOL.0": new Uint8Array([1, 2, 3]) },
      words: [],
    });
    return { saved, index: localStorage.getItem(storage.getStorageKey("blocked")) };
  });
  expect(result).toEqual({ saved: false, index: null });
});
