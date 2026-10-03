import { expect, type Page } from "@playwright/test";
import { isolateStorage, savedGameCard } from "./engineProbe.ts";

/**
 * Shared choreography for the Logic Studio debugger specs: seeding a stored
 * project, opening Studio, driving the test dock and reading the preview's
 * composed frame. Each helper waits on the app's own published state — no
 * wall-clock sleeps.
 */

/** Block real providers; returns a counter the caller asserts stays zero. */
export function blockProviders(page: Page): { count: () => number } {
  let calls = 0;
  void page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    calls++;
    return route.abort();
  });
  return { count: () => calls };
}

/** Fresh storage and a catalog fixture stub — run before page.goto. */
export async function prepareIsolatedPage(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
}

/**
 * Seed a stored project through the same path "Create game" uses. Only valid
 * against the dev/test server — `/src/...` module URLs do not exist in a
 * production build, where specs use the visible create form instead.
 */
export async function seedLocalProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "starter",
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ title, kind }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title, kind });
      await prepared.save();
      return prepared.projectId as string;
    },
    { title, kind },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

/**
 * Create a project through the visible UI form — the production-safe path.
 * Returns the project id once the card exists in the library.
 */
export async function createProjectViaUi(page: Page, title: string): Promise<void> {
  const disclosure = page.getByTestId("create-adventure-disclosure");
  if ((await disclosure.getAttribute("open")) === null) {
    await page.getByTestId("create-adventure-toggle").click();
  }
  await page.getByTestId("local-create-title").fill(title);
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  // Creation can open the project's workspace; the library card holds the
  // Edit entry, so leave the workspace when it took over the shell. Race the
  // exit button against the card so both landings are handled.
  const exit = page.getByTestId("btn-exit");
  const card = savedGameCard(page, title);
  await Promise.race([
    exit.waitFor({ state: "visible", timeout: 30_000 }),
    card.waitFor({ state: "visible", timeout: 30_000 }),
  ]).catch(() => {});
  if (await exit.isVisible().catch(() => false)) await exit.click();
  await expect(card).toBeVisible({ timeout: 30_000 });
}
