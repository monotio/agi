import { readFile } from "node:fs/promises";
import type { Download } from "@playwright/test";
import { providerReply } from "../../test/provider-stream.ts";
import { expect, test } from "./test.ts";
import {
  configureAi,
  downloadFromSettings,
  isolateStorage,
  openWorkspaceAgent,
  workspaceSaved,
  waitForRoom,
} from "./engineProbe.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { openContainer } from "../../src/container/container.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";

test("approved starter sound downloads a coherent project before and after reload @webkit-desktop", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../evals/fixtures/bad-cases/project-agent-sound-save-export.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let requests = 0;
  // Every provider response is supplied locally; the test never calls a paid provider.
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `sound-${requests}`,
        status: "completed",
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  id: "chime",
                  call_id: "chime",
                  name: "write_sound",
                  arguments: JSON.stringify(fixture.projectAgent.turns[0].toolCalls[0].input),
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Updated the chime." }],
                },
              ],
      }),
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Sound export");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);
  await openWorkspaceAgent(page);
  await page.getByTestId("agent-message").fill(fixture.projectAgent.request);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  for (let index = 0; index < 2; index++) {
    await downloadFromSettings(page, true);
    await expect
      .poll(async () => ({
        downloads: downloads.length,
        refusal: await page.getByTestId("export-refusal").count(),
      }))
      .toEqual({ downloads: index + 1, refusal: 0 });
    const opened = await readGameZip(
      new Uint8Array(await readFile((await downloads[index]!.path())!)),
    );
    expect(openContainer(new Map(Object.entries(opened.files))).getResource("sound", 1)).toEqual(
      Uint8Array.from(fixture.projectAgent.expectedSoundPayload!),
    );
    const source = readProjectWorkspace(opened.project!.workspace!)["sound:1"];
    const legacy = opened.project!.authoringState!["sources"] as { sounds: [number, unknown][] };
    expect(legacy.sounds.find(([num]) => num === 1)![1]).toEqual(JSON.parse(String(source)));
    if (index === 0) {
      await workspaceSaved(page);
      await page.reload();
      await waitForRoom(page, 1, { coldBoot: true });
      await expect(page.getByTestId("parts-list")).toBeVisible();
      await workspaceSaved(page);
    }
  }
  expect(requests).toBe(2);
});
