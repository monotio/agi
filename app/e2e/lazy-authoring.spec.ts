import { expect, test } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

/**
 * The AI authoring stack — the agent session, the LLM clients and provider
 * SDKs, the tool registry, the prompts — loads on demand
 * (app/src/agent/authoringLoader.ts). These are its script requests: the
 * modules the development server serves one by one, and the provider SDKs
 * it pre-bundles. The production build is held to the same line by
 * scripts/check-bundle-budget.ts.
 */
const AUTHORING_SCRIPT =
  /\/src\/agent\/(authoringStack|agentSession|llmClient)\.ts|\/assets\/authoringStack-[^/]*\.js|\/\.vite\/deps\/(openai|@anthropic-ai_sdk)\.js/;

test("Play boots a catalog game without the AI authoring stack, and opening Ask loads it", async ({
  page,
}) => {
  await isolateStorage(page);
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  const authoring = () => scripts.filter((url) => AUTHORING_SCRIPT.test(url));

  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  // Play's own idle-time warm-up (the map panel) has run: nothing further
  // is on its way without the player asking for it.
  await expect.poll(() => scripts.some((url) => /WorldPanel/.test(url))).toBe(true);
  expect(authoring(), "authoring scripts requested by a cold Play boot").toEqual([]);

  // No model is connected (the stored default is OpenAI without a key), so
  // Ask opens on its connect prompt: the stack warms on the intent alone.
  await page.getByTestId("menu-assistant").click();
  const bubble = page.getByTestId("agent-bubble");
  await expect(bubble).toContainText("Connect your AI provider to ask about this game.");
  await expect(page.getByTestId("agent-bubble-input")).toBeHidden();
  await expect.poll(() => authoring().length, { timeout: 10_000 }).toBeGreaterThan(0);
});
