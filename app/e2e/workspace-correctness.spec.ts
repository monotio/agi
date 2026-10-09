import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { enterCreateMode, isolateStorage, waitForRoom, workspaceSaved } from "./engineProbe.ts";
import { clickPictureCell, findWorkspaceLogic } from "./workspaceShared.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { buildView } from "../../src/view/view.ts";
import { createSoundDocument } from "../../src/sound/document.ts";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession | null } }
          ).__AGI_PROJECT__.getSession() !== null,
      ),
    )
    .toBe(true);
  await parts(page);
}

async function parts(page: Page): Promise<void> {
  if (page.viewportSize()!.width <= 600 && !(await page.getByTestId("parts-list").isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  const bytes = await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  if (process.env["CI"]) console.log(`CORRECTNESS_SHOT:${name}:${bytes.toString("base64")}`);
}

async function draftText(page: Page, key: string): Promise<string | null> {
  return page.evaluate((key) => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const value = session.workingSnapshot().read(key)?.content;
    return typeof value === "string"
      ? value
      : value instanceof Uint8Array
        ? [...value].join(",")
        : null;
  }, key);
}

for (const [group, kind] of [
  ["SHARED LOGIC", "logic"],
  ["PICTURES", "picture"],
  ["VIEWS", "view"],
  ["SOUNDS", "sound"],
] as const) {
  test(`two ${kind} adds preserve the edited draft and open distinct parts @webkit-desktop`, async ({
    page,
  }) => {
    await starter(page);
    const section = page
      .getByTestId("parts-list")
      .locator("section", { has: page.getByRole("heading", { name: group, exact: true }) })
      .first();
    async function add(): Promise<void> {
      await parts(page);
      await section.locator(".parts-add").first().click();
      if (kind === "logic")
        await page.getByRole("menuitem", { name: "Empty shared code", exact: true }).click();
    }
    const number = await page.evaluate((kind) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      let num = 1;
      while (session.workingSnapshot().keys.includes(`${kind}:${num}`)) num++;
      return num;
    }, kind);
    await add();
    const first = `${kind}:${number}`;
    await expect(page.getByTestId(`project-tab-${first}`)).toBeVisible();
    await expect(page.getByTestId(`project-tab-${first}`)).toHaveAttribute("aria-selected", "true");
    const editorId =
      kind === "logic"
        ? "workspace-logic-editor"
        : kind === "picture"
          ? "room-studio"
          : kind === "view"
            ? "sprite-studio"
            : "workspace-sound";
    await expect(page.getByTestId(editorId).filter({ visible: true })).toBeVisible();
    const binary =
      kind === "view"
        ? buildView({
            loops: [
              {
                cels: [
                  { width: 8, height: 8, transparentColor: 15, pixels: new Uint8Array(64).fill(3) },
                ],
              },
            ],
          })
        : kind === "sound"
          ? createSoundDocument()
              .insertEvent(0, 0, { ticks: 30, data: { kind: "tone", note: "C4", attenuation: 3 } })
              .encode()
          : undefined;
    await page.evaluate(
      ({ key, kind, binary }) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const content = session.workingSnapshot().read(key)!.content;
        const edited = binary
          ? Uint8Array.from(binary)
          : `${kind === "logic" ? "// changed\n" : "vis 4\n"}${content}`;
        session.drafts().stage([{ key, content: edited }]);
      },
      { key: first, kind, binary: binary ? [...binary] : undefined },
    );
    const changed = await draftText(page, first);
    await add();
    await expect(page.getByTestId(`project-tab-${kind}:${number + 1}`)).toBeVisible();
    await expect(page.getByTestId(editorId).filter({ visible: true })).toBeVisible();
    await shot(page, `adds-${kind}`);
    expect(await draftText(page, first)).toBe(changed);
  });
}

test("Undo after a committed note restores the latest room rename first @webkit-desktop", async ({
  page,
}) => {
  await starter(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    await session.submit({
      proposal: session.model.propose(capture, "Note", [
        { key: "notes", content: "Keep this note" },
      ]),
      label: "Note",
      origin: "logic",
      author: "creator",
    });
  });
  await page.getByTestId("part-room:1").dblclick();
  await page.getByTestId("room-rename-input").fill("Forest");
  await page.getByTestId("room-rename-input").press("Enter");
  await workspaceSaved(page);
  await page.getByTestId("workspace-undo").click();
  await shot(page, "rename-undo");
  await expect.poll(() => draftText(page, "world")).not.toContain('"Forest"');
  expect(await draftText(page, "notes")).toBe("Keep this note");
});

