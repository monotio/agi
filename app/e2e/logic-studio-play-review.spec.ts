import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard, textHook } from "./engineProbe.ts";

test("a no-key source and vocabulary edit changes the game a player actually runs", async ({
  page,
}) => {
  await isolateStorage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const prepared = await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const project = prepareLocalProject({ title: "My secret garden", kind: "starter" });
    const data = project.data();
    const source = data.workspace?.documents.find((doc) => doc.key === "logic:1")?.content;
    const words = data.workspace?.documents.find((doc) => doc.key === "words")?.content;
    if (source?.type !== "text" || words?.type !== "text")
      throw new Error("Starter source missing");
    await project.save();
    return {
      id: project.projectId,
      source: source.text,
      words: words.text,
      revision: data.library?.revision,
    };
  });
  await page.reload();
  const card = savedGameCard(page, "My secret garden");
  await openLibraryActions(page, card);
  await expect(page.getByTestId("edit-library-game")).toBeVisible();
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  const explorer = page.getByTestId("logic-explorer");
  const editor = page.getByTestId("logic-editor");
  const message = "I made a secret garden without an AI key.";
  const source = prepared.source
    .replace(/#message 1 "[^"]*"/, `#message 1 "${message}"`)
    .replace('said("look")', 'said("inspect")');
  expect(source).not.toBe(prepared.source);
  await explorer.getByTestId("logic-doc-logic:1").click();
  await editor.locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((text) => navigator.clipboard.writeText(text), source);
  await page.keyboard.press("ControlOrMeta+V");
  const words = JSON.parse(prepared.words) as [string, number][];
  const look = words.find(([word]) => word === "look");
  expect(look).toBeDefined();
  words.push(["inspect", look![1]]);
  await explorer.getByTestId("logic-doc-words").click();
  await editor.locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.evaluate((text) => navigator.clipboard.writeText(text), JSON.stringify(words));
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByTestId("logic-studio-status")).toContainText("2 changes");
  await page.getByTestId("logic-review-build").click();
  await expect(page.getByTestId("logic-keep-confirm")).toBeEnabled();
  await page.getByTestId("logic-review-doc-logic:1").click();
  await expect(
    page.getByTestId("logic-review-diff").locator(".modified .view-lines[data-mprt]"),
  ).toContainText(message);
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  const stored = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(id as never);
    return { revision: data?.library?.revision, words: data?.words };
  }, prepared.id);
  expect(stored.revision).not.toBe(prepared.revision);
  expect(stored.words).toContainEqual(["inspect", look![1]]);
  await page.getByTestId("logic-close").click();
  await expect(page.getByTestId("logic-studio")).toBeHidden();
  await card.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const input = page.getByTestId("input-line");
  await expect(input).toBeEnabled();
  await input.fill("inspect");
  await input.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" ").replace(/#/g, " ").replace(/\s+/g, " "))
    .toContain(message);
  await reviewShot(page, "logic-studio-authored-game-running");
  expect(providerCalls).toBe(0);
  expect(errors).toEqual([]);
});
