import { providerReply } from "../../test/provider-stream.ts";
import { type Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import {
  configureAi,
  isolateStorage,
  openDeveloperActivity,
  settled,
  textHook,
} from "./engineProbe.ts";

/**
 * The player-supplied art path end to end: the upload dialog decodes a real
 * PNG, stores it as project data, ships it to the provider as an image block,
 * converts a pose row into a staged VIEW the player keeps into the running
 * game, and detaches on request. Boot uses the offline stub author; the chat
 * turn is intercepted at the OpenAI transport to prove the bytes ride along.
 */

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

/**
 * An opaque magenta key field with one cyan figure per 16px pose cell. Cyan
 * is deliberately absent from the stub room's green/red palette so the kept
 * ego is countable on the canvas.
 */
function sheetPng(): Buffer {
  const width = 64;
  const height = 12;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lx = x % 16;
      const figure = lx >= 5 && lx < 11 && y >= 2;
      rgb.set(figure ? [0, 0xff, 0xff] : [0xff, 0, 0xff], (y * width + x) * 3);
    }
  }
  return Buffer.from(encodePngRgb(width, height, rgb));
}

/**
 * Count cyan-ish canvas pixels — the kept figure's EGA ink, tolerant of the
 * output transform's exact RGB (EGA bright cyan is 85,255,255).
 */
async function canvasCyanCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
    const d = c.getContext("2d")!.getImageData(0, 0, 320, 200).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i]! < 150 && d[i + 1]! > 200 && d[i + 2]! > 200) n++;
    return n;
  });
}

function roomPng(): Buffer {
  const width = 64;
  const height = 40;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgb.set(y < height / 2 ? [0, 0, 0xaa] : [0, 0xaa, 0], (y * width + x) * 3);
    }
  }
  return Buffer.from(encodePngRgb(width, height, rgb));
}

async function bootAgentGame(page: Page): Promise<void> {
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout: 20_000 })
    .toBeGreaterThan(0);
  // Room 1's entry description is a print window; acknowledge it.
  const pad = page.getByTestId("touch-controls");
  if (await pad.isVisible().catch(() => false)) {
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  } else {
    await page.keyboard.press("Enter");
  }
  await expect.poll(async () => (await textHook(page)).modal, { timeout: 5_000 }).toBe(null);
}

async function openBubbleAndUpload(page: Page): Promise<void> {
  await page.getByTestId("power-up").click();
  await page.getByTestId("agent-attach-reference").click();
  await expect(page.getByTestId("reference-upload")).toBeVisible();
}

/** Close the upload through the dialog's own labelled close control. */
async function closeUpload(page: Page): Promise<void> {
  await page
    .getByTestId("reference-upload")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

/**
 * Walk ego south on whichever input surface this form factor ships. AGI
 * direction input latches — one press walks until the edge — and the template
 * gives room 1 no south exit, so ego animates in place at the boundary
 * instead of triggering the new-room authoring flow the east edge would.
 */
async function walkSouth(page: Page): Promise<void> {
  const pad = page.getByTestId("touch-controls");
  if (await pad.isVisible().catch(() => false)) {
    await pad.getByRole("button", { name: "Walk south", exact: true }).tap();
    return;
  }
  await page.keyboard.press("ArrowDown");
}

/** Read the booted project's stored record through the real storage layer. */
async function storedProject(page: Page): Promise<{
  references?: { id: string; kind: string; staged?: { num: number } | undefined }[] | undefined;
  revision: string;
}> {
  return page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGame } = await import("/src/gameStorage.ts");
    const id = listCachedGames()[0]!.projectId;
    const data = await loadAuthoredGame(id);
    return {
      references: data?.references?.map((r) => ({
        id: r.id,
        kind: r.kind,
        staged: r.staged ? { num: r.staged.num } : undefined,
      })),
      revision: data?.library?.revision ?? "",
    };
  });
}

