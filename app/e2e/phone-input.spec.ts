import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildObjectFile } from "../../src/agent/tools.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

async function boot(
  page: Page,
  hold = false,
  interrupt?: "print" | "menu" | "save",
  rawDraft = false,
  nativeEnter: boolean | "mapped" = false,
) {
  const game = createContainer();
  game.putFile("OBJECT", buildObjectFile([{ name: "key" }, { name: "lamp" }]));
  game.putResource("picture", 0, Uint8Array.of(255));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if(!isset(f200)) {
      set(f200);assignn(v10,1);assignn(v60,0);load.pic(v60);draw.pic(v60);show.pic();
      load.view(0);animate.obj(0);set.view(0,0);position(0,60,120);draw(0);accept.input();
      set.key(0,59,1);set.key(0,60,2);set.key(0,61,3);set.key(0,62,4);
      set.key(0,63,5);set.key(1,0,6);set.key(0,30,7);
      set.key(0,64,8);set.key(0,65,9);set.key(0,66,10);set.key(0,67,11);
      set.key(120,0,13);
      set.key(0,68,12);set.key(122,0,14);
      ${nativeEnter === "mapped" ? "set.key(13,0,15);" : ""}
      assignn(v62,17);get(0);get(1);
      set.menu("Game");set.menu.item("Answer",1);submit.menu();set(f14);
      ${hold ? "hold.key();" : ""}
    }
    if(controller(1)) {get.string(s1,"Name?",20,0,12);display(3,0,"Name: %s1");}
    if(controller(2)) {get.num("Number?",v61);display(4,0,"Number: %v61");}
    if(controller(3)) {menu.input();}
    if(controller(4)) {print("Continue or cancel");display(5,0,"Window closed");}
    if(controller(5)) {text.screen();prevent.input();
      ${rawDraft ? "raw_answer: if(!have.key()) {goto raw_answer;} assignv(v65,v19);graphics();accept.input();" : ""}
    }
    if(controller(6)) {display(6,0,"CTRL A");}
    if(controller(7)) {display(7,0,"ALT A");}
    if(controller(8)) {set(f13);status();display(9,0,"Item: %v25");}
    if(controller(9)) {save.game();}
    if(controller(10)) {restore.game();}
    if(controller(11)) {assignn(v62,99);drop(1);}
    if(controller(13)) {display(11,0,"RAW X shortcut");}
    if(controller(12)) {
      text.screen();prevent.input();
      first_key: if(!have.key()) {goto first_key;} assignn(v19,0);
      second_key: if(!have.key()) {goto second_key;} display(12,0,"TWO KEYS");
    }
    if(controller(14)) {prevent.input();display(13,0,"RAW GRAPHICS");}
    if(equaln(v19,3)) {display(14,0,"RAW CTRL C");}
    display(10,0,"State: %v62");
    if(equaln(v19,121)) {graphics();accept.input();display(8,0,"RAW Y");}
    ${nativeEnter ? 'if(equaln(v19,13)) {graphics();accept.input();display(16,0,"RAW ENTER");} if(controller(15)) {display(16,0,"MAPPED ENTER");} if(isset(f2)) {display(17,0,"PARSER SUBMITTED");}' : ""}
    ${rawDraft ? 'if(greatern(v65,0)) {display(15,0,"First key: %v65");}' : ""}
    ${interrupt ? `get.posn(0,v63,v64);if(!isset(f201) && greatern(v63,64)) {set(f201);${interrupt === "print" ? 'print("Movement interruption");' : interrupt === "menu" ? "menu.input();" : "save.game();"}}` : ""}
    return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "phone.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      buildPublicGameZip({
        title: "Phone input",
        files: { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) },
      }),
    ),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(60);
}

test("touch Backspace updates the engine-rendered parser draft", async ({ page }) => {
  await boot(page);
  const input = page.getByTestId("input-line");
  await input.fill("look");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("look");
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "Backspace", exact: true }).tap();
  await expect(input).toHaveValue("loo");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).not.toContain("look");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("loo");
});

test("touch function keys cannot insert characters into a string prompt", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F1", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  const input = page.getByTestId("input-line");
  await input.fill("Ada");
  await pad.getByRole("button", { name: "F2", exact: true }).tap();
  await expect(input).toHaveValue("Ada");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Name: Ada");
});

test("desktop navigation includes diagonals", async ({ page }) => {
  await boot(page);
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("PageUp");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
  expect((await textHook(page)).egoY).toBeLessThan(120);
});

