import { isolateStorage, textHook, waitForAutosaveAfter } from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";

for (const kind of ["starter", "boilerplate"] as const) {
  test(`create a ${kind} locally without an AI key, then reopen the saved game`, async ({
    page,
  }) => {
    await isolateStorage(page);
    let providerCalls = 0;
    await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
      providerCalls++;
      return route.abort();
    });
    await page.goto("/");
    await page.getByTestId("create-adventure-toggle").click();
    const form = page.locator(".local-create");
    await expect(form.getByRole("button", { name: "Start building", exact: true })).toBeHidden();
    await form.getByRole("textbox").fill(`My ${kind} game`);
    await form.getByRole("radio", { name: new RegExp(kind, "i") }).click();
    await reviewShot(page, `local-${kind}-creation`);
    await form.getByRole("button", { name: "Start building", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await expect(page).toHaveURL(/#create\/local-/);
    await expect(page.getByTestId("parts-list")).toBeVisible();
    if (kind === "boilerplate") {
      await expect.poll(async () => (await textHook(page)).modal).toBe("print");
      await page.locator(".screen").click();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await textHook(page)).modal).toBe(null);
    }
    const project = await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      const entries = await storage.listStoredProjects();
      const entry = entries.find((game) => game.projectId.startsWith("local-"));
      if (!entry) throw new Error("Created project missing");
      const data = (await storage.loadAuthoredGame(entry.projectId))!;
      return {
        id: data.projectId,
        title: data.title,
        provider: data.provider ?? null,
        model: data.model ?? null,
        profile: data.library?.profile,
        keys: data.workspace?.documents.map((doc) => doc.key),
      };
    });
    expect(project.title).toBe(`My ${kind} game`);
    expect(project.provider).toBeNull();
    expect(project.model).toBeNull();
    expect(project.profile).toBe("2.936");
    expect(project.keys).toContain("logic:1");
    expect(project.keys?.includes("view:0")).toBe(kind === "starter");
    await reviewShot(page, `local-${kind}-workspace`);
    // Create keeps its opening checkpoint while the game runs temporarily.
    await waitForAutosaveAfter(page, 0);
    await page.reload();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    expect(providerCalls).toBe(0);
  });
}
