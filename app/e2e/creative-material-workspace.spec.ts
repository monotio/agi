import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import {
  enterCreateMode,
  isolateStorage,
  openLibraryActions,
  openWorldRoom,
  savedGameCard,
  waitForCycles,
  waitForRoom,
} from "./engineProbe.ts";
import { openContainer } from "../../src/container/container.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";

/**
 * The creative material workspace on the real app, with no key, no engine and
 * no provider: an image dropped on the resource editor stages its exact
 * original, the three roles prepare it (room underlay, sprite frames, board
 * pin) and one Keep publishes sources, recipes and board entries through the
 * same EditableProject transaction the drawing Keep uses. Closing with staged
 * work leaves a durable recovery the next open restores; kept bytes are
 * verified by decoding stored VIEW payloads and hashing them against the
 * kept recipe's outputPayloadHash.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** A 48x32 half-red/half-blue synthetic PNG, produced by the project's own encoder. */
function meadowPng(): Uint8Array {
  const rgb = new Uint8Array(48 * 32 * 3);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 48; x++) {
      const i = (y * 48 + x) * 3;
      if (x < 24) {
        rgb[i] = 200;
        rgb[i + 1] = 60;
        rgb[i + 2] = 40;
      } else {
        rgb[i] = 40;
        rgb[i + 1] = 80;
        rgb[i + 2] = 200;
      }
    }
  return encodePngRgb(48, 32, rgb);
}

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(page: Page, title: string): Promise<string> {
  const projectId = await page.evaluate(async (title) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const prepared = prepareLocalProject({ title, kind: "starter" });
    await prepared.save();
    return prepared.projectId as string;
  }, title);
  await page.waitForLoadState("networkidle");
  return projectId;
}

/** The library's Edit verb: Logic Studio on the stored project, no engine. */
async function openLogicStudio(page: Page, title: string) {
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  return studio;
}

async function openResource(page: Page, key: "picture" | "view", n: number) {
  await page.getByTestId("logic-explorer").getByTestId(`logic-doc-${key}:${n}`).click();
  await page.getByTestId("logic-resource-edit").click();
}

async function storedResource(
  page: Page,
  projectId: string,
  kind: "picture" | "view",
  n: number,
): Promise<Uint8Array> {
  const files = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const game = await loadAuthoredGame(id as never);
    return Object.fromEntries(
      Object.entries(game!.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        [...bytes],
      ]),
    );
  }, projectId);
  const container = openContainer(
    new Map(Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  );
  const resource = container.getResource(kind, n);
  if (resource === undefined || resource === null)
    throw new Error(`stored ${kind}:${n} is missing`);
  return resource;
}

/** Drop a real File through the editor surface's drop handler. */
async function dropPng(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.evaluate(
    async ({ b64, name }) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([raw], name, { type: "image/png" }));
      const surface = document.querySelector(".pre");
      if (surface === null) throw new Error("resource editor surface is not mounted");
      surface.dispatchEvent(
        new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    },
    { b64: Buffer.from(bytes).toString("base64"), name },
  );
}

