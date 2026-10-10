import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerInbound, WorkerOutbound, WorkerQueryFn } from "../src/worker/workerProtocol.ts";
import { test, expect } from "./test.ts";

test.use({ hasTouch: true });
import { start, open } from "./pictureWorkspaceShared.ts";
import {
  enterCreateMode,
  enterPlayMode,
  screenText,
  textHook,
  waitForRoom,
} from "./engineProbe.ts";

async function checkpoint(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const project = (
      window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn; getWorker(): Worker } }
    ).__AGI_PROJECT__;
    project.getWorker().postMessage({ type: "pause", paused: true });
    const image = await project.query("checkpoint");
    if (!image) throw new Error("The game needs a checkpoint.");
    return [...image];
  });
}

async function flushCheckpoint(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const worker = (
      window as unknown as { __AGI_PROJECT__: { getWorker(): Worker } }
    ).__AGI_PROJECT__.getWorker();
    return new Promise<boolean>((resolve) => {
      const receive = (event: MessageEvent<WorkerOutbound>): void => {
        if (event.data.type !== "flushed" || event.data.id !== -1) return;
        worker.removeEventListener("message", receive);
        resolve(event.data.taken);
      };
      worker.addEventListener("message", receive);
      worker.postMessage({ type: "flush", id: -1 });
    });
  });
}

async function shot(page: Page, name: string, browserName: string): Promise<void> {
  const bytes = await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  if (process.env["CI"] && browserName === "webkit")
    console.log(`OWNER_SHOT:${name}:${bytes.toString("base64")}`);
}

test("a pending game question keeps Play open and explains when Create can open @webkit-desktop", async ({
  page,
  browserName,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const result = await session.update(
      [{ key: "logic:1", content: 'if(isset(f221)){reset(f221);get.num("Number?",v80);}return;' }],
      false,
    );
    if (result.status !== "committed") throw new Error(result.status);
  });
  await enterPlayMode(page);
  await page.evaluate(async () =>
    (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } }).__AGI_PROJECT__.query(
      "debugWrite",
      { flags: [[221, 1]] },
    ),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __AGI_STATE__: { prompt: unknown } }).__AGI_STATE__.prompt !==
          null,
      ),
    )
    .toBe(true);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await shot(page, `entry-before-${width}`, browserName);
  }
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  const notice = page.getByTestId("entry-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Finish the game's question, then open Create.");
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(notice).toBeVisible();
    await shot(page, `entry-after-${width}`, browserName);
  }
  await expect(page.getByRole("radio", { name: "Play", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await input.fill("9");
  await input.press("Enter");
  await expect(notice).toBeHidden();
  await enterCreateMode(page);
});

test.describe("Play continuation", () => {
  test.use({ hasTouch: false });
  test("From my game and Back repeat the Play print wait on current files @webkit-desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const capture = session.model.capture();
      const result = await session.submit({
        proposal: session.model.propose(capture, "A waiting moment", [
          {
            key: "logic:1",
            content:
              'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();print("Your moment");}increment(v80);return;',
          },
        ]),
        label: "A waiting moment",
        origin: "logic",
        author: "creator",
      });
      if (result.status !== "committed") throw new Error(result.status);
    });
    await enterPlayMode(page);
    await page.evaluate(async () => {
      const query = (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } })
        .__AGI_PROJECT__.query;
      const result = await query("playHere", { room: 1, x: 0, y: 0, launch: {} });
      if (!result.ok) throw new Error(result.reason);
    });
    await expect.poll(() => screenText(page)).toContain("Your moment");
    const pause = page.getByTestId("btn-transport-pause");
    await expect(pause).toBeVisible();
    await pause.click();
    await expect.poll(async () => (await textHook(page)).paused).toBe(true);
    const original = await checkpoint(page);
    await enterCreateMode(page);
    await open(page, "part-room:8:logic");
    const action = page.getByTestId("workspace-update");
    await expect(action).toBeVisible();
    await action.click();
    await waitForRoom(page, 8);
    await page.getByTestId("workspace-update-menu").click();
    const fromGame = page.getByRole("menuitem", { name: "From my game", exact: true });
    await expect(fromGame).toBeVisible();
    await fromGame.click();
    await expect(action).toHaveAccessibleName("Play from my game");
    await action.click();
    await expect.poll(() => screenText(page)).toContain("Your moment");
    expect(await checkpoint(page)).toEqual(original);
    await action.click();
    expect(await checkpoint(page)).toEqual(original);
    const back = page.getByRole("button", { name: "Back to Home", exact: true });
    await expect(back).toBeVisible();
    await back.click();
    expect(await checkpoint(page)).toEqual(original);
    await enterPlayMode(page);
    await expect.poll(() => screenText(page)).toContain("Your moment");
    expect(await checkpoint(page)).toEqual(original);
    await enterCreateMode(page);
    await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const result = await session.update(
        [{ key: "logic:1", content: "assignn(v81,9);return;" }],
        false,
      );
      if (result.status !== "committed") throw new Error(result.status);
    });
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    const notice = page.getByTestId("return-notice");
    await expect(notice).toContainText("LOGIC 1 changed");
    await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await notice.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Play", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect
      .poll(async () => {
        return page.evaluate(
          async () =>
            (
              await (
                window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } }
              ).__AGI_PROJECT__.query("state")
            )?.vars[81],
        );
      })
      .toBe(9);
    expect((await textHook(page)).modal).toBeNull();
  });
});