for (const hold of [false, true]) {
  test(`touch directions preserve ${hold ? "hold.key" : "toggle"} behavior`, async ({ page }) => {
    await boot(page, hold);
    const pad = page.getByTestId("touch-controls");
    await expect(pad).toBeVisible();
    const right = pad.getByRole("button", { name: "Walk east", exact: true });
    await right.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
    await right.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
    await waitForCycles(page, 2);
    const released = (await textHook(page)).egoX;
    await waitForCycles(page, 3);
    if (hold) expect((await textHook(page)).egoX).toBe(released);
    else {
      expect((await textHook(page)).egoX).toBeGreaterThan(released);
      await right.tap();
      await waitForCycles(page, 2);
      const stopped = (await textHook(page)).egoX;
      await waitForCycles(page, 3);
      expect((await textHook(page)).egoX).toBe(stopped);
    }
    await page.screenshot({ path: test.info().outputPath("phone-controls.png") });
  });
}

test("touch hold release during a game-triggered print stops ego after dismissal", async ({
  page,
}) => {
  await boot(page, true, "print");
  const pad = page.getByTestId("touch-controls");
  const east = pad.getByRole("button", { name: /^(Walk|Navigate) east$/ });
  await east.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await east.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await waitForCycles(page, 2);
  const released = (await textHook(page)).egoX;
  await waitForCycles(page, 3);
  expect((await textHook(page)).egoX).toBe(released);
});

for (const modal of ["menu", "save"] as const) {
  for (const hold of [false, true]) {
    test(`${modal} navigation releases preserve ${hold ? "the next held gesture" : "toggle walking"}`, async ({
      page,
    }) => {
      await boot(page, hold, modal);
      const pad = page.getByTestId("touch-controls");
      const east = pad.getByRole("button", { name: /^(Walk|Navigate) east$/ });
      await east.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
      if (!hold) await east.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
      await expect.poll(async () => (await textHook(page)).modal).toBe(modal);
      if (hold) await east.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
      const south = pad.getByRole("button", { name: /^(Walk|Navigate) south$/ });
      await south.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", button: 0 });
      await pad.getByRole("button", { name: "Esc", exact: true }).tap();
      await expect.poll(async () => (await textHook(page)).modal).toBeNull();
      await waitForCycles(page, 2);
      const resumed = (await textHook(page)).egoX;
      await waitForCycles(page, 3);
      if (hold) {
        expect((await textHook(page)).egoX).toBe(resumed);
        await south.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch" });
        await east.dispatchEvent("pointerdown", { pointerId: 3, pointerType: "touch", button: 0 });
        await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(resumed);
        const moving = (await textHook(page)).egoX;
        await waitForCycles(page, 3);
        expect((await textHook(page)).egoX).toBeGreaterThan(moving);
        await east.dispatchEvent("pointerup", { pointerId: 3, pointerType: "touch" });
      } else {
        expect((await textHook(page)).egoX).toBeGreaterThan(resumed);
        await south.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch" });
        const afterNavigation = (await textHook(page)).egoX;
        await waitForCycles(page, 3);
        expect((await textHook(page)).egoX).toBeGreaterThan(afterNavigation);
        await east.tap();
      }
      await waitForCycles(page, 2);
      const stopped = (await textHook(page)).egoX;
      await waitForCycles(page, 3);
      expect((await textHook(page)).egoX).toBe(stopped);
    });
  }
}

