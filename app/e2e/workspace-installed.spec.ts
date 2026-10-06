import { test, expect } from "./test.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  configureAi,
  enterCreateMode,
  isolateStorage,
  waitForRoom,
  workspaceUpdated,
} from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test.describe(`first copy at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 390 });
    test("a host-served edition opens in Create and the first picture edit forks a copy", async ({
      page,
    }) => {
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
      if (viewport.width === 390) await page.getByTestId("workspace-parts").click();
      const part = page.getByTestId("part-room:1:picture:1");
      await expect(part).toBeVisible();
      await part.click();
      const studio = page.getByTestId("room-studio");
      await expect(studio).toBeVisible();
      const stored = () =>
        page.evaluate(async () =>
          (await import("/src/project/gameStorage.ts")).listStoredProjects(),
        );
      expect(await stored()).toHaveLength(0);
      await studio.locator('button[data-tool="line"]').click();
      const box = (await studio.locator(".studio-pane").last().boundingBox())!;
      for (const [x, y] of [
        [40, 110],
        [60, 120],
      ])
        await page.mouse.click(box.x + (x! * box.width) / 160, box.y + (y! * box.height) / 168);
      await studio.getByRole("button", { name: "Done", exact: true }).click();
      const workspace = page.locator(".shell-body");
      const editor = page.getByTestId("workspace-editor");
      const canvas = studio.getByRole("group", { name: /^Canvas/ });
      const pixels = studio.locator(".studio-pane canvas").last();
      const surfaces = [workspace, editor, canvas, pixels];
      for (const surface of surfaces) await expect(surface).toBeVisible();
      const before = await Promise.all(surfaces.map((surface) => surface.boundingBox()));
      await page.screenshot({
        path: test.info().outputPath(`fork-note-${viewport.width}-before.png`),
        animations: "disabled",
        scale: "css",
      });
      await workspaceUpdated(page);
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
      const note = page.getByTestId("copy-created-note");
      await expect(note).toBeVisible();
      await expect(note).toHaveText(
        "Saved as your own copy of Sample edition. The original stays unchanged.",
      );
      const subtitle = page.getByTestId("play-origin");
      await expect(subtitle).toBeVisible();
      await expect(subtitle).toHaveText("Your copy of Sample edition");
      await page.screenshot({
        path: test.info().outputPath(`fork-note-${viewport.width}-after.png`),
        animations: "disabled",
        scale: "css",
      });
      expect
        .soft(await Promise.all(surfaces.map((surface) => surface.boundingBox())))
        .toEqual(before);
      await note.getByRole("button", { name: "Close", exact: true }).click({ trial: true });
      if (viewport.width === 1063) await page.keyboard.press("Escape");
      else await note.getByRole("button", { name: "Close", exact: true }).click();
      await expect(note).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await studio.getByRole("group", { name: /^Canvas/ }).focus();
      await page.keyboard.press("ArrowUp");
      await workspaceUpdated(page);
      await expect(note).toHaveCount(0);
      await page.getByTestId("workspace-agent").click();
      const panel = page.getByTestId("workspace-agent-panel");
      await expect(panel).toBeVisible();
      await expect(panel).not.toContainText("Your changes went into your own copy.");
      await expect(note).toHaveCount(0);
      await page.reload();
      await waitForRoom(page, 1);
      await expect(subtitle).toBeVisible();
      await expect(subtitle).toHaveText("Your copy of Sample edition");
      await expect(note).toHaveCount(0);
    });
  });
}
