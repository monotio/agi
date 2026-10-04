import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom, openWorkspaceView } from "./engineProbe.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";

test("VIEW context is reachable in Focus with room preview and game pacing", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  const studio = await openWorkspaceView(page, 0, false);
  await expect(studio.getByTestId("sprite-usage")).toBeVisible();
  await studio.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = studio.getByTestId("sprite-preview");
  await expect(preview).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toBeInViewport();
  await expect(preview.getByRole("radio", { name: "Game", exact: true })).toHaveAttribute(
    "title",
    /hero changes pose every 6 game ticks/,
  );
  await expect(studio.getByTestId("sprite-room-preview")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("view-context.png") });
});

test("a character sheet opens its staged candidate in the workspace VIEW editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await page.evaluate(async () => {
    const path = "/src/references/referenceUploadState.ts";
    const { referenceUpload } = await import(path);
    referenceUpload.open = true;
  });
  const upload = page.getByTestId("reference-upload");
  await expect(upload).toBeVisible();
  await upload.getByTestId("reference-kind-character").click();
  await upload.getByTestId("reference-poses").fill("4");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = "red";
    for (let pose = 0; pose < 4; pose++) ctx.fillRect(pose * 16 + 4, 4, 8, 28);
    return canvas.toDataURL().split(",")[1]!;
  });
  await upload
    .getByTestId("reference-facing-right")
    .setInputFiles({ name: "hero.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await upload.getByTestId("reference-attach").click();
  await expect(upload.getByTestId("reference-preview")).toBeVisible();
  await expect(upload.getByRole("button", { name: "Keep", exact: true })).toHaveCount(0);
  const open = upload.getByTestId("reference-open-sprite");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Open VIEW editor");
  await open.click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  const use = studio.getByRole("button", { name: "Use VIEW", exact: true });
  await expect(use).toBeVisible();
  const bytes = await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]);
  expect(bytes.length).toBeGreaterThan(0);
  const original = openContainer(new Map(Object.entries(buildTutorial().files))).getResource(
    "view",
    0,
  )!;
  expect(bytes).not.toEqual([...original]);
  await page.screenshot({ path: test.info().outputPath("staged-view.png") });
  await use.click();
  await expect(use).toHaveCount(0);
});
