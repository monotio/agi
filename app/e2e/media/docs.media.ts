import { expect, test } from "../test.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../../src/project/projectSession.ts";
import { createStarterProject } from "../../../src/authoring/starterProject.ts";
import { encodePngRgba } from "../../../src/creative/composite.ts";
import { EGA_RGB } from "../../../scripts/png.ts";
import {
  configureAi,
  isolateStorage,
  openWorkspaceAgent,
  settled,
  textHook,
  workspaceSaved,
} from "../engineProbe.ts";
import { open, start } from "../pictureWorkspaceShared.ts";
import { openRoomGenerationGame, walkInto } from "./roomGeneration.ts";
import {
  clickPictureCell,
  focusWorkspaceLogic,
  runningWorkspaceDocument,
  workspaceDocumentEnd,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "../workspaceShared.ts";

/** Original project screenshots from the real app with the deterministic stub provider. */
async function shot(page: Page, name: string, pointer: "rest" | "keep" = "rest"): Promise<void> {
  // Nothing hovers: the pointer rests in the status bar's corner.
  if (pointer === "rest") await page.mouse.move(1439, 899);
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
    false,
  );
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("workspace-problems")).toContainText("unknown.command");
  // Problems is its own tab; the LOGIC tab shows the marked line.
  await page.getByTestId("project-tab-logic:1").click();
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
  // Focus gives the grid the workspace while the game keeps running.
  await page.getByTestId("workspace-focus").click();
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

test("blank-start-1.2", async ({ page }) => {
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("My game");
  await page.getByTestId("local-create-kind-blank").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  const stage = page.getByTestId("empty-project-stage");
  await expect(stage.getByText("Nothing to play yet.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("empty-add-room")).toBeVisible();
  await shot(page, "blank-start-1.2");
});

test("agent-drawer-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
  await expect(page.getByTestId("agent-message")).toBeFocused();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByTestId("agent-context-chip")).toContainText("PICTURE 1 ·");
  await page.getByTestId("agent-message").fill("Make the sun lower, as if it were evening");
  await shot(page, "agent-drawer-1.2");
});

test("picture-line-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await page.getByTestId("workspace-focus").click();
  await studio.locator('button[data-tool="line"]').click();
  await studio.locator('.workspace-palette__choices button[data-colour="15"]').click();
  for (const [x, y] of [
    [22, 150],
    [48, 128],
    [80, 122],
    [112, 128],
  ] as const)
    await clickPictureCell(studio, x, y);
  const path = page.getByTestId("workspace-context").getByTestId("studio-path");
  await expect(path).toContainText("Line · 4 points");
  // The next segment follows the pointer until Done.
  const pane = studio.locator(".studio-pane").last();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + (138.5 * box.width) / 160, box.y + (150.5 * box.height) / 168);
  await shot(page, "picture-line-1.2", "keep");
});

test("launch-menu-1.2", async ({ page }) => {
  await start(page);
  await workspaceSaved(page);
  await open(page, "part-room:1:logic");
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "New launch…" }).click();
  const name = page.getByTestId("launch-name-input");
  await expect(name).toBeVisible();
  await page.getByTestId("launch-add-row-menu").click();
  await page.getByRole("menuitem", { name: "Came from" }).click();
  await expect(page.getByTestId("launch-row-came-from")).toBeVisible();
  await page.getByTestId("launch-came-from-room").selectOption("8");
  await page.getByTestId("launch-add-row-menu").click();
  await page.getByRole("menuitem", { name: "Flag" }).click();
  await expect(page.getByTestId("launch-row-flag")).toBeVisible();
  await page.getByTestId("launch-flag-select").selectOption("204");
  await page.getByTestId("launch-flag-toggle").click();
  await page.getByTestId("launch-add-row-menu").click();
  await page.getByRole("menuitem", { name: "Same random each time" }).click();
  await expect(page.getByTestId("launch-row-seed")).toBeVisible();
  await page.getByTestId("launch-select-for-run").click();
  await expect(page.getByTestId("launch-selected-badge")).toBeVisible();
  // The name goes in last, once the project holds every row: an edit made
  // before the previous one lands can bring back "Launch 1".
  await expect.poll(() => launchNames(page)).toEqual(["Launch 1"]);
  await name.fill("Back from the garden");
  await name.press("Tab");
  await expect.poll(() => launchNames(page)).toEqual(["Back from the garden"]);
  await workspaceSaved(page);
  await page.getByTestId("workspace-update-menu").click();
  await expect(page.getByRole("menuitem", { name: "Carry over" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Back from the garden", exact: true }),
  ).toBeVisible();
  await shot(page, "launch-menu-1.2", "keep");
});

