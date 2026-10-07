import { decodePng } from "../../scripts/png.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { textHook, waitForRoom, workspaceSaved } from "./engineProbe.ts";

import { start, open } from "./pictureWorkspaceShared.ts";

async function playRoom(page: Page): Promise<void> {
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await action.click();
  await expect(action).toBeEnabled();
}
async function updateKeepPlaying(page: Page): Promise<void> {
  const pending = page.getByTestId("workspace-pending");
  if (!(await pending.isVisible())) return;
  await workspaceSaved(page);
  await expect(page.getByTestId("workspace-update")).toHaveAccessibleName(/^Update and restart /);
  await expect(page.getByTestId("workspace-update-menu")).toBeEnabled();
  await page.getByTestId("workspace-update-menu").click();
  const action = page.getByRole("menuitem", { name: "Update and keep playing", exact: true });
  await expect(action).toBeVisible();
  await action.click();
  await expect(pending).toBeHidden();
}

async function makeRoom(page: Page): Promise<void> {
  const action = page.getByRole("button", { name: "Make it a room", exact: true });
  if (await action.isVisible()) await action.click();
  else {
    await page.getByTestId("context-more-actions").click();
    await page.getByRole("menuitem", { name: "Make it a room", exact: true }).click();
  }
}

async function shot(page: Page, name: string, expected?: readonly number[]) {
  if (page.viewportSize()!.width > 600 && !["unused", "view-unused", "focus"].includes(name)) {
    const canvas = page.locator(".game-surface:visible");
    await expect(canvas).toBeVisible();
    await expect
      .poll(async () => {
        const image = decodePng(await canvas.screenshot());
        const at =
          (Math.floor(image.height * 0.4) * image.width + Math.floor(image.width * 0.5)) * 4;
        const colour = [...image.rgba.subarray(at, at + 3)];
        return ["stage", "picture", "back"].includes(name)
          ? colour.some((channel) => channel > 0)
          : colour;
      })
      .toEqual(["stage", "picture", "back"].includes(name) ? true : (expected ?? [0, 170, 170]));
  }
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}

test("opening pictures leaves play in place; Play enters and Back restores the prior moment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(page.getByTestId("room-studio")).not.toHaveClass(/is-live-game/);
  const before = await textHook(page);
  await open(page, "part-room:8:picture:8");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await expect(page.getByTestId("workspace-room")).toContainText("Room 8");
  await expect(page.locator(".play-area:visible")).toHaveCount(1);
  await expect(page.getByTestId("room-studio").filter({ visible: true })).not.toHaveClass(
    /is-live-game/,
  );
  await page.getByRole("button", { name: "Back to Home", exact: true }).click();
  await expect
    .poll(async () => {
      const state = await textHook(page);
      return [state.room, state.egoX, state.egoY];
    })
    .toEqual([before.room, before.egoX, before.egoY]);
});

test("switching Play and Create follows the running room without moving it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  const zoom = page.locator(".studio-zoom__level:visible");
  await expect(zoom).toBeVisible();
  await expect(zoom).toHaveText(/^\d+%$/);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await input.fill("look");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("room-studio").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("room-studio").filter({ visible: true })).not.toHaveClass(
    /is-live-game/,
  );
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("workspace-visit")).toBeHidden();
});

test("a late room visit reply preserves the captured Play room and selected editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const onmessage = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage")!;
    let held: (() => void) | null = null;
    const hooks = window as unknown as {
      roomVisitHeld(): boolean;
      releaseRoomVisit(): void;
    };
    hooks.roomVisitHeld = () => held !== null;
    hooks.releaseRoomVisit = () => {
      const reply = held;
      held = null;
      reply?.();
    };
    Object.defineProperty(Worker.prototype, "onmessage", {
      configurable: true,
      get: onmessage.get!,
      set(this: Worker, listener: (event: MessageEvent) => void) {
        onmessage.set!.call(this, (event: MessageEvent) => {
          if (event.data?.type === "playedHere" && event.data.returnRoom !== undefined) {
            held = () => listener.call(this, event);
            return;
          }
          listener.call(this, event);
        });
      },
    });
  });
  await start(page);
  await open(page, "part-room:8:picture:8");
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await action.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { roomVisitHeld(): boolean }).roomVisitHeld()),
    )
    .toBe(true);
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.evaluate(() => (window as unknown as { releaseRoomVisit(): void }).releaseRoomVisit());
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("room-studio").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("workspace-visit")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("project-tab-picture:8")).toBeVisible();
  await expect(page.getByTestId("project-tab-picture:8")).toHaveAttribute("aria-selected", "true");
});