test("a changed scan.start refuses exact return and Restart enters current files @webkit-desktop", async ({
  page,
  browserName,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const result = await session.update(
      [
        {
          key: "logic:1",
          content: "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}set.scan.start();return;",
        },
      ],
      true,
    );
    if (result.status !== "committed") throw new Error(result.status);
  });
  await enterPlayMode(page);
  await page.evaluate(async () => {
    const result = await (
      window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } }
    ).__AGI_PROJECT__.query("playHere", { room: 1, x: 0, y: 0, launch: {} });
    if (!result.ok) throw new Error(result.reason);
  });
  await checkpoint(page);
  await enterCreateMode(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const result = await session.update(
      [
        {
          key: "logic:1",
          content:
            'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();display(20,0,"New start");}return;',
        },
      ],
      true,
    );
    if (result.status !== "committed") throw new Error(result.status);
  });
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await shot(page, `return-before-${width}`, browserName);
  }
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const notice = page.getByTestId("return-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("LOGIC 1 changed after scan.start.");
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(notice).toBeVisible();
    await shot(page, `return-after-${width}`, browserName);
  }
  await notice.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Play", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(notice).toBeHidden();
  await expect.poll(() => screenText(page)).toContain("New start");
});

test("newest tab takes Play, rejects the old writer, and Take back survives closing the other tab @webkit-desktop", async ({
  page,
  context,
  browserName,
}) => {
  await start(page);
  await enterPlayMode(page);
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("monotio_agi.autosave.project:"),
    );
    if (!key) throw new Error("Play has no stored progress.");
    const writer = JSON.parse(
      localStorage.getItem(key.replace(".autosave.", ".writer.")) ?? "null",
    );
    return { key, generation: writer?.generation as number };
  });
  const newest = await context.newPage();
  await newest.goto(page.url());
  await waitForRoom(newest, 1, { coldBoot: true });
  const notice = page.getByTestId("other-tab-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("This game is open in another tab.");
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(notice).toBeVisible();
    await shot(page, `takeover-${width}`, browserName);
  }
  const stale = await page.evaluate(async ({ key, generation }) => {
    const progressPath = "/src/saves/gameProgress.ts";
    const bindingPath = "/src/project/progressBinding.ts";
    const { writeAutosave } = await import(/* @vite-ignore */ progressPath);
    const { bindSavedProgressTarget } = await import(/* @vite-ignore */ bindingPath);
    const before = localStorage.getItem(key)!;
    const record = JSON.parse(before);
    const target = await bindSavedProgressTarget(record.game.identity.project);
    if (!target) throw new Error("The game has no progress target.");
    const result = writeAutosave(localStorage, target, {
      ...record,
      cycle: record.cycle + 500,
      writerGeneration: generation,
    });
    return { refused: result === null, unchanged: before === localStorage.getItem(key) };
  }, saved);
  expect(stale).toEqual({ refused: true, unchanged: true });
  await notice.getByRole("button", { name: "Take back", exact: true }).click();
  const other = newest.getByTestId("other-tab-notice");
  await expect(other).toBeVisible();
  await expect(other).toContainText("This game is open in another tab.");
  await expect(notice).toBeHidden();
  await checkpoint(page);
  // Establish the paused cycle's cadence before changing its image.
  expect(await flushCheckpoint(page)).toBe(true);
  await page.evaluate(async () => {
    const project = (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } })
      .__AGI_PROJECT__;
    await project.query("debugWrite", { vars: [[80, 73]] });
  });
  const activeImage = Buffer.from(await checkpoint(page)).toString("base64");
  expect(await flushCheckpoint(page)).toBe(true);
  // A worker checkpoint captures the image; publication finishes separately on the host.
  await expect
    .poll(() =>
      page.evaluate(
        ({ key, image }) => {
          const record = JSON.parse(localStorage.getItem(key)!);
          return { generation: record.writerGeneration, imageMatches: record.image === image };
        },
        { key: saved.key, image: activeImage },
      ),
    )
    .toEqual({ generation: saved.generation + 2, imageMatches: true });
  const beforeClose = await page.evaluate(
    (key) => ({
      progress: localStorage.getItem(key),
      writer: localStorage.getItem(key.replace(".autosave.", ".writer.")),
    }),
    saved.key,
  );
  await expect(newest.getByRole("radio", { name: "Play", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Observe this stale tab's pagehide flush before native close can terminate its worker.
  const staleFlush = await newest.evaluate(() => {
    const worker = (
      window as unknown as { __AGI_PROJECT__: { getWorker(): Worker } }
    ).__AGI_PROJECT__.getWorker();
    return new Promise((resolve) => {
      let flushId: number | undefined;
      const receive = (event: MessageEvent<WorkerOutbound>): void => {
        const reply = event.data;
        if (reply.type !== "flushed" || reply.id !== flushId) return;
        worker.removeEventListener("message", receive);
        resolve({ taken: reply.taken, temporary: reply.temporary });
      };
      worker.addEventListener("message", receive);
      const post = worker.postMessage;
      const send = post.bind(worker);
      worker.postMessage = (
        message: WorkerInbound,
        options?: StructuredSerializeOptions | Transferable[],
      ) => {
        if (message.type === "flush") flushId = message.id;
        if (Array.isArray(options)) send(message, options);
        else send(message, options);
      };
      try {
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
      } finally {
        worker.postMessage = post;
      }
      if (flushId === undefined) {
        worker.removeEventListener("message", receive);
        throw new Error("Pagehide did not request a progress flush.");
      }
    });
  });
  expect(staleFlush).toEqual({ taken: false, temporary: true });
  await newest.close();
  expect(Buffer.from(await checkpoint(page)).toString("base64")).toBe(activeImage);
  expect(
    await page.evaluate(
      (key) => ({
        progress: localStorage.getItem(key),
        writer: localStorage.getItem(key.replace(".autosave.", ".writer.")),
      }),
      saved.key,
    ),
  ).toEqual(beforeClose);
});
