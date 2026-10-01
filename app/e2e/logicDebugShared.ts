import { inflateSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

/**
 * Shared choreography for the Logic Studio debugger specs: seeding a stored
 * project, opening Studio, driving the test dock and reading the preview's
 * composed frame. Each helper waits on the app's own published state — no
 * wall-clock sleeps.
 */

/** Block real providers; returns a counter the caller asserts stays zero. */
export function blockProviders(page: Page): { count: () => number } {
  let calls = 0;
  void page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    calls++;
    return route.abort();
  });
  return { count: () => calls };
}

/** Fresh storage and a catalog fixture stub — run before page.goto. */
export async function prepareIsolatedPage(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
}

/**
 * Seed a stored project through the same path "Create game" uses. Only valid
 * against the dev/test server — `/src/...` module URLs do not exist in a
 * production build, where specs use the visible create form instead.
 */
export async function seedLocalProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "starter",
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ title, kind }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title, kind });
      await prepared.save();
      return prepared.projectId as string;
    },
    { title, kind },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

/**
 * Create a project through the visible UI form — the production-safe path.
 * Returns the project id once the card exists in the library.
 */
export async function createProjectViaUi(page: Page, title: string): Promise<void> {
  const disclosure = page.getByTestId("create-adventure-disclosure");
  if ((await disclosure.getAttribute("open")) === null) {
    await page.getByTestId("create-adventure-toggle").click();
  }
  await page.getByTestId("local-create-title").fill(title);
  await page.getByTestId("local-create-kind-starter").check();
  await page.getByTestId("local-create-submit").click();
  // Creation can open the project's workspace; the library card holds the
  // Edit entry, so leave the workspace when it took over the shell. Race the
  // exit button against the card so both landings are handled.
  const exit = page.getByTestId("btn-exit");
  const card = savedGameCard(page, title);
  await Promise.race([
    exit.waitFor({ state: "visible", timeout: 30_000 }),
    card.waitFor({ state: "visible", timeout: 30_000 }),
  ]).catch(() => {});
  if (await exit.isVisible().catch(() => false)) await exit.click();
  await expect(card).toBeVisible({ timeout: 30_000 });
}

/** Open Logic Studio on a stored project through the library's Edit verb. */
export async function openStudio(page: Page, title: string): Promise<void> {
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  await expect(page.getByTestId("logic-studio")).toBeVisible({ timeout: 15_000 });
  // The assistant companion opens by default on wide screens and can overlap
  // the dock — collapse it so debugger controls stay pointer-reachable.
  const toggle = page.getByTestId("logic-assistant-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
}

/** Open logic:1 in the editor and return the Monaco wrapper. */
export async function openLogicOne(page: Page): Promise<Locator> {
  const editor = page.getByTestId("logic-editor");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText("sunny clearing");
  return editor;
}

/**
 * Start the isolated test and wait for the held entry stop. The entry stop
 * is the engine's own idle park between cycles — no invented source line.
 */
export async function startDebugRun(page: Page): Promise<Locator> {
  await page.getByTestId("logic-test").click();
  const dock = page.getByTestId("debug-test-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 30_000,
  });
  return dock;
}

/** Continue out of a held stop; waits until the run leaves Stopped. */
export async function continueRun(page: Page): Promise<void> {
  const dock = page.getByTestId("debug-test-dock");
  await dock.getByTestId("debug-continue").click();
  await expect(dock.getByTestId("debug-phase")).not.toContainText("Stopped");
}

/** Pause a live run into a held stop. */
export async function pauseToStop(page: Page): Promise<void> {
  const dock = page.getByTestId("debug-test-dock");
  await dock.getByTestId("debug-pause").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
}

/** Focus the preview's keyboard surface; returns the screen element. */
export async function focusScreen(page: Page): Promise<Locator> {
  const screen = page.getByTestId("debug-game-screen");
  await expect(screen).toBeVisible();
  await screen.click();
  await expect(screen).toBeFocused();
  return screen;
}

