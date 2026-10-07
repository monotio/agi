import type { Page } from "@playwright/test";
import { ORIGINAL_SCENE_PICTURES } from "../../games/adventure-department/sceneArt.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource, disassemblePicture } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { inferNativeItems } from "../../src/studio/nativeItems.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { compileDocument, itemMask, renderUpTo } from "../../src/studio/pictureQuery.ts";
import { buildView } from "../../src/view/view.ts";
import { EGA_PALETTE } from "../src/render/palette.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { DEMO_PICTURE_SOURCE } from "../src/studio/demoPicture.ts";
import { testProjectId } from "../test/identity.ts";
import { cacheGame, openWorkspacePicture, textHook, waitForCycles } from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";
import { expect, test } from "./test.ts";

/**
 * Room Studio read-only and inspection behaviors in the workspace. Expected
 * pixels and masks come from the kernel evaluated on its own
 * compile of the source, or are hand-placed in the demo picture
 * (app/src/studio/demoPicture.ts), never from the component's state.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const profile = DEFAULT_V2_PROFILE;
const PROJECT_ID = testProjectId("studio-readonly-fixture");

const SOURCE_70 = `${Array.from({ length: 70 }, (_, k) =>
  [
    `# @item i${k} "Item ${k}" art`,
    `vis ${1 + (k % 2)}`,
    `line ${2 * k},0 ${2 * k},5`,
    "# @end",
  ].join("\n"),
).join("\n")}\nend\n`;

const PIC1_BYTES = compilePictureSource(DEMO_PICTURE_SOURCE, { profile }).bytes;
const PIC2_BYTES = compilePictureSource(ORIGINAL_SCENE_PICTURES[1]!, { profile }).bytes;
const PIC3_BYTES = compilePictureSource(DEMO_PICTURE_SOURCE, { profile }).bytes;
const PIC4_BYTES = compilePictureSource(SOURCE_70, { profile }).bytes;
const PIC5_BYTES = compilePictureSource(ORIGINAL_SCENE_PICTURES[1]!, { profile }).bytes;

const PIC2_DISASSEMBLED = disassemblePicture(PIC2_BYTES, { profile });

function buildReadonlyFixture() {
  const container = createContainer();
  container.putResource("picture", 1, PIC1_BYTES);
  container.putResource("picture", 2, PIC2_BYTES);
  container.putResource("picture", 3, PIC3_BYTES);
  container.putResource("picture", 4, PIC4_BYTES);
  container.putResource("picture", 5, PIC5_BYTES);

  const emptyView = buildView({
    description: "ego",
    loops: [{ cels: [{ width: 1, height: 1, pixels: new Uint8Array([0]) }] }],
  });
  container.putResource("view", 0, emptyView);

  const roomLogic = (n: number) =>
    `if(isset(f5)){assignn(v30,${n});load.pic(v30);draw.pic(v30);discard.pic(v30);show.pic();}return;`;

  const logic = (src: string) => assembleLogic(src, { dictionary: new Map() }).payload;

  container.putResource(
    "logic",
    0,
    logic("if(!isset(f200)){set(f200);accept.input();new.room(1);}return;"),
  );
  container.putResource("logic", 1, logic(roomLogic(1)));
  container.putResource("logic", 2, logic(roomLogic(2)));
  container.putResource("logic", 3, logic(roomLogic(3)));
  container.putResource("logic", 4, logic(roomLogic(4)));
  container.putResource("logic", 5, logic(roomLogic(5)));

  return container;
}

const fixtureAuthoringState = {
  authoring: {
    version: 1,
    bindings: {},
    world: {
      rooms: {
        "1": { title: "Demo", description: "", exits: {} },
        "2": { title: "Gallery Disassembled", description: "", exits: {} },
        "3": { title: "Rebuilt Demo", description: "", exits: {} },
        "4": { title: "Sections 70", description: "", exits: {} },
        "5": { title: "Gallery Authored", description: "", exits: {} },
      },
      facts: {},
      quests: {},
    },
  },
  sources: {
    logics: [],
    pictures: [
      [1, DEMO_PICTURE_SOURCE],
      // 2 is deliberately omitted: native disassembled picture
      // 3 is deliberately omitted: native rebuilt demo picture
      [4, SOURCE_70],
      [5, ORIGINAL_SCENE_PICTURES[1]!],
    ],
  },
};

async function bootReadonlyGame(page: Page): Promise<void> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT_ID,
    title: "Readonly Studio Fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: fixtureAuthoringState,
    files: Object.fromEntries(buildReadonlyFixture().files),
    words: [["look", 1]],
  });
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) {
    await page.getByTestId("btn-resume-cached").click();
  }
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await waitForCycles(page, 2);
}

async function openRoomStudio(page: Page, room: number): Promise<void> {
  await openWorkspacePicture(page, room, false);
}

/** Cells covered by the hover highlight: its fill path is one `M x y h w v1 h-w z` per row run. */
function highlightCells(page: Page): Promise<number[]> {
  return page.locator('[data-role="hover-fill"]').evaluate((path) => {
    const cells: number[] = [];
    for (const [, x, y, w] of (path.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)h(\d+)/g))
      for (let i = 0; i < Number(w); i++) cells.push(Number(y) * 160 + Number(x) + i);
    return cells.sort((a, b) => a - b);
  });
}

