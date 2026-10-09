import { test, expect } from "./test.ts";
import {
  isolateStorage,
  configureAi,
  textHook,
  openWorkspaceAgent,
  workspaceSaved,
} from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

for (const width of [1440, 1063, 390]) {
  for (const order of ["native-first", "draft-first"] as const) {
    test(`mixed captured LOGIC previews preserve native and draft vocabulary after reload (${order}, ${width}) @webkit-desktop`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : width === 1063 ? 815 : 900,
      });
      await isolateStorage(page);
      await page.goto("/");
      await configureAi(page, { provider: "stub" });
      await page.goto("/#create-adventure");
      await page.getByTestId("local-create-kind-starter").click();
      await page.getByRole("button", { name: "Start building", exact: true }).click();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      // Set up an unadmitted vocabulary through the production draft boundary.
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const words = JSON.parse(String(session.workingSnapshot().read("words")!.content)) as [
          string,
          number,
        ][];
        await session.stage([
          {
            key: "words",
            content: JSON.stringify([
              ...words.filter(([, group]) => group !== 100),
              ["banana", 100],
            ]),
          },
          { key: "logic:0", content: 'if (said("banana")) { print("Draft"); } return;' },
        ]);
      });
      await configureAi(page, { provider: "openai", key: "test-placeholder" });
      await page.getByRole("radio", { name: "Play", exact: true }).click();
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      let requests = 0;
      await page.route("**/api/openai/v1/responses", async (route) => {
        requests++;
        const native = {
          type: "function_call",
          call_id: "native",
          name: "read_logic",
          arguments: JSON.stringify({ num: 1, offset: null, limit: null }),
        };
        const draft = {
          type: "function_call",
          call_id: "draft",
          name: "read_document",
          arguments: JSON.stringify({ key: "logic:0", offset: null, limit: null }),
        };
        await route.fulfill(
          providerReply("openai", {
            id: `capture-${requests}`,
            output:
              requests === 1
                ? order === "native-first"
                  ? [native, draft]
                  : [draft, native]
                : [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Both captured versions." }],
                    },
                  ],
          }),
        );
      });
      await page.getByTestId("agent-message").fill("Inspect native and draft logics");
      await page.getByTestId("agent-send").click();
      await expect(page.getByTestId("agent-conversation")).toContainText("Both captured versions.");
      async function verifyPreviews() {
        const buttons = page.getByTestId("agent-result").getByRole("button");
        await expect(buttons).toHaveCount(2);
        for (const [index, word] of (order === "native-first"
          ? ["examine", "banana"]
          : ["banana", "examine"]
        ).entries()) {
          await buttons.nth(index).click();
          const result = page.getByTestId("agent-result-preview");
          await expect(result).toBeVisible();
          if (width === 390) expect((await result.boundingBox())!.width).toBe(390);
          const source = result.locator(".agent-source-preview");
          await expect(source).toBeVisible();
          await expect(source).toContainText(`said("${word}")`);
          await expect(source).not.toContainText(
            `said("${word === "banana" ? "examine" : "banana"}")`,
          );
          await expect(result.getByTestId("agent-earlier-version")).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(`capture-${width}-${order}-${word}.png`),
          });
          await result.getByRole("button", { name: "Back to chat", exact: true }).click();
        }
      }
      await verifyPreviews();
      if (width === 390) await page.getByTestId("agent-panel-close").click();
      await page.getByRole("radio", { name: "Create", exact: true }).click();
      await workspaceSaved(page);
      await page.reload();
      await openWorkspaceAgent(page);
      await expect(page.getByTestId("agent-conversation")).toContainText("Both captured versions.");
      await verifyPreviews();
      expect(requests).toBe(2);
    });
  }
}