/** Monaco's focusable node differs by engine: EditContext or textarea. */
export async function focusEditor(page: Page): Promise<void> {
  await page
    .getByTestId("logic-editor")
    .locator("textarea.inputarea, .native-edit-context")
    .first()
    .focus();
}

/** The editor's caret line via the dev bridge; only defined in dev/test mode. */
async function editorCaretLine(page: Page): Promise<number | undefined> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __AGI_LOGIC__?: { cursor(): { line: number; column: number } | undefined };
        }
      ).__AGI_LOGIC__?.cursor()?.line,
  );
}

/** Walk the caret to an absolute 1-based line from the document top. */
export async function caretToLine(page: Page, line: number): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  for (let i = 0; i < line - 1; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(async () => editorCaretLine(page)).toBe(line);
}

/**
 * Read the preview's composed pixels. In test mode the flat 320x200 probe
 * canvas always draws; a nonzero sample count means real engine output —
 * picture, priority and engine-owned text bytes composited, never DOM.
 */
async function litPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='debug-canvas']");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== 0 || px[i + 1] !== 0 || px[i + 2] !== 0) lit++;
    }
    return lit;
  });
}

/** Wait until the preview holds a composed frame with non-black pixels. */
export async function waitForFrame(page: Page): Promise<void> {
  await expect(page.getByTestId("debug-game")).toHaveAttribute("data-has-frame", "true", {
    timeout: 20_000,
  });
  await expect.poll(async () => litPixels(page), { timeout: 20_000 }).toBeGreaterThan(0);
}

/**
 * Decode a PNG screenshot enough to count non-black pixels. Playwright
 * captures are 8-bit RGB/RGBA, non-interlaced — the only honest read of a
 * GPU-composited canvas, since `getImageData`/`drawImage` cannot see inside
 * a WebGL or WebGPU back buffer.
 */
function litPixelsInPng(png: Buffer): number {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(sig)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[11] !== 0 || data[12] !== 0)
        throw new Error(`unsupported PNG bitDepth=${data[8]} interlace=${data[12]}`);
      colorType = data[9]!;
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (bpp === 0) throw new Error(`unsupported PNG colorType=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const prior = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let lit = 0;
  let pos = 0;
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const source = raw.subarray(pos, pos + stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? line[x - bpp]! : 0;
      const up = prior[x]!;
      const upLeft = x >= bpp ? prior[x - bpp]! : 0;
      let v = source[x]!;
      if (filter === 1) v = (v + left) & 0xff;
      else if (filter === 2) v = (v + up) & 0xff;
      else if (filter === 3) v = (v + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) v = (v + paeth(left, up, upLeft)) & 0xff;
      line[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const base = x * bpp;
      if (line[base] !== 0 || line[base + 1] !== 0 || line[base + 2] !== 0) lit++;
    }
    line.copy(prior);
    pos += stride;
  }
  return lit;
}

/** Screenshot a locator and count non-black pixels in the real PNG. */
export async function litPixelsInShot(page: Page, testId: string): Promise<number> {
  return litPixelsInPng(await page.getByTestId(testId).screenshot());
}

/** The engine-reported ego position, from the held stop's state report. */
export async function egoPosition(page: Page): Promise<{ x: number; y: number }> {
  const values = page.getByTestId("debug-values");
  await expect(values).toContainText(/ego \d+,\d+/, { timeout: 15_000 });
  const text = (await values.innerText()) ?? "";
  const match = /ego (\d+),(\d+)/.exec(text);
  if (!match) throw new Error(`ego position missing from values: ${text.slice(0, 300)}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** The engine's open modal kind on the latest frame, or null. */
async function modalKind(page: Page): Promise<string | null> {
  return page.getByTestId("debug-game-screen").getAttribute("data-modal");
}

/** Wait until the engine reports no open modal on the presented frame. */
export async function expectNoModal(page: Page): Promise<void> {
  await expect.poll(async () => modalKind(page), { timeout: 10_000 }).toBe(null);
}

/** Dismiss the open print/message window with Enter, then wait for clear. */
export async function dismissModal(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press("Enter");
    expect(await modalKind(page)).toBe(null);
  }).toPass({ timeout: 15_000 });
}