test("room changes during Create keep the selected picture editor open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await input.fill("look");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await expect(studio).not.toHaveClass(/is-live-game/);
  await expect(page.getByRole("tab", { selected: true })).toHaveText("PICTURE 8");
});

test("phone VIEW editing keeps a usable drawing canvas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  for (const view of [8, 9]) {
    await open(page, `part-view:${view}`);
    const canvas = page.getByTestId("sprite-stage").filter({ visible: true });
    await expect(canvas).toBeVisible();
    expect((await canvas.boundingBox())!.width).toBeGreaterThan(200);
  }
  // Focus is an icon-only toggle on the tab bar.
  await page.getByTestId("workspace-focus").click();
  const done = page.getByTestId("workspace-focus");
  await expect(done).toBeVisible();
  await expect(done).toHaveAttribute("aria-pressed", "true");
  await done.click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});

for (const dynamic of [false, true]) {
  test(`a VIEW chosen by ${dynamic ? "dynamic" : "shared"} LOGIC stays with the running room`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await page.evaluate(async (dynamic) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const setup = dynamic
        ? "assignn(v101,0);load.view.v(v101);set.view.v(o0,v101);"
        : "load.view(0);set.view(o0,0);";
      const result = await session.submit({
        proposal: session.model.propose(session.model.capture(), "Shared hero", [
          {
            key: "logic:0",
            content: `if(equaln(v0,0)){new.room(1);}if(isset(f5)){animate.obj(o0);${setup}}call.v(v0);return;`,
          },
          {
            key: "logic:1",
            content:
              "if(isset(f5)){assignn(v100,1);load.pic(v100);draw.pic(v100);show.pic();position(o0,80,140);draw(o0);accept.input();}return;",
          },
        ]),
        label: "Shared hero",
        origin: "logic",
        author: "creator",
      });
      if (result.status !== "committed") throw new Error(result.status);
    }, dynamic);
    await open(page, "part-view:0");
    await expect(page.getByTestId("sprite-studio")).toBeVisible();
    await expect(page.getByTestId("workspace-unused")).toHaveCount(0);
    await expect(page.locator(".play-area:visible")).toBeVisible();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
  });
}

test("a shared PICTURE opens the room chosen in Parts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    await session.submit({
      proposal: session.model.propose(capture, "Shared scenery", [
        {
          key: "logic:8",
          content: (capture.read("logic:8")!.content as string).replace(
            "assignn(v100,8)",
            "assignn(v100,1)",
          ),
        },
      ]),
      label: "Shared scenery",
      origin: "logic",
      author: "creator",
    });
  });
  await open(page, "part-room:1:picture:1");
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await open(page, "part-room:8:picture:1");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await expect(page.locator(".play-area:visible")).toHaveCount(1);
});

