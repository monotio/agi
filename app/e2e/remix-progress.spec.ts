import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { buildZip } from "../src/zip.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { textHook } from "./engineProbe.ts";

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
    const tool = request === 1 ? "read_state" : request === 2 ? "read_objects" : "list_resources";
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
              tool === "list_resources"
                ? { kind: ["logic", "picture", "view", "sound"][i % 4] }
                : tool === "read_state"
                  ? { variables: [i], compact: true }
                  : { ids: [i] },
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
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await page.getByTestId("power-up").click();
    await page.getByTestId("power-up-provider").selectOption("openai");
    await page.getByTestId("power-up-api-key").fill("test-placeholder");
    await page.getByTestId("power-up-connect").click();
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
    await expect(feed).toContainText("read_objects");
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
      const modulePath = "/src/cartridgeStorage.ts";
      const { loadAuthoredCartridge } = await import(modulePath);
      return JSON.stringify(
        (await loadAuthoredCartridge(key.slice("monotio_agi.authored.".length)))?.transcript,
      );
    });
    expect(savedTranscript).toContain("Give the adventurer a blue coat");
  } finally {
    releaseFirst();
    releaseSecond();
    finish();
  }
});