/** The names of room 1's Launches in the working project. */
function launchNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const world = session.workingSnapshot().read("world")?.content;
    if (typeof world !== "string") return [];
    const launches = (
      JSON.parse(world) as {
        launches?: Record<string, { entries: { name: string; seed?: number }[] }>;
      }
    ).launches;
    return (launches?.["1"]?.entries ?? []).map((entry) =>
      entry.seed === undefined ? `${entry.name} (no seed yet)` : entry.name,
    );
  });
}

test("action-states-1.2", async ({ page }) => {
  await start(page);
  await workspaceSaved(page);
  const action = page.getByTestId("workspace-update");
  const bar = page.getByRole("banner");
  const crops: { label: string; png: Buffer }[] = [];
  const crop = async (label: string) => {
    await page.mouse.move(1439, 899);
    const box = (await bar.boundingBox())!;
    crops.push({
      label,
      png: await page.screenshot({
        clip: { x: 500, y: box.y, width: 940, height: box.height },
        scale: "css",
        animations: "disabled",
        caret: "hide",
      }),
    });
  };
  await open(page, "part-room:1:logic");
  await focusWorkspaceLogic(page);
  await expect(action).toHaveAccessibleName("Restart Home");
  await crop("Restart Home · the game is in Home and up to date");
  await open(page, "part-room:8:logic");
  await expect(action).toHaveAccessibleName("Play Garden");
  await crop("Play Garden · you are editing Garden while the game is in Home");
  const source = await runningWorkspaceDocument(page, "logic:8");
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    source.replace("accept.input();", 'accept.input(); print("The garden gate creaks.");'),
  );
  await page.keyboard.press("Escape");
  await workspaceSaved(page);
  await expect(action).toHaveAccessibleName("Update and restart Garden");
  await crop("Update and restart Garden · an edit is waiting for the game");
  // One image: the three bars stacked, each with its state named underneath.
  await page.setContent(
    `<body style="margin:0;background:#0e1b1d"><div id="states" style="display:inline-block;padding:20px 0 4px;font:500 18px/1.3 system-ui,sans-serif;color:#cfe0dd">${crops
      .map(
        ({ label, png }) =>
          `<figure style="margin:0 0 18px"><img style="display:block;width:940px" src="data:image/png;base64,${png.toString("base64")}"><figcaption style="padding:8px 24px 0">${label}</figcaption></figure>`,
      )
      .join("")}</div></body>`,
  );
  await page.locator("#states").screenshot({
    path: test.info().outputPath("action-states-1.2.png"),
    scale: "css",
  });
});

test("test-run-1.2", async ({ page }) => {
  await starter(page);
  const chip = page
    .getByTestId("workspace-game-bar")
    .getByRole("button", { name: "Test run", exact: true });
  await expect(chip).toBeVisible();
  await chip.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.mouse.move(1439, 899);
  await page.screenshot({
    path: test.info().outputPath("test-run-1.2.png"),
    scale: "css",
    animations: "disabled",
    caret: "hide",
  });
});

test("room-setting-1.2", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await page.getByTestId("workspace-more").click();
  await page.getByRole("menuitem", { name: "Details…", exact: true }).click();
  const details = page.getByTestId("workspace-game-details");
  await expect(details).toBeVisible();
  const setting = details.getByRole("switch", {
    name: "AI makes new rooms when the hero walks into one",
    exact: true,
  });
  await expect(setting).toBeVisible();
  await setting.click();
  await expect(setting).toHaveAttribute("aria-checked", "true");
  await shot(page, "room-setting-1.2");
});

test("room-generation-1.2", async ({ page }) => {
  const room = await openRoomGenerationGame(page);
  await walkInto(page);
  await expect(page.getByTestId("room-generation")).toBeVisible();
  await expect(page.getByTestId("room-generation-step")).toHaveText("Building the next room…");
  await shot(page, "room-generation-1.2");
  room.release();
});
