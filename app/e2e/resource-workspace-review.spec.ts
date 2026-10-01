import { expect, test, reviewShot } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import {
  isolateStorage,
  openWorldRoom,
  waitForCycles,
  waitForRoom,
  textHook,
} from "./engineProbe.ts";
import { openContainer } from "../../src/container/container.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

/**
 * Cross-editor coherence in the real app: a local project holds its native
 * files and its workspace envelope together. An ordinary Room or Sprite
 * Studio Keep — the live commit path over the running game — must leave
 * the envelope verifying against the files it describes, so the next Logic
 * Studio build and Keep is not refused by a stale claim the other editor
 * left behind. The Logic Keep is also exercised first, so both orders of
 * the same two editors are covered.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** Create a local project through the same dialog a player uses; returns its id. */
async function createLocal(
  page: Page,
  title: string,
  kind: "boilerplate" | "starter",
): Promise<string> {
  await page.getByTestId("create-adventure-toggle").click();
  const form = page.locator(".local-create");
  await expect(form.getByRole("button", { name: "Start building", exact: true })).toBeEnabled();
  await form.getByRole("textbox").fill(title);
  await form.getByRole("radio", { name: new RegExp(kind, "i") }).click();
  await form.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1, { coldBoot: true });
  return page.evaluate(async (name) => {
    const { listStoredProjects } = await import("/src/project/gameStorage.ts");
    const entry = (await listStoredProjects()).find((game) => game.title === name);
    if (!entry) throw new Error("created project missing");
    return entry.projectId as string;
  }, title);
}

/** Seed a local project through production persistence without booting it. */
async function seedLocal(
  page: Page,
  title: string,
  kind: "boilerplate" | "starter",
): Promise<string> {
  return page.evaluate(
    async ({ name, template }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const project = prepareLocalProject({ title: name, kind: template });
      await project.save();
      return project.projectId as string;
    },
    { name: title, template: kind },
  );
}

/** Open a stored project's Logic Studio from its library card's Edit item. */
async function editFromLibrary(page: Page, title: string): Promise<void> {
  const card = page
    .getByTestId("saved-game-gallery")
    .locator("[data-project-id]")
    .filter({ has: page.getByTestId("saved-game-title").filter({ hasText: title }) });
  const trigger = card.getByRole("button", { name: "Game actions", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
}

/** Boot a stored project from its library card into room 1, in Create. */
async function playFromLibrary(page: Page, title: string): Promise<void> {
  const card = page
    .getByTestId("saved-game-gallery")
    .locator("[data-project-id]")
    .filter({ has: page.getByTestId("saved-game-title").filter({ hasText: title }) });
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  if ((await textHook(page)).modal === "print") {
    await page.locator(".screen").click();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  }
  await waitForRoom(page, 1, { coldBoot: true });
  const create = page.getByRole("radio", { name: "Create", exact: true });
  if ((await create.getAttribute("aria-checked")) !== "true") await create.click();
  await expect(page).toHaveURL(/#create\//);
  await waitForCycles(page, 2);
}

/** The shell entry the library's Edit uses, over the running game. */
async function openLogicStudio(page: Page, projectId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { __AGI_LOGIC__: { open(projectId: string): void } }).__AGI_LOGIC__.open(
      id,
    );
  }, projectId);
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
}

