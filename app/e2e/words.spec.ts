import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, textHook, configureAi } from "./engineProbe.ts";

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
      .getByRole("button", { name: /Same as/ })
      .click();
    const choose = editor.getByRole("combobox", { name: "Same meaning" });
    await choose.selectOption("100");
    await editor
      .getByRole("form", { name: "Same as…" })
      .getByRole("button", { name: "Add word", exact: true })
      .click();
    await expect(page.getByTestId("player-sentence")).toHaveCount(0);
    await sentence.fill("inspect");
    await expect(page.getByTestId("sentence-parse")).toContainText("· 100");
    await expect(page.getByTestId("sentence-outcome")).toContainText("LOGIC 1");
    await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
    await expect(page.getByTestId("sentence-outcome")).toContainText("Answers “You stand");
    const meaning = editor.locator('[data-word-group="100"]');
    await expect(meaning.locator(".head")).toHaveText(/look/);
    const singleUse = editor.locator('[data-word-group="101"] .meaning-uses');
    await expect(singleUse).toContainText("1 use");
    await expect(singleUse).not.toContainText("1 uses");
    await expect(page.getByTestId("sentence-outcome")).toContainText(
      "when the game's state allows it",
    );
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

test("WORDS Suggest and Predict prefill the Create agent composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  let requests = 0;
  const prompts: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    prompts.push(route.request().postData() ?? "");
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
                text: requests === 1 ? '{"synonyms":["inspect"]}' : '{"commands":["look tree"]}',
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
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByTestId("part-words").click();
  const words = page.getByTestId("workspace-words-editor");
  await words
    .locator('[data-word-group="100"]')
    .getByRole("button", { name: "✦ Suggest", exact: true })
    .click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("agent-message")).toHaveValue("Suggest words for look");
  await expect(panel.getByTestId("agent-message")).toBeFocused();
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(words.locator('[data-word-group="100"] .word-suggestion')).toHaveText("inspect");
  expect(requests).toBe(1);
  const firstMessage = panel.locator(".agent-panel__message--user").first();
  await expect(firstMessage.locator("p").first()).toHaveText("Suggest words for look");
  const folded = firstMessage.locator("details");
  await expect(folded).not.toHaveAttribute("open", "");
  await expect(folded.locator("summary")).toHaveText("Context");
  await folded.locator("summary").click();
  await expect(folded).toContainText("Return a JSON object");
  expect(prompts[0]).toContain("meaning 100");
  await folded.locator("summary").click();

  await words.getByRole("button", { name: "✦ Predict commands", exact: true }).click();
  await expect(panel.getByTestId("agent-message")).toHaveValue(
    "Predict what players will try in Meadow",
  );
  await expect(panel.getByTestId("agent-message")).toBeFocused();
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(words.getByRole("region", { name: "Predicted commands" })).toContainText(
    "look tree",
  );
  expect(requests).toBe(2);
  await expect(
    words.getByRole("heading", { name: "✦ Players will likely try in Meadow" }),
  ).toBeVisible();
  expect(prompts[1]).toContain("draw.pic(v50)");
  expect(prompts[1]).toContain("commands");
  await page.screenshot({ path: test.info().outputPath("words-context-1440.png") });
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