/** The kernel's mask for an item, computed in Node from source. */
function kernelMaskCells(source: string, itemId: string, plane: "visual" | "priority"): number[] {
  const annotated = inferNativeItems(source, { profile });
  const { document } = parsePictureDocument(annotated);
  const mask = itemMask(compileDocument(document, profile), document, itemId, plane);
  const cells: number[] = [];
  mask.forEach((bit, i) => bit === 1 && cells.push(i));
  return cells;
}

/** Move the pointer to the centre of logical cell x,y on .studio-pane. */
async function hoverCell(page: Page, x: number, y: number): Promise<void> {
  const point = await page.locator(".studio-pane").evaluate(
    (pane, [cx, cy]) => {
      const rect = pane.getBoundingClientRect();
      const zoom = rect.height / 168;
      const at = { x: rect.left + cx! * 2 * zoom, y: rect.top + cy! * zoom };
      return { x: at.x + zoom, y: at.y + zoom / 2 };
    },
    [x, y],
  );
  await page.mouse.move(point.x, point.y);
}

test("hovering a scene row highlights exactly that item's pixels", async ({ page }) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 1);
  await page.locator('[data-row="bench-occluder"]').hover();
  // The occluder is the filled rectangle 40,90..119,105 on the priority plane.
  const box = await page.locator('[data-role="hover-fill"]').evaluate((path) => {
    const { x, y, width, height } = (path as SVGGraphicsElement).getBBox();
    return { x, y, width, height };
  });
  expect(box).toEqual({ x: 40, y: 90, width: 80, height: 16 });
  const expected: number[] = [];
  for (let y = 90; y <= 105; y++) for (let x = 40; x <= 119; x++) expected.push(y * 160 + x);
  expect(await highlightCells(page)).toEqual(expected);

  // The gallery picture as an import sees it: bytes only, one item per element.
  await openRoomStudio(page, 2);
  await page.getByTestId("scene-toggle-groups").click();
  for (const id of ["el-1", "el-20"]) {
    await page.locator(`[data-row="${id}"]`).hover();
    const cells = await highlightCells(page);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toEqual(kernelMaskCells(PIC2_DISASSEMBLED, id, "visual"));
  }
});

