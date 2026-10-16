import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildZip } from "../src/archive/zip.ts";

test.use({ keepDetectedProfileOption: false });

async function boot(page: Page, profile: string): Promise<void> {
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(255));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) {
      set(f200); configure.screen(1,22,0);
      load.pic(v250); draw.pic(v250); show.pic();
      load.view(0); animate.obj(o0); set.view(o0,0); position(o0,80,120); draw(o0);
      assignn(v99,1); step.size(o0,v99); step.time(o0,v99); accept.input();
      set.key(0,59,1); set.key(3,0,2); set.key(24,0,3); set.key(1,4,4);
    }
    if (controller(c1)) { print("Help window"); }
    if (controller(c2)) { display(4,0,"Control 3"); }
    if (controller(c3)) { display(4,0,"Control 24"); }
    if (controller(c4)) { print("Secondary action"); }
    get.dir(o0,v100); display(5,0,"Direction %v100");
    return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  await isolateStorage(page);
  await page.addInitScript(() => localStorage.setItem("monotio_agi.crtAmount", "0"));
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "platform-input.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  await page.getByTestId("profile-picker-select").selectOption(profile);
  await page.getByTestId("profile-picker-confirm").click();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(profile);
  await expect.poll(async () => (await textHook(page)).egoX).toBe(80);
  await page.getByTestId("input-line").focus();
}

for (const profile of ["amiga-2.082", "amiga-2.202", "iigs-1.014"]) {
  test(`${profile} physical keys use the native translation and keypad center stops walking @webkit-desktop`, async ({
    page,
  }) => {
    await boot(page, profile);
    await page.keyboard.press("Control+x");
    await expect
      .poll(async () => (await textHook(page)).rows.join("\n"))
      .toContain(profile === "amiga-2.202" ? "Control 3" : "Control 24");
    await page.keyboard.press(profile === "iigs-1.014" ? "Shift+Digit1" : "F1");
    await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    const input = page.getByTestId("input-line");
    await input.dispatchEvent("keydown", { key: "6", code: "Numpad6", location: 3 });
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(80);
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Direction 3");
    await input.dispatchEvent("keydown", { key: "5", code: "Numpad5", location: 3 });
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Direction 0");
    // Text frames precede the 250 ms position heartbeat. Observe a heartbeat
    // after the stop before comparing positions.
    await waitForCycles(page, 2);
    const x = (await textHook(page)).egoX;
    await waitForCycles(page, 3);
    expect((await textHook(page)).egoX).toBe(x);
  });
}

test.describe(() => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("phone keys expose the Amiga secondary double-click action and native Control X @phone", async ({
    page,
  }) => {
    await boot(page, "amiga-2.316");
    const pad = page.getByTestId("touch-controls");
    await expect(pad).toBeVisible();
    await pad.getByText("Keys", { exact: true }).tap();
    await pad.getByRole("button", { name: "Button 4", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    await pad.getByRole("combobox", { name: "Key modifier" }).selectOption("ctrl");
    await pad.getByRole("button", { name: "Ctrl+X", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Control 3");
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1063, height: 815 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: test.info().outputPath(`platform-keys-${viewport.width}.png`),
      });
    }
  });
});
