import { expect, test } from "./test.ts";
import type { Locator, Page, Route } from "@playwright/test";
import { providerReply } from "../../test/provider-stream.ts";
import {
  AFTER_BRIDGE,
  BRIDGE_SOURCE,
  DOT_EGO,
  ROBOT_VIEW,
} from "../../test/studioAssistFixtures.ts";
import { testProjectId } from "../test/identity.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { STUDIO_ASSIST_TOOLS } from "../../src/agent/studioAssistTools.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { openSprite } from "../../src/studio/sprite/spriteDocument.ts";
import { createPictureSurface } from "../../src/types.ts";
import { cacheGame, configureAi, enterCreateMode, textHook, waitForCycles } from "./engineProbe.ts";

/**
 * "Ask about this selection" in Room Studio and Sprite Studio on the real
 * app. The stub provider scripts the model side ("walkable", "eyes", "bad",
 * "impossible"); a routed OpenAI stream holds a request open where a test
 * needs one in flight (Stop, an edit during the run). The game holds the
 * bridge fixture as picture 1 and the robot as view 1; every expectation is
 * decoded here from the bytes read out of the page.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** Screenshots go here when set (the rc.5 review set), else to the test's output. */
const SHOTS = process.env["AGI_ASSIST_SHOTS"];
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: SHOTS ? `${SHOTS}/${name}.png` : test.info().outputPath(`${name}.png`),
  });

const PROJECT = testProjectId("studio-assist");
/** The room draws picture 1 and stands a one-pixel ego in the sky; it names VIEW 1 too. */
const ROOM = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); discard.pic(v0); show.pic();",
  "  load.view(1);",
  "  load.view(0); animate.obj(o0); set.view(o0, 0); position(o0, 40, 100); draw(o0);",
  "}",
  "return;",
  "",
].join("\n");
const LOGIC_0 = "if (!isset(f200)) { set(f200); accept.input(); new.room(1); } call.v(v0); return;";

async function bootAssistGame(page: Page): Promise<void> {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource("logic", 0, logic(LOGIC_0));
  game.putResource("logic", 1, logic(ROOM));
  game.putResource("picture", 1, compilePictureSource(BRIDGE_SOURCE).bytes);
  game.putResource("view", 0, DOT_EGO);
  game.putResource("view", 1, ROBOT_VIEW);
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "River crossing",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: false,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: { "1": { title: "River", description: "A bridge.", exits: {} } },
          facts: {},
          quests: {},
        },
      },
      sources: { logics: [[1, ROOM]], pictures: [[1, BRIDGE_SOURCE]] },
    },
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  await enterCreateMode(page);
}

async function openRoomStudio(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** The Walk lens with the bridge selected. */
async function selectBridge(page: Page, studio: Locator): Promise<void> {
  await studio.getByRole("radio", { name: /Walk/ }).click();
  await studio.locator('[data-row="bridge"]').click();
  await expect(studio.getByTestId("assist-chip").first()).toHaveText("Only: Bridge");
}

const draftSource = (page: Page): Promise<string> =>
  page.evaluate(() => window.__AGI_STUDIO__!.source());
const draftBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));

/** Picture bytes decoded to their two planes, as the interpreter draws them. */
function planes(bytes: Uint8Array) {
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile: DEFAULT_V2_PROFILE });
  return { visual: surface.visual, priority: surface.priority };
}

async function ask(page: Page, studio: Locator, words: string): Promise<void> {
  const input = studio.getByTestId("assist-input");
  await input.fill(words);
  await input.press("Enter");
}

/** Every cell that differs between two decoded planes, as "x,y:was>now". */
function diffCells(a: Uint8Array, b: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) out.push(`${i % 160},${Math.floor(i / 160)}:${a[i]}>${b[i]}`);
  return out;
}

