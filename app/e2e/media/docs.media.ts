import { expect, test } from "../test.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../../src/project/projectSession.ts";
import { createStarterProject } from "../../../src/authoring/starterProject.ts";
import { encodePngRgba } from "../../../src/creative/composite.ts";
import { EGA_RGB } from "../../../scripts/png.ts";
import { configureAi, isolateStorage, settled, textHook, workspaceSaved } from "../engineProbe.ts";
import {
  focusWorkspaceLogic,
  workspaceDocumentEnd,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "../workspaceShared.ts";

/** Original project screenshots from the real app with the deterministic stub provider. */
async function shot(page: Page, name: string): Promise<void> {
  // Nothing hovers: the pointer rests in the status bar's corner.
  await page.mouse.move(1439, 899);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    scale: "css",
    animations: "disabled",
    caret: "hide",
  });
}

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  // Only the catalog and the stored fixtures: no games from a local games/ folder.
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  // The shipped display: square-pixel test mode off, 4:3 like a monitor of the day.
  await page.addInitScript(() => localStorage.setItem("monotio_agi.originalAspect", "on"));
});

async function starter(page: Page): Promise<void> {
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("My adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await settled(page);
}

/** Build a sheet from Starter's original hero, with gaps for frame detection. */
function heroSheet(): Buffer {
  const cels = createStarterProject("starter").sources.views.get(0)!.loops[0]!.cels!;
  const height = Math.max(...cels.map((cel) => cel.height)) + 8;
  const width = cels.reduce((sum, cel) => sum + cel.width * 2 + 8, 0);
  const rgba = new Uint8Array(width * height * 4);
  let left = 4;
  for (const cel of cels) {
    for (let y = 0; y < cel.height; y++)
      for (let x = 0; x < cel.width; x++) {
        const colour = cel.pixels[y * cel.width + x]!;
        if (colour === (cel.transparentColor ?? 0)) continue;
        const rgb = EGA_RGB[colour]!;
        for (let dx = 0; dx < 2; dx++)
          rgba.set([...rgb, 255], ((y + 4) * width + left + x * 2 + dx) * 4);
      }
    left += cel.width * 2 + 8;
  }
  return Buffer.from(encodePngRgba(width, height, rgba));
}

test("home-1.2", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("catalog-play-adventure-department")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(() => [...document.images].every((image) => image.complete)))
    .toBe(true);
  await shot(page, "home-1.2");
});

test("new-game-1.2", async ({ page }) => {
  await page.goto("/#create-adventure");
  await expect(page.getByTestId("local-create-kind-starter")).toBeVisible();
  await shot(page, "new-game-1.2");
});

test("play-crt-1.2", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("monotio_agi.crt", "on"));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await settled(page);
  await shot(page, "play-crt-1.2");
});

test("workspace-picture-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await shot(page, "workspace-picture-1.2");
});

test("logic-problems-1.2", async ({ page }) => {
  await starter(page);
  const source = await workspaceDocument(page, "logic:1");
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    source.replace("return;", "unknown.command();\nreturn;"),
  );
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("workspace-problems")).toContainText("unknown.command");
  await focusWorkspaceLogic(page);
  await workspaceDocumentEnd(page);
  await shot(page, "logic-problems-1.2");
});

test("view-cels-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-view:0").click();
  await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
  await page
    .getByTestId("image-file")
    .setInputFiles({ name: "starter-hero.png", mimeType: "image/png", buffer: heroSheet() });
  await expect(page.getByTestId("image-frame").first()).toBeVisible();
  await page.getByTestId("image-add-cels").click();
  await expect(page.getByTestId("image-status")).toContainText("Added");
  await workspaceSaved(page);
  await shot(page, "cels-from-image-1.2");
  await page
    .getByTestId("image-reference")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(page.getByTestId("sprite-timeline")).toBeVisible();
  await shot(page, "view-editor-1.2");
});

test("words-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-words").click();
  await expect(page.getByTestId("workspace-words-editor")).toBeVisible();
  await page.getByLabel("A sentence a player might type").fill("look at the tree");
  await expect(page.getByTestId("sentence-parse")).toContainText("look");
  await shot(page, "words-1.2");
});

test("sound-grid-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-sound:1").click();
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await shot(page, "sound-grid-1.2");
});

test("agent-review-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:logic").click();
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByTestId("agent-message").fill("Add a welcome sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect(page.getByTestId("agent-code-diff").locator(".line-insert").first()).toBeVisible();
  await expect(page.getByTestId("agent-art-review").locator("img").last()).toBeVisible();
  await workspaceSaved(page);
  await shot(page, "agent-review-1.2");
});

test("history-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:logic").click();
  const source = await workspaceDocument(page, "logic:1");
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    source.replace(/print\("[^"\n]*"\)/, 'print("Welcome to my adventure.")'),
  );
  await workspaceSaved(page);
  await page.getByTestId("workspace-saved").click();
  await expect(page.getByTestId("workspace-history")).toBeVisible();
  await page.getByLabel("Version name", { exact: true }).fill("Opening message");
  await page.getByRole("button", { name: "Name this version", exact: true }).click();
  await expect(page.getByLabel("Version name", { exact: true })).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const history = session.capture().history;
        return history.tags["Opening message"] === history.cursor;
      }),
    )
    .toBe(true);
  await workspaceSaved(page);
  await shot(page, "history-1.2");
});
