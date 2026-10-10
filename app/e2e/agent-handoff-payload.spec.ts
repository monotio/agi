import { test, expect } from "./test.ts";
import { isolateStorage, configureAi, textHook, workspaceSaved } from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { traceImageChanges } from "../../src/creative/imageOperations.ts";
import type { ProjectContent } from "../../src/authoring/projectContent.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

test("captured art survives reload while a model handoff sends source outcomes without image payloads @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
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
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    if (!(await session.ready)) throw new Error("Project session could not acquire ownership.");
  });
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const documents: Record<string, ProjectContent> = { "picture:1": "end", "picture:2": "end" };
  for (const [target, size, color] of [
    ["picture:1", 16, 127],
    ["picture:2", 1, 63],
  ] as const) {
    const rgba = new Uint8Array(size * size * 4).fill(color);
    for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
    Object.assign(
      documents,
      Object.fromEntries(
        traceImageChanges(documents, target, {
          title: target,
          mime: "image/png",
          width: size,
          height: size,
          rgba,
          encoded: encodePngRgba(size, size, rgba),
        }).map(({ key, content }) => [key, content!]),
      ),
    );
  }
  for (let number = 2; number <= 6; number++) documents[`logic:${number}`] = "return;";
  await page.evaluate(
    async (entries) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const changes = entries.map(([key, content]) => ({
        key,
        content: typeof content === "string" ? content : new Uint8Array(content),
      }));
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Reference art", changes),
        label: "Reference art",
        author: "creator",
        origin: "picture",
      });
    },
    Object.entries(documents).map(
      ([key, content]) => [key, typeof content === "string" ? content : [...content]] as const,
    ),
  );
  await workspaceSaved(page);
  await configureAi(page, { provider: "openai", model: "gpt-6.1-sol", key: "test-placeholder" });
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  let requests = 0;
  let handoff = "";
  await page.route("**/api/openai/v1/responses", async (route) => {
    const body = route.request().postDataJSON();
    const request = ++requests;
    const text = JSON.stringify(body.input);
    const summarizing = text.includes("compaction summary pattern");
    if (summarizing) handoff = text;
    await route.fulfill(
      providerReply("openai", {
        id: `payload-${request}`,
        output:
          request === 1
            ? [...Array.from({ length: 5 }, (_, index) => `logic:${index + 2}`), "picture:1"].map(
                (key, index) => ({
                  type: "function_call",
                  call_id: `read-${index}`,
                  name: "read_document",
                  arguments: JSON.stringify({ key, offset: null, limit: null }),
                }),
              )
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: summarizing
                        ? "Objective: inspect source and reference art. Next: continue."
                        : request === 2
                          ? "Captured source and art."
                          : "Continued.",
                    },
                  ],
                },
              ],
      }),
    );
  });
  await page.getByTestId("agent-message").fill("Inspect the five logics and the first picture");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("Captured source and art.");
  const results = page.getByTestId("agent-result").getByRole("button");
  await expect(results).toHaveCount(6);
  await results.last().click();
  const preview = page.getByTestId("agent-result-preview");
  await expect(preview.getByRole("img")).toBeVisible();
  await expect(preview.getByTestId("agent-earlier-version")).toHaveCount(0);
  await preview.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.getByTestId("agent-panel-close").click();
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await workspaceSaved(page);
  await page.reload();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(results).toHaveCount(6);
  await results.last().click();
  await expect(preview.getByRole("img")).toBeVisible();
  await expect(preview.getByTestId("agent-earlier-version")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("captured-reference-after-reload.png") });
  await preview.getByRole("button", { name: "Back to chat", exact: true }).click();
  await configureAi(page, { provider: "openai", model: "gpt-6-sol", key: "test-placeholder" });
  await page.getByTestId("agent-message").fill("Continue");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("Continued.");
  expect(handoff).toContain("logic:2");
  expect(handoff).toContain("picture:1");
  expect(handoff).not.toContain("attachment:");
  expect(handoff).not.toContain("resourceSnapshots");
  expect(handoff).not.toContain("rasterEncoding");
  expect(requests).toBe(4);
});
