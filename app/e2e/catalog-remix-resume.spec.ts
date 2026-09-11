import { test, expect } from "@playwright/test";
import { providerReply } from "../../test/provider-stream.ts";
import { TUTORIAL_LOGIC_SOURCES } from "../../games/adventure-department/game.ts";
import {
  configureAi,
  isolateStorage,
  savedGameCard,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
} from "./engineProbe.ts";

/** The catalog installs the bundled tutorial under a deterministic project ID. */
const TUTORIAL_PROJECT_ID = "catalog-adventure-department-1.0.0";

test("forking the tutorial moves its checkpoint to the remix card", async ({ page }) => {
  const original = TUTORIAL_LOGIC_SOURCES[1]!;
  const patched = original.replace("PICTURE GALLERY", "REMIX GALLERY");
  expect(patched).not.toBe(original);
  const sprite = { loops: [{ cels: [{ width: 3, height: 2, pixels: [4, 4, 4, 4, 0, 4] }] }] };
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    const calls = [
      ["write_view", { num: 9, spec: sprite }],
      ["write_logic_source", { room: 1, source: patched }],
    ];
    await route.fulfill(
      providerReply("openai", {
        id: `catalog-fork-${requests}`,
        output:
          requests === 1
            ? calls.map(([name, args], i) => ({
                type: "function_call",
                id: `item-${i}`,
                call_id: `call-${i}`,
                name,
                arguments: JSON.stringify(args),
              }))
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "The gallery is remixed." }],
                },
              ],
      }),
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("PICTURE GALLERY");
  await expect(page, "catalog cards must mount under their release identity").toHaveURL(
    new RegExp(`#play/${TUTORIAL_PROJECT_ID}$`),
  );
  await page.screenshot({ path: test.info().outputPath("remix-before.png") });
  // A checkpoint on the untouched tutorial is what the fork has to move away.
  await waitForAutosaveAfter(page, 0);
  expect(await storedAutosave(page, TUTORIAL_PROJECT_ID)).not.toBeNull();

  // Author a change to trigger a remix fork
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("Rename the gallery");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(() => requests).toBe(2);
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("REMIX GALLERY");
  await page.screenshot({ path: test.info().outputPath("remix-after.png") });
  const remixProjectId = await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"));
  expect(remixProjectId).not.toBe(TUTORIAL_PROJECT_ID);
  expect(new URL(page.url()).hash, "the URL must follow the remix project ID").toBe(
    `#play/${remixProjectId}`,
  );
  // Progress now belongs to the remix: the original card must not offer a checkpoint.
  expect(await storedAutosave(page, TUTORIAL_PROJECT_ID)).toBeNull();

  await page.getByTestId("btn-eject").click();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const tutorialCard = savedGameCard(page, "Adventure Department");
  await expect(tutorialCard.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(tutorialCard.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  const remixCard = savedGameCard(page, "Adventure Department Remix");
  await expect(remixCard.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  await tutorialCard.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("PICTURE GALLERY");
  expect(new URL(page.url()).hash, "the replayed tutorial must be named in the URL").toBe(
    `#play/${TUTORIAL_PROJECT_ID}`,
  );
  expect((await textHook(page)).rows.join(" ")).not.toContain("REMIX GALLERY");
  await expect(page.getByText(/different revision/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
