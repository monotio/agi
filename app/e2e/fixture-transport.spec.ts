import { test, expect } from "./test.ts";
import vue from "@vitejs/plugin-vue";
import { createServer as netServer } from "node:net";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { canonicalResourceName } from "../../src/types.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { gameRevision, isPlayableFileName } from "../src/project/gameMetadata.ts";
import { fixtureRoot, startFixtureServer, writeFixture } from "../test/fixtureServerHarness.ts";
import { downloadFromSettings, isolateStorage, textHook } from "./engineProbe.ts";

/**
 * The fixture transport proof in a real browser: a dedicated Vite test-mode
 * server runs the production fixture plugin over injected temporary
 * discovery, serving the real application. Nothing mocks a route — the card,
 * the encoded resource requests, the boot and the download all cross the
 * actual Connect middleware.
 *
 * The spec owns one fixed port per engine: 5770 for Chromium, 5771 for the
 * desktop WebKit project; never run both engines in parallel.
 */

const TRANSPORT_PORT = (project: string): number => (project === "desktop-webkit" ? 5771 : 5770);

/** Verify the assigned port is unused before the server binds it. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.once("error", (error) =>
      reject(new Error(`Fixture transport port ${port} is already in use: ${String(error)}`)),
    );
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, "127.0.0.1");
  });
}

const WORDS = new Uint8Array(52);
const OBJECT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** A minimal bootable game whose logic 1 prints its one identifying line. */
function transportGame(message: string): Record<string, Uint8Array> {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("assignn(v10,1);if(equaln(v0,0)){new.room(1);}call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      `if(isset(f5)){assignn(v60,1);load.pic(v60);draw.pic(v60);show.pic();}display(5, 4, "${message}");accept.input();return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putFile("WORDS.TOK", WORDS);
  game.putFile("OBJECT", OBJECT);
  return Object.fromEntries(game.files);
}

test("an unusual-name installed fixture boots through the real transport and exports its own bytes @webkit-desktop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const FOLDER = "Moon Room Å";
  const port = TRANSPORT_PORT(test.info().project.name);
  await assertPortFree(port);
  const root = fixtureRoot();
  const moon = writeFixture(root, FOLDER, transportGame("TRANSPORT MOON ANCHOR"));
  const decoy = writeFixture(root, "Star Dock", transportGame("DECOY STAR DOCK"));
  const running = await startFixtureServer([moon, decoy], {
    mode: "test",
    plugins: [vue()],
    optimizeDeps: { entries: ["index.html", "src/studio/logic/monacoLanguage.ts"] },
    server: { port },
  });
  try {
    // The fixture manifest names the descriptor this browser will boot.
    const manifestRes = await fetch(`${running.url}/fixtures/`);
    const manifest = (await manifestRes.json()) as { folder: string; revision?: string }[];
    const moonDescriptor = manifest.find((entry) => entry.folder === FOLDER);
    expect(moonDescriptor).toBeDefined();
    expect(moonDescriptor!.revision).toMatch(/^[0-9a-f]{64}$/);

    interface Observed {
      url: string;
      status: number;
      body: Promise<Buffer>;
    }
    const observed: Observed[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (!new URL(url).pathname.startsWith("/fixtures/")) return;
      observed.push({ url, status: response.status(), body: response.body() });
    });

    await isolateStorage(page);
    await page.goto(`${running.url}/`);

    // The real card, keyed by its unusual folder spelling.
    const card = page.getByTestId(`local-game-card-${FOLDER}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: test.info().outputPath("fixture-transport-card.png"),
      fullPage: true,
    });

    // Gallery lists fixtures; Play fetches the selected edition's native bytes.
    const encoded = encodeURIComponent(FOLDER);
    const moonFileNames = [...moon.files.values()].filter(isPlayableFileName);
    expect(observed.filter((entry) => /\/VOL\.0$/.test(entry.url))).toEqual([]);
    await card.getByTestId(`boot-${FOLDER}`).click();
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 30_000 })
      .toContain("TRANSPORT MOON ANCHOR");
    await expect(page).toHaveURL(new RegExp(`#play/${encoded}$`));
    await page.screenshot({ path: test.info().outputPath("fixture-transport-boot.png") });
    // Unrelated cards may still fetch lazily around the boot; what matters is
    // that every request the boot made to this instance succeeded and no
    // sibling file request stood in for it.
    const moonEntries = observed.filter((entry) => entry.url.includes(`/fixtures/${encoded}/`));
    expect(moonEntries.length).toBeGreaterThan(0);
    for (const entry of moonEntries) expect(entry.status).toBe(200);
    for (const name of moonFileNames) {
      const entry = moonEntries.find(
        (entry) =>
          new URL(entry.url).pathname === `/fixtures/${encoded}/${encodeURIComponent(name)}`,
      );
      expect(entry, `encoded request for ${name}`).toBeDefined();
      expect(await entry!.body).toEqual(
        Buffer.from(new Uint8Array(await readFile(`${moon.dir}${name}`))),
      );
    }
    // The public export carries exactly the canonical playable set.
    const downloading = page.waitForEvent("download");
    await downloadFromSettings(page);
    const download = await downloading;
    const exported = await readGameZip(new Uint8Array(await readFile(await download.path())));
    const expected: Record<string, Uint8Array> = {};
    for (const actual of moonFileNames) {
      expected[canonicalResourceName(actual)] = new Uint8Array(
        await readFile(`${moon.dir}${actual}`),
      );
    }
    const exportedPlayable = Object.fromEntries(
      Object.entries(exported.files).filter(([name]) => isPlayableFileName(name)),
    );
    expect(Object.keys(exportedPlayable).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, bytes] of Object.entries(expected)) {
      expect(exportedPlayable[name], name).toEqual(bytes);
    }
    expect(await gameRevision(exportedPlayable)).toBe(moonDescriptor!.revision);
  } finally {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  }
});
