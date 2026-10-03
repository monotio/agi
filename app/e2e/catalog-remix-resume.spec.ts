import { expect, test } from "@playwright/test";
import { TUTORIAL_LOGIC_SOURCES } from "../../games/adventure-department/game.ts";
import { providerReply } from "../../test/provider-stream.ts";
import {
  configureAi,
  enterCreateMode,
  isolateStorage,
  openWorkspaceAgent,
  savedGameCard,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
} from "./engineProbe.ts";

/** The catalog installs the bundled tutorial under a deterministic project ID. */
const TUTORIAL_PROJECT_ID = "catalog-adventure-department-1.2.0";

test("forking the tutorial keeps each card’s own checkpoint", async ({ page }) => {
  const original = TUTORIAL_LOGIC_SOURCES[1]!;
  const patched = original.replace("PICTURE GALLERY", "REMIX GALLERY");
  expect(patched).not.toBe(original);
  const sprite = "view\ncel s 3 2 0\n444\n4.4\nendcel\nloop 0 s\nendview";
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    const calls = [
      ["write_view", { num: 9, source: sprite }],
      ["write_logic", { room: 1, source: patched }],
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
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await page.getByTestId("agent-message").fill("Rename the gallery");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect.poll(() => requests).toBe(2);
  // The panel closes on the forked copy, but the request stays in view, with
  // the answer and where the change went — not the empty first-run state.
  const lastTurn = page.getByTestId("workspace-agent-panel");
  await expect(lastTurn).toContainText("Rename the gallery");
  await expect(lastTurn).toContainText("The gallery is remixed.");
  await expect(
    page.getByRole("heading", { name: "Adventure Department Remix", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("create-read-only")).toHaveCount(0);
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("REMIX GALLERY");
  await page.screenshot({ path: test.info().outputPath("remix-after.png") });
  const remixProjectId = await page.evaluate(
    () => localStorage.getItem("monotio_agi.resumeTarget")?.split(":")[1],
  );
  expect(remixProjectId).not.toBe(TUTORIAL_PROJECT_ID);
  // The remix was made in Create mode, which the URL names with the project.
  expect(new URL(page.url()).hash, "the URL must follow the remix project ID").toBe(
    `#create/${remixProjectId}`,
  );
  // The original keeps its checkpoint; subsequent progress belongs to the remix.
  expect(await storedAutosave(page, TUTORIAL_PROJECT_ID)).not.toBeNull();

  await page.getByTestId("btn-exit").click();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const tutorialCard = savedGameCard(page, "Adventure Department");
  await expect(tutorialCard.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  const remixCard = savedGameCard(page, "Adventure Department Remix");
  await expect(remixCard.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  await tutorialCard.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("PICTURE GALLERY");
  expect(new URL(page.url()).hash, "the replayed tutorial must be named in the URL").toBe(
    `#play/${TUTORIAL_PROJECT_ID}`,
  );
  expect((await textHook(page)).rows.join(" ")).not.toContain("REMIX GALLERY");
  await expect(page.getByText(/different revision/)).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
});
