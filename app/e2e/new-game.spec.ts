import { readFile } from "node:fs/promises";
import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook, configureAi } from "./engineProbe.ts";

for (const kind of ["starter", "boilerplate", "blank"] as const) {
  test(`Start building opens ${kind} in Create`, async ({ page }) => {
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await expect(page.getByRole("heading", { name: "Make a new game" })).toBeVisible();
    await expect(
      page.getByTestId("create-adventure-disclosure").getByLabel("Name", { exact: true }),
    ).toBeFocused();
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill(`My ${kind} game`);
    await page.getByTestId(`local-create-kind-${kind}`).click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect(page).toHaveURL(/#create\/local-/);
    if (kind === "blank") {
      await expect(page.getByText("Nothing to play yet. Add a LOGIC 0 to start.")).toBeVisible();
    } else {
      await expect(page.getByTestId("create-dock-left")).toBeVisible();
      if (kind === "boilerplate") {
        await expect.poll(async () => (await textHook(page)).modal).toBe("print");
        await page.locator(".screen").click();
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await textHook(page)).modal).toBe(null);
      }
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      const cycle = (await textHook(page)).cycle;
      await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
    }
    const stored = await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      const entry = (await storage.listStoredProjects()).find((game) =>
        game.projectId.startsWith("local-"),
      )!;
      const project = (await storage.loadAuthoredGame(entry.projectId))!;
      return {
        title: project.title,
        keys: project.workspace?.documents.map((doc) => doc.key) ?? [],
      };
    });
    expect(stored.title).toBe(`My ${kind} game`);
    expect(stored.keys.includes("logic:0")).toBe(kind !== "blank");
    expect(stored.keys.includes("view:0")).toBe(kind === "starter");
    if (kind === "blank") {
      await page.reload();
      await expect(page.getByText("Nothing to play yet. Add a LOGIC 0 to start.")).toBeVisible();
    }
  });
}

test("AI choice reveals full editable sources and creates with the stub provider", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  const starter = page.getByTestId("local-create-kind-starter");
  await starter.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("local-create-kind-ai")).toBeFocused();
  await expect(page.getByTestId("local-create-kind-ai")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Needs an AI key. Connect one in Settings.")).toBeVisible();
  const outline = page.getByRole("textbox", { name: "Adventure outline" });
  for (const id of ["knights-trial", "badge-of-millhaven", "mop-jockey", "polyester-nights"]) {
    await page.getByTestId(`template-${id}`).click();
    await expect(outline).toHaveValue(
      await readFile(new URL(`../../games/${id}/SKILL.md`, import.meta.url), "utf8"),
    );
  }
  await outline.fill((await outline.inputValue()) + "\n\n## Direction\nFind a blue lantern.\n");
  const edited = await outline.inputValue();
  await page.getByTestId("template-custom").click();
  await expect(outline).toHaveValue("");
  await page.getByTestId("template-polyester-nights").click();
  await expect(outline).toHaveValue(edited);
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Lantern adventure");
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("boot-game").click();
  await expect(page.getByTestId("create-dock-left")).toBeVisible();
  await expect(page).toHaveURL(/#create\//);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`new game page screenshots at ${size.width}×${size.height}`, async ({ page }) => {
    await isolateStorage(page);
    await page.setViewportSize(size);
    await page.goto("/#create-adventure");
    await expect(page.getByRole("heading", { name: "Make a new game" })).toBeVisible();
    await expect(page.getByTestId("template-picture-starter")).toHaveAttribute(
      "data-rendered",
      "true",
    );
    await reviewShot(page, `starter-${size.width}x${size.height}`);
    await page.getByTestId("local-create-kind-ai").click();
    await expect(page.getByRole("textbox", { name: "Adventure outline" })).toBeVisible();
    await reviewShot(page, `ai-${size.width}x${size.height}`);
  });
}

test("closing the new game page returns focus to its Home trigger", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("create-adventure-toggle").click();
  await expect(page.getByTestId("local-create-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("create-adventure-toggle")).toBeFocused();
});