test("phone text input answers string and numeric prompts without keydown", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F1", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("Rosella");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Name: Rosella");
  await pad.getByRole("button", { name: "F1", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  const input = page.getByTestId("input-line");
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.fill("Graham");
  await input.dispatchEvent("compositionend", { data: "Graham" });
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Name: Graham");
  await pad.getByRole("button", { name: "F2", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("42");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Number: 42");
  await pad.getByRole("button", { name: "F1", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("Cancel me");
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeHidden();
});

test("touch pad exposes all eight walking directions", async ({ page }) => {
  await boot(page, true);
  const pad = page.getByTestId("touch-controls");
  const directions = [
    ["north", 0, -1],
    ["northeast", 1, -1],
    ["east", 1, 0],
    ["southeast", 1, 1],
    ["south", 0, 1],
    ["southwest", -1, 1],
    ["west", -1, 0],
    ["northwest", -1, -1],
  ] as const;
  for (const [name, dx, dy] of directions) {
    const before = await textHook(page);
    const button = pad.getByRole("button", { name: `Walk ${name}`, exact: true });
    await button.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
    await expect
      .poll(async () => {
        const after = await textHook(page);
        return [Math.sign(after.egoX - before.egoX), Math.sign(after.egoY - before.egoY)];
      })
      .toEqual([dx, dy]);
    await button.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
    await waitForCycles(page, 2);
  }
});

for (const interruption of ["pointercancel", "blur"] as const) {
  test(`touch hold stops after ${interruption} and accepts a new direction`, async ({ page }) => {
    await boot(page, true);
    const right = page
      .getByTestId("touch-controls")
      .getByRole("button", { name: "Walk east", exact: true });
    await right.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
    if (interruption === "pointercancel") {
      await right.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "touch" });
    } else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await waitForCycles(page, 2);
    const stopped = (await textHook(page)).egoX;
    await waitForCycles(page, 3);
    expect((await textHook(page)).egoX).toBe(stopped);
    await right.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", button: 0 });
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(stopped);
    await right.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch" });
  });
}

for (const desktop of [false, true]) {
  test.describe(`${desktop ? "desktop" : "touch-enabled"} mouse focus`, () => {
    test.use({
      hasTouch: !desktop,
      viewport: desktop ? { width: 1280, height: 900 } : { width: 390, height: 844 },
    });
    test("real mouse hold on another arrow survives the previous arrow's focus", async ({
      page,
    }) => {
      await boot(page, true);
      if (desktop) {
        const settings = page.getByTestId("settings-menu");
        await settings.click();
        await page.getByTestId("toggle-touch-controls").click();
        await settings.click();
      }
      const pad = page.getByTestId("touch-controls");
      const west = pad.getByRole("button", { name: "Walk west", exact: true });
      const east = pad.getByRole("button", { name: "Walk east", exact: true });
      await west.focus();
      await expect(west).toBeFocused();
      await east.evaluate((button) => {
        document.addEventListener(
          "pointerdown",
          (event) => {
            if (event.target === button)
              button.setAttribute("data-pointer-default-prevented", String(event.defaultPrevented));
          },
          { once: true },
        );
      });
      const button = await east.boundingBox();
      expect(button).not.toBeNull();
      await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2);
      await page.mouse.down();
      await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
      await expect(west).toBeFocused();
      const held = (await textHook(page)).egoX;
      await waitForCycles(page, 3);
      expect((await textHook(page)).egoX).toBeGreaterThan(held);
      expect((await textHook(page)).egoY).toBe(120);
      await expect(east).toHaveAttribute("data-pointer-default-prevented", "true");
      await page.mouse.up();
      await waitForCycles(page, 2);
      const released = (await textHook(page)).egoX;
      await waitForCycles(page, 3);
      expect((await textHook(page)).egoX).toBe(released);
    });
  });
}

for (const key of ["Enter", "Space"]) {
  test(`focused touch arrow supports ${key} hold and release`, async ({ page }) => {
    await boot(page, true);
    const east = page
      .getByTestId("touch-controls")
      .getByRole("button", { name: "Walk east", exact: true });
    await east.focus();
    await page.keyboard.down(key);
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
    await page.keyboard.up(key);
    await waitForCycles(page, 2);
    const released = (await textHook(page)).egoX;
    await waitForCycles(page, 3);
    expect((await textHook(page)).egoX).toBe(released);
  });
}

for (const key of ["Enter", "Space"]) {
  test(`focused touch arrow ${key} activation toggles walking exactly once`, async ({ page }) => {
    await boot(page);
    const east = page
      .getByTestId("touch-controls")
      .getByRole("button", { name: "Walk east", exact: true });
    await east.evaluate((button) => {
      button.setAttribute("data-native-clicks", "0");
      button.addEventListener("click", () => {
        button.setAttribute(
          "data-native-clicks",
          String(Number(button.getAttribute("data-native-clicks")) + 1),
        );
      });
    });
    await east.focus();
    await page.keyboard.down(key);
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
    await page.keyboard.up(key);
    await waitForCycles(page, 2);
    const released = (await textHook(page)).egoX;
    await waitForCycles(page, 3);
    expect((await textHook(page)).egoX).toBeGreaterThan(released);
    await page.keyboard.press(key);
    await waitForCycles(page, 2);
    const stopped = (await textHook(page)).egoX;
    await waitForCycles(page, 3);
    expect((await textHook(page)).egoX).toBe(stopped);
    await test.info().attach("native-button-click-count", {
      body: (await east.getAttribute("data-native-clicks")) ?? "missing",
      contentType: "text/plain",
    });
  });
}

test("assistive click holds movement until repeated activation or blur", async ({ page }) => {
  await boot(page, true);
  const east = page
    .getByTestId("touch-controls")
    .getByRole("button", { name: "Walk east", exact: true });
  await east.dispatchEvent("click", { detail: 0 });
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
  await expect(east).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("touch-controls")).toContainText(
    "Activate this arrow again to stop.",
  );
  await page.screenshot({ path: test.info().outputPath("assistive-hold-active.png") });
  const moving = (await textHook(page)).egoX;
  await waitForCycles(page, 3);
  expect((await textHook(page)).egoX).toBeGreaterThan(moving);
  await east.dispatchEvent("click", { detail: 0 });
  await expect(east).toHaveAttribute("aria-pressed", "false");
  await waitForCycles(page, 2);
  const released = (await textHook(page)).egoX;
  await waitForCycles(page, 3);
  expect((await textHook(page)).egoX).toBe(released);
  await east.dispatchEvent("click", { detail: 0 });
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(released);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(east).toHaveAttribute("aria-pressed", "false");
  await waitForCycles(page, 2);
  const blurred = (await textHook(page)).egoX;
  await waitForCycles(page, 3);
  expect((await textHook(page)).egoX).toBe(blurred);
});

