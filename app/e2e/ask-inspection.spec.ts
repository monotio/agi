import type { ProjectSession } from "../src/project/projectSession.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { buildZip } from "../src/archive/zip.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { configureAi, enterCreateMode, textHook, workspaceSaved } from "./engineProbe.ts";
import { openStoredWorkspace } from "./workspaceShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("Ask inspects damaged native resources and retries saving without another request @webkit-desktop", async ({
  page,
}) => {
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  const files = Object.fromEntries(createStarterProject("starter").files());
  const sounds = new Uint8Array(256 * 3).fill(255);
  sounds.set(files["SNDDIR"]!);
  sounds.set([1, 255, 255], 255 * 3);
  files["SNDDIR"] = sounds;
  const zip = buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
  const requests: string[] = [];
  const heldRequest = Promise.withResolvers<void>();
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postData()!);
    const count = requests.length;
    if (count > 3) await heldRequest.promise;
    const output =
      count === 1
        ? [
            {
              type: "function_call",
              call_id: "room",
              name: "read_room",
              arguments: JSON.stringify({ room: 1, state: null, frames: null }),
            },
          ]
        : count === 2
          ? [
              {
                type: "function_call",
                call_id: "sound",
                name: "read_sound",
                arguments: JSON.stringify({ num: 255 }),
              },
              {
                type: "function_call",
                call_id: "logic",
                name: "read_logic",
                arguments: JSON.stringify({ num: 0, offset: null, limit: null }),
              },
              {
                type: "function_call",
                call_id: "write",
                name: "write_logic",
                arguments: JSON.stringify({ room: 0, source: "return;" }),
              },
            ]
          : [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: '{"commands":["look around"]}' }],
              },
            ];
    await route.fulfill(providerReply("openai", { id: `inspection-${count}`, output }));
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "inspection.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await enterCreateMode(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("part-words").click();
  await page
    .getByTestId("workspace-words-editor")
    .getByRole("button", { name: "Suggest sentences", exact: true })
    .click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel.getByTestId("agent-message")).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession | null } }
          ).__AGI_PROJECT__.getSession() !== null,
      ),
    )
    .toBe(true);
  const before = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.flush();
    return {
      documentId: session.model.capture().documentId,
      history: session.history.capture(),
      files: Object.fromEntries(
        [...session.model.capture().lastAdmissibleBuild!.files()].map(([name, bytes]) => [
          name,
          [...bytes],
        ]),
      ),
    };
  });
  // Refuse actual IndexedDB writes after the initial editable copy has settled.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut(): void }).restorePut = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("Storage refused", "QuotaExceededError");
    };
  });
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    panel.locator(".agent-panel__message").filter({ hasText: "Predicted 1 command" }),
  ).toBeVisible();
  await expect(page.getByTestId("agent-retry-save")).toBeVisible();
  expect(requests).toHaveLength(3);
  const toolResults = JSON.parse(requests[2]!).input as {
    type: string;
    call_id?: string;
    output?: { text: string }[];
  }[];
  const soundResult = JSON.parse(
    toolResults.find((entry) => entry.type === "function_call_output" && entry.call_id === "sound")!
      .output![0]!.text,
  );
  expect(soundResult.success).toBe(false);
  expect(soundResult.error).toContain("out of bounds");
  expect(requests[2]).toContain("This tool is unavailable");
  await expect(page.getByTestId("agent-review")).toHaveCount(0);

  const after = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return {
      documentId: session.model.capture().documentId,
      history: session.history.capture(),
      files: Object.fromEntries(
        [...session.model.capture().lastAdmissibleBuild!.files()].map(([name, bytes]) => [
          name,
          [...bytes],
        ]),
      ),
    };
  });
  expect(after).toEqual(before);
  await reviewShot(page, "ask-save-retry");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("agent-retry-save")).toBeInViewport();
  // The full-width conversation stays above the game's storage recovery notice.
  await expect
    .poll(() =>
      page.getByTestId("download-unsaved-edits").evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return Boolean(
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('[data-testid="agent-drawer"]'),
        );
      }),
    )
    .toBe(true);
  await reviewShot(page, "ask-save-retry-phone");
  await page.evaluate(() => (window as unknown as { restorePut(): void }).restorePut());
  await page.getByTestId("agent-retry-save").click();
  await expect(page.getByTestId("agent-retry-save")).toBeHidden();
  expect(requests).toHaveLength(3);
  // A new prepared Ask keeps Stop bound to the same task chat.
  await panel.getByTestId("agent-panel-close").click();
  await page
    .getByTestId("workspace-words-editor")
    .getByRole("button", { name: "Suggest sentences", exact: true })
    .click();
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  await page.getByTestId("agent-stop").click();
  heldRequest.resolve();
  await expect(page.getByTestId("agent-continue")).toBeVisible();
  await page.getByTestId("agent-discard").click();
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await page.getByTestId("agent-panel-close").first().click();
  await page.reload();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await enterCreateMode(page);
  await page.getByTestId("workspace-agent").click();
  await expect(panel).toContainText("Predicted 1 command");
});

test("closing before an Ask conversation commits recovers the answer once @webkit-desktop", async ({
  page,
  context,
}) => {
  const reply = "ASK_CLOSE_BEFORE_COMMIT_SENTINEL";
  let requests = 0;
  await context.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: "close-recovery",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] },
        ],
      }),
    );
  });
  await context.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Ask recovery");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await workspaceSaved(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  const before = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.flush();
    return {
      documentId: session.model.capture().documentId,
      history: session.history.capture(),
      revision: session.model.capture().lastAdmissibleBuild!.identity.revision,
    };
  });
  await page.getByTestId("part-words").click();
  await page
    .getByTestId("workspace-words-editor")
    .getByRole("button", { name: "Suggest sentences", exact: true })
    .click();
  await page.evaluate((sentinel) => {
    const put = IDBObjectStore.prototype.put;
    const held = new WeakSet<IDBTransaction>();
    IDBObjectStore.prototype.put = function (...args) {
      if (JSON.stringify(args[0]).includes(sentinel) && !held.has(this.transaction)) {
        held.add(this.transaction);
        Object.assign(window, { askWriteHeld: true });
        const pump = () => {
          this.get("__hold_ask_write__").onsuccess = pump;
        };
        pump();
      }
      return put.apply(this, args);
    };
  }, reply);
  await page
    .getByTestId("workspace-agent-panel")
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect(page.locator(".agent-panel__message").filter({ hasText: reply })).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { askWriteHeld?: boolean }).askWriteHeld))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("monotio_agi.project-writes."))
          .map((key) => localStorage.getItem(key))
          .join("\n"),
      ),
    )
    .toContain(reply);
  const recovered = await context.newPage();
  await page.close();
  await recovered.goto("/");
  await openStoredWorkspace(recovered, "Ask recovery");
  await workspaceSaved(recovered);
  await recovered.getByTestId("workspace-agent").click();
  await expect(recovered.locator(".agent-panel__message").filter({ hasText: reply })).toHaveCount(
    1,
  );
  const after = await recovered.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return {
      documentId: session.model.capture().documentId,
      history: session.history.capture(),
      revision: session.model.capture().lastAdmissibleBuild!.identity.revision,
      chats: session.chats(),
    };
  });
  expect({
    documentId: after.documentId,
    history: after.history,
    revision: after.revision,
  }).toEqual(before);
  expect(JSON.stringify(after.chats)).toContain(reply);
  expect(requests).toBe(1);
  await reviewShot(recovered, "ask-close-recovery");
});
