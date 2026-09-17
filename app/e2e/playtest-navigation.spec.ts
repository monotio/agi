import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { buildZip } from "../src/zip.ts";
import { configureAi, isolateStorage, textHook } from "./engineProbe.ts";

test("agent playtest reports bounded navigation through the browser without moving the live game", async ({
  page,
}) => {
  const game = createContainer();
  game.putFile("WORDS.TOK", new Uint8Array(52));
  game.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 3, height: 2, pixels: [1, 1, 1, 1, 1, 1] }] }] }),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) {
      set(f200); assignn(v0,1); assignn(v10,1);
      load.pic(v0); draw.pic(v0); show.pic();
      load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
    }
    return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  let requests = 0;
  let toolOutput: unknown;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    if (requests > 1) {
      const request = route.request().postDataJSON() as {
        input: { type: string; call_id?: string; output?: { type: string; text?: string }[] }[];
      };
      const result = request.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "navigate",
      );
      const text = result?.output?.find((block) => block.type === "input_text")?.text;
      toolOutput = text ? JSON.parse(text) : null;
    }
    await route.fulfill(
      providerReply("openai", {
        id: `navigation-${requests}`,
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  call_id: "navigate",
                  name: "playtest_room",
                  arguments: JSON.stringify({
                    room: 1,
                    spawnX: null,
                    spawnY: null,
                    fromLiveCheckpoint: false,
                    cycleBudget: 100,
                    instructionBudget: 50000,
                    expect: null,
                    steps: [
                      {
                        action: "walkPath",
                        command: null,
                        direction: null,
                        key: null,
                        x: null,
                        y: null,
                        answer: null,
                        until: null,
                        waypoints: null,
                        target: { x0: 88, x1: 88, y0: 120, y1: 120 },
                        ticks: 30,
                        captureTicks: null,
                      },
                    ],
                  }),
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Navigation checked." }],
                },
              ],
      }),
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "navigation.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("power-up").click();
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("Check walking to the nearby region.");
  await page.getByTestId("agent-bubble-send").click();
  await expect.poll(() => toolOutput).toBeTruthy();
  expect(toolOutput).toMatchObject({
    success: true,
    details: {
      navigation: {
        status: "reached",
        room: 1,
        x: 88,
        y: 120,
        inputEnabled: true,
        movementControlEnabled: true,
        counters: { movementUpdates: 8, replans: 0 },
      },
    },
  });
  const live = await textHook(page);
  expect(live.egoX).toBe(80);
  expect(live.egoY).toBe(120);
});
