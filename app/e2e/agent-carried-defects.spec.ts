import type { ProjectSession } from "../src/project/projectSession.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { buildZip } from "../src/archive/zip.ts";
import { providerReply } from "../../test/provider-stream.ts";
import {
  configureAi,
  enterCreateMode,
  isolateStorage,
  openWorkspaceAgent,
  textHook,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * Original releases ship directory entries no reader can follow. An edit to
 * something else still applies, the person reads a calm notice naming the
 * unreadable part, and no raw error appears.
 */
test("an edit applies to a game with an unreadable sound and the notice names it @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  const project = createStarterProject("starter");
  const files = Object.fromEntries(project.files());
  // SOUND 254: volume 0 at offset 0x1ffff, far past the end of VOL.0.
  const sounds = new Uint8Array(files["SNDDIR"]!);
  sounds.set([1, 255, 255], 254 * 3);
  files["SNDDIR"] = sounds;
  const zip = buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `carried-${requests}`,
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  call_id: "write",
                  name: "write_words",
                  arguments: '{"words":["sparkle"]}',
                },
                {
                  type: "function_call",
                  call_id: "finish",
                  name: "finish",
                  arguments: '{"notes":null}',
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Added sparkle." }],
                },
              ],
      }),
    );
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "carried.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await enterCreateMode(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await openWorkspaceAgent(page);
  const panel = page.getByTestId("workspace-agent-panel");
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
  await panel.getByTestId("agent-message").fill("Add sparkle to the vocabulary");
  await panel.getByTestId("agent-send").click();
  // The handover validates the staged image before the review appears.
  await expect(page.getByTestId("agent-approve")).toBeEnabled({ timeout: 30_000 });
  const notice = page.getByTestId("agent-notice");
  await expect(notice).toHaveText(
    "One sound in this game (254) cannot be read, so it stays as it is.",
  );
  await expect(page.getByTestId("agent-error")).toHaveCount(0);
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await workspaceSaved(page);
  await expect(page.getByTestId("agent-error")).toHaveCount(0);
  await expect(notice).toBeVisible();
  const applied = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const image = capture.lastAdmissibleBuild!.files();
    const words = capture.read("words")!.content;
    return {
      words: typeof words === "string" ? (JSON.parse(words) as [string, number][]) : null,
      entry: [...image.get("SNDDIR")!.subarray(254 * 3, 254 * 3 + 3)],
    };
  });
  expect(applied.words?.map(([word]) => word)).toContain("sparkle");
  expect(applied.entry).toEqual([1, 255, 255]);
});
