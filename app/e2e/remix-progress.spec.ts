import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { buildZip } from "../src/zip.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { configureAi, textHook } from "./engineProbe.ts";

test("remix progress follows activity, preserves reading position and jumps to latest", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic('assignn(v0, 1); display(5, 4, "A little adventure."); accept.input(); return;', {
      dictionary: new Map(),
    }).payload,
  );
  const zip = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
  );
  let requests = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const last = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/openai/v1/responses", async (route) => {
    const request = ++requests;
    if (request === 2) await first;
    if (request === 3) await second;
    if (request === 4) await last;
    const tool = "read_room_context";
    const output =
      request >= 4
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Ready." }],
            },
          ]
        : Array.from({ length: 12 }, (_, i) => ({
            type: "function_call",
            id: `${request}-${i}`,
            call_id: `${request}-${i}`,
            name: tool,
            arguments: JSON.stringify(
              request === 1
                ? {
                    room: null,
                    state: { variables: [i], flags: null, compact: true },
                    frames: null,
                  }
                : request === 2
                  ? { room: null, state: null, frames: null }
                  : {
                      room: null,
                      state: null,
                      frames: { count: 1, stride: 1, sheet: true, plane: null },
                    },
            ),
          }));
    await route.fulfill(providerReply("openai", { id: `reply-${request}`, output }));
  });
  try {
    await page.goto("/");
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "adventure.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zip),
    });
    await page.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await expect(page).toHaveURL(/#play\//);
    await page.getByTestId("power-up").click();
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
    await page.getByTestId("agent-bubble-input").fill("Give the adventurer a blue coat");
    await page.getByTestId("agent-bubble-send").click();
    await expect.poll(() => requests).toBe(2);
    const feed = page.getByTestId("agent-bubble-feed");
    const remaining = () => feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(remaining).toBeLessThan(4);
    await feed.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByTestId("remix-jump-latest")).toBeVisible();
    const firstEntry = await feed.locator(".agent-bubble-line").first().textContent();
    releaseFirst();
    await expect.poll(() => requests).toBe(3);
    await expect(feed).toContainText("read_room_context");
    expect(await feed.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await feed.locator(".agent-bubble-line").first().textContent()).toBe(firstEntry);
    await expect(page.getByTestId("agent-stream-status")).toHaveText("Waiting for the model…");
    await page.screenshot({
      path: "test-results/remix-reading-earlier.png",
      animations: "disabled",
    });
    await page.getByTestId("remix-jump-latest").click();
    await expect.poll(remaining).toBeLessThan(4);
    await expect(page.getByTestId("remix-jump-latest")).toBeHidden();
    releaseSecond();
    await expect.poll(() => requests).toBe(4);
    await expect.poll(remaining).toBeLessThan(4);
    await page.screenshot({
      path: "test-results/remix-following-live.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("agent-stream-status")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Back to game" })).toBeInViewport();
    await page.screenshot({
      path: "test-results/remix-progress-mobile.png",
      animations: "disabled",
    });
    finish();
    await expect(page.getByTestId("agent-bubble")).toBeHidden();
    const savedTranscript = await page.evaluate(async () => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("monotio_agi.authored."))!;
      const modulePath = "/src/gameStorage.ts";
      const { loadAuthoredGame } = await import(modulePath);
      return JSON.stringify(
        (await loadAuthoredGame(key.slice("monotio_agi.authored.".length)))?.transcript,
      );
    });
    expect(savedTranscript).toContain("Give the adventurer a blue coat");
  } finally {
    releaseFirst();
    releaseSecond();
    finish();
  }
});
