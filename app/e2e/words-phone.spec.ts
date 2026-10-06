import { test } from "./test.ts";
import { checkWordsAgentHandoff } from "./wordsAgentShared.ts";

test("WORDS shortcut opens the shared agent at 390", async ({ page }) => {
  await checkWordsAgentHandoff(page, 390, 844);
});
