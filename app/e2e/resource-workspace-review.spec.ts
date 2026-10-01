import type { Locator, Page } from "@playwright/test";
import { openContainer } from "../../src/container/container.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import {
  closeWorkspaceEditor,
  isolateStorage,
  openWorkspacePicture,
  openWorkspaceView,
  textHook,
  waitForRoom,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  focusWorkspaceLogic,
  openStoredWorkspace,
  openWorkspaceLogic,
  workspaceDocumentEnd,
} from "./workspaceShared.ts";

/** PICTURE, VIEW and LOGIC edits keep stored source and compiled bytes coherent. */
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
  await openStoredWorkspace(page, title);
  await openWorkspaceLogic(page);
}

async function appendComment(page: Page, text: string): Promise<void> {
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
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

test("PICTURE autosave preserves workspace claims for the next LOGIC edit @webkit-desktop", async ({
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

  // A source-only LOGIC edit saves before the resource gesture.
  await editFromLibrary(page, "Workspace coherence");
  await appendComment(page, "// kept before the room edit");
  await workspaceSaved(page);
  await closeWorkspaceEditor(page);
  if ((await textHook(page)).modal === "print") {
    await page.locator(".screen").click();
    await page.keyboard.press("Enter");
  }

  // The running game's Room Studio draws and keeps a real picture change.
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await drawRect(page, studio);
  await workspaceSaved(page);
  const draft = Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
  await reviewShot(page, "resource-workspace-room-draft");
  await workspaceSaved(page);
  await reviewShot(page, "resource-workspace-room-kept");
  await closeWorkspaceEditor(page);

  // The same conditional write left files and envelope agreeing: the kept
  // bytes are stored, the picture's claim is its new source, the Logic
  // The saved commented text survives, and re-verification finds nothing stale.
  const stored = await storedClaim(page, projectId, "picture", 1);
  expect(stored.bytes).toEqual([...draft]);
  expect(typeof stored.claim).toBe("string");
  expect(stored.claim as string).toContain("20,120");
  expect([...compilePictureSource(stored.claim as string).bytes]).toEqual(stored.bytes);
  expect(stored.logicOne).toContain("// kept before the room edit");
  expect(stored.sourceReview).toBe(false);
  expect(stored.rejected).toEqual([]);

  // Reopening builds and keeps a further LOGIC edit without review refusal.
  await openWorkspaceLogic(page);
  await expect(
    page.getByTestId("workspace-logic-editor").filter({ visible: true }).locator(".view-lines"),
  ).toContainText("kept before the room edit");
  await appendComment(page, "// kept after the room edit");
  await workspaceSaved(page);
  await reviewShot(page, "resource-workspace-logic-rekept");
  const again = await storedClaim(page, projectId, "picture", 1);
  expect(again.logicOne).toContain("// kept after the room edit");
  expect(again.claim).toBe(stored.claim);
  await closeWorkspaceEditor(page);

  expect(providerCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("VIEW autosave preserves workspace claims for the next LOGIC edit @webkit-desktop", async ({
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
  await openWorkspaceView(page, 0);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  await studio.locator('[data-colour="4"]').click();
  await studio.locator('[data-loop="0"][data-cel="0"]').click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("b");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await workspaceSaved(page);
  await reviewShot(page, "resource-workspace-sprite-draft");
  await workspaceSaved(page);
  await reviewShot(page, "resource-workspace-sprite-kept");
  await closeWorkspaceEditor(page);

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

  await openWorkspaceLogic(page);
  await appendComment(page, "// kept after the sprite edit");
  await workspaceSaved(page);
  const again = await storedClaim(page, projectId, "view", 0);
  expect(again.logicOne).toContain("// kept after the sprite edit");
  expect(again.claim).toEqual(stored.claim);
  await closeWorkspaceEditor(page);

  expect(providerCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});
