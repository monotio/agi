import { readFile } from "node:fs/promises";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { disassembleLogic } from "../../src/logic/disassembler.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";
import {
  configureAi,
  downloadFromSettings,
  enterCreateMode,
  isolateStorage,
  openDeveloperActivity,
  openGameDownload,
  openLibraryActions,
  openWorkspaceAgent,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";
import { expect, keepDetectedProfile, test } from "./test.ts";

test("a friend opens an exported world in a fresh browser without a key @webkit-desktop", async ({
  page,
  browser,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add game", exact: true })).toBeVisible();
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);
  // Room 1's entry LOGIC opens a print window; finish it so "east" reaches the parser.
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("generated room 1.");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await page.getByTestId("input-line").fill("east");
  await page.getByTestId("input-line").press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("generated room 2");
  const downloading = page.waitForEvent("download");
  await downloadFromSettings(page);
  const zip = await downloading;
  const context = await browser.newContext();
  try {
    const friend = await context.newPage();
    await keepDetectedProfile(friend);
    let providerCalls = 0;
    await friend.route("**/api/**", (route) => {
      providerCalls++;
      return route.abort();
    });
    await friend.goto(page.url());
    await expect(friend.getByRole("button", { name: "Add game", exact: true })).toBeVisible();
    await friend.getByTestId("game-zip-input").setInputFiles((await zip.path())!);
    await friend.getByTestId("btn-resume-cached").click();
    await expect(friend.getByTestId("input-line")).toBeVisible();
    await expect.poll(async () => (await textHook(friend)).room).toBe(1);
    // new.room posts its room before the entry LOGIC opens its print window.
    await expect.poll(async () => (await textHook(friend)).modal).toBe("print");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("generated room 1.");
    await friend.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(friend)).modal).toBeNull();
    await friend.getByTestId("input-line").fill("east");
    await friend.getByTestId("input-line").press("Enter");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("generated room 2");
    expect(providerCalls).toBe(0);
    expect(await friend.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBeNull();
    await friend.screenshot({ path: test.info().outputPath("shared-zip-playing.png") });
    await friend.getByTestId("btn-exit").click();
    const before = await friend.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.authored.imported-")),
    );
    expect(before).toHaveLength(1);
    await friend.getByTestId("game-zip-input").setInputFiles({
      name: "broken.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("broken"),
    });
    await expect(friend.getByTestId("game-zip-error")).toContainText("valid game ZIP");
    expect(
      await friend.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.authored.imported-")),
      ),
    ).toEqual(before);
    const bytes = await readFile((await zip.path())!);
    const transfer = await friend.evaluateHandle(
      (data) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(data)], "shared-game.zip", { type: "application/zip" }),
        );
        return transfer;
      },
      [...bytes],
    );
    await friend.getByTestId("game-zip-drop").dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    expect(
      await friend.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.authored.imported-")),
      ),
    ).toHaveLength(1);
    expect(providerCalls).toBe(0);
    await friend.getByTestId("btn-resume-cached").click();
    // Keep interception enabled across the worker boot; the later endpoint
    // mock takes precedence over the API-blocking fallback. The re-import
    // dedupes to the same record, so the friend's latest checkpoint — taken
    // while room 2's print window was parked — is the resume point.
    await expect.poll(async () => (await textHook(friend)).room).toBe(2);
    await expect.poll(async () => (await textHook(friend)).modal).toBe("print");
    await friend.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(friend)).modal).toBeNull();
    await expect.poll(async () => (await textHook(friend)).cycle).toBeGreaterThan(0);
    await friend.getByTestId("input-line").fill("west");
    await friend.getByTestId("input-line").press("Enter");
    await expect.poll(async () => (await textHook(friend)).room).toBe(1);
    // new.room posts its room before the entry LOGIC opens its print window.
    // Finish that interaction before the agent can defer its image behind it.
    await expect.poll(async () => (await textHook(friend)).modal).toBe("print");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("generated room 1.");
    await friend.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(friend)).modal).toBeNull();
    const exported = await readGameZip(bytes);
    const originalSource = disassembleLogic(
      openContainer(new Map(Object.entries(exported.files))).getResource("logic", 1)!,
    );
    expect(originalSource).toContain("You stand in generated room 1.");
    const patchedSource = originalSource.replace(
      "You stand in generated room 1.",
      "Remixed room one.",
    );
    const remixRequests: unknown[] = [];
    await friend.route("**/api/openai/v1/responses", async (route) => {
      remixRequests.push(route.request().postDataJSON());
      await route.fulfill(
        providerReply("openai", {
          id: `remix-${remixRequests.length}`,
          output:
            remixRequests.length === 1
              ? [
                  {
                    type: "function_call",
                    id: "patch",
                    call_id: "patch",
                    name: "propose_changes",
                    arguments: JSON.stringify({
                      label: "Complete the world and remix room one",
                      changes: [
                        { key: "logic:1", content: patchedSource },
                        { key: "logic:3", content: "return;" },
                      ],
                    }),
                  },
                ]
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Ready." }],
                  },
                ],
        }),
      );
    });
    await enterCreateMode(friend);
    await openWorkspaceAgent(friend);
    await expect(friend.getByTestId("workspace-agent-panel")).toContainText(
      "Connect your AI provider in Settings to start a task.",
    );
    await friend.screenshot({ path: test.info().outputPath("power-up-connect.png") });
    await configureAi(friend, { provider: "openai", key: "test-placeholder" });
    await expect(friend.getByTestId("agent-message")).toBeEnabled();
    await friend.getByTestId("agent-message").fill("remix the room description");
    await friend.getByRole("button", { name: "Send", exact: true }).click();
    await expect(friend.getByTestId("agent-review")).toBeVisible();
    await friend.getByTestId("agent-approve").click();
    await expect(friend.getByTestId("agent-review")).toHaveCount(0);
    await friend.getByTestId("input-line").fill("look");
    await friend.getByTestId("input-line").press("Enter");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("Remixed room one.");
    expect(remixRequests).toHaveLength(2);
    await friend.screenshot({ path: test.info().outputPath("shared-zip-remixed.png") });
    await friend.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(friend)).modal).toBeNull();
    const remixDownloading = friend.waitForEvent("download");
    await downloadFromSettings(friend);
    const remixedZip = await remixDownloading;
    const remixedArchive = await readGameZip(await readFile((await remixedZip.path())!));
    const remixedLogic = openContainer(new Map(Object.entries(remixedArchive.files))).getResource(
      "logic",
      1,
    )!;
    expect(Array.from(remixedLogic)).toEqual(
      Array.from(assembleLogic(patchedSource, { dictionary: new Map(exported.words) }).payload),
    );
    const remixedBrowser = await browser.newContext();
    try {
      const recipient = await remixedBrowser.newPage();
      await keepDetectedProfile(recipient);
      await recipient.goto(page.url());
      await recipient.getByTestId("game-zip-input").setInputFiles((await remixedZip.path())!);
      await recipient.getByTestId("btn-resume-cached").click();
      await expect
        .poll(async () => (await textHook(recipient)).rows.join(" "))
        .toContain("Remixed room one.");
      await recipient.screenshot({ path: test.info().outputPath("remixed-zip-fresh-browser.png") });
    } finally {
      await remixedBrowser.close();
    }
  } finally {
    await context.close();
  }
});

