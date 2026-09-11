import { cacheGame, configureAi } from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildObjectFile } from "../../src/agent/tools.ts";
import { textHook } from "./engineProbe.ts";

for (const fail of [false, true])
  test(`room generation shows activity and ${fail ? "recovers from failure" : "enters with new inventory"}`, async ({
    page,
  }) => {
    const game = createContainer();
    game.putResource(
      "logic",
      0,
      assembleLogic(
        "set.key(9,0,1); if (controller(1)) { status(); } if (equaln(v0,0)) { new.room(1); } call.v(v0); return;",
        {
          dictionary: new Map(),
        },
      ).payload,
    );
    game.putResource(
      "logic",
      1,
      assembleLogic(
        "if (isset(f5)) { get(0); animate.obj(o0); set.view(o0,0); position(o0,155,100); draw(o0); accept.input(); } if (equaln(v2,2)) { new.room(2); } return;",
        { dictionary: new Map() },
      ).payload,
    );
    game.putResource(
      "view",
      0,
      buildView({ loops: [{ cels: [{ width: 2, height: 2, pixels: [15, 15, 15, 15] }] }] }),
    );
    game.putFile("OBJECT", buildObjectFile([{ name: "Old key", startingRoom: 1 }]));
    game.putFile("WORDS.TOK", new Uint8Array(52));
    await page.goto("/");
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    await cacheGame(page, {
      projectId: "progress",
      title: "A growing world",
      provider: "openai",
      model: "gpt-6-astra",
      imported: false,
      roomGeneration: true,
      files: Object.fromEntries(game.files),
      words: [],
    });
    let release!: () => void;
    let finish!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const final = new Promise<void>((r) => {
      finish = r;
    });
    let requests = 0;
    const providerRequests: Record<string, unknown>[] = [];
    await page.route("**/api/openai/v1/responses", async (route) => {
      providerRequests.push(route.request().postDataJSON());
      requests++;
      if (requests === 1) await pending;
      else await final;
      if (fail) {
        await route.fulfill({
          status: 400,
          json: { error: { message: "Room generation test failure" } },
        });
        return;
      }
      const calls = [
        [
          "read_live",
          { state: { variables: null, flags: null, compact: true }, objects: null, frames: null },
        ],
        ["read_live", { state: null, objects: { ids: null }, frames: null }],
        ["read_view", { num: 0 }],
        [
          "write_inventory_objects",
          {
            objects: [
              { name: "Old key", startingRoom: 1 },
              { name: "Letter", startingRoom: 255 },
            ],
          },
        ],
        ["write_picture", { room: 2, source: "vis 1\nfill 0,0\nend" }],
        [
          "write_logic_source",
          {
            room: 2,
            source:
              'if (isset(f5)) { assignn(v60,2); load.pic(v60); draw.pic(v60); show.pic(); display(5,2,"Room two is ready."); } return;',
          },
        ],
      ];
      await route.fulfill(
        providerReply("openai", {
          id: `room-${requests}`,
          output:
            requests === 1
              ? calls.map(([name, args], i) => ({
                  type: "function_call",
                  id: `item${i}`,
                  call_id: `call${i}`,
                  name,
                  arguments: JSON.stringify(args),
                }))
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Room ready." }],
                  },
                ],
        }),
      );
    });
    try {
      await page.reload();
      await page.getByTestId("btn-resume-cached").click();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await page.keyboard.down("ArrowRight");
      await expect.poll(() => requests).toBe(1);
      await page.keyboard.up("ArrowRight");
      const panel = page.getByTestId("agent-bubble");
      await expect(panel).toContainText("Creating the next room");
      await expect(panel.getByTestId("agent-bubble-room")).toContainText("2");
      await expect(page.getByTestId("agent-bubble-input")).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("power-up")).toBeDisabled();
      release();
      if (fail) {
        await expect(page.getByTestId("agent-bubble-error")).toContainText(
          "Room generation test failure",
        );
        await panel.getByRole("button", { name: "Back to game" }).click();
        await expect(panel).toBeHidden();
        await expect.poll(async () => (await textHook(page)).room).toBe(1);
      } else {
        await expect.poll(() => requests).toBe(2);
        await expect(panel.getByTestId("agent-bubble-feed")).toContainText("read_live -> ok");
        await expect(panel.getByTestId("agent-bubble-feed")).toContainText("read_view -> ok");
        const tools = (providerRequests[0]!["tool_choice"] as { tools: { name: string }[] }).tools;
        expect(tools.some((tool) => tool.name === "read_live")).toBe(true);
        expect(tools.some((tool) => tool.name === "handover")).toBe(true);
        const input = providerRequests[1]!["input"] as {
          type: string;
          call_id?: string;
          output?: { type: string; text: string }[];
        }[];
        const stateOutput = input.find(
          (item) => item.type === "function_call_output" && item.call_id === "call0",
        )!;
        const state = JSON.parse(stateOutput.output![0]!.text).details;
        expect(state.room).toBe(1);
        expect(state.inventory).toEqual([{ num: 0, name: "Old key", room: 255 }]);
        expect(state.vars).toHaveLength(256);
        const viewOutput = input.find(
          (item) => item.type === "function_call_output" && item.call_id === "call2",
        )!;
        expect(viewOutput.output!.some((block) => block.type === "input_image")).toBe(true);
        await expect(panel.getByTestId("agent-bubble-feed")).toContainText(
          "write_inventory_objects -> ok",
        );
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: "test-results/creating-next-room.png" });
        finish();
        await expect(panel).toBeHidden();
        await expect.poll(async () => (await textHook(page)).room).toBe(2);
        await page.keyboard.press("Tab");
        await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Letter");
        expect((await textHook(page)).rows.join(" ")).toContain("Old key");
      }
    } finally {
      release();
      finish();
    }
  });
