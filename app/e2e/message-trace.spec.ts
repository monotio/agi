import { cacheGame } from "./engineProbe.ts";
import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildLogicResource } from "../../src/logic/resource.ts";
import { screenText, textHook } from "./engineProbe.ts";

test("timed messages resume promptly, persistent windows allow play, and Scroll Lock toggles trace", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 255));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if(!isset(f200)){
      set(f200);assignn(v60,0);load.pic(v60);draw.pic(v60);show.pic();
      trace.info(10,1,6);set(f10);trace.on();
      assignn(v10,255);assignn(v21,4);print("This message closes by itself.");
      assignn(v10,0);assignn(v21,0);set(f15);print("You can keep playing.");reset(f15);
      set.key(0,62,1);accept.input();
    }
    if(controller(1)){close.window();display(20,1,"Window closed by the game.");}
    increment(v200);return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  const names: (string | null)[] = Array(178).fill(null);
  names[0] = "increment";
  names[171] = "controller";
  game.putResource("logic", 10, buildLogicResource(Uint8Array.of(0), names));
  await page.goto("/");
  await cacheGame(page, {
    projectId: "message-trace",
    title: "Window and trace test",
    provider: "stub",
    model: "local-playback",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(() => screenText(page)).toContain("This message closes by itself.");
  expect((await textHook(page)).modal).toBe("print");
  await expect.poll(() => screenText(page), { timeout: 5000 }).toContain("You can keep playing.");
  expect((await textHook(page)).modal).toBeNull();
  await page.screenshot({ path: "test-results/persistent-message.png" });
  await page.keyboard.press("F4");
  await expect.poll(() => screenText(page)).toContain("Window closed by the game.");
  await expect.poll(() => screenText(page)).toContain("Trace");
  await expect.poll(() => screenText(page)).toContain("increment");
  await page.screenshot({ path: "test-results/trace-window.png" });
  await page.keyboard.press("ScrollLock");
  await expect.poll(() => screenText(page)).not.toContain("Trace");
  await expect.poll(() => screenText(page)).toContain("Window closed by the game.");
  await page.keyboard.press("ScrollLock");
  await expect.poll(() => screenText(page)).toContain("Trace");
  const controls = page.getByTestId("game-controls");
  await controls.locator("summary").click();
  await controls.getByRole("button", { name: "Hide trace Scroll Lock", exact: true }).click();
  await expect.poll(() => screenText(page)).not.toContain("Trace");
  await controls.locator("summary").click();
  await controls.getByRole("button", { name: "Show trace Scroll Lock", exact: true }).click();
  await expect.poll(() => screenText(page)).toContain("Trace");
});