test("an imported image underlays the room, pins the board, keeps and reopens cold @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Traced meadow");
  await page.reload();

  const studio = await openLogicStudio(page, "Traced meadow");
  await openResource(page, "picture", 1);
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();

  // A real drop on the editor surface stages the exact original.
  const png = meadowPng();
  const pngHash = sha256Hex(png);
  await dropPng(page, png, "meadow.png");
  const preview = creative.locator(".source-preview");
  await expect(preview).toHaveCount(1);
  await expect(preview.getByText("meadow.png")).toBeVisible();
  await expect(preview.getByText("48×32")).toBeVisible();
  await reviewShot(page, "creative-source-imported");

  // Closing with staged work leaves a durable recovery; reopening offers it.
  await room.getByTestId("studio-close").click();
  await expect(room).toHaveCount(0);
  await openResource(page, "picture", 1);
  await expect(room).toBeVisible();
  await expect(creative).toContainText("Unsaved creative work found");
  await creative.getByRole("button", { name: "Restore" }).click();
  await expect(preview.getByText("meadow.png")).toBeVisible();

  // Role 1: the image becomes a tracing underlay over the art pane.
  const beforeBytes = Uint8Array.from(
    await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]),
  );
  await creative.getByRole("button", { name: "Trace in room" }).click();
  await expect(page.getByTestId("underlay-job")).toBeVisible();
  await reviewShot(page, "creative-underlay-room");
  // The underlay never touches the native picture bytes.
  expect(Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]))).toEqual(
    beforeBytes,
  );

  // Role 3: pin the source to the project board with a note.
  await creative.getByLabel("Board note").fill("meadow palette");
  await creative.getByRole("button", { name: "Add to board" }).click();
  await expect(creative.locator(".board__notes")).toHaveText("meadow palette");

  // One Keep seals the source, the underlay recipe and the board entry.
  await creative.getByTestId("creative-keep").click();
  await expect(creative.getByRole("status")).toContainText("Creative work kept");
  const storedPic = await storedResource(page, projectId, "picture", 1);
  expect(storedPic).toEqual(beforeBytes);
  const manifest = await page.evaluate(async (id) => {
    const { loadCreativeCatalog } = await import("/src/project/creativeStore.ts");
    const { catalog } = await loadCreativeCatalog(id as never);
    if (!catalog) return null;
    return {
      sources: catalog.sources.length,
      recipes: catalog.recipes.map((recipe) => recipe.algorithm + ":" + recipe.destination.kind),
      board: catalog.board.length,
      encoded: Object.keys(catalog.blobs).length,
    };
  }, projectId);
  expect(manifest).not.toBeNull();
  expect(manifest!.sources).toBe(1);
  expect(manifest!.recipes).toEqual(["manual-picture-underlay-v1:picture"]);
  expect(manifest!.board).toBe(1);
  // The staged blob set carries the exact original and the canonical raster.
  expect(manifest!.encoded).toBe(2);
  await reviewShot(page, "creative-after-keep");

  // Cold reopen: the board kept its entry and the source is readable again —
  // and still usable: its Sprite action starts a real view job from it.
  await room.getByTestId("studio-close").click();
  await page.getByTestId("logic-close").click();
  await expect(studio).toHaveCount(0);
  await page.reload();
  await openLogicStudio(page, "Traced meadow");
  await openResource(page, "picture", 1);
  await expect(creative.locator(".board__notes")).toHaveText("meadow palette");
  await expect(creative.locator(".board__thumb")).toBeVisible();
  await creative.getByTestId("board-entry").getByRole("button", { name: "VIEW" }).click();
  await expect(page.getByTestId("view-job")).toBeVisible();
  await expect(page.getByTestId("frame-editor")).toBeVisible();
  expect(providerCalls).toBe(0);
  expect(pngHash.length).toBe(64);
});

test("an imported image prepares real VIEW bytes through the frame editor and keeps atomically", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => route.abort());
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Prepared actor");
  await page.reload();

  await openLogicStudio(page, "Prepared actor");
  await openResource(page, "view", 1);
  const sprite = page.getByTestId("sprite-studio");
  await expect(sprite).toBeVisible();
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();

  // The Choose input is the same intake path as drop.
  await creative.getByTestId("creative-choose").setInputFiles({
    name: "walker.png",
    mimeType: "image/png",
    buffer: Buffer.from(meadowPng()),
  });
  await expect(creative.locator(".source-preview").getByText("walker.png")).toBeVisible();

  // Role 2: the frame editor opens with one frame covering the source.
  await creative.getByRole("button", { name: "Use as a character or object" }).click();
  const job = page.getByTestId("view-job");
  await expect(job).toBeVisible();
  const frames = page.getByTestId("frame-editor");
  await expect(frames).toBeVisible();

  // The grid splitter rebuilds the frames over real source-space regions.
  await frames.getByLabel("Grid columns").fill("2");
  await frames.getByLabel("Grid rows").fill("1");
  await frames.getByRole("button", { name: "Apply grid" }).click();
  await expect(frames.locator(".frames__box")).toHaveCount(2);

  // Dragging a box moves its source region; the numeric row reports it.
  const surface = frames.getByTestId("frame-source");
  const surfaceBox = (await surface.boundingBox())!;
  const firstX = frames.locator(".frames__row").first().getByLabel("Region x");
  await page.mouse.move(
    surfaceBox.x + surfaceBox.width * 0.2,
    surfaceBox.y + surfaceBox.height * 0.4,
  );
  await page.mouse.down();
  await page.mouse.move(
    surfaceBox.x + surfaceBox.width * 0.2 + 12,
    surfaceBox.y + surfaceBox.height * 0.4,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(firstX).not.toHaveValue("0");

  // Add frame splits the next free region; the numeric fields stay
  // reachable beside the boxes and edit the same frame.
  await frames.getByRole("button", { name: "Add frame" }).click();
  await expect(frames.locator(".frames__box")).toHaveCount(3);
  const third = frames.locator(".frames__row").nth(2);
  await third.getByLabel("Region width").fill("8");
  await third.getByLabel("Region width").press("Tab");
  await expect(third.getByLabel("Region width")).toHaveValue("8");

  // Destination is a number, labelled for the draft it would write over.
  await page.getByTestId("view-destination").fill("1");
  await page.getByTestId("view-destination").press("Tab");
  await expect(page.getByTestId("view-destination-label")).toContainText("replaces");
  await reviewShot(page, "creative-view-prepared");

  // The prepared payload writes into the shared draft; the open editor
  // reopens on the new bytes, then the workspace Keep seals both.
  await page.getByTestId("apply-view").click();
  await expect(creative.getByRole("status")).toContainText("prepared in the draft");
  await expect(sprite).toBeVisible();
  await creative.getByTestId("creative-keep").click();
  await expect(creative.getByRole("status")).toContainText("Creative work kept");

  // The stored VIEW decodes under the real profile and its bytes are exactly
  // the payload the kept recipe reviewed.
  const storedView = await storedResource(page, projectId, "view", 1);
  const decoded = openSprite(storedView, DEFAULT_V2_PROFILE);
  expect(decoded.loops.length).toBeGreaterThan(0);
  // The grid pair and the added frame all joined the first loop.
  expect(decoded.loops[0]!.cels.length).toBe(3);
  const storedHash = sha256Hex(storedView);
  const keptHash = await page.evaluate(async (id) => {
    const { loadCreativeCatalog } = await import("/src/project/creativeStore.ts");
    const { catalog } = await loadCreativeCatalog(id as never);
    const recipe = catalog?.recipes.find((entry) => entry.destination.kind === "view");
    return recipe?.outputPayloadHash ?? null;
  }, projectId);
  expect(keptHash).toBe(storedHash);
});