/** The bank cells under the bridge (x 60..99, rows 120 and 139) turned from barrier to water. */
const BANKS_TO_WATER = [120, 139].flatMap((y) =>
  Array.from({ length: 40 }, (_, k) => `${60 + k},${y}:0>3`),
);

test("Room Studio: make the bridge walkable, accept as one undo step, the art unchanged", async ({
  page,
}) => {
  await bootAssistGame(page);
  const studio = await openRoomStudio(page);
  await selectBridge(page, studio);
  // No provider yet: the box offers the shared Connect AI flow.
  await studio.getByTestId("assist-connect").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(studio.getByTestId("assist-chip")).toHaveText([
    "Only: Bridge",
    "Art is locked",
    "Depth values locked (Walk view)",
  ]);
  // `/` on the canvas focuses the box; the ctx bar's Ask does too.
  await studio.locator(".studio__stage").focus();
  await page.keyboard.press("/");
  await expect(studio.getByTestId("assist-input")).toBeFocused();
  await studio
    .getByTestId("assist-input")
    .fill("Make this bridge walkable without changing the art");
  await shot(page, "room-ask-box");

  const before = await draftBytes(page);
  const source = await draftSource(page);
  await studio.getByTestId("assist-input").press("Enter");
  const candidate = studio.getByTestId("assist-candidate");
  await expect(candidate).toBeVisible();
  await expect(studio.getByTestId("assist-summary")).toHaveText(
    "Opened the barrier under the bridge without touching its art.",
  );
  await expect(studio.getByTestId("assist-changes")).toHaveText("80 depth cells inside Bridge");
  await expect(studio.getByTestId("assist-live")).toContainText("Proposal ready");
  // The canvas shows the proposal with its changed cells outlined; Before shows the draft.
  const compare = studio.getByTestId("assist-compare");
  await expect(compare.getByRole("radio", { name: "After" })).toBeChecked();
  await expect(studio.locator('[data-role="changed"]').first()).toBeVisible();
  await shot(page, "room-candidate-after");
  await compare.getByRole("radio", { name: "Before" }).click();
  await shot(page, "room-candidate-before");
  await compare.getByRole("radio", { name: "After" }).click();
  // Nothing is applied before Accept.
  expect(await draftSource(page)).toBe(source);

  await studio.getByTestId("assist-accept").click();
  await expect(studio.getByTestId("assist-outcome")).toContainText("Accepted as one undo step");
  await expect(compare).toBeHidden();
  const after = await draftBytes(page);
  const [was, now] = [planes(before), planes(after)];
  expect(diffCells(was.visual, now.visual)).toEqual([]);
  expect(diffCells(was.priority, now.priority).sort()).toEqual([...BANKS_TO_WATER].sort());
  // An ordinary unkept edit: Keep is offered, and one Undo restores the draft.
  await expect(studio.getByTestId("studio-keep")).toBeEnabled();
  await studio.locator(".studio__stage").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => draftSource(page)).toBe(source);
  expect([...(await draftBytes(page))]).toEqual([...before]);
  // No key reached the game.
  expect((await textHook(page)).room).toBe(1);
});

test("Room Studio: a refused proposal shows in the activity, and the retry keeps the locks", async ({
  page,
}) => {
  await bootAssistGame(page);
  await configureAi(page, { provider: "stub" });
  const studio = await openRoomStudio(page);
  await selectBridge(page, studio);
  const before = planes(await draftBytes(page));
  await ask(page, studio, "bad: repaint the bridge, then make it walkable");
  await expect(studio.getByTestId("assist-candidate")).toBeVisible();
  await expect(studio.getByTestId("assist-steps").locator("li")).toHaveText([
    "Read the selection",
    "Refused: would change the art — trying again",
    "Proposed a change",
  ]);
  await shot(page, "room-refusal-retry");
  await studio.getByTestId("assist-accept").click();
  await expect(studio.getByTestId("assist-outcome")).toBeVisible();
  const after = planes(await draftBytes(page));
  expect(diffCells(before.visual, after.visual)).toEqual([]);
  expect(diffCells(before.priority, after.priority).every((cell) => cell.endsWith(":0>3"))).toBe(
    true,
  );
});

