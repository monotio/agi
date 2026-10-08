import {
  configureAi,
  isolateStorage,
  storedAutosave,
  textHook,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";

test("closing new-game setup retires its pending Create intent @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/sound/psgNoise.ts", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await requested.promise;
  try {
    await page.getByTestId("create-adventure-close").click();
  } finally {
    release.resolve();
  }
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as { __AGI_AUDIO__?: unknown }).__AGI_AUDIO__),
      ),
    )
    .toBe(true);
  expect((await textHook(page)).profile).toBeNull();
  expect(await page.evaluate(() => window.__AGI_STATE__?.phase)).toBe("idle");
  await expect(page.getByTestId("create-adventure-toggle")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(
    await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      return (await storage.listStoredProjects()).length;
    }),
  ).toBe(1);
});

test("a failed game load keeps the saved Starter and shows recovery in Create @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/sound/psgNoise.ts", (route) => route.abort("connectionreset"));
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  const failure = page.getByTestId("local-create-open-error");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Game saved.");
  await expect(failure).toContainText("Reload");
  await expect(page).toHaveURL(/#create-adventure$/);
  expect((await textHook(page)).profile).toBeNull();
  await expect(page.getByTestId("parts-list")).toBeHidden();
  const projects = await page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    return (await storage.listStoredProjects()).map((entry) => entry.projectId);
  });
  expect(projects).toHaveLength(1);
  const project = projects[0]!;
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(failure).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      return (await storage.listStoredProjects()).map((entry) => entry.projectId);
    }),
  ).toEqual([project]);
  await reviewShot(page, "local-create-load-failure");
  // The browser can cache a rejected module graph until the page reloads.
  // Reopening the durable project starts a fresh graph and keeps its identity.
  await page.unroute("**/sound/psgNoise.ts");
  await failure.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#create/${project}$`));
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  expect(
    await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      return (await storage.listStoredProjects()).map((entry) => entry.projectId);
    }),
  ).toEqual([project]);
});

test("Create with AI shows a load failure before any game is saved @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.route("**/sound/psgNoise.ts", (route) => route.abort("connectionreset"));
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-ai").click();
  await page.getByTestId("boot-game").click();
  const failure = page.getByTestId("local-create-open-error");
  await expect(failure).toContainText("Game loading failed. Reload to try again.");
  await expect(failure).not.toContainText("saved");
  expect((await textHook(page)).profile).toBeNull();
  expect(
    await page.evaluate(async () => {
      const storage = await import("/src/project/gameStorage.ts");
      return (await storage.listStoredProjects()).length;
    }),
  ).toBe(0);
  await reviewShot(page, "ai-create-load-failure");
  await page.unroute("**/sound/psgNoise.ts");
  await failure.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByTestId("local-create-form")).toBeVisible();
  await page.getByTestId("local-create-kind-ai").click();
  await page.getByTestId("boot-game").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
});

for (const fail of [false, true]) {
  test(`the blank stage opens its saved first room after ${fail ? "reload recovery" : "admission"} @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-blank").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    const stage = page.getByTestId("empty-project-stage");
    await expect(stage).toBeVisible();
    await expect(stage.getByRole("status")).toHaveText("Nothing to play yet.");
    const hash = new URL(page.url()).hash;
    if (fail) await page.route("**/sound/psgNoise.ts", (route) => route.abort("connectionreset"));
    await page.getByTestId("empty-add-room").click();
    if (fail) {
      await expect(stage).toBeVisible();
      const failure = stage.getByRole("alert");
      await expect(failure).toContainText("Reload to open it.");
      await expect(stage.getByRole("status")).toHaveText("Game saved");
      await expect(stage.getByTestId("empty-add-room")).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`${hash}$`));
      expect((await textHook(page)).profile).toBeNull();
      const documents = await page.evaluate(
        async (id) => {
          const storage = await import("/src/project/gameStorage.ts");
          const project = (await storage.listStoredProjects()).find(
            (entry) => entry.projectId === id,
          );
          if (!project) throw new Error("Created project missing");
          return (await storage.loadAuthoredGame(project.projectId))?.workspace?.documents.map(
            (doc) => doc.key,
          );
        },
        decodeURIComponent(hash.slice("#create/".length)),
      );
      expect(documents).toContain("logic:0");
      expect(documents).toContain("logic:1");
      await reviewShot(page, "blank-create-load-failure");
      await page.unroute("**/sound/psgNoise.ts");
      await failure.getByRole("button", { name: "Reload", exact: true }).click();
    }
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await expect(stage).toBeHidden();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
  });
}

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
    // Create saves the project while its preview leaves Play progress empty.
    await workspaceSaved(page);
    expect(await storedAutosave(page, project.id)).toBeNull();
    await page.reload();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    expect(await storedAutosave(page, project.id)).toBeNull();
    expect(providerCalls).toBe(0);
  });
}