test("Room and Sprite Studios open the creative dock directly, and the chooser is a keyboard journey @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  await seedLocalProject(page, "Direct meadow");
  await page.reload();

  // The running game, entered without the Library's editor path.
  await savedGameCard(page, "Direct meadow").getByTestId("btn-resume-cached").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await waitForCycles(page, 2);
  await enterCreateMode(page);

  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();

  // The studio's own import affordance opens the project-bound dock; no
  // Logic Studio, key, worker or provider was involved anywhere upstream.
  await room.getByRole("button", { name: "Import image…" }).click();
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();

  // The chooser is a real keyboard journey: focus lands on the clipped
  // input, Enter raises the native picker, and the file lands staged.
  const choose = creative.getByTestId("creative-choose");
  await choose.focus();
  await expect(choose).toBeFocused();
  const chooser = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  await chooser[0].setFiles({
    name: "direct.png",
    mimeType: "image/png",
    buffer: Buffer.from(meadowPng()),
  });
  // WebKit's decode+stage path can outlast the default 5s assertion window.
  await expect(creative.locator(".source-preview").getByText("direct.png")).toBeVisible({
    timeout: 15_000,
  });
  await reviewShot(page, "creative-direct-room-entry");

  // The same dock prepares the underlay over the direct studio's art.
  await creative.getByRole("button", { name: "Trace in room" }).click();
  await expect(page.getByTestId("underlay-job")).toBeVisible();

  // The dock folds to a rail that is itself keyboard focusable and reopens.
  await creative.getByTestId("creative-collapse").click();
  const rail = page.getByTestId("creative-rail");
  await expect(rail).toBeVisible();
  await rail.focus();
  await expect(rail).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(creative).toBeVisible();

  // Sprite Studio gets the same entry through the room's sprite list.
  await room.getByTestId("studio-close").click();
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-sprite-1").click();
  const sprite = page.getByTestId("sprite-studio");
  await expect(sprite).toBeVisible();
  await sprite.getByRole("button", { name: "Import image…" }).click();
  const creative2 = page.getByTestId("creative-workspace");
  await expect(creative2).toBeVisible();
  await creative2.getByTestId("creative-choose").setInputFiles({
    name: "walker-direct.png",
    mimeType: "image/png",
    buffer: Buffer.from(meadowPng()),
  });
  await expect(creative2.locator(".source-preview").getByText("walker-direct.png")).toBeVisible();
  await creative2.getByRole("button", { name: "Use as a character or object" }).click();
  await expect(page.getByTestId("view-job")).toBeVisible();
  await reviewShot(page, "creative-direct-sprite-entry");
  expect(providerCalls).toBe(0);
});

test("the creative panel stacks under the studio on a narrow screen without clipping the art", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedLocalProject(page, "Narrow room");
  await page.reload();

  const studio = await openLogicStudio(page, "Narrow room");
  await openResource(page, "picture", 1);
  const room = page.getByTestId("room-studio");
  const creative = page.getByTestId("creative-workspace");
  await expect(room).toBeVisible();
  await expect(creative).toBeVisible();

  await page.setViewportSize({ width: 760, height: 720 });
  const roomBox = (await room.boundingBox())!;
  const creativeBox = (await creative.boundingBox())!;
  // The panel moved below the editor instead of squeezing it sideways.
  expect(creativeBox.y).toBeGreaterThanOrEqual(roomBox.y + roomBox.height - 1);
  // The art canvas itself keeps a usable height — the 168-pixel logical
  // picture stays near 1:1, not clipped to a sliver under the panel.
  const artBox = (await room.locator(".studio-pane__pixels").first().boundingBox())!;
  expect(artBox.height).toBeGreaterThan(140);
  expect(creativeBox.height).toBeGreaterThan(100);
  await dropPng(page, meadowPng(), "narrow.png");
  await expect(creative.locator(".source-preview").getByText("narrow.png")).toBeVisible();
  await reviewShot(page, "creative-narrow-layout");

  // The rail fold/reopen works on the narrow layout too.
  await creative.getByTestId("creative-collapse").click();
  await expect(page.getByTestId("creative-rail")).toBeVisible();
  await page.getByTestId("creative-rail").click();
  await expect(creative).toBeVisible();
  await expect(studio).toBeVisible();
});