test("Room Studio: a declined request and a rejected proposal leave the draft untouched", async ({
  page,
}) => {
  await bootAssistGame(page);
  await configureAi(page, { provider: "stub" });
  const studio = await openRoomStudio(page);
  await selectBridge(page, studio);
  const source = await draftSource(page);
  await ask(page, studio, "impossible: make the sky walkable");
  const declined = studio.getByTestId("assist-declined");
  await expect(declined).toContainText("The AI didn't change anything:");
  await expect(declined).toContainText("I can't do that within your selection");
  expect(await draftSource(page)).toBe(source);
  // Ask again on the same selection keeps the conversation.
  await ask(page, studio, "make it walkable then");
  await expect(studio.getByTestId("assist-candidate")).toBeVisible();
  await expect(studio.getByTestId("assist-turn")).toHaveCount(4);
  await studio.getByTestId("assist-reject").click();
  await expect(studio.getByTestId("assist-outcome")).toHaveText(
    "Rejected. The draft is unchanged.",
  );
  await expect(studio.getByTestId("assist-compare")).toBeHidden();
  expect(await draftSource(page)).toBe(source);
  await expect(studio.getByTestId("studio-keep")).toBeDisabled();
});

test("Sprite Studio: make the eyes blue on loop 1, accept, loop 0 unchanged", async ({ page }) => {
  await bootAssistGame(page);
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("world-panel").getByTestId("map-room-1").click();
  await page.getByTestId("world-panel").getByTestId("world-open-sprite-1").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  await studio.locator('[data-loop="1"][data-cel="0"]').click();
  // The side panel keeps its previews in view: the box is folded until asked for.
  await expect(studio.getByTestId("assist-fold")).toHaveAttribute("aria-expanded", "false");
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("/");
  await expect(studio.getByTestId("assist-input")).toBeFocused();
  await expect(studio.getByTestId("assist-chip")).toHaveText([
    "Only loop 1, cels 0, 1",
    "Loop 0 protected",
  ]);
  await shot(page, "sprite-ask-box");
  const original = openSprite(ROBOT_VIEW, DEFAULT_V2_PROFILE);
  await ask(page, studio, "Make the robot's eyes blue");
  await expect(studio.getByTestId("assist-candidate")).toBeVisible();
  await expect(studio.getByTestId("assist-changes")).toHaveText("2 pixels in loop 1, cels 0, 1");
  // The cel canvas outlines the changed pixel of the cel on show.
  await expect(studio.getByTestId("sprite-canvas")).toHaveAttribute("data-changed", "1");
  await shot(page, "sprite-candidate-after");
  await studio.getByTestId("assist-compare").getByRole("radio", { name: "Before" }).click();
  await shot(page, "sprite-candidate-before");
  await studio.getByTestId("assist-accept").click();
  await expect(studio.getByTestId("assist-outcome")).toBeVisible();
  const edited = openSprite(
    Uint8Array.from(await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()])),
    DEFAULT_V2_PROFILE,
  );
  const pixels = (document: typeof edited, loop: number) =>
    document.loops[loop]!.cels.map((cel) => [...cel.pixels]);
  expect(pixels(edited, 0)).toEqual(pixels(original, 0));
  expect(pixels(edited, 1)).toEqual(
    pixels(original, 1).map((cel) => cel.map((p) => (p === 12 ? 1 : p))),
  );
});

// ---- A request held open: Stop, and an edit while the AI works ------------