test("reference art uploads, rides the agent turn as an image, and stages a VIEW", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postData()!);
    await route.fulfill(
      providerReply("openai", {
        id: `reply-${requests.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I see the reference." }],
          },
        ],
      }),
    );
  });

  await bootAgentGame(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });

  // --- Room reference: attach, then send to the agent as an image block. ---
  await openBubbleAndUpload(page);
  await page.getByTestId("reference-room-file").setInputFiles({
    name: "dock.png",
    mimeType: "image/png",
    buffer: roomPng(),
  });
  await page.getByTestId("reference-brief").fill("a harbour at dawn");
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-attached")).toBeVisible();
  expect((await storedProject(page)).references?.some((r) => r.kind === "room")).toBe(true);

  await expect(page.getByTestId("reference-send")).toHaveText("Use in edit");
  await page.screenshot({ path: testInfo.outputPath("reference-edit-intent.png") });
  await page.getByTestId("reference-send").click();
  await expect(page.getByTestId("reference-upload")).toBeHidden();
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const sent = requests.find((body) => body.includes("input_image"));
  expect(sent, "the provider request carries the uploaded image block").toBeTruthy();
  expect(sent).toContain("data:image/png;base64,");
  expect(sent).toContain("harbour");

  // --- Character reference: convert a pose row, stage, keep into view 0. ---
  const cyanBefore = await canvasCyanCount(page);
  const revisionBefore = (await storedProject(page)).revision;
  await openBubbleAndUpload(page);
  // The stored room reference is listed for resend or removal.
  await expect(page.getByTestId("reference-existing")).toContainText("harbour");
  await page.getByTestId("reference-kind-character").click();
  await page.getByTestId("reference-facing-right").setInputFiles({
    name: "hero-right.png",
    mimeType: "image/png",
    buffer: sheetPng(),
  });
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-preview")).toBeVisible({ timeout: 15_000 });
  // The missing left facing was mirrored from the right row — reported, not silent.
  await expect(page.getByTestId("reference-staged")).toContainText("mirror");
  await page.screenshot({ path: testInfo.outputPath("staged-view.png") });

  // Closing and reopening the dialog restores the stored staged candidate:
  // the stored list offers it, and selecting it brings the deterministic
  // preview, Keep and Send back without re-uploading. The bubble stays open
  // under the dialog, so the upload reopens straight from it.
  await closeUpload(page);
  await page.getByTestId("agent-attach-reference").click();
  await expect(page.getByTestId("reference-upload")).toBeVisible();
  await expect(page.getByTestId("reference-attached")).toBeHidden();
  await page.locator("[data-testid^='reference-staged-']").click();
  await expect(page.getByTestId("reference-preview")).toBeVisible();
  await expect(page.getByTestId("reference-staged")).toContainText("mirror");

  await page.getByTestId("reference-keep").click();
  await expect(page.getByTestId("reference-attached")).toBeVisible();
  // The keep spent the staged offer but the art stays attached as provenance.
  const after = await storedProject(page);
  const kept = after.references?.find((r) => r.kind === "character");
  expect(kept?.staged).toBeUndefined();
  expect(after.revision).not.toBe(revisionBefore);
  // Ego (view 0) now draws from the kept sheet. The bubble parks the game, so
  // close it and walk ego a step — the renderer presents only on change, and a
  // moving ego forces fresh cels from the patched view onto the canvas. The
  // figure's cyan ink is absent from the stub room, so a sizeable cyan count
  // proves the kept VIEW is what ego walks in — not just a moved sprite.
  await closeUpload(page);
  await page.getByRole("button", { name: "Back to game", exact: true }).first().click();
  await walkSouth(page);
  await settled(page);
  await expect
    .poll(async () => canvasCyanCount(page), { timeout: 15_000 })
    .toBeGreaterThan(cyanBefore + 50);
  await page.screenshot({ path: testInfo.outputPath("ego-walking-kept-view.png") });

  // --- Detach: the stored list shrinks and the dialog reflects it. ---
  await openBubbleAndUpload(page);
  await expect(page.getByTestId("reference-existing")).toContainText("View 0");
  const rows = page.locator("[data-testid^='reference-remove-']");
  const count = await rows.count();
  expect(count).toBe(2);
  await rows.first().click();
  await expect(rows).toHaveCount(1);
  expect((await storedProject(page)).references?.length).toBe(1);
});

test("a large room reference reaches the model within provider image limits", async ({ page }) => {
  // Uploads went to the provider byte for byte. Anthropic rejects an image
  // side over 2000 px once a request carries more than 20 images, which a long
  // authoring conversation soon does, so the model's copy is fitted to it.
  test.setTimeout(120_000);
  const requests: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postData()!);
    await route.fulfill(
      providerReply("openai", {
        id: `reply-${requests.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I see the reference." }],
          },
        ],
      }),
    );
  });
  await bootAgentGame(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await openBubbleAndUpload(page);
  const width = 2400;
  const height = 300;
  await page.getByTestId("reference-room-file").setInputFiles({
    name: "panorama.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgb(width, height, new Uint8Array(width * height * 3).fill(90))),
  });
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-attached")).toBeVisible();
  await page.getByTestId("reference-send").click();
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const sent = requests.find((body) => body.includes("input_image"))!;
  const data = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(sent)![1]!;
  const png = Buffer.from(data, "base64");
  // IHDR: width and height are the big-endian words at bytes 16 and 20.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2000, 250]);
});