test("touch letter modifiers dispatch the game's Ctrl and Alt bindings", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByLabel("Key modifier").selectOption("ctrl");
  await pad.getByRole("button", { name: "Ctrl+A", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("CTRL A");
  await pad.getByLabel("Key modifier").selectOption("alt");
  await pad.getByRole("button", { name: "Alt+A", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("ALT A");
});

test("native phone typing honors a printable set.key binding", async ({ page }) => {
  await boot(page);
  const input = page.getByTestId("input-line");
  await input.fill("x");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("RAW X shortcut");
  await expect(input).toHaveValue("");
});

test("native phone text delivers both characters across blocking key waits", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F10", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
  await page.getByTestId("input-line").fill("ab");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("TWO KEYS");
});

test("physical Ctrl keys reach raw graphics input", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "z", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("RAW GRAPHICS");
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("Control+c");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("RAW CTRL C");
});

test("cancelling a native save description leaves the slot empty", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F7", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("save");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("Describe this saved game:");
  const blankEditor = await page.getByTestId("game-canvas").evaluate((canvas) => {
    const pixels = (canvas as HTMLCanvasElement)
      .getContext("2d")!
      .getImageData(16, 24, 112, 8).data;
    return Array.from(pixels).filter((value, index) => index % 4 === 0 && value === 0).length;
  });
  await page.getByTestId("input-line").fill("Cancelled name");
  await expect
    .poll(async () =>
      page.getByTestId("game-canvas").evaluate((canvas) => {
        const pixels = (canvas as HTMLCanvasElement)
          .getContext("2d")!
          .getImageData(16, 24, 112, 8).data;
        if (!Array.from(pixels).every((value) => value === 0 || value === 255)) return -1;
        return Array.from(pixels).filter((value, index) => index % 4 === 0 && value === 0).length;
      }),
    )
    .toBeGreaterThan(blankEditor);
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("Describe this saved game:");
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await pad.getByRole("button", { name: "F8", exact: true }).tap();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("No saved games for this game.");
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
});

