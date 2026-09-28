import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { BRIDGE_SOURCE, DOT_EGO, ROBOT_VIEW } from "../../test/studioAssistFixtures.ts";
import { testProjectId } from "../test/identity.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { referenceArtId } from "../../src/agent/referenceTools.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { cacheGame, enterCreateMode, textHook, waitForCycles } from "./engineProbe.ts";

/**
 * Reference art in a Studio's Ask, on the real app with the offline stub:
 * an image attached in the Ask section is stored with the game as the
 * room's reference art and rides the next request as a handle, a manifest
 * line and one contact strip of thumbnails, never the image itself. The
 * stub's "reference" scenario views the attached art with view_reference and
 * says which art it viewed and what images its request carried. A chip
 * removed before asking leaves the art off the request.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** Screenshots go here when set, else to the test's output. */
const SHOTS = process.env["AGI_STUDIO_SHOTS"];
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: SHOTS ? `${SHOTS}/${name}.png` : test.info().outputPath(`${name}.png`),
    animations: "disabled",
  });

const PROJECT = testProjectId("studio-reference");
const ROOM = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); discard.pic(v0); show.pic();",
  "  load.view(0); animate.obj(o0); set.view(o0, 0); position(o0, 40, 100); draw(o0);",
  "}",
  "return;",
  "",
].join("\n");
const LOGIC_0 = "if (!isset(f200)) { set(f200); accept.input(); new.room(1); } call.v(v0); return;";

async function bootGame(page: Page): Promise<void> {
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

/** Room Studio on room 1 with the bridge selected and the stub connected. */
async function openAsk(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await studio.locator('[data-row="bridge"]').click();
  await studio.getByTestId("assist-connect").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  return studio.getByTestId("studio-assist");
}

/** A 48x32 plate: sky blue over grass green. */
function platePng(): Buffer {
  const width = 48;
  const height = 32;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgb.set(y < height / 2 ? [0x55, 0x55, 0xff] : [0, 0xaa, 0], (y * width + x) * 3);
  return Buffer.from(encodePngRgb(width, height, rgb));
}

/** The booted project's stored references: id and the first image's bytes, base64. */
async function storedReferences(page: Page): Promise<{ id: string; kind: string; png: string }[]> {
  return page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(listCachedGames()[0]!.projectId);
    return (data?.references ?? []).map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      png: reference.images[0]!.png,
    }));
  });
}

async function ask(ask: Locator, words: string): Promise<void> {
  const input = ask.getByTestId("assist-input");
  await input.fill(words);
  await input.press("Enter");
}

test("Room Studio: an attached reference rides Ask as a handle, and a removed one stays off", async ({
  page,
}) => {
  await bootGame(page);
  const section = await openAsk(page);

  // Attach: the picked image is stored as room 1's reference art and shows
  // as a chip with its thumbnail.
  await section.getByTestId("assist-reference-file").setInputFiles({
    name: "plate.png",
    mimeType: "image/png",
    buffer: platePng(),
  });
  const chip = section.getByTestId("assist-reference-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Reference 1");
  await expect
    .poll(() =>
      chip
        .getByTestId("assist-reference-thumb")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(48);
  const stored = await storedReferences(page);
  expect(stored.map(({ kind }) => kind)).toEqual(["room"]);
  const art = referenceArtId(Buffer.from(stored[0]!.png, "base64"));
  await section.getByTestId("assist-input").fill("Match the reference");
  await shot(page, "room-ask-reference");

  // Ask: the stub views the attached art by its handle, and the request
  // carried one 72x72 contact strip (a 64 px thumbnail in a 4 px gutter),
  // never the 48x32 upload.
  await section.getByTestId("assist-input").press("Enter");
  const declined = section.getByTestId("assist-declined");
  await expect(declined).toContainText(
    `I viewed ${art} and left the selection as it is; this request carried its reference list and one image (72x72).`,
  );
  // The chips left with the request.
  await expect(chip).toHaveCount(0);

  // The art the game holds for this room is offered again; a chip removed
  // before asking stays off the request.
  await section.getByTestId("assist-reference-menu").click();
  await page.getByTestId(`assist-reference-saved-${stored[0]!.id}`).click();
  await expect(chip).toHaveCount(1);
  await chip.getByTestId("assist-reference-remove").click();
  await expect(chip).toHaveCount(0);
  await ask(section, "Match the reference again");
  await expect(declined).toContainText("No reference art was attached to this request.");
  // Removing the chip left the art with the game.
  expect((await storedReferences(page)).map(({ id }) => id)).toEqual([stored[0]!.id]);
});
