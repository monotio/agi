import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { gameHint, isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildZip } from "../src/archive/zip.ts";

test.use({ keepDetectedProfileOption: false });

async function boot(page: Page, profile: string, joystick = false): Promise<void> {
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
      set.key(1,1,5); set.key(120,1,6); set.key(0,60,7); ${profile === "iigs-1.014" ? "set.key(13,0,5);" : ""}
      ${joystick ? "init.joy();" : ""}
    }
    if (controller(c1)) { print("Help window"); }
    if (controller(c2)) { display(4,0,"Control 3"); }
    if (controller(c3)) { display(4,0,"Control 24"); }
    if (controller(c4)) { print("Secondary action"); }
    if (controller(c5)) {display(6,0,"Primary action");}
    if (controller(c6)) {display(7,0,"Command X");}
    if (controller(c7)) {get.string(s1,"Name?",20,0,10); if (isset(f9)) {display(8,0,"Sound on");} else {display(8,0,"Sound off");}}
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
    // The browser keeps Command shortcuts; a word the game binds reaches it.
    const input = page.getByTestId("input-line");
    const pasteKept = await input.evaluate((el) => {
      const ev = new KeyboardEvent("keydown", {
        key: "v",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      return !ev.defaultPrevented;
    });
    expect(pasteKept).toBe(true);
    if (profile.startsWith("amiga-")) {
      await input.dispatchEvent("keydown", { key: "x", code: "KeyX", metaKey: true });
      await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Command X");
    }
    await page.keyboard.press(profile === "iigs-1.014" ? "Shift+Digit1" : "F1");
    await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
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
    await page.keyboard.press("F2");
    await expect(await gameHint(page, "prompt-hint")).toBeVisible();
    await input.dispatchEvent(
      "keydown",
      profile === "iigs-1.014" ? { key: "/", altKey: true } : { key: "Help", altKey: true },
    );
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Sound off");
  });
}

test.describe(() => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("phone keys expose the Amiga fire button and native modified letters @phone", async ({
    page,
  }) => {
    await boot(page, "amiga-2.316");
    const pad = page.getByTestId("touch-controls");
    await expect(pad).toBeVisible();
    await pad.getByText("Keys", { exact: true }).tap();
    await expect(pad.getByRole("button", { name: "Fire 2", exact: true })).toHaveCount(0);
    await pad.getByRole("button", { name: "Fire twice", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    await pad.getByRole("combobox", { name: "Key modifier" }).selectOption("ctrl");
    await pad.getByRole("button", { name: "Ctrl+X", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Control 3");
    await pad.getByRole("button", { name: "F2", exact: true }).tap();
    await expect(await gameHint(page, "prompt-hint")).toBeVisible();
    await pad.getByRole("button", { name: "Sound", exact: true }).tap();
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Sound off");
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1063, height: 815 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: test.info().outputPath(`platform-keys-${viewport.width}.png`),
        fullPage: true,
      });
    }
  });
});

for (const profile of ["2.936", "amiga-2.202", "iigs-1.014"]) {
  test(`${profile} Gamepad calibration, movement and fire use the native joystick @webkit-desktop`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const pad = {
        connected: true,
        axes: [0, 0],
        buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
      };
      (window as unknown as { gamepad: typeof pad }).gamepad = pad;
      Object.defineProperty(navigator, "getGamepads", {
        value: () => {
          (pad as typeof pad & { polls?: number }).polls =
            ((pad as typeof pad & { polls?: number }).polls ?? 0) + 1;
          return [pad];
        },
      });
    });
    await boot(page, profile, true);
    if (profile !== "amiga-2.202") {
      await expect.poll(async () => (await textHook(page)).modal).toBe("print");
      if (profile === "iigs-1.014")
        await page.evaluate(() => {
          (
            window as unknown as { gamepad: { buttons: { pressed: boolean }[] } }
          ).gamepad.buttons[0]!.pressed = true;
        });
      else await page.keyboard.press("Enter");
      await expect.poll(async () => (await textHook(page)).modal).toBeNull();
      await page.evaluate(() => {
        (
          window as unknown as { gamepad: { buttons: { pressed: boolean }[] } }
        ).gamepad.buttons[0]!.pressed = false;
      });
    }
    await page.evaluate(() => {
      (window as unknown as { gamepad: { axes: number[] } }).gamepad.axes[0] = 0.9;
    });
    await expect.poll(async () => (await textHook(page)).rows[5]?.trim()).toBe("Direction 3");
    await page.evaluate(() => {
      (window as unknown as { gamepad: { axes: number[] } }).gamepad.axes[0] = 0;
    });
    await expect.poll(async () => (await textHook(page)).rows[5]?.trim()).toBe("Direction 0");
    await page.evaluate(() => {
      (
        window as unknown as { gamepad: { buttons: { pressed: boolean }[] } }
      ).gamepad.buttons[0]!.pressed = true;
    });
    if (profile === "iigs-1.014") {
      await expect
        .poll(async () => (await textHook(page)).rows.join("\n"))
        .toContain("Primary action");
    } else {
      // Establish that the held sample reached the worker before releasing it.
      const polls = await page.evaluate(
        () => (window as unknown as { gamepad: { polls: number } }).gamepad.polls,
      );
      await expect
        .poll(async () =>
          page.evaluate(() => (window as unknown as { gamepad: { polls: number } }).gamepad.polls),
        )
        .toBeGreaterThan(polls);
      await waitForCycles(page, 2);
    }
    await page.evaluate(() => {
      (
        window as unknown as { gamepad: { buttons: { pressed: boolean }[] } }
      ).gamepad.buttons[0]!.pressed = false;
    });
    await expect
      .poll(async () => (await textHook(page)).rows.join("\n"))
      .toContain("Primary action");
  });
}