test("touch inventory selects and cancels, and save restores carried items and variables", async ({
  page,
}) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F7", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("save");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("Before change");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Save in slot 1?");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await pad.getByRole("button", { name: "F9", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("State: 99");
  await pad.getByRole("button", { name: "F7", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("save");
  await pad.getByRole("button", { name: "Navigate south", exact: true }).tap();
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("After change");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Save in slot 2?");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await pad.getByRole("button", { name: "F8", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("restore");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Before change");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("After change");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("State: 17");
  await pad.getByRole("button", { name: "F6", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("inventory");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("lamp");
  await pad.getByRole("button", { name: "Navigate south", exact: true }).tap();
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Item: 1");
  await pad.getByRole("button", { name: "F6", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("inventory");
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Item: 255");
  await pad.getByRole("button", { name: "F8", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("restore");
  await pad.getByRole("button", { name: "Navigate south", exact: true }).tap();
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("State: 99");
});

test("touch keys navigate game menus and preserve raw text-screen answers", async ({ page }) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F3", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("menu");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await pad.getByRole("button", { name: "F4", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await pad.getByRole("button", { name: "Esc", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Window closed");
  await pad.getByRole("button", { name: "F5", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
  await page.getByTestId("input-line").fill("y");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("RAW Y");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(pad.getByRole("button", { name: "Enter", exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("phone-landscape.png") });
});

for (const replacement of [false, true]) {
  test(`native raw-key ${replacement ? "replacement" : "answer"} preserves the unfinished parser draft`, async ({
    page,
  }) => {
    await boot(page, false, undefined, true);
    const input = page.getByTestId("input-line");
    await input.fill("look");
    await waitForCycles(page, 2);
    await page.keyboard.press("F5");
    await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
    await input.focus();
    if (replacement) await input.selectText();
    await page.keyboard.insertText(replacement ? "l" : "y");
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "))
      .toContain(`First key: ${replacement ? 108 : 121}`);
    await expect(input).toHaveValue("look");
    await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("look");
  });
}

for (const completion of ["touch Enter", "touch Esc", "native form submit"] as const) {
  test(`${completion} preserves the parser draft after a prompt`, async ({ page }) => {
    await boot(page);
    const input = page.getByTestId("input-line");
    await input.fill("look");
    await waitForCycles(page, 2);
    await page.keyboard.press("F1");
    await expect(page.getByTestId("prompt-hint")).toBeVisible();
    await input.fill("Rosella");
    if (completion === "native form submit") {
      await input.evaluate((element) => (element as HTMLInputElement).form!.requestSubmit());
    } else {
      const pad = page.getByTestId("touch-controls");
      await pad
        .getByRole("button", { name: completion === "touch Enter" ? "Enter" : "Esc", exact: true })
        .tap();
    }
    await expect(page.getByTestId("prompt-hint")).toBeHidden();
    await expect(input).toHaveValue("look");
    await input.focus();
    await input.evaluate((element) => {
      const field = element as HTMLInputElement;
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await page.keyboard.insertText(" around");
    await expect(input).toHaveValue("look around");
    await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("look around");
  });
}

for (const consumer of [
  "text screen",
  "blocking key wait",
  "print modal",
  "disabled parser",
  "mapped Enter",
] as const) {
  test(`native form Enter reaches ${consumer} and preserves the parser draft`, async ({ page }) => {
    await boot(
      page,
      false,
      undefined,
      consumer === "blocking key wait",
      consumer === "mapped Enter" ? "mapped" : true,
    );
    const input = page.getByTestId("input-line");
    await input.fill("look");
    await waitForCycles(page, 2);
    if (consumer !== "mapped Enter") {
      await page.keyboard.press(
        consumer === "print modal" ? "F4" : consumer === "disabled parser" ? "z" : "F5",
      );
    }
    if (consumer === "print modal") {
      await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    } else if (consumer === "disabled parser") {
      await expect
        .poll(async () => (await textHook(page)).rows.join(" "))
        .toContain("RAW GRAPHICS");
    } else if (consumer !== "mapped Enter") {
      await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
      if (consumer === "text screen") await waitForCycles(page, 2);
    }
    await input.evaluate((element) => (element as HTMLInputElement).form!.requestSubmit());
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "))
      .toContain(
        consumer === "print modal"
          ? "Window closed"
          : consumer === "mapped Enter"
            ? "MAPPED ENTER"
            : "RAW ENTER",
      );
    if (consumer === "blocking key wait") {
      await expect
        .poll(async () => (await textHook(page)).rows.join(" "))
        .toContain("First key: 13");
    }
    await expect(input).toHaveValue("look");
    await input.focus();
    await input.evaluate((element) => {
      const field = element as HTMLInputElement;
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await page.keyboard.insertText(" around");
    await expect(input).toHaveValue("look around");
    await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("look around");
    if (consumer === "text screen") {
      await input.evaluate((element) => (element as HTMLInputElement).form!.requestSubmit());
      await expect(input).toHaveValue("");
      await expect
        .poll(async () => (await textHook(page)).rows.join(" "))
        .toContain("PARSER SUBMITTED");
    }
  });
}

test("a text-screen string prompt shows answer instructions and accepts touch input", async ({
  page,
}) => {
  await boot(page);
  const pad = page.getByTestId("touch-controls");
  await pad.getByText("Keys", { exact: true }).tap();
  await pad.getByRole("button", { name: "F5", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
  await pad.getByRole("button", { name: "F1", exact: true }).tap();
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await expect(page.getByTestId("text-mode-hint")).toBeHidden();
  await page.getByTestId("input-line").fill("Player");
  await pad.getByRole("button", { name: "Enter", exact: true }).tap();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Name: Player");
  await page.screenshot({ path: test.info().outputPath("text-screen-answer.png") });
});
