import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";

/**
 * The AI authoring stack (app/src/agent/authoringLoader.ts) and the Studios
 * load on demand. A cold visit from Home to the tutorial's first room, with
 * Play's own idle warm-up, requests none of these source modules: the agent
 * tool registry, playtest, the lazy authoring entry, the provider SDKs, and
 * any Studio code. scripts/check-bundle-budget.ts holds the production chunk
 * graph to the same line.
 */
const DEFERRED_MODULES: Record<string, RegExp> = {
  "tool registry": /^src\/agent\/tools\.ts$/,
  playtest: /^src\/agent\/playtest\.ts$/,
  "authoring stack": /^app\/src\/agent\/authoringStack\.ts$/,
  "provider SDK": /^app\/node_modules\/(openai|@anthropic-ai\/sdk)\//,
  Studio: /^(app\/)?src\/studio\//,
};

const repository = join(import.meta.dirname, "..", "..");
const app = join(repository, "app");

/**
 * The source modules a requested script carries, relative to the repository
 * root. The production build answers from the chunk graph app/vite.config.ts
 * records beside it; the development server serves one module per request,
 * files outside app/ under /@fs/, and pre-bundled packages under
 * /node_modules/.vite/deps/, named in its optimizer metadata.
 */
function modulesOf(url: URL): readonly string[] {
  const path = decodeURIComponent(url.pathname);
  if (path.startsWith("/assets/")) {
    const graph = JSON.parse(
      readFileSync(join(app, "dist", ".vite", "bundle-graph.json"), "utf8"),
    ) as { chunks: { file: string; modules: string[] }[] };
    return graph.chunks.find((chunk) => `/${chunk.file}` === path)?.modules ?? [];
  }
  if (path.startsWith("/@fs/")) return [relative(repository, path.slice("/@fs".length))];
  const prebundled = path.match(/^\/node_modules\/\.vite\/deps\/([^/]+)$/)?.[1];
  if (prebundled) {
    const { optimized } = JSON.parse(
      readFileSync(join(app, "node_modules", ".vite", "deps", "_metadata.json"), "utf8"),
    ) as { optimized: Record<string, { file: string }> };
    return Object.entries(optimized)
      .filter(([, entry]) => entry.file === prebundled)
      .map(([id]) => `app/node_modules/${id}/`);
  }
  return [`app${path}`];
}

test("Play boots a catalog game without the AI authoring stack, and opening Ask loads it", async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env["AGI_DEPLOY_URL"] !== undefined,
    "A deployed site omits its chunk graph; the local production run and check:bundle cover the build.",
  );
  const origin = new URL(baseURL!).origin;
  await isolateStorage(page);
  const modules: string[] = [];
  const offOrigin: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.protocol.startsWith("http")) return;
    if (url.origin !== origin || url.pathname.startsWith("/api/")) offOrigin.push(url.href);
    else modules.push(...modulesOf(url));
  });
  const deferred = () =>
    Object.entries(DEFERRED_MODULES).flatMap(([name, pattern]) =>
      modules.filter((module) => pattern.test(module)).map((module) => `${name}: ${module}`),
    );

  await page.goto("/");
  await expect(page.getByTestId("catalog-adventure-department").getByRole("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  // Home's catalog thumbnail builds the tutorial: its module loads here.
  expect(modules).toContain("games/adventure-department/game.ts");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  // Play's own idle-time warm-up (the map panel) has run: nothing further
  // is on its way without the player asking for it.
  await expect.poll(() => modules).toContain("app/src/world/WorldPanel.vue");
  expect(deferred(), "deferred modules requested from Home to a cold Play").toEqual([]);

  // No model is connected (the stored default is OpenAI without a key), so
  // Ask opens on its connect prompt: the stack warms on the intent alone.
  await page.getByTestId("menu-assistant").click();
  const bubble = page.getByTestId("agent-bubble");
  await expect(bubble).toContainText("Connect your AI provider to ask about this game.");
  await expect(page.getByTestId("agent-bubble-input")).toBeHidden();
  await expect
    .poll(() => modules, { timeout: 10_000 })
    .toContain("app/src/agent/authoringStack.ts");
  expect(offOrigin, "provider or cross-origin requests").toEqual([]);
});