test("a v3 game can be imported, remixed, exported and opened in a fresh session", async ({
  page,
  browser,
}) => {
  const files = new Map([
    ["DEMODIR", Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0)],
    ["DEMOVOL.0", new Uint8Array()],
    ["WORDS.TOK", new Uint8Array(52)],
  ]);
  const original = 'display(5, 2, "A shared v3 adventure."); accept.input(); return;';
  const patched = 'display(5, 2, "A remixed v3 adventure."); accept.input(); return;';
  const container = openContainer(files);
  container.putResource("logic", 0, assembleLogic(original, { dictionary: new Map() }).payload);
  const zip = buildZip([...container.files].map(([name, data]) => ({ name, data })));
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "adventure.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("3.002.149");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("A shared v3 adventure.");
  const stillFrame = await textHook(page);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(stillFrame.cycle + 5);
  expect((await textHook(page)).frame).toBe(stillFrame.frame);
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `v3-remix-${requests}`,
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  id: "patch",
                  call_id: "patch",
                  name: "write_logic",
                  arguments: JSON.stringify({ room: 0, source: patched }),
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Ready." }],
                },
              ],
      }),
    );
  });
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await page.getByTestId("agent-message").fill("remix the room description");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("A remixed v3 adventure.");
  const downloading = page.waitForEvent("download");
  await downloadFromSettings(page);
  const download = await downloading;
  const downloaded = await readFile((await download.path())!);
  const imported = await readGameZip(downloaded);
  expect(imported.files["DEMODIR"]).toBeDefined();
  expect(imported.files["LOGDIR"]).toBeUndefined();
  const reloaded = openContainer(new Map(Object.entries(imported.files)));
  expect(disassembleLogic(reloaded.getResource("logic", 0)!)).toContain("A remixed v3 adventure.");
  const expectedPayload = assembleLogic(patched, { dictionary: new Map() }).payload;
  expect(Array.from(reloaded.getResource("logic", 0)!)).toEqual(Array.from(expectedPayload));
  expect(imported.files["DEMOVOL.0"]!.length).toBe(expectedPayload.length + 7);
  const fresh = await browser.newContext();
  try {
    const friend = await fresh.newPage();
    await keepDetectedProfile(friend);
    // Cover a cold worker request instead of depending on the runner's load speed.
    const workerRequested = Promise.withResolvers<void>();
    const releaseWorker = Promise.withResolvers<void>();
    await friend.route("**/engine.worker.ts*", async (route) => {
      workerRequested.resolve();
      await releaseWorker.promise;
      await route.continue();
    });
    await friend.goto(page.url());
    await friend.getByTestId("game-zip-input").setInputFiles((await download.path())!);
    await friend.getByTestId("btn-resume-cached").click();
    await workerRequested.promise;
    expect((await textHook(friend)).profile).toBeNull();
    releaseWorker.resolve();
    // A fresh browser must load and boot its worker before it can paint game text.
    await expect
      .poll(async () => (await textHook(friend)).profile, { timeout: 15_000 })
      .toBe("3.002.149");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("A remixed v3 adventure.");
    await friend.screenshot({ path: test.info().outputPath("shared-v3-zip-remixed.png") });
  } finally {
    await fresh.close();
  }
});

