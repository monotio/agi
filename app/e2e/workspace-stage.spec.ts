import { decodePng } from "../../scripts/png.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, textHook, waitForRoom, workspaceUpdated } from "./engineProbe.ts";

async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await workspaceUpdated(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const result = await session.submit({
      proposal: session.model.propose(capture, "More rooms and art", [
        { key: "picture:8", content: "vis 3\nfill 0,0\nend\n" },
        { key: "picture:9", content: "vis 5\nfill 0,0\nend\n" },
        { key: "view:8", content: capture.read("view:0")!.content },
        { key: "view:9", content: capture.read("view:0")!.content },
        {
          key: "logic:8",
          content:
            'if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);load.view(8);set.view(o0,8);position(o0,60,140);draw(o0);accept.input();}if(said("look")){new.room(1);}return;',
        },
        {
          key: "world",
          content: JSON.stringify({
            ...JSON.parse(capture.read("world")!.content as string),
            rooms: {
              "1": { title: "Home", description: "", exits: {} },
              "8": { title: "Garden", description: "", exits: {} },
            },
          }),
        },
      ]),
      label: "More rooms and art",
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "committed") throw new Error(result.status);
  });
}
async function open(page: Page, id: string) {
  if (page.viewportSize()!.width <= 600) await page.getByTestId("workspace-parts").click();
  await page.getByTestId(id).click();
}
async function shot(page: Page, name: string, expected?: readonly number[]) {
  if (!["unused", "view-unused", "focus"].includes(name)) {
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

test("opening pictures visits their rooms and Back restores the prior moment", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(page.getByTestId("room-studio")).toHaveClass(/is-live-game/);
  const before = await textHook(page);
  await open(page, "part-room:8:picture:8");
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await expect(page.getByTestId("workspace-visit")).toBeVisible();
  await expect(page.getByTestId("workspace-visit")).toContainText("Visiting Room 8");
  await expect(page.locator(".play-area:visible")).toHaveCount(1);
  await expect(page.getByTestId("room-studio").filter({ visible: true })).toHaveClass(
    /is-live-game/,
  );
  await page.getByRole("button", { name: "Back to Room 1", exact: true }).click();
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
  await expect(page.getByTestId("room-studio").filter({ visible: true })).toHaveClass(
    /is-live-game/,
  );
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

test("room changes during Create keep the picture editor on the running room", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await input.fill("look");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await expect(studio).toHaveClass(/is-live-game/);
  await expect(page.getByRole("tab", { selected: true })).toHaveText("PICTURE 1");
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
  await page.getByTestId("workspace-focus").click();
  const done = page.getByTestId("workspace-show-game");
  await expect(done).toBeVisible();
  await expect(done).toHaveText("Done");
  await done.click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
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
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await expect(page.locator(".play-area:visible")).toHaveCount(1);
});

test("unused picture becomes a room in one Undo step", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-picture:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await expect(page.getByTestId("workspace-unused")).toContainText("Not used by a room yet");
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await expect(page.locator(".play-area")).toBeHidden();
  const previousRoom = (await textHook(page)).room;
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  expect((await textHook(page)).room).toBe(previousRoom);
  await workspaceUpdated(page);
  expect((await textHook(page)).room).toBe(previousRoom);
  await open(page, "part-room:2:picture:9");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("room-studio").filter({ visible: true })).toHaveClass(
    /is-live-game/,
  );
  await page.getByTestId("workspace-undo").click();
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
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
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("room-studio").filter({ visible: true })).toHaveClass(
    /is-live-game/,
  );
  await page.getByTestId("workspace-undo").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  await workspaceUpdated(page);
  await open(page, "part-room:2:logic");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

test("opening another room's VIEW visits it and unused VIEW can become a room", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-view:8");
  await expect(page.getByTestId("sprite-studio")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(8);
  await open(page, "part-view:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await expect(page.getByTestId("workspace-unused")).toContainText("Not used by a room yet");
  await expect(page.locator(".play-area")).toBeHidden();
  const previousRoom = (await textHook(page)).room;
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  expect((await textHook(page)).room).toBe(previousRoom);
  await workspaceUpdated(page);
  expect((await textHook(page)).room).toBe(previousRoom);
  await open(page, "part-room:2:logic");
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
  await expect(page.getByRole("alert")).toHaveCount(0);
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
  await workspaceUpdated(page);
  await open(page, "part-room:2:logic");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`a room that redirects entry shows its paused picture beside LOGIC ${size.width}`, async ({
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
    await expect(page.getByTestId("workspace-stage-note")).toBeVisible();
    await expect(page.getByTestId("workspace-paused-picture")).toBeVisible();
    await expect.poll(async () => (await textHook(page)).paused).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`fallback-${size.width}.png`),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Back to Room 1", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await expect(page.getByTestId("workspace-stage-note")).toHaveCount(0);
  });
}

test("stacked persists on reload and its splitter drags vertically", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await start(page);
  await open(page, "part-room:1:logic");
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Stacked", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(splitter).toBeVisible();
});

test("phone panels pull up along the stacked axis", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await open(page, "part-room:1:logic");
  const panel = page.getByTestId("workspace-editor");
  await expect(panel).toBeVisible();
  const splitter = page.getByRole("separator");
  await expect(splitter).toBeVisible();
  const before = (await panel.boundingBox())!.height;
  const box = (await splitter.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y - 70, { steps: 12 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.height).toBeGreaterThan(before + 40);
  await expect(splitter).toHaveAttribute("aria-label", "Editor height");
});

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
    await expect(page.getByTestId("workspace-visit")).toBeVisible();
    await shot(page, "visiting");
    await page.getByRole("button", { name: "Back to Room 1", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await shot(page, "back");
    await open(page, "part-room:8:picture:8");
    await expect.poll(async () => (await textHook(page)).room).toBe(8);
    await open(page, "part-picture:9");
    await expect(page.getByTestId("workspace-unused")).toBeVisible();
    await shot(page, "unused");
    await page.getByRole("button", { name: "Make it a room", exact: true }).click();
    await workspaceUpdated(page);
    await open(page, "part-room:2:picture:9");
    await expect.poll(async () => (await textHook(page)).room).toBe(2);
    await shot(page, "make-room", [170, 0, 170]);
    await page.getByRole("button", { name: "Back to Room 1", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await open(page, "part-view:8");
    await expect(page.getByTestId("sprite-studio").filter({ visible: true })).toBeVisible();
    await expect.poll(async () => (await textHook(page)).room).toBe(8);
    await shot(page, "view");
    await open(page, "part-view:9");
    await expect(page.getByTestId("workspace-unused")).toBeVisible();
    await shot(page, "view-unused");
    await page.getByRole("button", { name: "Make it a room", exact: true }).click();
    await workspaceUpdated(page);
    await open(page, "part-room:3:logic");
    await expect.poll(async () => (await textHook(page)).room).toBe(3);
    await shot(page, "view-make-room", [255, 255, 255]);
    await open(page, "part-room:8:logic");
    await expect(
      page.getByTestId("workspace-logic-editor").filter({ visible: true }),
    ).toBeVisible();
    const surface = page.locator(".game-surface:visible");
    await expect(surface).toBeVisible();
    const ratio = await surface.evaluate(
      (el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height,
    );
    expect(ratio).toBeCloseTo(1.6, 1);
    await shot(page, "side-by-side");
    if (size.width > 600) {
      await page.getByRole("button", { name: "Stacked", exact: true }).click();
      const panel = (await page.getByTestId("workspace-editor").boundingBox())!;
      const stage = (await page.locator(".play-area").boundingBox())!;
      expect(panel.width).toBeCloseTo(stage.width, 0);
      expect(panel.y).toBeGreaterThan(stage.y);
      expect(
        await surface.evaluate(
          (el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height,
        ),
      ).toBeCloseTo(1.6, 1);
      expect(
        await page.evaluate(() => localStorage.getItem("monotio_agi.workspaceSplitAxis")),
      ).toBe("vertical");
      await shot(page, "stacked");
    }
    await page.getByTestId("workspace-focus").click();
    await expect(page.getByTestId("workspace-show-game")).toBeVisible();
    await shot(page, "focus");
    await page.getByTestId("workspace-show-game").click();
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
    await expect.poll(async () => (await textHook(page)).room).toBe(8);
    await shot(page, "play");
  });
}
