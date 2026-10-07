import type { Page } from "@playwright/test";
import { expect } from "../test.ts";
import { AgentSession } from "../../src/agent/agentSession.ts";
import { buildProjectZip } from "../../src/archive/projectArchive.ts";
import { testProjectId } from "../../test/identity.ts";
import { providerReply } from "../../../test/provider-stream.ts";
import { ORIGINAL_SCENE_PICTURES } from "../../../games/adventure-department/sceneArt.ts";
import { buildTutorial } from "../../../games/adventure-department/game.ts";
import { openContainer } from "../../../src/container/container.ts";
import { configureAi, textHook } from "../engineProbe.ts";

/**
 * A game made with the deterministic stub, with AI rooms on, dressed in the
 * tutorial's own gallery picture and hero so the clip shows original art.
 * Walking east
 * asks the provider for room 2; the reply is a recorded one that writes the
 * tutorial's own Sprite Lab picture and a short LOGIC, held until `release`
 * so the overlay stays on screen. Validation, compiling and the room entry
 * are the app's own.
 */
export async function openRoomGenerationGame(page: Page): Promise<{ release(): void }> {
  const session = new AgentSession({ provider: "stub", apiKey: "", model: "stub" }, () => {});
  const resources = await session.startGenesis("A clearing and a workshop.");
  const tutorial = openContainer(new Map(Object.entries(buildTutorial().files)));
  const game = openContainer(new Map(Object.entries(resources.files)));
  game.putResource("picture", 1, tutorial.getResource("picture", 1)!);
  game.putResource("view", 0, tutorial.getResource("view", 0)!);
  resources.files = Object.fromEntries(game.files);
  const zip = await buildProjectZip({
    projectId: testProjectId("media-room-generation"),
    title: "The museum",
    authoredAt: "",
    provider: "openai",
    model: "gpt-6-sol",
    ...resources,
    roomGeneration: true,
    authoringState: session.getAuthoringState(),
  });
  await page.goto("/");
  await configureAi(page, {
    provider: "openai",
    model: "gpt-6-sol",
    key: "test-placeholder",
    budget: 5,
  });
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "workshop.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect(page.locator(".game-surface:visible")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);

  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/openai/v1/responses", async (route) => {
    await pending;
    await route.fulfill(roomReply());
  });
  return { release: () => release() };
}

/** Type the command letter by letter, as a player would. */
export async function walkInto(page: Page, delay = 0): Promise<void> {
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.pressSequentially("east", { delay });
  await input.press("Enter");
}

const LOGIC = `if (isset(f5)) {
  load.pic(v0); draw.pic(v0); show.pic(); set.horizon(40);
  animate.obj(o0); set.view(o0,0); position(o0,20,130); draw(o0); accept.input();
  print("Workbenches line the walls. Someone left a lever half fitted.");
}
if (said("west")) { new.room(1); }
if (said("north")) { new.room(3); }
return;`;

function roomReply() {
  const id = "media-room";
  return providerReply("openai", {
    id,
    usage: { input_tokens: 0, output_tokens: 0 },
    output: [
      {
        type: "function_call",
        call_id: `${id}-pic`,
        name: "write_picture",
        arguments: JSON.stringify({ room: 2, source: ORIGINAL_SCENE_PICTURES[2] }),
      },
      {
        type: "function_call",
        call_id: `${id}-logic`,
        name: "write_logic",
        arguments: JSON.stringify({ room: 2, source: LOGIC }),
      },
      {
        type: "function_call",
        call_id: `${id}-finish`,
        name: "finish",
        arguments: '{"notes":"The workshop is ready."}',
      },
    ],
  });
}
