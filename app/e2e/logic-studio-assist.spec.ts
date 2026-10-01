import type { Page, Route } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { configureAi, isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

/**
 * The Logic Studio assistant panel over the real app: the stored project,
 * the shared AI settings, and a routed OpenAI Responses stream standing in
 * for the model. Every spec asserts the transport by hand — the request's
 * model, its narrow tool catalog, the attached editor context — and that
 * nothing provider-bound moves before the first Ask. No paid provider is
 * ever contacted; the key in these tests is a placeholder.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const ASSIST_SOURCE =
  "// Room 1\nif (isset(f5)) {\n  accept.input();\n}\n// added by the assistant\nreturn;";
const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "blank",
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ title, kind }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title, kind });
      await prepared.save();
      return prepared.projectId as string;
    },
    { title, kind },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

/** Open Logic Studio on the stored project through the library card's Edit. */
async function openStudio(page: Page, title: string) {
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  return studio;
}

const call = (id: string, name: string, args: unknown) =>
  providerReply("openai", {
    id,
    output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }],
  });
const say = (id: string, text: string) =>
  providerReply("openai", {
    id,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  });
async function fulfil(route: Route, reply: ReturnType<typeof providerReply>): Promise<void> {
  try {
    await route.fulfill(reply);
  } catch {
    // A cancelled request aborts the fetch before the route answers.
  }
}

test("assistant reviews a proposed change, applies it once, undoes it, keeps it @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const request = bodies.length;
    if (request === 1) return fulfil(route, call("r1", "read_project_context", {}));
    if (request === 2)
      return fulfil(
        route,
        call("r2", "propose_project_documents", {
          label: "Comment the room",
          changes: [{ key: "logic:1", content: ASSIST_SOURCE }],
        }),
      );
    return fulfil(route, say(`s${request}`, "Added a comment to room 1."));
  });
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  const projectId = await seedLocalProject(page, "Assist me");
  await page.reload();
  const studio = await openStudio(page, "Assist me");
  const panel = studio.getByTestId("logic-assistant");
  await expect(panel).toBeVisible();
  // The saved provider bound locally at mount: connected, Review the default,
  // and not one provider request before the first Ask.
  await expect(panel.getByTestId("logic-assistant-provider")).toContainText("openai · gpt-6.1-sol");
  await expect(panel.getByTestId("logic-assistant-mode-chip")).toHaveText("Review");
  expect(bodies).toHaveLength(0);

  // The open document is the attached context.
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await expect(studio.getByTestId("logic-editor").locator(".monaco-editor")).toBeVisible();

  const input = panel.getByTestId("logic-assistant-input");
  await input.fill("Add a comment to the open room");
  await reviewShot(page, "logic-assist-connected");
  await panel.getByTestId("logic-assistant-ask").click();
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(1);

  // The exact request: the saved model, the narrow project catalog, the
  // captured editor context — and no source outside the document set.
  expect(bodies[0]!["model"]).toBe("gpt-6.1-sol");
  const tools = ((bodies[0]!["tools"] as { name: string }[]) ?? []).map((tool) => tool.name);
  expect(tools).toEqual([
    "read_project_context",
    "read_document",
    "propose_project_documents",
    "withdraw_proposal",
    "read_command_reference",
    "read_authoring_guide",
  ]);
  const sent = JSON.stringify(bodies[0]!["input"]);
  expect(sent).toContain("Add a comment to the open room");
  expect(sent).toContain("Attached context");
  expect(sent).toContain("Document: logic:1");

  const proposal = panel.getByTestId("logic-assistant-proposal");
  await expect(proposal).toBeVisible({ timeout: 15_000 });
  await expect(proposal.getByTestId("logic-assistant-summary")).toContainText("Comment the room");
  await expect(proposal.getByTestId("logic-assistant-keys")).toContainText("LOGIC 1");
  // The draft is untouched: review first, always.
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");

  await proposal.getByTestId("logic-assistant-review").click();
  const review = page.getByTestId("logic-agent-review");
  await expect(review).toBeVisible();
  const diff = review.getByTestId("logic-agent-diff");
  await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
  await expect(diff.locator(".modified .view-lines")).toContainText("added by the assistant");
  await reviewShot(page, "logic-assist-diff");

  await review.getByTestId("logic-agent-approve").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await expect(studio.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "added by the assistant",
  );

  // One atomic transaction: Undo changes reverts the draft and the model.
  await panel.getByTestId("logic-assistant-undo").click();
  await expect(studio.getByTestId("logic-editor").locator(".view-lines")).not.toContainText(
    "added by the assistant",
  );
  await panel.getByTestId("logic-assistant-redo").click();
  await expect(studio.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "added by the assistant",
  );

  // Keep writes it; the stored document is the proposed source.
  await page.getByTestId("logic-review-build").click();
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-saved-note")).toContainText("Saved to the library");
  const stored = await page.evaluate(async (id) => {
    const storage = await import("/src/project/gameStorage.ts");
    const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
    const data = await storage.loadAuthoredGame(id as never);
    if (!data) return null;
    const document = inspectEditableProject(data).documents["logic:1"];
    return typeof document === "string" ? document : null;
  }, projectId);
  expect(stored).toContain("added by the assistant");
  expect(bodies.length).toBe(3);
});

