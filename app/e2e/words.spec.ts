import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "./test.ts";
import {
  isolateStorage,
  textHook,
  configureAi,
  waitForAutosaveAfter,
  workspaceUpdated,
} from "./engineProbe.ts";

for (const width of [1440, 1280])
  test(`Words sentence, local playtest miss and Same as at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill("Words proof");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    if ((await textHook(page)).modal) {
      await page.getByTestId("input-line").focus();
      await page.keyboard.press("Enter");
    }
    await page.getByTestId("part-words").click();
    const editor = page.getByTestId("workspace-words-editor");
    await expect(editor).toBeVisible();
    const sentence = editor.getByRole("textbox", { name: "A sentence a player might type" });
    await sentence.fill("inspect around");
    await expect(page.getByTestId("sentence-parse")).toContainText("new word");
    await expect(page.getByTestId("sentence-parse")).toContainText("not read");
    await editor.getByRole("button", { name: "Type it in the game ↵", exact: true }).click();
    await expect(page.getByTestId("player-sentence")).toContainText("inspect around");
    await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
    await page.getByTestId("input-line").focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    await page
      .getByTestId("player-sentence")
      .getByRole("button", { name: "Teach “inspect”…", exact: true })
      .click();
    const teaching = editor.getByRole("form", { name: "Teach inspect", exact: true });
    await expect(teaching).toBeVisible();
    await teaching.getByLabel("Same as…", { exact: true }).check();
    const choose = teaching.getByRole("combobox", { name: "Same meaning" });
    await expect(choose).toHaveValue("");
    await choose.selectOption("100");
    await teaching.getByLabel("The game says…", { exact: true }).fill("You look around.");
    await teaching.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByTestId("player-sentence")).toHaveCount(0);
    await sentence.fill("inspect");
    await expect(page.getByTestId("sentence-parse")).toContainText("· 100");
    await expect(page.getByTestId("sentence-outcome")).toContainText("LOGIC 1");
    await expect(page.getByTestId("workspace-saved")).toBeVisible();
    await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
    await expect(page.getByTestId("sentence-outcome")).toContainText("Answers “You stand");
    const meaning = editor.locator('[data-word-group="100"]');
    await expect(meaning.locator(".head")).toHaveText(/look/);
    const singleUse = editor.locator('[data-word-group="101"] .meaning-uses');
    await expect(singleUse).toContainText("1 use");
    await expect(singleUse).not.toContainText("1 uses");
    await expect(page.getByTestId("sentence-outcome")).toContainText(
      "when the game's state allows it",
    );
    await workspaceUpdated(page);
    await sentence.focus();
    await page.mouse.move(0, 0);
    const move = meaning.getByRole("button", { name: "Move to… inspect", exact: true });
    await expect(move).toHaveCSS("opacity", "0");
    await move.focus();
    await expect(move).toHaveCSS("opacity", "1");
    await meaning.locator(".word-chip").filter({ hasText: "inspect" }).hover();
    await expect(move).toHaveCSS("opacity", "1");
    await sentence.focus();
    await editor.getByRole("button", { name: "Type it in the game ↵", exact: true }).click();
    await expect
      .poll(async () => (await textHook(page)).rows.join("\n"))
      .toContain("You stand in a sunny clearing");
    await expect(page.getByTestId("player-sentence")).toHaveCount(0);
    await editor.getByRole("textbox", { name: "Find a word", exact: true }).fill("100");
    await expect(editor.locator(".meaning-row")).toHaveCount(1);
    await editor.getByRole("textbox", { name: "Find a word", exact: true }).fill("");
    await page.screenshot({ path: test.info().outputPath(`chromium-${width}-words.png`) });
    await page.getByTestId("workspace-focus").click();
    await meaning.locator(".word-chip").filter({ hasText: "inspect" }).hover();
    await editor.getByRole("button", { name: "Move to… inspect", exact: true }).click();
    await editor.getByRole("combobox", { name: "Destination meaning", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(editor.getByRole("form", { name: "Move to…" })).toHaveCount(0);
    await sentence.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".play-area")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator(".play-area")).toBeVisible();
  });

test("WORDS row actions, in-place stub suggestions and tester choices", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await page.getByTestId("part-words").click();
  const words = page.getByTestId("workspace-words-editor");
  const row = words.locator('[data-word-group="100"]');
  const suggest = row.getByRole("button", { name: "Suggest", exact: true });
  const plus = row.getByRole("button", { name: "Add word", exact: true });
  await words.getByRole("textbox", { name: "Find a word", exact: true }).focus();
  await page.mouse.move(0, 0);
  await expect(suggest).toHaveCSS("opacity", "0");
  await expect(plus).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(suggest).toHaveCSS("opacity", "1");
  await expect(plus).toHaveCSS("opacity", "1");
  await page.screenshot({ path: test.info().outputPath("words-hover-1440.png") });
  await page.mouse.move(0, 0);
  await plus.focus();
  await expect(suggest).toHaveCSS("opacity", "1");
  await plus.click();
  await expect(row.getByRole("textbox")).toBeFocused();
  await row.getByRole("textbox").press("Escape");
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await suggest.click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeHidden();
  await expect(row.locator(".word-suggestion")).toHaveText(["inspect", "check"]);
  await expect(row.locator(".word-suggestion").first()).toHaveCSS("border-style", "dashed");
  await expect(words.getByRole("status")).toContainText("Suggestions from");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await page.screenshot({ path: test.info().outputPath("words-suggestions-1440.png") });
  await row.getByRole("button", { name: "Add all", exact: true }).click();
  await expect(row.locator(".word-suggestion")).toHaveCount(0);
  await expect(row.locator(".word-chip").filter({ hasText: "inspect" })).toHaveCount(1);
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  const sentence = words.getByRole("textbox", { name: "A sentence a player might type" });
  await sentence.fill("inspect");
  await expect(page.getByTestId("sentence-parse")).toContainText("· 100");
  await workspaceUpdated(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).not.toContainText("inspect");
  await expect(row).not.toContainText("check");
  await expect(page.getByTestId("sentence-parse")).toContainText("new word");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByTestId("sentence-parse")).toContainText("· 100");
  await words.getByRole("button", { name: "Suggest sentences", exact: true }).click();
  await expect(panel).toBeHidden();
  const predicted = words.getByRole("region", { name: "Predicted commands" });
  await expect(predicted).toContainText("climb tree");
  await expect(predicted).toContainText("✦ look tree");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await page.screenshot({ path: test.info().outputPath("words-predict-1440.png") });
  await predicted.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(predicted).toHaveCount(0);
  await sentence.fill("climb tree");
  const verdict = page.getByTestId("sentence-outcome");
  await expect(verdict).toContainText("“climb” is a new word, so the game stops reading there.");
  await expect(verdict.getByRole("button", { name: "New meaning", exact: true })).toBeHidden();
  await verdict.getByRole("button", { name: "Teach “climb”…", exact: true }).click();
  const teaching = words.getByRole("form", { name: "Teach climb", exact: true });
  await expect(teaching).toBeVisible();
  await expect(teaching.getByLabel("A new thing", { exact: true })).toBeChecked();
  await teaching.getByLabel("Same as…", { exact: true }).check();
  await expect(teaching.getByRole("combobox", { name: "Same meaning" })).toHaveValue("");
  await words
    .getByRole("form", { name: "Teach climb", exact: true })
    .getByRole("button", { name: "Cancel" })
    .click();
  await verdict.getByRole("button", { name: "More", exact: true }).click();
  await expect(verdict.getByRole("button", { name: "New meaning", exact: true })).toBeVisible();
  const newMeaning = verdict.getByRole("button", { name: "New meaning", exact: true });
  await expect
    .poll(() =>
      newMeaning.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    )
    .toBe(true);
  await expect(
    verdict.getByRole("button", { name: "Skip it like “the”", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await page.screenshot({ path: test.info().outputPath("words-tester-1440.png") });
  await verdict.getByRole("button", { name: "Skip it like “the”", exact: true }).click();
  await expect(page.getByTestId("sentence-parse")).toContainText("skipped");
  await sentence.fill("wander");
  await verdict.getByRole("button", { name: "More", exact: true }).click();
  await verdict.getByRole("button", { name: "New meaning", exact: true }).click();
  await expect(page.getByTestId("sentence-parse")).not.toContainText("new word");
  await expect(words.locator(".meaning-row").filter({ hasText: "wander" })).toHaveCount(1);
  await workspaceUpdated(page);
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await words.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Suggest words for look");
  await expect(panel).toContainText("Suggested inspect, check · shown in WORDS");
  await expect(panel).toContainText("Predict what players will try in Meadow");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await page.screenshot({ path: test.info().outputPath("words-chat-1440.png") });
  await page.reload();
  await page.getByTestId("part-words").click();
  await expect(words.locator('[data-word-group="100"]')).toContainText("inspect");
  await page.getByTestId("workspace-agent").click();
  await expect(panel).toContainText("Suggested inspect, check · shown in WORDS");
});

test("WORDS suggestions show progress, inline failures and retry while chat stays closed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  let requests = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    prompts.push(route.request().postData() ?? "");
    if (requests === 1) await held;
    await route.fulfill(
      providerReply("openai", {
        id: `words-${requests}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  requests === 1
                    ? '{"synonyms":'
                    : requests === 2
                      ? '{"synonyms":["inspect"]}'
                      : '{"commands":["look tree"]}',
              },
            ],
          },
        ],
      }),
    );
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await page.getByTestId("part-words").click();
  const words = page.getByTestId("workspace-words-editor");
  const row = words.locator('[data-word-group="100"]');
  await row.hover();
  await row.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(row).toContainText("Suggesting…");
  await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("words-suggesting-1440.png") });
  release();
  await expect(row.getByRole("alert")).toContainText("The reply’s JSON could not be read.");
  await page.screenshot({ path: test.info().outputPath("words-retry-1440.png") });
  await row.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(row.locator(".word-suggestion")).toHaveText("inspect");
  await expect(words.getByRole("status")).toContainText("Suggestions from GPT-6.1 Sol · Open chat");
  await row.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(row.locator(".word-suggestion")).toHaveCount(0);
  await words.getByRole("button", { name: "Suggest sentences", exact: true }).click();
  await expect(words.getByRole("region", { name: "Predicted commands" })).toContainText(
    "look tree",
  );
  expect(requests).toBe(3);
  expect(prompts[0]).toContain("meaning 100");
  expect(prompts[2]).toContain("draw.pic(v50)");
  await words.getByRole("button", { name: "Open chat", exact: true }).click();
  const panel = page.getByTestId("workspace-agent-panel");
  const user = panel.locator(".agent-panel__message--user").first();
  await expect(user.locator("p").first()).toHaveText("Suggest words for look");
  await expect(user.locator("details")).not.toHaveAttribute("open", "");
  await user.locator("summary").click();
  await expect(user).toContainText("Return a JSON object");
  const reply = panel
    .locator(".agent-panel__message")
    .filter({ hasText: "Suggested inspect · shown in WORDS" });
  await reply.locator("summary").click();
  await expect(reply.locator("pre")).toHaveText('{"synonyms":["inspect"]}');
  await page.reload();
  await page.getByTestId("workspace-agent").click();
  await expect(panel).toContainText("Suggested inspect · shown in WORDS");
});

test("Create keeps a missed sentence across reload before WORDS first opens", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const input = page.getByTestId("input-line");
  if ((await textHook(page)).modal) {
    await input.focus();
    await page.keyboard.press("Enter");
  }
  await input.fill("inspect around");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("monotio_agi.tried."))
          .map((key) => localStorage.getItem(key))
          .join(""),
      ),
    )
    .toContain("inspect around");
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByTestId("part-words").click();
  await expect(page.getByTestId("player-sentence")).toContainText("inspect around");
});
