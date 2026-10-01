import { expect, test, reviewShot } from "./test.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { configureAi, isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

test.use({ viewport: { width: 1440, height: 900 } });

test("proposal review renders the exact removed and inserted source before approval @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let after = "";
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    const id = `review-${++requests}`;
    const output =
      requests === 1
        ? [
            {
              type: "function_call",
              call_id: id,
              name: "propose_changes",
              arguments: JSON.stringify({
                label: "Explain the room",
                changes: [{ key: "logic:1", content: after }],
              }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Updated the room comment." }],
            },
          ];
    await route.fulfill(providerReply("openai", { id, output }));
  });
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  const before = await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
    const prepared = prepareLocalProject({ title: "Rendered review", kind: "blank" });
    await prepared.save();
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(prepared.projectId);
    if (!data) throw new Error("The starter project was not saved.");
    const content = inspectEditableProject(data).documents["logic:1"];
    if (typeof content !== "string") throw new Error("The starter room source is missing.");
    return content;
  });
  after =
    "// Enter this room to see your first picture.\n" + before.split("\n").slice(1).join("\n");
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Rendered review"));
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  const panel = studio.getByTestId("logic-assistant");
  await panel.getByTestId("logic-assistant-input").fill("Explain the room with a clearer comment");
  await panel.getByTestId("logic-assistant-ask").click();
  await panel.getByTestId("logic-assistant-review").click();
  const review = page.getByTestId("logic-agent-review");
  await expect(review).toBeVisible();
  // A mounted editor is insufficient: wait for Monaco's actual diff computation.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor.getDiffEditors().at(-1)?.getLineChanges()?.length ?? 0;
      }),
    )
    .toBeGreaterThan(0);
  const observed = await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getDiffEditors().at(-1);
    const models = editor?.getModel();
    return {
      before: models?.original.getValue(),
      after: models?.modified.getValue(),
      changes: editor?.getLineChanges(),
    };
  });
  expect(observed.before).toBe(before);
  expect(observed.after).toBe(after);
  expect(observed.changes?.[0]?.originalStartLineNumber).toBe(1);
  expect(observed.changes?.[0]?.modifiedStartLineNumber).toBe(1);
  const diff = review.getByTestId("logic-agent-diff");
  await expect(diff.locator(".line-delete").first()).toBeVisible();
  await expect(diff.locator(".line-insert").first()).toBeVisible();
  await reviewShot(page, "logic-agent-computed-diff");
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await review.getByTestId("logic-agent-approve").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  expect(requests).toBe(2);
});