test("picture strokes share keyboard and header Undo, and a fresh stroke clears Redo @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await page.getByTestId("workspace-focus").click();
  const initial = await draftText(page, "picture:1");
  await studio.getByRole("button", { name: "Line", exact: true }).click();
  await clickPictureCell(studio, 20, 20);
  await clickPictureCell(studio, 40, 20);
  await page.keyboard.press("Enter");
  await expect.poll(() => draftText(page, "picture:1")).not.toBe(initial);
  const first = await draftText(page, "picture:1");
  await clickPictureCell(studio, 30, 30);
  await clickPictureCell(studio, 50, 30);
  await page.keyboard.press("Enter");
  await expect.poll(() => draftText(page, "picture:1")).not.toBe(first);
  await studio.locator(".studio__stage").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => draftText(page, "picture:1")).toBe(first);
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => draftText(page, "picture:1")).toBe(initial);
  await page.getByTestId("workspace-redo").click();
  await expect.poll(() => draftText(page, "picture:1")).toBe(first);
  await studio.getByRole("button", { name: "Line", exact: true }).click();
  await clickPictureCell(studio, 40, 40);
  await clickPictureCell(studio, 60, 40);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-redo")).toBeDisabled();
});

test("a hero drag with the Views list open undoes before older committed work @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await page.getByTestId("workspace-focus").click();
  await studio.getByRole("slider", { name: "Views", exact: true }).evaluate((element) => {
    (element as HTMLInputElement).value = "100";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await studio
    .getByRole("radiogroup", { name: "Side panel", exact: true })
    .getByRole("radio", { name: "Views", exact: true })
    .click();
  await expect(studio.getByTestId("views-panel")).toBeVisible();
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  const initial = await draftText(page, "logic:8");
  const pane = (await studio.locator('.studio-pane[data-layer="art"]').boundingBox())!;
  const px = (column: number) => Math.round(pane.x + ((column + 0.5) * pane.width) / 160);
  const y = Math.round(pane.y + (138.5 * pane.height) / 168);
  await page.mouse.move(px(60), y);
  await page.mouse.down();
  await page.mouse.move(px(70), y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => draftText(page, "logic:8")).not.toBe(initial);
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => draftText(page, "logic:8")).toBe(initial);
  await expect(figure).toHaveAttribute("data-x", "60");
  expect(await draftText(page, "view:8")).not.toBeNull();
});

test("a first catalog edit claims the copy before another page takes it over @webkit-desktop", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1);
  await enterCreateMode(page);
  await parts(page);
  await page.getByTestId("part-notes").click();
  await page.getByLabel("Game notes", { exact: true }).fill("My first change");
  await workspaceSaved(page);
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  await workspaceSaved(page);
  const copy = await page.evaluate(async () => {
    const { listCachedGames } = await import("/src/project/gameStorage.ts");
    return listCachedGames().find((game) => game.library?.source === "remix")!.projectId;
  });
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const other = await context.newPage();
  await other.goto(`/#play/${copy}`);
  await waitForRoom(other, 1);
  await enterCreateMode(other);
  await parts(other);
  await expect(other.getByTestId("project-tab-notes")).toBeVisible();
  await expect(page.getByTestId("other-tab-notice")).toBeVisible();
  await expect(page.getByTestId("input-line")).toBeDisabled();
});

test("a second page pauses edits until Take back and keeps each page's tabs @webkit-desktop", async ({
  page,
  context,
}) => {
  await starter(page);
  await page.getByTestId("part-room:1:logic").click();
  const other = await context.newPage();
  await other.goto(page.url());
  await waitForRoom(other, 1, { coldBoot: true });
  await parts(other);
  await expect(other.getByTestId("project-tab-logic:1")).toBeVisible();
  const notice = page.getByTestId("other-tab-notice");
  await expect(notice).toBeVisible();
  await shot(page, "paused-tab");
  await parts(page);
  await expect(page.getByRole("button", { name: "Add a room", exact: true })).toBeDisabled();
  await expect(page.getByTestId("workspace-update")).toBeDisabled();
  await page.getByTestId("part-notes").click();
  const notes = page.getByLabel("Game notes", { exact: true });
  await expect(notes).toBeVisible();
  await expect(notes).toHaveJSProperty("readOnly", true);
  const before = await draftText(page, "notes");
  await notes.focus();
  await page.keyboard.type("Paused edit");
  expect(await draftText(page, "notes")).toBe(before);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Take back", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(notes).toHaveJSProperty("readOnly", false);
  await expect(page.getByRole("button", { name: "Add a room", exact: true })).toBeEnabled();
  await other.getByTestId("part-room:1:picture:1").click();
  await expect(other.getByTestId("project-tab-picture:1")).toBeVisible();
  await page.reload();
  await waitForRoom(page, 1, { coldBoot: true });
  await parts(page);
  await expect(page.getByTestId("project-tab-notes")).toBeVisible();
  await expect(page.getByTestId("project-tab-picture:1")).toHaveCount(0);
  await other.reload();
  await waitForRoom(other, 1, { coldBoot: true });
  await parts(other);
  await expect(other.getByTestId("project-tab-picture:1")).toBeVisible();
  await expect(other.getByTestId("project-tab-notes")).toHaveCount(0);
});