test("typing while the AI works makes its proposal stale; the draft keeps the typed text @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    const request = ++requests;
    if (request === 1) return fulfil(route, call("r1", "read_project_context", {}));
    if (request === 2)
      return fulfil(
        route,
        call("r2", "propose_project_documents", {
          label: "Late proposal",
          changes: [{ key: "logic:1", content: ASSIST_SOURCE }],
        }),
      );
    await held;
    return fulfil(route, say(`s${request}`, "Done."));
  });
  try {
    await page.goto("/");
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    await seedLocalProject(page, "Stale assist");
    await page.reload();
    const studio = await openStudio(page, "Stale assist");
    const panel = studio.getByTestId("logic-assistant");
    await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
    const editor = studio.getByTestId("logic-editor");
    await panel.getByTestId("logic-assistant-input").fill("Change the room");
    await panel.getByTestId("logic-assistant-ask").click();
    // While the last provider call hangs, the tool steps it took stay visible.
    await expect(panel.getByTestId("logic-assistant-running")).toBeVisible();
    await expect(panel.getByTestId("logic-assistant-steps")).toContainText("Read the project");
    await expect(panel.getByTestId("logic-assistant-steps")).toContainText("Proposed changes");
    await expect.poll(() => requests).toBe(3);

    // Type while the third request is in flight: the proposal's base is now
    // behind the draft.
    await editor.locator(".view-lines").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type("\n// typed while it thought");
    release();
    const proposal = panel.getByTestId("logic-assistant-proposal");
    await expect(proposal).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId("logic-assistant-stale")).toContainText("changed");

    // The stale diff stays reviewable; approve is off; the typed text stands.
    await proposal.getByTestId("logic-assistant-review").click();
    const review = page.getByTestId("logic-agent-review");
    await expect(review).toBeVisible();
    await expect(review.getByTestId("logic-agent-approve")).toBeDisabled();
    await review.getByTestId("logic-agent-again").click();
    await expect(editor.locator(".view-lines")).toContainText("typed while it thought");
    await expect(editor.locator(".view-lines")).not.toContainText("added by the assistant");
  } finally {
    release();
  }
});

test("Stop parks a running request; Cancel abandons it without touching the draft @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/openai/v1/responses", async (route) => {
    await held;
    return fulfil(route, say("s1", "Too late."));
  });
  try {
    await page.goto("/");
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    await seedLocalProject(page, "Stop assist");
    await page.reload();
    const studio = await openStudio(page, "Stop assist");
    const panel = studio.getByTestId("logic-assistant");
    await panel.getByTestId("logic-assistant-input").fill("Anything");
    await panel.getByTestId("logic-assistant-ask").click();
    await expect(panel.getByTestId("logic-assistant-running")).toBeVisible();
    await panel.getByTestId("logic-assistant-stop").click();
    await expect(panel.getByTestId("logic-assistant-cancel")).toBeVisible({ timeout: 15_000 });
    await panel.getByTestId("logic-assistant-cancel").click();
    await expect(panel.getByTestId("logic-assistant-running")).toBeHidden();
    await expect(panel.getByTestId("logic-assistant-live")).toContainText("Cancelled");
    await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
    // The composer is ready again.
    await expect(panel.getByTestId("logic-assistant-ask")).toBeVisible();
  } finally {
    release();
  }
});

test("no key leaves the panel a connect point; a small laptop reaches it as a drawer @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(
    /api\.openai\.com|api\.anthropic\.com|\/api\/openai\/|\/api\/anthropic\//,
    () => {
      providerCalls++;
      return Promise.resolve();
    },
  );
  await page.goto("/");
  await seedLocalProject(page, "No key here");
  await page.reload();
  const studio = await openStudio(page, "No key here");
  const panel = studio.getByTestId("logic-assistant");
  await expect(panel).toBeVisible();

  // Connect opens the shared settings dialog; no request fires meanwhile.
  await panel.getByTestId("logic-assistant-connect").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Manual editing is untouched by an unconnected panel.
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  const editor = studio.getByTestId("logic-editor");
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type("\n// mine, not its");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  expect(providerCalls).toBe(0);

  // A small laptop keeps the assistant reachable through the explicit
  // toggle: an open panel stays open as a drawer, Escape or the toggle
  // closes it, and the toggle always brings it back.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(panel).toBeVisible();
  await page.getByTestId("logic-assistant-toggle").click();
  await expect(panel).toBeHidden();
  await page.getByTestId("logic-assistant-toggle").click();
  await expect(panel).toBeVisible();
  // The drawer moved focus inside itself — the first control, Connect AI.
  await expect(panel.getByTestId("logic-assistant-connect")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("logic-assistant-toggle")).toBeFocused();
});
