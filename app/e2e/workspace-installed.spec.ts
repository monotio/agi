import { test, expect } from "./test.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  configureAi,
  enterCreateMode,
  isolateStorage,
  waitForRoom,
  workspaceSaved,
} from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

test("a host-served edition opens in Create and the first picture edit forks a copy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const files = buildTutorial().files;
  const revision = await gameRevision(files);
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/")
      return route.fulfill({ json: [{ folder: "sample", title: "Sample edition", revision }] });
    if (path === "/fixtures/sample/") return route.fulfill({ json: Object.keys(files) });
    const bytes = files[path.split("/").at(-1)!];
    return route.fulfill(
      bytes
        ? { body: Buffer.from(bytes), contentType: "application/octet-stream" }
        : { status: 404 },
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("boot-sample").click();
  await waitForRoom(page, 1);
  await enterCreateMode(page);
  const part = page.getByTestId("part-room:1:picture:1");
  await expect(part).toBeVisible();
  await part.click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  const stored = () =>
    page.evaluate(async () => (await import("/src/project/gameStorage.ts")).listStoredProjects());
  expect(await stored()).toHaveLength(0);
  await studio.locator('button[data-tool="line"]').click();
  const box = (await studio.locator(".studio-pane").last().boundingBox())!;
  for (const [x, y] of [
    [40, 110],
    [60, 120],
  ])
    await page.mouse.click(box.x + (x! * box.width) / 160, box.y + (y! * box.height) / 168);
  await studio.getByRole("button", { name: "✓ Done", exact: true }).click();
  await workspaceSaved(page);
  const copies = await stored();
  expect(copies).toHaveLength(1);
  expect(copies[0]!.library?.source).toBe("remix");
  expect(copies[0]!.library?.parent?.revision).toBe(revision);
  expect(copies[0]!.projectId).not.toBe("sample");
  const saved = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return [...session.capture().snapshot.lastAdmissibleBuild!.files().get("WORDS.TOK")!];
  });
  expect(saved).toEqual([...files["WORDS.TOK"]!]);
  await page.getByTestId("workspace-agent").click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  const note = panel.getByRole("status", { includeHidden: true }).filter({
    hasText: "Your changes went into your own copy.",
  });
  await expect(note).toBeVisible();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(note).toBeVisible();
    await note.evaluate((element) => {
      element.style.visibility = "hidden";
    });
    await page.screenshot({
      path: test.info().outputPath(`fork-note-${width}-before.png`),
      scale: "css",
    });
    await note.evaluate((element) => {
      element.style.visibility = "";
    });
    await page.screenshot({
      path: test.info().outputPath(`fork-note-${width}-after.png`),
      scale: "css",
    });
  }
});
