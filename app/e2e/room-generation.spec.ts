import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { testProjectId } from "../test/identity.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { configureAi, enterCreateMode, isolateStorage, textHook } from "./engineProbe.ts";

async function openGame(page: Page, mode: "Play" | "Create") {
  const session = new AgentSession({ provider: "stub", apiKey: "", model: "stub" }, () => {});
  const resources = await session.startGenesis("A clearing and a hall.");
  const zip = await buildProjectZip({
    projectId: testProjectId("room-overlay"),
    title: "Room overlay",
    authoredAt: "",
    provider: "openai",
    model: "gpt-6-sol",
    ...resources,
    roomGeneration: true,
    authoringState: session.getAuthoringState(),
  });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, {
    provider: "openai",
    model: "gpt-6-sol",
    key: "test-placeholder",
    budget: 5,
  });
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "room-overlay.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect(page.locator(".game-surface:visible")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  if (mode === "Create") {
    await enterCreateMode(page);
    if ((page.viewportSize()?.width ?? 0) > 900) {
      await page.getByTestId("part-room:1:picture:1").click();
      await expect(page.getByTestId("room-studio")).toBeVisible();
    }
  }
  await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
  await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
}

const room = `if (isset(f5)) {
  load.pic(v0); draw.pic(v0); show.pic(); set.horizon(40);
  animate.obj(o0); set.view(o0,0); position(o0,20,120); draw(o0); accept.input();
  print("The hall is ready.");
}
if (said("west")) { new.room(1); }
if (said("north")) { new.room(3); }
return;`;
function roomReply(id: string) {
  return providerReply("openai", {
    id,
    usage: { input_tokens: 0, output_tokens: 0 },
    output: [
      {
        type: "function_call",
        call_id: `${id}-pic`,
        name: "write_picture",
        arguments: JSON.stringify({ room: 2, source: "vis 3\nfill 0,0\nend\n" }),
      },
      {
        type: "function_call",
        call_id: `${id}-logic`,
        name: "write_logic",
        arguments: JSON.stringify({ room: 2, source: room }),
      },
      {
        type: "function_call",
        call_id: `${id}-finish`,
        name: "finish",
        arguments: '{"notes":"The hall is ready."}',
      },
    ],
  });
}
async function walkEast(page: Page) {
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.fill("east");
  await input.press("Enter");
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  for (const mode of ["Play", "Create"] as const) {
    test(`${mode} shows room generation with the drawer closed ${size.width} @webkit-desktop`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openGame(page, mode);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requests = 0;
      await page.route("**/api/openai/v1/responses", async (route) => {
        requests++;
        await pending;
        await route.fulfill(roomReply("room"));
      });
      try {
        await walkEast(page);
        await expect.poll(() => requests).toBe(1);
        const overlay = page.getByTestId("room-generation");
        await expect(overlay).toBeVisible();
        await expect(overlay).toContainText("Creating the next room");
        await expect(page.getByTestId("room-generation-step")).toBeVisible();
        await expect(page.getByTestId("room-generation-step")).toHaveText(
          "Building the next room…",
        );
        await expect(page.getByTestId("room-generation-spent")).toBeVisible();
        await expect(page.getByTestId("room-generation-spent")).toHaveText("$0.00 of $5 spent");
        const bounds = (await overlay.boundingBox())!;
        const screen = (await page.locator(".screen:visible").boundingBox())!;
        expect(bounds).toEqual(screen);
        const header = page.getByRole("banner");
        await expect(header).toBeVisible();
        const headerBounds = (await header.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
        await page.screenshot({ path: test.info().outputPath(`room-${mode}-${size.width}.png`) });
        const before = await textHook(page);
        expect(before.room).toBe(1);
        await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
        await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
        release();
        await expect.poll(async () => (await textHook(page)).room).toBe(2);
        await expect(overlay).toBeHidden();
        await expect
          .poll(async () => (await textHook(page)).rows.join(" "))
          .toContain("The hall is ready.");
        await page.screenshot({
          path: test.info().outputPath(`room-ready-${mode}-${size.width}.png`),
        });
      } finally {
        release();
      }
    });
  }
}

for (const mode of ["Play", "Create"] as const) {
  test(`${mode} Stop cancels a room request and keeps the departure room @webkit-desktop`, async ({
    page,
  }) => {
    await openGame(page, mode);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/openai/v1/responses", async (route) => {
      await pending;
      await route.fulfill(roomReply("stopped"));
    });
    try {
      await walkEast(page);
      await expect(page.getByTestId("room-generation")).toBeVisible();
      await expect(page.getByTestId("room-generation-stop")).toBeVisible();
      await page.getByTestId("room-generation-stop").click();
      await expect(page.getByTestId("room-generation")).toBeHidden();
      release();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect(page.getByTestId("input-line")).toBeEnabled();
    } finally {
      release();
    }
  });
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`room budget stays live below budget and pauses once after crossing ${size.width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openGame(page, "Play");
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/openai/v1/responses", async (route) => {
      const n = ++requests;
      if (n === 2) await pending;
      await route.fulfill(
        n <= 2
          ? providerReply("openai", {
              id: `usage-${n}`,
              usage: { input_tokens: 0, output_tokens: n === 1 ? 47_000 : 465_000 },
              output: [
                { type: "function_call", call_id: `read-${n}`, name: "read_plan", arguments: "{}" },
              ],
            })
          : roomReply("finished"),
      );
    });
    try {
      await walkEast(page);
      const spend = page.getByTestId("room-generation-spent");
      await expect(spend).toBeVisible();
      await expect(spend).toHaveText("$0.47 of $5 spent");
      expect(requests).toBe(2);
      await expect(page.getByTestId("room-generation-continue")).toBeHidden();
      release();
      await expect(page.getByTestId("room-generation-continue")).toBeVisible();
      await expect(spend).toHaveText("$5.12 of $5 spent");
      expect(requests).toBe(2);
      await expect(page.getByTestId("room-generation-stop")).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`room-budget-crossed-${size.width}.png`),
      });
      await page.getByTestId("room-generation-continue").click();
      await expect.poll(async () => (await textHook(page)).room).toBe(2);
      expect(requests).toBe(3);
      await expect(page.getByTestId("room-generation")).toBeHidden();
    } finally {
      release();
    }
  });
}

test("room errors offer Retry and Stop with the drawer closed @webkit-desktop", async ({
  page,
}) => {
  await openGame(page, "Create");
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    if (++requests === 1)
      await route.fulfill({
        status: 400,
        json: { error: { message: "The model could not create this room." } },
      });
    else await route.fulfill(roomReply("retried"));
  });
  await walkEast(page);
  await expect(page.getByTestId("room-generation-error")).toBeVisible();
  await expect(page.getByTestId("room-generation-error")).toContainText(
    "The model could not create this room.",
  );
  await expect(page.getByTestId("room-generation-stop")).toBeVisible();
  await page.getByTestId("room-generation-retry").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("room-generation")).toBeHidden();
  expect(requests).toBe(2);
});