for (const deviceScaleFactor of [1, 2]) {
  test(`hovering a canvas pixel hovers its owner at two zooms (devicePixelRatio ${deviceScaleFactor})`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      deviceScaleFactor,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await bootReadonlyGame(page);
    await openRoomStudio(page, 1);
    await page
      .getByRole("radiogroup", { name: "Side panel", exact: true })
      .getByRole("radio", { name: "Inspector", exact: true })
      .click();
    await page.getByTestId("inspector-details").click();
    const zoomLevel = page.getByRole("group", { name: "Zoom" });
    const zooms: string[] = [];
    for (const step of ["fit", "+"]) {
      if (step === "+") await page.keyboard.press("+");
      zooms.push((await zoomLevel.textContent()) ?? "");
      // 80,97 is inside the art bench and the depth occluder drawn over it.
      await page.keyboard.press("1");
      await hoverCell(page, 80, 97);
      await expect(page.locator(".scene-list__row.is-hover")).toHaveAttribute("data-row", "bench");
      await page.keyboard.press("2");
      await hoverCell(page, 80, 97);
      await expect(page.locator(".scene-list__row.is-hover")).toHaveAttribute(
        "data-row",
        "bench-occluder",
      );
      await expect(page.locator('[data-role="pixel"]')).toContainText("Pixel 80,97");
      // 80,60 is bare wall: the Depth lens falls back to the visual owner.
      await hoverCell(page, 80, 60);
      await expect(page.locator(".scene-list__row.is-hover")).toHaveAttribute("data-row", "wall");
    }
    expect(new Set(zooms).size).toBe(2);
    // The backing store carries the device ratio, so pixels stay crisp.
    const ratio = await page
      .locator(".studio-pane canvas")
      .evaluate(
        (canvas) => (canvas as HTMLCanvasElement).width / canvas.getBoundingClientRect().width,
      );
    expect(ratio).toBe(deviceScaleFactor);

    await hoverCell(page, 80, 97);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('[data-row="bench-occluder"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator('[data-role="announce"]')).toHaveText("Bench depth, depth, 18 steps");
    await context.close();
  });
}