test("each page reloads its own tabs and a fresh page inherits the latest list @webkit-desktop", async ({
  page,
  context,
}) => {
  await starter(page);
  await page.getByTestId("part-room:1:logic").click();
  const other = await context.newPage();
  await other.goto(page.url());
  await waitForRoom(other, 1, { coldBoot: true });
  await parts(other);
  await expect(other.getByTestId("project-tab-logic:1")).toBeVisible();
  await page.getByTestId("part-notes").click();
  await expect(page.getByTestId("project-tab-notes")).toBeVisible();
  await other.getByTestId("part-room:1:picture:1").click();
  await expect(other.getByTestId("project-tab-picture:1")).toBeVisible();
  await page.reload();
  await waitForRoom(page, 1, { coldBoot: true });
  await parts(page);
  await expect(page.getByTestId("project-tab-notes")).toBeVisible();
  await expect(page.getByTestId("project-tab-picture:1")).toHaveCount(0);
  const fresh = await context.newPage();
  await fresh.goto(page.url());
  await waitForRoom(fresh, 1, { coldBoot: true });
  await parts(fresh);
  await expect(fresh.getByTestId("project-tab-picture:1")).toBeVisible();
  await expect(fresh.getByTestId("project-tab-notes")).toHaveCount(0);
});

test("bad saved Launches offer repair while keeping other world edits @webkit-desktop", async ({
  page,
}) => {
  await starter(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const world = JSON.parse(session.workingSnapshot().read("world")!.content as string);
    world.rooms["1"] = { title: "Recovery room", description: "", exits: {} };
    world.launches = {
      "1": { entries: [{ id: "bad", name: "Repair me", variables: { "0": 1, "30": 7 } }] },
    };
    session.drafts().stage([{ key: "world", content: JSON.stringify(world) }]);
    await session.drafts().flush();
  });
  await page.reload();
  await expect(page.getByTestId("launch-recovery-error")).toBeVisible();
});

test("A breakpoint run from a cold Create hides Back when its return point has no room @webkit-desktop", async ({
  page,
}) => {
  await starter(page);
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
  await findWorkspaceLogic(page, "assignn(v50, clearing_pic)");
  await page.keyboard.press("F9");
  await expect(page.locator(".workspace-breakpoint")).toHaveCount(1);
  await page.keyboard.press("F5");
  await expect(page.getByTestId("debug-stop")).toBeVisible();
  await shot(page, "debug-back");
  await expect(page.getByRole("button", { name: "Back to Room 0", exact: true })).toHaveCount(0);
});

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`Launch filters transition inputs and repairs recovery at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await starter(page);
    await page.evaluate(() => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const bindings = JSON.parse(session.workingSnapshot().read("bindings")!.content as string);
      Object.assign(bindings, {
        reserved_room: { kind: "variable", num: 0 },
        reserved_edge: { kind: "variable", num: 2 },
        reserved_new_room: { kind: "flag", num: 5 },
      });
      session.drafts().stage([{ key: "bindings", content: JSON.stringify(bindings) }]);
    });
    await page.getByTestId("part-room:1:logic").click();
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    await page.getByTestId("workspace-update-menu").click();
    await page.getByRole("menuitem", { name: "New launch…", exact: true }).click();
    await expect(page.getByTestId("launch-editor")).toBeVisible();
    await page.getByTestId("launch-add-row-menu").click();
    await page.getByRole("menuitem", { name: "Variable", exact: true }).click();
    const picker = page.getByTestId("launch-var-select");
    await expect(picker).toBeVisible();
    await shot(page, `launch-${width}`);
    await expect(picker.locator('option[value="0"], option[value="2"]')).toHaveCount(0);
    const before = await draftText(page, "world");
    await picker.evaluate((element) => element.append(new Option("Injected variable 0", "0")));
    await picker.selectOption("0");
    const refusal = page.getByRole("alert").filter({ hasText: "set by the room transition" });
    await expect(refusal).toBeVisible();
    expect(await draftText(page, "world")).toBe(before);
    await picker.selectOption("30");
    await page.getByTestId("launch-add-row-menu").click();
    await page.getByRole("menuitem", { name: "Flag", exact: true }).click();
    await expect(page.getByTestId("launch-flag-select")).toBeVisible();
    await expect(page.getByTestId("launch-flag-select").locator('option[value="5"]')).toHaveCount(
      0,
    );
    await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const world = JSON.parse(session.workingSnapshot().read("world")!.content as string);
      world.rooms["1"] = { title: "Recovery room", description: "", exits: {} };
      world.launches = {
        "1": {
          entries: [
            {
              id: "bad",
              name: "Repair me",
              variables: { "0": 1, "30": 7 },
              flags: { "5": true, "40": true },
            },
          ],
        },
      };
      session.drafts().stage([{ key: "world", content: JSON.stringify(world) }]);
      await session.drafts().flush();
    });
    await page.reload();
    await waitForRoom(page, 1, { coldBoot: true });
    const error = page.getByTestId("launch-recovery-error");
    await expect(error).toBeVisible();
    await shot(page, `recovery-${width}`);
    await error.getByRole("button", { name: "Repair launches", exact: true }).click();
    await expect(error).toBeHidden();
    const repaired = JSON.parse((await draftText(page, "world"))!);
    expect(repaired.rooms["1"].title).toBe("Recovery room");
    expect(repaired.launches["1"].entries[0]).toMatchObject({
      variables: { "30": 7 },
      flags: { "40": true },
    });
  });
}