async function appendComment(page: Page, text: string): Promise<void> {
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

/** Build the draft and confirm the Keep in its review dialog. */
async function buildAndKeep(page: Page): Promise<void> {
  await page.getByTestId("logic-review-build").click();
  await expect(page.getByTestId("logic-review-dialog")).toBeVisible();
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
}

async function closeLogicStudio(page: Page): Promise<void> {
  await page.getByTestId("logic-close").click();
  await expect(page.getByTestId("logic-studio")).toBeHidden();
}

/** What the stored record now holds for one resource and its workspace claim. */
interface StoredClaim {
  readonly bytes: number[];
  readonly claim: string | number[] | undefined;
  readonly sourceReview: boolean;
  readonly rejected: string[];
  readonly logicOne: string | null;
}

async function storedClaim(
  page: Page,
  projectId: string,
  kind: "picture" | "view",
  num: number,
): Promise<StoredClaim> {
  const stored = await page.evaluate(
    async ({ id, resource, resNum }) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
      const data = (await loadAuthoredGame(id as never))!;
      const document = data.workspace?.documents.find((doc) => doc.key === `${resource}:${resNum}`);
      const logic = data.workspace?.documents.find((doc) => doc.key === "logic:1");
      const inspection = inspectEditableProject(data);
      return {
        files: Object.fromEntries(
          Object.entries(data.files).map(([name, bytes]) => [name, [...bytes]]),
        ),
        claim:
          document?.content.type === "text"
            ? document.content.text
            : document
              ? [...document.content.bytes]
              : undefined,
        sourceReview: inspection.requiresSourceReview,
        rejected: Object.keys(inspection.rejectedSources),
        logicOne: logic?.content.type === "text" ? logic.content.text : null,
      };
    },
    { id: projectId, resource: kind, resNum: num },
  );
  const container = openContainer(
    new Map(Object.entries(stored.files).map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  );
  return {
    bytes: [...container.getResource(kind, num)!],
    claim: stored.claim,
    sourceReview: stored.sourceReview,
    rejected: stored.rejected,
    logicOne: stored.logicOne,
  };
}

/** Draw a filled rect by keyboard on the Room Studio canvas: 20,120 to 40,140. */
async function drawRect(page: Page, studio: Locator): Promise<void> {
  const repeat = async (key: string, times: number): Promise<void> => {
    for (let k = 0; k < times; k++) await page.keyboard.press(key);
  };
  await page.keyboard.press("r");
  await studio.getByTestId("studio-tool-filled").press("Space");
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await repeat("Shift+ArrowLeft", 7);
  await repeat("ArrowLeft", 4);
  await repeat("Shift+ArrowDown", 4);
  await repeat("ArrowDown", 4);
  await page.keyboard.press("Space");
  await repeat("Shift+ArrowRight", 2);
  await repeat("ArrowRight", 4);
  await repeat("Shift+ArrowDown", 2);
  await repeat("ArrowDown", 4);
  await page.keyboard.press("Space");
}

test("a Room Studio Keep keeps the workspace agreeing so Logic Studio still builds and keeps @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seedLocal(page, "Workspace coherence", "boilerplate");
  await page.reload();

  // Reverse order first: a Logic Studio Keep lands on the stored project
  // before the game boots and before the resource Keep.
  await editFromLibrary(page, "Workspace coherence");
  await appendComment(page, "// kept before the room edit");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await buildAndKeep(page);
  await closeLogicStudio(page);
  await playFromLibrary(page, "Workspace coherence");

  // The running game's Room Studio draws and keeps a real picture change.
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await drawRect(page, studio);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const draft = Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
  await reviewShot(page, "resource-workspace-room-draft");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await reviewShot(page, "resource-workspace-room-kept");
  await studio.getByTestId("studio-close").click();

  // The same conditional write left files and envelope agreeing: the kept
  // bytes are stored, the picture's claim is its new source, the Logic
  // Keep's commented text survives, and re-verification finds nothing stale.
  const stored = await storedClaim(page, projectId, "picture", 1);
  expect(stored.bytes).toEqual([...draft]);
  expect(typeof stored.claim).toBe("string");
  expect(stored.claim as string).toContain("20,120");
  expect([...compilePictureSource(stored.claim as string).bytes]).toEqual(stored.bytes);
  expect(stored.logicOne).toContain("// kept before the room edit");
  expect(stored.sourceReview).toBe(false);
  expect(stored.rejected).toEqual([]);

  // Reopening builds and keeps a further LOGIC edit without review refusal.
  await openLogicStudio(page, projectId);
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "kept before the room edit",
  );
  await appendComment(page, "// kept after the room edit");
  await buildAndKeep(page);
  await reviewShot(page, "resource-workspace-logic-rekept");
  const again = await storedClaim(page, projectId, "picture", 1);
  expect(again.logicOne).toContain("// kept after the room edit");
  expect(again.claim).toBe(stored.claim);
  await closeLogicStudio(page);

  expect(providerCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("a Sprite Studio Keep keeps the workspace agreeing so Logic Studio still builds and keeps @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await createLocal(page, "Sprite coherence", "starter");

  // Sprite Studio repaints a pixel of the ego's VIEW 0 and keeps it.
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-sprite-0").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  await studio.locator('[data-colour="4"]').click();
  await studio.locator('[data-loop="0"][data-cel="0"]').click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("b");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await reviewShot(page, "resource-workspace-sprite-draft");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await reviewShot(page, "resource-workspace-sprite-kept");
  await studio.getByTestId("studio-close").click();

  const stored = await storedClaim(page, projectId, "view", 0);
  if (typeof stored.claim === "string") {
    // A verified spec claim rebuilds exactly the kept VIEW bytes.
    expect([...buildView(JSON.parse(stored.claim) as BuildViewInput, DEFAULT_V2_PROFILE)]).toEqual(
      stored.bytes,
    );
  } else {
    expect(stored.claim).toEqual(stored.bytes);
  }
  expect(stored.sourceReview).toBe(false);
  expect(stored.rejected).toEqual([]);

  await openLogicStudio(page, projectId);
  await appendComment(page, "// kept after the sprite edit");
  await buildAndKeep(page);
  const again = await storedClaim(page, projectId, "view", 0);
  expect(again.logicOne).toContain("// kept after the sprite edit");
  expect(again.claim).toEqual(stored.claim);
  await closeLogicStudio(page);

  expect(providerCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});
