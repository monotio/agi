import { test, expect } from "./test.ts";
import {
  configureAi,
  isolateStorage,
  openCreateAdventure,
  textHook,
  workspaceSaved,
  openWorkspaceAgent,
} from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { openWorkspaceLogic, focusWorkspaceLogic, workspaceDocument } from "./workspaceShared.ts";

test("Update and agent approval work after walking into a live-built room @webkit-desktop", async ({
  page,
  browserName,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await openCreateAdventure(page);
  await page.getByTestId("template-custom").click();
  await page.getByTestId("custom-adventure-input").fill("A small stub adventure.");
  await page.getByTestId("boot-game").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await workspaceSaved(page);
  await page.getByTestId("part-notes").click();
  const notes = page.getByRole("textbox", { name: "Game notes", exact: true });
  await expect(notes).toBeVisible();
  await notes.fill("Keep this draft while the next rooms are built.");
  await workspaceSaved(page);
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await input.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(100);
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(135);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await page.keyboard.up("ArrowRight");
  await workspaceSaved(page);
  await input.focus();
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await input.fill("east");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(3);
  await workspaceSaved(page);
  // Hold draft hydration across reload: accepted-project saves can already be
  // settled while the separate notes draft is still opening its journal.
  // Chromium supports the journal ownership locks used by this interleaving.
  if (browserName === "chromium")
    await page.addInitScript(() => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = { blocked: false, release };
      (window as unknown as { __draftReadGate: typeof gate }).__draftReadGate = gate;
      navigator.locks.request = new Proxy(navigator.locks.request, {
        apply(target, receiver, args: unknown[]) {
          if (typeof args[0] === "string" && args[0].startsWith("monotio_agi.part-drafts/")) {
            gate.blocked = true;
            return ready.then(() => Reflect.apply(target, receiver, args));
          }
          return Reflect.apply(target, receiver, args);
        },
      });
    });
  const playProgress = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith("monotio_agi.autosave."))
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
  expect(Object.keys(playProgress).length).toBeGreaterThan(0);
  await page.reload();
  // Create's new rooms leave the original Play position at its earlier revision.
  // Reload preserves it until the creator explicitly opens the latest resources.
  const latest = page.getByTestId("start-latest-version");
  await expect(latest).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith("monotio_agi.autosave."))
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    ),
  ).toEqual(playProgress);
  await latest.click();
  await workspaceSaved(page);
  await page.evaluate(async () => {
    const probe = window as unknown as {
      __draftReadGate?: { blocked: boolean; release(): void };
      __AGI_PROJECT__: { getSession(): ProjectSession };
    };
    const session = probe.__AGI_PROJECT__.getSession();
    const drafts = session.drafts();
    if (probe.__draftReadGate) {
      if (!probe.__draftReadGate.blocked) throw new Error("Draft hydration was not held");
      if (session.workingSnapshot().read("notes") !== undefined)
        throw new Error("Notes appeared before draft hydration");
      probe.__draftReadGate.release();
    }
    // Project flush covers accepted writes; notes live in separately loaded drafts.
    await drafts.ready;
  });
  expect(await workspaceDocument(page, "notes")).toBe(
    "Keep this draft while the next rooms are built.",
  );
  const logic = await openWorkspaceLogic(page, 1);
  const source = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const snapshot = session.workingSnapshot();
    const content = snapshot.read("logic:1")!.content;
    if (typeof content === "string") return content;
    const { derivedLogicSource } = await import("/src/studio/logic/logicWorkspace.ts");
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(location.hash.split("/")[1] as never);
    return derivedLogicSource(content, "2.936", data!.words).source;
  });
  await expect(logic).toBeVisible();
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(`${source}\n// Edited after the live room arrived.\n`);
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await expect(action).toHaveAccessibleName("Update and restart The Clearing");
  await action.click();
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await expect(action).toHaveAccessibleName("Restart The Clearing");
  await openWorkspaceAgent(page);
  await page
    .getByTestId("agent-message")
    .fill("Add a welcome sign. Typing look at sign should describe it.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toContain("Welcome sign");
  expect(await workspaceDocument(page, "logic:1")).toContain("Edited after the live room arrived");
  expect(await workspaceDocument(page, "notes")).toBe(
    "Keep this draft while the next rooms are built.",
  );
});