const propose = STUDIO_ASSIST_TOOLS.find((tool) => tool.name === "propose_edit")!;
const pictureOpFields = (
  propose.parameters.properties["pictureOps"] as { items: { required: readonly string[] } }
).items.required;
/** The walkable op the stub proposes, as a model sends it: every field, null unless given. */
const walkwayOp = Object.fromEntries(
  pictureOpFields.map((field) => [
    field,
    (
      {
        type: "insertShape",
        atLine: AFTER_BRIDGE,
        shape: {
          kind: "rect",
          color: null,
          priority: 3,
          filled: true,
          x1: 60,
          y1: 120,
          x2: 99,
          y2: 139,
          points: null,
        },
        id: "bridge-walk",
        label: "Bridge walkway",
        kind: "walk",
      } as Record<string, unknown>
    )[field] ?? null,
  ]),
);

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
    // Stop aborted the request.
  }
}

test("Room Studio: Stop mid-run leaves the draft unchanged", async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await held;
    await fulfil(route, say("s1", "Too late."));
  });
  try {
    await bootAssistGame(page);
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    const studio = await openRoomStudio(page);
    await selectBridge(page, studio);
    const source = await draftSource(page);
    await ask(page, studio, "Make this bridge walkable");
    const running = studio.getByTestId("assist-running");
    await expect(running).toBeVisible();
    await expect.poll(() => requests).toBe(1);
    await expect(studio.getByTestId("assist-budget")).toContainText("left");
    // Editing waits while the AI works: the item editor steps aside.
    await expect(studio.getByTestId("item-editor")).toBeHidden();
    await shot(page, "room-running");
    await studio.getByTestId("assist-stop").click();
    await expect(studio.getByTestId("assist-outcome")).toHaveText(
      "Stopped. The draft is unchanged.",
    );
    expect(await draftSource(page)).toBe(source);
    await expect(studio.getByTestId("item-editor")).toBeVisible();
  } finally {
    release();
  }
});

test("Room Studio: an edit while the AI works makes its proposal stale", async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/openai/v1/responses", async (route) => {
    const request = ++requests;
    if (request === 1) return fulfil(route, call("r1", "read_edit_context", { images: false }));
    if (request === 2) {
      const sent = JSON.stringify(route.request().postDataJSON());
      const baseRevision = /baseRevision (picture-\d+-[0-9a-f]{8})/.exec(sent)![1];
      return fulfil(
        route,
        call("p1", "propose_edit", {
          baseRevision,
          summary: "Opened the barrier under the bridge.",
          pictureOps: [walkwayOp],
          spriteOps: null,
        }),
      );
    }
    await held;
    return fulfil(route, say(`s${request}`, "Opened the barrier under the bridge."));
  });
  try {
    await bootAssistGame(page);
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    const studio = await openRoomStudio(page);
    await selectBridge(page, studio);
    // A change of the creator's own first, so an undo has something to take back.
    const label = studio.getByTestId("item-label");
    await label.fill("Stone bridge");
    await label.press("Enter");
    await expect.poll(() => draftSource(page)).toContain('"Stone bridge"');
    await ask(page, studio, "Make this bridge walkable");
    await expect.poll(() => requests).toBe(3);
    await expect(studio.getByTestId("assist-steps").locator("li")).toContainText([
      "Proposed a change",
    ]);
    await expect(studio.getByTestId("assist-status")).toHaveText("Finishing…");
    await shot(page, "room-running-proposed");
    // Undo still runs while editing waits: the draft moves under the request.
    await studio.locator(".studio__stage").focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => draftSource(page)).not.toContain('"Stone bridge"');
    const source = await draftSource(page);
    release();
    await expect(studio.getByTestId("assist-candidate")).toBeVisible();
    await expect(studio.getByTestId("assist-stale")).toHaveText(
      "You changed the picture while the AI worked. Ask again.",
    );
    await expect(studio.getByTestId("assist-accept")).toBeDisabled();
    await expect(studio.getByTestId("assist-compare")).toContainText("Stale proposal");
    await shot(page, "room-stale");
    await studio.getByTestId("assist-reject").click();
    expect(await draftSource(page)).toBe(source);
  } finally {
    release();
  }
});