test("rename preserves a saved game and travels with its ZIP", async ({ page, browser }) => {
  const game = openContainer(
    new Map([
      ["LOGDIR", new Uint8Array()],
      ["PICDIR", new Uint8Array()],
      ["VIEWDIR", new Uint8Array()],
      ["SNDDIR", new Uint8Array()],
      ["VOL.0", new Uint8Array()],
      ["WORDS.TOK", new Uint8Array(52)],
    ]),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic('display(5, 2, "A name to remember."); accept.input(); return;', {
      dictionary: new Map(),
    }).payload,
  );
  const zip = buildZip([...game.files].map(([name, data]) => ({ name, data })));
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "Custom Adventure.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await savedGameCard(page, "Custom Adventure").getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("input-line")).toBeVisible();
  await page.getByTestId("btn-exit").click();
  const before = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("monotio_agi.authored."))!;
    return { key, data: JSON.parse(localStorage.getItem(key)!) };
  });
  const card = savedGameCard(page, "Custom Adventure");
  await openLibraryActions(page, card);
  await page.getByTestId("rename-game").click();
  const name = card.getByRole("textbox", { name: "Game name", exact: true });
  await expect(name).toBeFocused();
  await name.fill("Discard this name");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByTestId("saved-game-title")).toHaveText(before.data.title);
  await openLibraryActions(page, card);
  await page.getByTestId("rename-game").click();
  await name.fill("   ");
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
  await name.fill("  The Midnight Appointment  ");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("rename-game-mobile.png") });
  await name.press("Enter");
  const renamedCard = savedGameCard(page, "The Midnight Appointment");
  await expect(renamedCard.getByTestId("saved-game-title")).toHaveText("The Midnight Appointment");
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), before.key);
  // Rename is a serialized write: it bumps the optimistic-concurrency generation.
  expect(after).toEqual({
    ...before.data,
    title: "The Midnight Appointment",
    generation: before.data.generation + 1,
  });
  await page.reload();
  await expect(renamedCard.getByTestId("saved-game-title")).toHaveText("The Midnight Appointment");
  const downloading = page.waitForEvent("download");
  const downloadDialog = await openGameDownload(page, renamedCard);
  await downloadDialog.getByTestId("export-library-game").click();
  const exported = await downloading;
  const content = await readGameZip(new Uint8Array(await readFile((await exported.path())!)));
  expect(content.title).toBe("The Midnight Appointment");
  const context = await browser.newContext();
  try {
    const friend = await context.newPage();
    await keepDetectedProfile(friend);
    await friend.goto(page.url());
    await friend.getByTestId("game-zip-input").setInputFiles((await exported.path())!);
    const friendCard = savedGameCard(friend, "The Midnight Appointment");
    await friendCard.getByTestId("btn-resume-cached").click();
    await expect(friend.getByTestId("input-line")).toBeVisible();
    await friend.getByTestId("btn-exit").click();
    await expect(friendCard.getByTestId("saved-game-title")).toHaveText("The Midnight Appointment");
  } finally {
    await context.close();
  }
});