test("a group row highlights the union of its members, and a canvas click opens its group", async ({
  page,
}) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 2);
  const groups = page.locator('[role="treeitem"][aria-expanded]');
  // More than 40 items: every group starts closed, and no member row is shown.
  expect(await groups.count()).toBeGreaterThan(0);
  for (const expanded of await groups.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("aria-expanded")),
  ))
    expect(expanded).toBe("false");
  await expect(page.locator('[role="treeitem"][aria-level="2"]')).toHaveCount(0);

  // Open the largest group and read its members from the list.
  const header = page.locator(
    await groups.evaluateAll((rows) => {
      const size = (row: Element): number =>
        Number(/· (\d+)$/.exec(row.querySelector(".scene-list__label")?.textContent ?? "")?.[1]);
      const best = rows.reduce((a, b) => (size(b) > size(a) ? b : a));
      return `[data-row="${best.getAttribute("data-row")}"]`;
    }),
  );
  await header.locator('[data-role="twisty"]').click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const members = await header.evaluate((row) => {
    const ids: string[] = [];
    let next = row.nextElementSibling;
    while (next?.getAttribute("aria-level") === "2") {
      ids.push(next.getAttribute("data-row")!);
      next = next.nextElementSibling;
    }
    return ids;
  });
  expect(members.length).toBeGreaterThan(1);

  await header.hover();
  const union = new Set<number>();
  for (const id of members)
    for (const cell of kernelMaskCells(PIC2_DISASSEMBLED, id, "visual")) union.add(cell);
  expect(await highlightCells(page)).toEqual([...union].sort((a, b) => a - b));

  // Close it again; a click on a member's pixel selects that item and reopens the group.
  await header.locator('[data-role="twisty"]').click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  const cell = kernelMaskCells(PIC2_DISASSEMBLED, members[0]!, "visual")[0]!;
  await hoverCell(page, cell % 160, Math.floor(cell / 160));
  await page.mouse.down();
  await page.mouse.up();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-row="${members[0]}"]`)).toHaveAttribute("aria-selected", "true");
});

test("a long list folds into draw-order sections, and a canvas click opens one", async ({
  page,
}) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 4);
  const sections = page.locator('[role="treeitem"][aria-level="1"][aria-expanded]');
  await expect(sections).toHaveCount(36);
  expect(
    new Set(
      await sections.evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-expanded"))),
    ),
  ).toEqual(new Set(["false"]));
  await expect(page.locator('[role="treeitem"][aria-level="2"]')).toHaveCount(0);

  // The first section holds items 0 and 1 (commands 1-4): lines at x 0 and 2, y 0-5.
  const first = page.locator('[data-row="(section)i0"]');
  await expect(first.locator(".scene-list__label")).toHaveText("Steps 1–4");
  await expect(first.locator('[data-role="section-swatches"] i')).toHaveCount(2);
  await first.hover();
  const expected: number[] = [];
  for (let y = 0; y <= 5; y++) expected.push(y * 160, y * 160 + 2);
  expect(await highlightCells(page)).toEqual(expected);

  // Item 40's line is at x 80: clicking it selects the item and opens its section only.
  await hoverCell(page, 80, 3);
  await page.mouse.down();
  await page.mouse.up();
  const item = page.locator('[data-row="i40"]');
  await expect(item).toHaveAttribute("aria-selected", "true");
  await expect(item).toHaveAttribute("aria-level", "2");
  await expect(page.locator('[role="treeitem"][aria-level="1"][aria-expanded="true"]')).toHaveCount(
    1,
  );
});

test("Alt+arrow keys on the canvas step through items; Tab and Shift+Tab leave", async ({
  page,
}) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 1);
  const canvas = page.getByRole("group", { name: /^Canvas/ });
  await canvas.focus();
  const selected = page.locator('[role="treeitem"][aria-selected="true"]');
  await page.keyboard.press("Alt+ArrowDown");
  await expect(selected).toHaveAttribute("data-row", "floor");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(selected).toHaveAttribute("data-row", "wall");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(selected).toHaveAttribute("data-row", "floor");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(selected).toHaveAttribute("data-row", "floor");
  // Tab and Shift+Tab are never taken by the canvas: each moves focus on or back.
  await page.keyboard.press("Tab");
  await expect(canvas).not.toBeFocused();
  await expect(page.locator(".studio__scene")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).not.toBeFocused();
  await expect(selected).toHaveAttribute("data-row", "floor");
});

test("studio shortcuts keep working after clicking studio controls", async ({ page }) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 1);
  const lens = (name: string) =>
    page
      .getByRole("radiogroup", { name: "Lens", exact: true })
      .getByRole("radio", { name: new RegExp(`^${name}`) });
  await lens("Visual").click();
  await page.keyboard.press("2");
  await expect(lens("Priority")).toHaveAttribute("aria-checked", "true");
  // Band lines shows only under Priority: after "1" hides it, keys still land in the studio.
  await page.getByRole("button", { name: "Band lines", exact: true }).click();
  await page.keyboard.press("1");
  await expect(lens("Visual")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("2");
  await expect(lens("Priority")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.keyboard.press("0");
  await expect(page.getByRole("button", { name: "Zoom to fit" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("dragging the transport to a shape paints exactly renderUpTo(k)", async ({ page }) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 5);
  const slider = page.getByRole("slider", { name: "Draw order", exact: true });
  await expect(slider).toBeVisible();
  const total = Number(await slider.getAttribute("aria-valuemax"));
  const scene1Document = parsePictureDocument(ORIGINAL_SCENE_PICTURES[1]!).document;
  const scene1Compiled = compileDocument(scene1Document, profile);
  expect(total).toBe(scene1Compiled.spans.length - 1);

  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  // The marker lands on a shape boundary, wherever the drag stopped.
  const k = Number(await slider.getAttribute("aria-valuenow"));
  expect(k).toBeGreaterThan(0);
  expect(k).toBeLessThan(total);
  await expect(page.getByTestId("scrubber-position")).toHaveText(/^Drawing /);

  const expectedVisual = renderUpTo(scene1Compiled, k, profile).visual;
  const mismatches = await page.locator(".studio-pane canvas").evaluate(
    (element, { expected, palette }) => {
      const canvas = element as HTMLCanvasElement;
      const scaleX = canvas.width / 160;
      const scaleY = canvas.height / 168;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let wrong = 0;
      for (let y = 0; y < 168; y++)
        for (let x = 0; x < 160; x++) {
          const o =
            (Math.floor((y + 0.5) * scaleY) * canvas.width + Math.floor((x + 0.5) * scaleX)) * 4;
          const [r, g, b] = palette[expected[y * 160 + x]!]!;
          if (pixels[o] !== r || pixels[o + 1] !== g || pixels[o + 2] !== b) wrong++;
        }
      return wrong;
    },
    { expected: Array.from(expectedVisual), palette: EGA_PALETTE },
  );
  expect(mismatches).toBe(0);

  // The full picture differs from the partial one, so the comparison is not vacuous.
  expect(scene1Compiled.visual.some((value, i) => value !== expectedVisual[i])).toBe(true);
});

test("lens keys switch lenses and studio keys never reach a window listener", async ({ page }) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 1);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seenKeys: string[] }).seenKeys = seen;
    for (const type of ["keydown", "keyup", "keypress"])
      window.addEventListener(type, (event) =>
        seen.push(`${type}:${(event as KeyboardEvent).key}`),
      );
  });
  const lens = (name: string) =>
    page
      .getByRole("radiogroup", { name: "Lens", exact: true })
      .getByRole("radio", { name: new RegExp(`^${name}`) });
  await page.keyboard.press("2");
  await expect(lens("Priority")).toHaveAttribute("aria-checked", "true");
  // Band lines start off and the choice is remembered.
  await expect(page.locator('[data-role="band-guides"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Band lines", exact: true }).click();
  await expect(page.locator('[data-role="band-guides"]')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.studioBands"))).toBe("1");
  // The Priority lens's room panel lists the control lines, off the picture.
  await expect(page.locator('.studio__inspector [data-role="control-legend"]')).toContainText(
    "0 · Wall",
  );
  await page.keyboard.press("1");
  await expect(lens("Visual")).toHaveAttribute("aria-checked", "true");

  // Items shows the list.
  await page
    .getByRole("radiogroup", { name: "Side panel", exact: true })
    .getByRole("radio", { name: "Items", exact: true })
    .click();
  const slider = page.getByRole("slider", { name: "Draw order", exact: true });
  await expect(slider).toBeVisible();
  const total = Number(await slider.getAttribute("aria-valuemax"));
  await page.keyboard.press(",");
  await expect(slider).toHaveAttribute("aria-valuenow", String(total - 1));
  // Home and End belong to a focused radiogroup; the canvas gives them to the studio.
  await page.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");

  // A keydown dispatched on the studio root itself is handled and stopped there.
  await page
    .locator(".studio")
    .evaluate((root) =>
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })),
    );
  await expect(lens("Priority")).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)).toEqual(
    [],
  );

  // Esc with nothing in hand stays in Studio (its tab's × closes it, as in the workspace).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("room-studio")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)).toEqual(
    [],
  );
});

test("a picture rebuilt from the game's bytes reads as its own source once its draft is written back", async ({
  page,
}) => {
  await bootReadonlyGame(page);
  await openRoomStudio(page, 3);
  const source = page.getByTestId("studio-source-kind");
  await expect(source).toHaveText("Rebuilt");
  // A rect by keys: R, Enter at the cursor, three cells right and down, Enter.
  await page.locator(".studio__stage").focus();
  await page.keyboard.press("r");
  await page.keyboard.press("Enter");
  for (const key of ["ArrowRight", "ArrowDown"])
    for (let i = 0; i < 3; i++) await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  // The emitted draft is written back as the authored source: the rebuild is trusted.
  await expect(source).toHaveCount(0);
  expect(await workspaceDocument(page, "picture:3")).toContain("rect");
});
