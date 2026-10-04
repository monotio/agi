import {
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  textHook,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import { openWorkspaceLogic, replaceWorkspaceDocument } from "./workspaceShared.ts";

test("a no-key source and vocabulary edit changes the game a player actually runs", async ({
  page,
}) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
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
  // Finish the opening preview before navigating away from this document.
  await expect(
    page.getByTestId("catalog-adventure-department").getByTestId("library-thumbnail"),
  ).toBeVisible();
  await page.reload();
  const card = savedGameCard(page, "My secret garden");
  await openLibraryActions(page, card);
  await expect(page.getByTestId("edit-library-game")).toBeVisible();
  await page.getByTestId("edit-library-game").click();
  await openWorkspaceLogic(page);
  const message = "I made a secret garden without an AI key.";
  const source = prepared.source
    .replace(/print\("[^"\n]*"\)/, `print("${message}")`)
    .replace('said("look")', 'said("inspect")');
  expect(source).not.toBe(prepared.source);
  await replaceWorkspaceDocument(page, "logic:1", source);
  const words = JSON.parse(prepared.words) as [string, number][];
  const look = words.find(([word]) => word === "look");
  expect(look).toBeDefined();
  words.push(["inspect", look![1]]);
  await replaceWorkspaceDocument(page, "words", JSON.stringify(words));
  await workspaceSaved(page);
  const stored = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(id as never);
    return { revision: data?.library?.revision, words: data?.words };
  }, prepared.id);
  expect(stored.revision).not.toBe(prepared.revision);
  expect(stored.words).toContainEqual(["inspect", look![1]]);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
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
