import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildSound } from "../../src/agent/tools.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { buildZip } from "../src/zip.ts";
import { configureAi, textHook } from "./engineProbe.ts";

type ProviderItem = {
  type?: string;
  call_id?: string;
  output?: { type?: string; text?: string; image_url?: string }[];
};

function toolOutput(request: Record<string, unknown>, callId: string): ProviderItem["output"] {
  const input = request["input"] as ProviderItem[];
  return input.find((item) => item.type === "function_call_output" && item.call_id === callId)
    ?.output;
}

async function importSoundGame(page: Page): Promise<void> {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic('assignn(v0, 1); display(5, 4, "Listen closely."); accept.input(); return;', {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "sound",
    5,
    buildSound([
      {
        notes: [
          { note: "C4", duration: 30, attenuation: 1 },
          { note: "E4", duration: 30, attenuation: 2 },
        ],
      },
      { notes: [{ note: "G4", duration: 60, attenuation: 3 }] },
      { notes: [] },
      { notes: [] },
    ]),
  );
  const zip = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
  );
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "sound-feedback.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await expect(page.getByTestId("game-import-ready")).toBeVisible();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

test("Ask presents a local WAV while the model receives only sound data and a timeline", async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postDataJSON());
    const turn = requests.length;
    await route.fulfill(
      providerReply("openai", {
        id: `sound-reply-${turn}`,
        output:
          turn === 1
            ? [
                {
                  type: "function_call",
                  call_id: "inspect-sound",
                  name: "read_sound",
                  arguments: JSON.stringify({
                    num: 5,
                    channel: null,
                    offset: null,
                    limit: null,
                    representation: "music",
                  }),
                },
              ]
            : turn === 2
              ? [
                  {
                    type: "function_call",
                    call_id: "sound-events",
                    name: "read_diagnostic",
                    arguments: JSON.stringify({
                      id: "d1",
                      fields: ["events"],
                      offset: null,
                      limit: null,
                    }),
                  },
                ]
              : turn === 3
                ? [
                    {
                      type: "function_call",
                      call_id: "listen-sound",
                      name: "preview_sound",
                      arguments: JSON.stringify({
                        num: 5,
                        startSeconds: 0,
                        durationSeconds: 1,
                        device: "tandy",
                      }),
                    },
                  ]
                : [
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: "The one-second Tandy preview is ready to play.",
                        },
                      ],
                    },
                  ],
      }),
    );
  });

  await page.goto("/");
  await importSoundGame(page);
  await page.getByTestId("power-up").click();
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-bubble-input").fill("Inspect sound 5 and let me hear it.");
  await page.getByTestId("agent-bubble-send").click();

  await expect(page.getByTestId("agent-conversation")).toContainText(
    "The one-second Tandy preview is ready to play.",
  );
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  expect(requests).toHaveLength(4);

  const readBlocks = toolOutput(requests[1]!, "inspect-sound")!;
  expect(readBlocks.some((block) => block.type === "input_image")).toBe(true);
  expect(readBlocks.some((block) => block.image_url?.startsWith("data:image/png;base64,"))).toBe(
    true,
  );
  const readText = readBlocks.find((block) => block.type === "input_text")!.text!;
  expect(readText).toContain("diagnosticId");
  expect(readText).toContain("read_diagnostic");

  const eventBlocks = toolOutput(requests[2]!, "sound-events")!;
  const eventText = eventBlocks.find((block) => block.type === "input_text")!.text!;
  expect(eventText).toContain("noteName");
  expect(eventText).toContain("startSeconds");

  const previewBlocks = toolOutput(requests[3]!, "listen-sound")!;
  expect(previewBlocks).toHaveLength(1);
  const previewText = previewBlocks[0]!.text!;
  expect(previewText).toContain("Audio is not sent to the model");
  expect(JSON.parse(previewText).wav).toBeUndefined();
  expect(previewText).not.toMatch(/data:audio|"wav"\s*:|UklGR/i);

  const preview = page.getByTestId("agent-bubble-sound-preview");
  await expect(preview).not.toContainText("The agent receives");
  await expect(preview).toContainText("Sound 5");
  const audio = preview.getByTestId("sound-preview-audio");
  await expect(audio).toHaveAttribute("controls", "");
  await expect(audio).not.toHaveAttribute("autoplay", "");
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState))
    .toBeGreaterThanOrEqual(1);
  const duration = await audio.evaluate((node: HTMLAudioElement) => node.duration);
  expect(duration).toBeGreaterThan(0.98);
  expect(duration).toBeLessThan(1.02);
  expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
  await audio.evaluate((node: HTMLAudioElement) => node.play());
  await expect
    .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBeGreaterThan(0);
  await audio.evaluate((node: HTMLAudioElement) => node.pause());
  expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);

  const download = preview.getByTestId("sound-preview-download");
  await expect(download).toHaveAttribute("download", /\.wav$/);
  expect(
    (await download.boundingBox())!.height,
    "Download WAV is a shared 44px control, not an inline link",
  ).toBeGreaterThanOrEqual(44);
  const wav = await download.evaluate(async (link: HTMLAnchorElement) => {
    const response = await fetch(link.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      type: response.headers.get("content-type"),
      signature: String.fromCharCode(...bytes.slice(0, 4)),
      wave: String.fromCharCode(...bytes.slice(8, 12)),
    };
  });
  expect(wav).toEqual({ type: "audio/wav", signature: "RIFF", wave: "WAVE" });
  const downloadEvent = page.waitForEvent("download");
  await download.click();
  const savedDownload = await downloadEvent;
  expect(savedDownload.suggestedFilename()).toBe("agi-sound-preview-1.wav");
  const stream = await savedDownload.createReadStream();
  const savedBytes: Buffer[] = [];
  for await (const chunk of stream) savedBytes.push(Buffer.from(chunk));
  expect(Buffer.concat(savedBytes).subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as Window & { __AGI_TRACE__?: unknown }).__AGI_TRACE__ ?? []),
    ),
  ).not.toMatch(/blob:|audio\/wav|"wav"/);

  await page.screenshot({ path: "test-results/sound-feedback-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await preview.scrollIntoViewIfNeeded();
  await expect(audio).toBeInViewport();
  await expect(download).toBeInViewport();
  await page.screenshot({ path: "test-results/sound-feedback-phone.png" });

  await page.getByRole("button", { name: "Back to game", exact: true }).first().click();
  await expect(page.getByTestId("latest-sound-preview")).toBeVisible();
  await page.getByTestId("agent-panel").locator("summary").click();
  await expect(page.getByTestId("agent-panel").getByTestId("sound-preview-audio")).toBeVisible();

  const blobUrl = await page
    .getByTestId("latest-sound-preview")
    .getByTestId("sound-preview-download")
    .getAttribute("href");
  await page.getByTestId("btn-clear-trace").click();
  await expect(page.getByTestId("latest-sound-preview")).toBeHidden();
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(url!);
        return false;
      } catch {
        return true;
      }
    }, blobUrl),
  ).toBe(true);
});