test("a refused recovery cleanup surfaces a named retry that finishes the save @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  // A real one-shot fault on the owned recovery row's durable delete: the
  // patch refuses the first `creative/<project>/draft/<workspace>` delete
  // once the test arms it, so the Keep commits but its cleanup fails.
  await page.addInitScript(() => {
    const realDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key: IDBValidKey | IDBKeyRange) {
      const w = window as unknown as { __creativeDeleteFault?: boolean };
      if (w.__creativeDeleteFault === true && typeof key === "string" && key.includes("/draft/")) {
        w.__creativeDeleteFault = false;
        throw new DOMException("Injected recovery cleanup failure", "UnknownError");
      }
      return realDelete.call(this, key);
    };
  });
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Cleanup retry");
  await page.reload();

  await openLogicStudio(page, "Cleanup retry");
  await openResource(page, "picture", 1);
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();
  await dropPng(page, meadowPng(), "meadow.png");
  await expect(creative.locator(".source-preview").getByText("meadow.png")).toBeVisible();
  // Keep the underlay open so the retried save has real pending work to carry.
  await creative.getByRole("button", { name: "Trace in room" }).click();
  await expect(page.getByTestId("underlay-job")).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __creativeDeleteFault?: boolean }).__creativeDeleteFault = true;
  });
  await creative.getByTestId("creative-keep").click();
  // The durable Keep is acknowledged even though its cleanup was refused.
  await expect(creative.getByRole("status")).toContainText("Creative work kept");
  // The stranded cleanup is named and retryable instead of silently stuck.
  await expect(creative.getByTestId("creative-cleanup-retry")).toBeVisible();
  await reviewShot(page, "creative-cleanup-failure");
  await creative.getByTestId("creative-cleanup-retry").click();
  await expect(creative.getByTestId("creative-cleanup-retry")).toHaveCount(0);
  // The retry retired the stale owned row and saved a fresh current recovery
  // for the still-open underlay — verified in durable storage, not the DOM.
  await expect(creative).toContainText("Unsaved creative work found (current)");
  const row = await page.evaluate(async (id) => {
    const { listCreativeDrafts } = await import("/src/project/creativeDrafts.ts");
    const drafts = await listCreativeDrafts(id as never);
    return drafts.map((entry) => entry.status);
  }, projectId);
  expect(row).toEqual(["current"]);
  await reviewShot(page, "creative-cleanup-retried");
});

test("a drop racing the studio's close cannot revive the dock or reach a successor", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => route.abort());
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Raced drop");
  await page.reload();

  // The running game, entered without the Library's editor path.
  await savedGameCard(page, "Raced drop").getByTestId("btn-resume-cached").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await waitForCycles(page, 2);
  await enterCreateMode(page);

  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();

  // One synchronous turn: the drop stages a file and starts the project
  // open, then the studio closes before the open can resolve. The in-flight
  // open must not adopt into the unmounted host, and the staged file must
  // not cross into whatever panel opens next.
  await page.evaluate(async (b64) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([raw], "raced.png", { type: "image/png" }));
    const host = document.querySelector(".studio-host");
    if (host === null) throw new Error("studio host is not mounted");
    host.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
    const close = document.querySelector<HTMLElement>(
      '[data-testid="room-studio"] [data-testid="studio-close"]',
    );
    if (close === null) throw new Error("studio close is not mounted");
    close.click();
  }, Buffer.from(meadowPng()).toString("base64"));
  await expect(room).toHaveCount(0);
  // Let any resolved-but-dropped open settle, then prove it left no trace.
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(async (id) => {
      const { listCreativeDrafts } = await import("/src/project/creativeDrafts.ts");
      return (await listCreativeDrafts(id as never)).length;
    }, projectId),
  ).toBe(0);

  // The successor studio opens a clean dock: no recovered work, no staged
  // file inherited from the dead open.
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  await expect(room).toBeVisible();
  await room.getByRole("button", { name: "Import image…" }).click();
  const creative = page.getByTestId("creative-workspace");
  await expect(creative).toBeVisible();
  await expect(creative).not.toContainText("Unsaved creative work found");
  await expect(creative.locator(".source-preview")).toHaveCount(0);
});
