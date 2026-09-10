import { providerReply } from "../../test/provider-stream.ts";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { disassembleLogic } from "../../src/logic/disassembler.ts";
import {
  configureAi,
  isolateStorage,
  openDeveloperActivity,
  openGameOptions,
  openLibraryActions,
  openSavedGameDetails,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";

test("a friend opens an exported world in a fresh browser without a key", async ({
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
  if ((await textHook(page)).modal) {
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  }
  await page.getByTestId("input-line").fill("east");
  await page.getByTestId("input-line").press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("generated room 2");
  const downloading = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-export-live-zip").click();
  const zip = await downloading;
  const context = await browser.newContext();
  try {
    const friend = await context.newPage();
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
    if ((await textHook(friend)).modal) {
      await friend.keyboard.press("Enter");
      await expect.poll(async () => (await textHook(friend)).modal).toBeNull();
    }
    await friend.getByTestId("input-line").fill("east");
    await friend.getByTestId("input-line").press("Enter");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("generated room 2");
    expect(providerCalls).toBe(0);
    expect(await friend.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBeNull();
    await friend.screenshot({ path: "test-results/shared-zip-playing.png" });
    await friend.getByTestId("btn-eject").click();
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
    // mock takes precedence over the API-blocking fallback.
    await expect.poll(async () => (await textHook(friend)).room).toBe(1);
    await expect.poll(async () => (await textHook(friend)).cycle).toBeGreaterThan(0);
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
                    name: "write_logic_source",
                    arguments: JSON.stringify({
                      room: 1,
                      source: patchedSource,
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
    await friend.getByTestId("power-up").click();
    await expect(friend.getByTestId("connect-assistant-ai")).toBeVisible();
    await friend.screenshot({ path: "test-results/power-up-connect.png" });
    await configureAi(friend, { provider: "openai", key: "test-placeholder" });
    await expect(friend.getByTestId("agent-bubble-input")).toBeEnabled();
    await friend.getByTestId("agent-bubble-input").fill("remix the room description");
    await friend.getByTestId("agent-bubble-send").click();
    await expect(friend.getByTestId("agent-bubble")).toBeHidden();
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("Remixed room one.");
    expect(remixRequests).toHaveLength(2);
    await friend.screenshot({ path: "test-results/shared-zip-remixed.png" });
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
                  name: "write_logic_source",
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
  await page.getByTestId("power-up").click();
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("remix the room description");
  await page.getByTestId("agent-bubble-send").click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("A remixed v3 adventure.");
  const downloading = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-export-live-zip").click();
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
    // Cover a cold worker request instead of depending on the runner's load speed.
    await friend.route("**/engine.worker.ts*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await route.continue();
    });
    await friend.goto(page.url());
    await friend.getByTestId("game-zip-input").setInputFiles((await download.path())!);
    await friend.getByTestId("btn-resume-cached").click();
    // A fresh browser must load and boot its worker before it can paint game text.
    await expect
      .poll(async () => (await textHook(friend)).profile, { timeout: 15_000 })
      .toBe("3.002.149");
    await expect
      .poll(async () => (await textHook(friend)).rows.join(" "))
      .toContain("A remixed v3 adventure.");
    await friend.screenshot({ path: "test-results/shared-v3-zip-remixed.png" });
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
  await page.getByTestId("btn-eject").click();
  const before = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("monotio_agi.authored."))!;
    return { key, data: JSON.parse(localStorage.getItem(key)!) };
  });
  const card = savedGameCard(page, "Custom Adventure");
  await openSavedGameDetails(card);
  await card.getByTestId("rename-game").click();
  const name = card.getByRole("textbox", { name: "Game name", exact: true });
  await expect(name).toBeFocused();
  await name.fill("Discard this name");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByTestId("saved-game-title")).toHaveText(before.data.title);
  await card.getByTestId("rename-game").click();
  await name.fill("   ");
  await expect(page.getByRole("button", { name: "Save name", exact: true })).toBeDisabled();
  await name.fill("  The Midnight Appointment  ");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/rename-game-mobile.png" });
  await name.press("Enter");
  const renamedCard = savedGameCard(page, "The Midnight Appointment");
  await expect(renamedCard.getByTestId("saved-game-title")).toHaveText("The Midnight Appointment");
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), before.key);
  expect(after).toEqual({ ...before.data, title: "The Midnight Appointment" });
  await page.reload();
  await expect(renamedCard.getByTestId("saved-game-title")).toHaveText("The Midnight Appointment");
  await openSavedGameDetails(renamedCard);
  const downloading = page.waitForEvent("download");
  await openLibraryActions(page, renamedCard);
  await page.getByTestId("btn-export-agi-zip").click();
  const exported = await downloading;
  const content = await readGameZip(new Uint8Array(await readFile((await exported.path())!)));
  expect(content.title).toBe("The Midnight Appointment");
  const context = await browser.newContext();
  try {
    const friend = await context.newPage();
    await friend.goto(page.url());
    await friend.getByTestId("game-zip-input").setInputFiles((await exported.path())!);
    const friendCard = savedGameCard(friend, "The Midnight Appointment");
    await friendCard.getByTestId("btn-resume-cached").click();
    await expect(friend.getByTestId("input-line")).toBeVisible();
    await friend.getByTestId("btn-eject").click();
    await expect(friendCard.getByTestId("saved-game-title")).toHaveText("The Midnight Appointment");
  } finally {
    await context.close();
  }
});
