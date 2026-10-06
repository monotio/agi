import { expect, test } from "./test.ts";
import { testProjectId, testRevision } from "../test/identity.ts";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { buildZip } from "../src/archive/zip.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { Engine } from "../../src/runtime/engine.ts";
import {
  gameHint,
  isolateStorage,
  agentActivity,
  openDeveloperActivity,
  openGameOptions,
  openLibraryActions,
  progressStorageKey,
  savedGameCard,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
} from "./engineProbe.ts";

const TUTORIAL_PROJECT_ID = "catalog-adventure-department-1.2.0";

for (const size of [
  { width: 1063, height: 815 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const destination of ["Play", "Create"] as const) {
    test(`${destination} preserves an older checkpoint and offers the latest version ${size.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const game = createContainer();
      game.putResource(
        "logic",
        0,
        assembleLogic('display(20,2,"Latest opening"); return;', { dictionary: new Map() }).payload,
      );
      const archive = buildZip(
        [...game.files]
          .map(([name, data]) => ({ name, data }))
          .concat([{ name: "WORDS.TOK", data: buildWordsTok([]) }]),
      );
      await isolateStorage(page);
      await page.goto("/");
      await page.getByTestId("game-zip-input").setInputFiles({
        name: "older-position.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive),
      });
      await expect(savedGameCard(page, "older-position")).toBeVisible();
      const original = await page.evaluate(async () => {
        const { listCachedGames } = await import("/src/project/gameStorage.ts");
        const { bindSavedProgressTarget } = await import("/src/project/progressBinding.ts");
        const { autosaveKey } = await import("/src/saves/useAutosaveController.ts");
        const project = listCachedGames().find(
          (game) => game.title === "older-position",
        )!.projectId;
        const target = (await bindSavedProgressTarget(project))!;
        const key = autosaveKey(target.locator);
        const raw = JSON.stringify({
          format: "monotio.agi.autosave",
          version: 1,
          image: "b2xk",
          cycle: 17,
          room: 99,
          savedAt: 1,
          game: { installed: false, identity: { project, revision: "a".repeat(64) } },
        });
        localStorage.setItem(key, raw);
        return { project, key, raw };
      });
      if (destination === "Create") {
        await openLibraryActions(page, savedGameCard(page, "older-position"));
        await page.getByTestId("edit-library-game").click();
      } else await savedGameCard(page, "older-position").getByTestId("btn-resume-cached").click();
      await expect(page.getByTestId("start-latest-version")).toBeVisible();
      await expect(page.getByTestId("older-position-choice")).toContainText(
        "The old position is replaced when the new run saves.",
      );
      const refusal = await page.getByTestId("older-position-choice").innerText();
      expect(refusal.match(/Start the latest version\?/g)).toHaveLength(1);
      expect(refusal.match(/The old position is replaced when the new run saves\./g)).toHaveLength(
        1,
      );
      expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(
        original.raw,
      );
      await page.screenshot({
        path: test.info().outputPath(`older-position-${destination}-${size.width}.png`),
      });
      const choice = page.getByTestId("older-position-choice");
      await expect.soft(choice).not.toContainText("ERROR");
      await expect.soft(choice).toHaveCSS("font-family", /sans/);
      await expect
        .soft(savedGameCard(page, "older-position").getByTestId("older-position-choice"))
        .toBeVisible();
      if (await choice.getByRole("button", { name: "Not now", exact: true }).count()) {
        await choice.getByRole("button", { name: "Not now", exact: true }).click();
        await expect(choice).toHaveCount(0);
        expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBe(
          original.raw,
        );
        if (destination === "Create") {
          await openLibraryActions(page, savedGameCard(page, "older-position"));
          await page.getByTestId("edit-library-game").click();
        } else await savedGameCard(page, "older-position").getByTestId("btn-resume-cached").click();
      }
      const choiceBox = (await choice.boundingBox())!;
      for (const label of ["Start the latest version", "Not now"]) {
        const button = choice.getByRole("button", { name: label, exact: true });
        const box = (await button.boundingBox())!;
        expect.soft(box.x + box.width).toBeLessThanOrEqual(choiceBox.x + choiceBox.width);
      }
      await page.getByTestId("start-latest-version").click();
      await expect
        .poll(async () => (await textHook(page)).rows.join(" "))
        .toContain("Latest opening");
      expect((await textHook(page)).room).toBe(0);
      if (destination === "Create")
        await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
          "aria-checked",
          "true",
        );
    });
  }
}

test("project import names each stored and refused progress entry", async ({ page }, testInfo) => {
  const container = createContainer();
  container.putFile("WORDS.TOK", new Uint8Array(52));
  container.putResource("picture", 1, Uint8Array.of(0xff));
  for (const [room, source] of [
    [0, "if(!isset(f200)){set(f200);new.room(1);}call(1);return;"],
    [1, "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();accept.input();}return;"],
  ] as const)
    container.putResource("logic", room, assembleLogic(source, { dictionary: new Map() }).payload);
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  const image = engine.autosaveImage();
  expect(image).not.toBeNull();
  const archive = await buildProjectZip(
    {
      projectId: testProjectId("storage-report"),
      title: "Storage report",
      authoredAt: new Date(0).toISOString(),
      provider: "stub",
      model: "stub",
      files: Object.fromEntries(container.files),
      words: [],
    },
    {
      saves: { "1": engine.serialize(), "7": engine.serialize() },
      autosave: {
        format: "monotio.agi.autosave",
        version: 1,
        image: Buffer.from(image!).toString("base64"),
        cycle: 1,
        room: 1,
        savedAt: 1,
        game: {
          installed: false,
          identity: {
            project: testProjectId("storage-report"),
            revision: testRevision("storage-report"),
          },
        },
      },
    },
  );
  await isolateStorage(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (
        key.startsWith("monotio_agi.autosave.") ||
        (key.startsWith("monotio_agi.saves.") && JSON.parse(value).slots["7"])
      )
        throw new Error("Injected storage refusal");
      original.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "storage-report.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  const notice = page.getByTestId("game-import-ready");
  // One plain sentence for what came along, one for what storage refused.
  await expect(notice).toHaveText(
    "Storage report added to your library, with its save slot 1. " +
      "Its saved progress and save slot 7 could not be stored.",
  );
  const stored = await page.evaluate(async () => {
    const { listCachedGames } = await import("/src/project/gameStorage.ts");
    const { readGameSaves } = await import("/src/saves/gameSaves.ts");
    const projectId = listCachedGames()[0]!.projectId;
    const bindingPath = "/src/project/progressBinding.ts";
    const { bindSavedProgressTarget } = await import(bindingPath);
    const target = await bindSavedProgressTarget(projectId);
    return {
      slots: Object.keys(readGameSaves(localStorage, target!.locator)),
      autosave: localStorage.getItem(`monotio_agi.autosave.${target!.locator}`),
    };
  });
  expect(stored).toEqual({ slots: ["1"], autosave: null });
  await page.screenshot({
    path: testInfo.outputPath("partial-progress-import.png"),
    fullPage: true,
  });
});

/**
 * A project archive carries the player's progress; a game export never does.
 * Imported on another browser, the project's card offers Resume and lands
 * where the walk stopped.
 */
test("the project archive moves the autosave to another browser; the game export carries none", async ({
  page,
  browser,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 4);
  const stopped = await textHook(page);
  await waitForCycles(page, 2);
  expect((await textHook(page)).egoX, "ego stands still before the checkpoint").toBe(stopped.egoX);
  await waitForAutosaveAfter(page, stopped.cycle);
  expect((await storedAutosave(page, TUTORIAL_PROJECT_ID))?.room).toBe(1);

  // The project download from the running game carries the checkpoint.
  const projectDownload = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-download-game").click();
  const saved = await projectDownload;
  const savedPath = (await saved.path())!;
  const project = await readGameZip(new Uint8Array(await readFile(savedPath)));
  expect(project.progress?.autosave?.room).toBe(1);
  expect(project.progress?.autosave?.game.identity.project).toBe(TUTORIAL_PROJECT_ID);
  expect(Object.keys(project.progress?.saves ?? {})).toEqual([]);

  // The game export is for publishing: no progress in it.
  const publicDownload = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-export-game").click();
  const published = await publicDownload;
  const publicGame = await readGameZip(new Uint8Array(await readFile((await published.path())!)));
  // Publication safety: tests, saves and authoring context each excluded on their own.
  expect(
    publicGame.files["TESTS.JSON"],
    "tests travel with the project archive only",
  ).toBeUndefined();
  expect(publicGame.progress, "saves travel with the project archive only").toBeUndefined();
  expect(
    publicGame.project,
    "authoring context travels with the project archive only",
  ).toBeUndefined();
  expect(project.files["TESTS.JSON"]).toBeDefined();

  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto(page.url());
    await other.getByTestId("game-zip-input").setInputFiles(savedPath);
    await expect(other.getByTestId("game-import-ready")).toContainText(
      /added to your library, with its saved progress[^()]*\.$/,
    );
    const resume = other.getByTestId("btn-resume-cached");
    await expect(resume).toHaveText("Resume");
    const projectId = await other.evaluate(async () => {
      const path = "/src/project/gameStorage.ts";
      const store = await import(path);
      return store.listCachedGames()[0].projectId as string;
    });
    expect(projectId).not.toBe(TUTORIAL_PROJECT_ID);
    expect((await storedAutosave(other, projectId))?.room).toBe(1);
    await resume.click();
    await expect.poll(async () => (await textHook(other)).room).toBe(1);
    await expect
      .poll(async () => (await textHook(other)).egoX, {
        message: "the imported checkpoint is restored, not a boot from room 1",
      })
      .toBe(stopped.egoX);
    await expect(await gameHint(other, "resume-caption")).toBeVisible();
    await other.mouse.move(0, 0);
  } finally {
    await fresh.close();
  }
});

/**
 * A checkpoint taken while a message window is up carries the parked pass:
 * a reload resumes into the same open window on the identical instruction,
 * and Enter finishes what was interrupted rather than restarting the room.
 */
test("a reload resumes into the checkpoint's parked window @webkit-desktop", async ({
  page,
  browserName,
}) => {
  // The agent-room case below covers the throttled journey on every run; this
  // one throttles only when AGI_PROGRESS_CPU_RATE asks for it.
  const rate = Number(process.env["AGI_PROGRESS_CPU_RATE"] ?? 1);
  if (browserName === "chromium" && rate !== 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  }
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);new.room(1);}call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      "if(isset(f5)){assignn(v50,1);load.pic(v50);draw.pic(v50);show.pic();}" +
        'if(!isset(f201)){set(f201);print("Checkpoint window");display(20,2,"Beyond the window");}' +
        "return;",
      { dictionary: new Map() },
    ).payload,
  );
  const archive = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: buildWordsTok([]) }]),
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "parked-checkpoint.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await savedGameCard(page, "parked-checkpoint").getByTestId("btn-resume-cached").click();

  // The window parks the pass mid-print: the cycle counter freezes there.
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  const parked = await textHook(page);
  expect(parked.rows.join(" ")).toContain("Checkpoint window");

  // The autosave interval keeps firing while the interpreter waits, and the
  // image it stores at the parked cycle now carries the open window.
  await expect
    .poll(async () => (await textHook(page)).autosave, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(parked.cycle);
  const projectId = await page.evaluate(async () => {
    const { listCachedGames } = await import("/src/project/gameStorage.ts");
    return listCachedGames().find((game) => game.title === "parked-checkpoint")!.projectId;
  });
  const checkpointCycle = (await textHook(page)).cycle;
  expect((await storedAutosave(page, projectId))?.cycle).toBe(checkpointCycle);

  await page.reload();

  // The #play hash boots straight into the checkpoint: the same window is
  // still up, on the identical instruction. Check the running surface before
  // polling its modal so cold worker loading is a separate assertion.
  await expect(page.getByTestId("input-line")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  expect((await textHook(page)).rows.join(" ")).toContain("Checkpoint window");

  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("Beyond the window");
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(checkpointCycle);
});

/**
 * The same parked-window checkpoint, but on a world the stub agent grew:
 * walking east authored room 2 into the live container before its entry
 * window parked the pass. The snapshot therefore carries frames keyed on
 * logic written after boot, and a reload has to hold the same window for
 * Enter to finish the interrupted pass.
 */
test("a reload resumes the parked window in an agent-authored room @webkit-desktop", async ({
  page,
  browserName,
}) => {
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: Number(process.env["AGI_PROGRESS_CPU_RATE"] ?? 6),
    });
  }
  await isolateStorage(page);
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => agentActivity(page), { timeout: 30_000 }).toContain("assembled room 1");

  // Room 1's entry window is parked too; acknowledge it, then walk east so
  // the stub authors room 2 and its entry print parks the pass there.
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal, { timeout: 5_000 }).toBe(null);
  await input.fill("east");
  await input.press("Enter");
  await expect.poll(() => agentActivity(page), { timeout: 10_000 }).toContain("authored room 2");
  await expect(page.locator(".game-surface:visible")).toBeVisible();
  await expect
    .poll(
      async () => {
        const frame = await textHook(page);
        return [frame.room, frame.modal, frame.rows.join(" ")];
      },
      { timeout: 10_000 },
    )
    .toEqual([2, "print", expect.stringContaining("generated room 2")]);
  const parked = await textHook(page);
  expect(parked.rows.join(" ")).toContain("generated room 2");
  try {
    await expect
      .poll(
        async () => {
          const current = await textHook(page);
          const record = await storedAutosave(page, "custom");
          return (
            record?.room === 2 &&
            record.cycle === current.cycle &&
            current.autosave >= current.cycle
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    await test.info().attach("checkpoint-trace", {
      body: JSON.stringify({
        hook: await textHook(page),
        stored: await storedAutosave(page, "custom"),
      }),
      contentType: "application/json",
    });
  }

  const stored = await storedAutosave(page, "custom");
  // Publication and the cycle acknowledgement belong to the room-2 parked image.
  const checkpointCycle = (await textHook(page)).cycle;
  expect(stored?.cycle).toBe(checkpointCycle);
  expect(stored?.room).toBe(2);

  // Hold the lazy game surface while the worker restores its parked window.
  // The probe can report the window before that surface handles keyboard input.
  let release!: () => void;
  const surface = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/src/play/PlayArea.vue", async (route) => {
    await surface;
    await route.continue();
  });
  await page.reload();

  // The authored bytes persisted beside the image, so the continuation is
  // still keyed on identical logic: the same window is back up.
  try {
    await expect
      .poll(
        async () => {
          const frame = await textHook(page);
          return [frame.room, frame.modal, frame.rows.join(" ")];
        },
        { timeout: 30_000 },
      )
      .toEqual([2, "print", expect.stringContaining("generated room 2")]);
    expect((await textHook(page)).rows.join(" ")).toContain("generated room 2");
    expect(await input.count()).toBe(0);
  } finally {
    release();
  }
  await expect(input).toBeVisible();
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(checkpointCycle);
});

/**
 * A text window the game keeps up while it runs on (a print with f15 set, as
 * the demo pack captions its demonstrations) has no parked pass to carry, so
 * no checkpoint is taken while it is up. That is no reason to hold Exit: the
 * last save point stays, the timeline is sealed, and the player is Home.
 */
test("Exit leaves a moment it cannot checkpoint and keeps the last save point", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);new.room(1);}call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      "if(isset(f5)){assignn(v50,1);load.pic(v50);draw.pic(v50);show.pic();}" +
        'if(!isset(f201)){if(have.key()){set(f201);set(f15);print("A window the game keeps up");}}' +
        "return;",
      { dictionary: new Map() },
    ).payload,
  );
  const archive = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: buildWordsTok([]) }]),
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "running-window.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await savedGameCard(page, "running-window").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForAutosaveAfter(page, 0);

  // Any key opens the window; the interpreter keeps cycling under it.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("x");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("A window the game keeps up");
  const windowUp = await textHook(page);
  expect(windowUp.modal, "the window does not pause the game").toBeNull();
  await waitForCycles(page, 2);

  const projectId = await page.evaluate(async () => {
    const path = "/src/project/gameStorage.ts";
    const store = await import(path);
    return store.listCachedGames()[0].projectId as string;
  });
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(page.getByTestId("eject-refusal")).toHaveCount(0);
  const kept = (await storedAutosave(page, projectId))?.cycle ?? 0;
  expect(kept, "the save point from before the window is kept").toBeGreaterThan(0);
  // Frame rows and the cycle heartbeat arrive separately. Read the saved
  // image's own flag to prove it predates the key that opened the window.
  const locator = await progressStorageKey(page, projectId);
  const image = await page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(`monotio_agi.autosave.${key}`)!);
    return [...atob(stored.image)].map((char) => char.charCodeAt(0));
  }, locator);
  const restored = new Engine(game, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  restored.restoreImage(Uint8Array.from(image));
  expect(restored.flags[201], "the stored game predates the window-opening key").toBe(0);
});

test("page hide stores play progress when the document flush fails", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Hide progress");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const project = await page.evaluate(async () => {
    const { listCachedGames } = await import("/src/project/gameStorage.ts");
    return listCachedGames().find((game) => game.title === "Hide progress")!.projectId;
  });
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(() => storedAutosave(page, project)).not.toBeNull();
  const storedCycle = (await storedAutosave(page, project))!.cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(storedCycle);
  await page.evaluate(() => {
    const probe = window as unknown as {
      __AGI_PROJECT__: { getSession(): { flush(): Promise<void> } };
      hideFlushes: number;
    };
    probe.__AGI_PROJECT__.getSession().flush = () =>
      Promise.reject(new Error("Injected document flush failure"));
    probe.hideFlushes = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === "flush") probe.hideFlushes++;
      return Reflect.apply(post, this, [message, ...args]);
    };
    window.dispatchEvent(new Event("pagehide"));
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { hideFlushes: number }).hideFlushes))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await storedAutosave(page, project))!.cycle)
    .toBeGreaterThan(storedCycle);
  expect(errors).toEqual([]);
});