test("oversized, corrupt and unusable uploads each fail with a reason", async ({ page }) => {
  test.setTimeout(120_000);
  await bootAgentGame(page);
  await openBubbleAndUpload(page);

  // Oversized: refused on byte count before any decode attempt.
  await page.getByTestId("reference-room-file").setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(8 * 1024 * 1024 + 1),
  });
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-error")).toContainText("limit is 8 MB");

  // Corrupt: bytes that are not an image are named, not stored.
  await page.getByTestId("reference-room-file").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("this is not an image"),
  });
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-error")).toContainText("could not be decoded");

  // Unusable: a valid sheet under a manifest the converter refuses — three
  // poses is outside the four-to-six contract.
  await page.getByTestId("reference-kind-character").click();
  await page.getByTestId("reference-facing-right").setInputFiles({
    name: "hero-right.png",
    mimeType: "image/png",
    buffer: sheetPng(),
  });
  await page.getByTestId("reference-poses").fill("3");
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-error")).toContainText("four to six poses");

  // Every refusal left the project untouched and the game still runs.
  expect((await storedProject(page)).references?.length ?? 0).toBe(0);
  await closeUpload(page);
  await page.getByRole("button", { name: "Back to game", exact: true }).first().click();
  const cycle = (await textHook(page)).cycle;
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout: 10_000 })
    .toBeGreaterThan(cycle);
});

test("JPEG and WebP attachments survive closing upload and ride only the next ordinary chat", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postData()!);
    await route.fulfill(
      providerReply("openai", {
        id: `reference-chat-${requests.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I see the reference." }],
          },
        ],
      }),
    );
  });
  await bootAgentGame(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  const encoded: Record<string, string> = {};
  for (const mime of ["image/jpeg", "image/webp"]) {
    await openBubbleAndUpload(page);
    // A project-authored solid blue WebP fixture: WebKit decodes WebP but its canvas
    // encoder may silently fall back to PNG.
    encoded[mime] =
      mime === "image/webp"
        ? "UklGRkIAAABXRUJQVlA4IDYAAAAQAwCdASogABQAPm0ylkekIyIhKAgAgA2JZQB2AACQ7IgA/u4KZ//cGZ9XY4f/4tz9uuXwAAA="
        : await page.evaluate((mime) => {
            const canvas = document.createElement("canvas");
            canvas.width = 32;
            canvas.height = 20;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#336699";
            context.fillRect(0, 0, 32, 20);
            return canvas.toDataURL(mime).split(",")[1]!;
          }, mime);
    await page.getByTestId("reference-room-file").setInputFiles({
      name: `harbour.${mime.split("/")[1]}`,
      mimeType: mime,
      buffer: Buffer.from(encoded[mime]!, "base64"),
    });
    await page.getByTestId("reference-attach").click();
    await expect(page.getByTestId("reference-attached")).toBeVisible();
    await closeUpload(page);
    await expect(page.getByTestId("agent-pending-references")).toContainText("Room 1");
    await page.screenshot({ path: testInfo.outputPath(`pending-${mime.split("/")[1]}.png`) });
    if (mime === "image/webp") await page.getByTestId("agent-mode-ask").click();
    // Submit through the ordinary composer, without the upload dialog's Send action.
    const previous = requests.length;
    await page.getByTestId("agent-bubble-input").fill("Use the attached room reference.");
    await page.getByTestId("agent-bubble-input").press("Enter");
    await expect.poll(() => requests.length).toBeGreaterThan(previous);
    expect(requests[previous]).toContain(`data:${mime};base64,${encoded[mime]}`);
    await expect(page.getByTestId("agent-pending-references")).toBeHidden();
    if (mime === "image/webp") {
      await expect(page.getByTestId("agent-mode-ask")).toHaveAttribute("aria-pressed", "true");
      const body = JSON.parse(requests[previous]!);
      expect(
        body.tool_choice.tools.some((tool: { name: string }) => tool.name === "write_picture"),
      ).toBe(false);
      await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
      const next = requests.length;
      await page.getByTestId("agent-bubble-input").fill("Describe the room again.");
      await page.getByTestId("agent-bubble-input").press("Enter");
      await expect.poll(() => requests.length).toBeGreaterThan(next);
      const nextBody = JSON.parse(requests[next]!);
      const lastUser = nextBody.input
        .filter((item: { role?: string }) => item.role === "user")
        .at(-1);
      expect(JSON.stringify(lastUser)).not.toContain("input_image");
      await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
      await page.getByTestId("agent-mode-remix").click();
      await page.getByTestId("agent-bubble-close").click();
    }
    await expect(page.getByTestId("agent-bubble")).toBeHidden();
  }
  // Reaching the storage limit is an explicit refusal; the seventeenth cannot disappear.
  await page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGame, updateAuthoredReferences } =
      await import("/src/gameStorage.ts");
    const id = listCachedGames()[0]!.projectId;
    const data = await loadAuthoredGame(id);
    const first = data!.references![0]!;
    await updateAuthoredReferences(
      id,
      Array.from({ length: 16 }, (_, i) => ({ ...first, id: `capacity-${i}` })),
    );
  });
  await openBubbleAndUpload(page);
  await page
    .getByTestId("reference-room-file")
    .setInputFiles({ name: "extra.png", mimeType: "image/png", buffer: roomPng() });
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-error")).toContainText("16 references");
  expect((await storedProject(page)).references?.length).toBe(16);
});