test("unused picture becomes a room in one Undo step", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-picture:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await expect(page.getByTestId("workspace-unused")).toContainText("Not used by a room yet");
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect(page.locator(".play-area")).toBeVisible();
  const previousRoom = (await textHook(page)).room;
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  expect((await textHook(page)).room).toBe(previousRoom);
  await updateKeepPlaying(page);
  expect((await textHook(page)).room).toBe(previousRoom);
  await open(page, "part-room:2:picture:9");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("room-studio").filter({ visible: true })).not.toHaveClass(
    /is-live-game/,
  );
  await page.getByTestId("workspace-undo").click();
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  expect((await textHook(page)).room).toBe(2);
  await open(page, "part-room:1:logic");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await open(page, "part-picture:9");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const build = session.model.capture().lastAdmissibleBuild!;
        return [...build.files().get("LOGDIR")!.slice(6, 9)];
      }),
    )
    .toEqual([255, 255, 255]);
  await page.getByTestId("workspace-redo").click();
  await open(page, "part-room:2:picture:9");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("room-studio").filter({ visible: true })).not.toHaveClass(
    /is-live-game/,
  );
  await page.getByTestId("workspace-undo").click();
  await open(page, "part-room:1:logic");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await open(page, "part-picture:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  await updateKeepPlaying(page);
  await open(page, "part-room:2:logic");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

test("Play enters a VIEW's room and unused VIEW can become a room", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-view:8");
  await expect(page.getByTestId("sprite-studio")).toBeVisible();
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await open(page, "part-view:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await expect(page.getByTestId("workspace-unused")).toContainText("Not used by a room yet");
  await expect(page.locator(".play-area")).toBeVisible();
  const previousRoom = (await textHook(page)).room;
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  expect((await textHook(page)).room).toBe(previousRoom);
  await updateKeepPlaying(page);
  expect((await textHook(page)).room).toBe(previousRoom);
  await open(page, "part-room:2:logic");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("workspace-unused")).toHaveCount(0);
  await page.getByTestId("workspace-undo").click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        return [...session.model.capture().lastAdmissibleBuild!.files().get("LOGDIR")!.slice(6, 9)];
      }),
    )
    .toEqual([255, 255, 255]);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.locator('.workspace-error[role="alert"]')).toHaveCount(0);
  for (const size of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: test.info().outputPath(`room-undo-${size.width}.png`),
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  await updateKeepPlaying(page);
  await open(page, "part-room:2:logic");
  await playRoom(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`a room launch follows its LOGIC redirect and keeps the selected editor ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await start(page);
    await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Room entry needs a key", [
          {
            key: "logic:8",
            content:
              "if(!isset(f60)){new.room(1);}assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();return;",
          },
        ]),
        label: "Room entry needs a key",
        origin: "logic",
        author: "creator",
      });
    });
    await open(page, "part-room:8:logic");
    expect((await textHook(page)).room).toBe(1);
    await playRoom(page);
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    if (size.width <= 600) await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    const selectedTab = page.getByRole("tab", { selected: true });
    await expect(selectedTab).toBeVisible();
    await expect(selectedTab).toHaveText("LOGIC 8");
    await expect(page.getByTestId("workspace-update")).toHaveAccessibleName("Play Garden");
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    await page.screenshot({
      path: test.info().outputPath(`redirect-${size.width}.png`),
      animations: "disabled",
    });
  });
}

test("stacked persists on reload and its splitter drags vertically", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await start(page);
  await open(page, "part-room:1:logic");
  // Stacked is the default: the toggle turns Side by side on.
  const layout = page.getByTestId("workspace-layout");
  if ((await layout.getAttribute("aria-pressed")) === "true") await layout.click();
  const splitter = page.getByRole("separator", { name: "Editor height" });
  await expect(splitter).toBeVisible();
  const panel = page.getByTestId("workspace-editor");
  const before = (await panel.boundingBox())!.height;
  const box = (await splitter.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y - 70, { steps: 12 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.height).toBeGreaterThan(before + 40);
  await page.reload();
  await waitForRoom(page, 1);
  await open(page, "part-room:1:logic");
  await expect(page.getByTestId("workspace-layout")).toHaveAttribute("aria-pressed", "false");
  await expect(splitter).toBeVisible();
});

// The Picture editor storyboard replaces the phone pull-up sheet with
// workspace-picture.spec.ts's Edit / Playtest and Update regression.
for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`stage storyboard ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    await shot(page, "stage");
    await open(page, "part-room:1:picture:1");
    await expect(page.getByTestId("room-studio")).toBeVisible();
    await shot(page, "picture");
    await open(page, "part-room:8:picture:8");
    expect((await textHook(page)).room).toBe(1);
    await playRoom(page);
    if (size.width <= 600) await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(8);
    const visitBar = page.getByTestId(size.width <= 600 ? "workspace-visit" : "workspace-game-bar");
    await expect(visitBar).toBeVisible();
    await expect(visitBar).toContainText("Garden");
    await expect(visitBar.getByRole("button", { name: "Back to Home", exact: true })).toBeVisible();
    await shot(page, "visiting");
    await page.getByRole("button", { name: "Back to Home", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await shot(page, "back");
    await open(page, "part-room:8:picture:8");
    await playRoom(page);
    await expect.poll(async () => (await textHook(page)).room).toBe(8);
    await open(page, "part-picture:9");
    await expect(page.getByTestId("workspace-unused")).toBeVisible();
    await shot(page, "unused");
    await makeRoom(page);
    await updateKeepPlaying(page);
    await open(page, "part-room:2:picture:9");
    await playRoom(page);
    await expect.poll(async () => (await textHook(page)).room).toBe(2);
    await shot(page, "make-room", [170, 0, 170]);
    if (size.width <= 600) await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Back to Home", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await open(page, "part-view:8");
    await expect(page.getByTestId("sprite-studio").filter({ visible: true })).toBeVisible();
    await playRoom(page);
    await expect.poll(async () => (await textHook(page)).room).toBe(8);
    await shot(page, "view");
    await open(page, "part-view:9");
    await expect(page.getByTestId("workspace-unused")).toBeVisible();
    await shot(page, "view-unused");
    await makeRoom(page);
    await updateKeepPlaying(page);
    await open(page, "part-room:3:logic");
    await playRoom(page);
    await expect.poll(async () => (await textHook(page)).room).toBe(3);
    await shot(page, "view-make-room", [255, 255, 255]);
    await open(page, "part-room:8:logic");
    await expect(
      page.getByTestId("workspace-logic-editor").filter({ visible: true }),
    ).toBeVisible();
    await playRoom(page);
    if (size.width <= 600) await page.getByRole("button", { name: "Game", exact: true }).click();
    const surface = page.locator(".game-surface:visible");
    await expect(surface).toBeVisible();
    const ratio = await surface.evaluate(
      (el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height,
    );
    expect(ratio).toBeCloseTo(1.6, 1);
    await shot(page, "side-by-side");
    if (size.width > 600) {
      // Stacked is the default: the toggle turns Side by side on and is
      // remembered per viewer.
      const layoutToggle = page.getByTestId("workspace-layout");
      if ((await layoutToggle.getAttribute("aria-pressed")) === "true") await layoutToggle.click();
      const panel = (await page.getByTestId("workspace-editor").boundingBox())!;
      const stage = (await page.locator(".play-area").boundingBox())!;
      expect(panel.width).toBeCloseTo(stage.width, 0);
      expect(panel.y).toBeGreaterThan(stage.y);
      expect(
        await surface.evaluate(
          (el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height,
        ),
      ).toBeCloseTo(1.6, 1);
      await layoutToggle.click();
      expect(
        await page.evaluate(() => localStorage.getItem("monotio_agi.workspaceSplitAxis")),
      ).toBe("horizontal");
      await layoutToggle.click();
      expect(
        await page.evaluate(() => localStorage.getItem("monotio_agi.workspaceSplitAxis")),
      ).toBe("vertical");
      await shot(page, "stacked");
    }
    if (size.width > 600) {
      await page.getByTestId("workspace-focus").click();
      await expect(page.getByTestId("workspace-show-game")).toBeVisible();
      await shot(page, "focus");
      await page.getByTestId("workspace-show-game").click();
    } else await page.getByRole("button", { name: "Edit", exact: true }).click();
    for (const [part, name] of [
      ["words", "words"],
      ["inventory", "objects"],
      ["sound:255", "sound"],
      ["notes", "notes"],
    ] as const) {
      await open(page, `part-${part}`);
      await expect(page.getByTestId("workspace-editor")).toBeVisible();
      await shot(page, name);
    }
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await shot(page, "play", [0, 170, 0]);
  });
}

test("draft room logic counts in picture usage check", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.getByRole("button", { name: "Add a room", exact: true }).click();
  const rename = page.getByTestId("room-rename-input");
  await expect(rename).toBeVisible();
  await rename.fill("Cave");
  await rename.press("Enter");

  // Room 2 was added in draft (staged). Open its picture (picture 2).
  await open(page, "part-room:2:picture:2");
  await expect(page.getByTestId("room-studio")).toBeVisible();
  // Draft LOGIC 2 loads PICTURE 2, so PICTURE 2 must not be treated as unused.
  await expect(page.getByTestId("workspace-unused")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("draft-room-picture-used-1440.png") });
});
