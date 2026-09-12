import { cacheGame, waitForCycles } from "./engineProbe.ts";
import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";

test.use({ headless: process.platform !== "darwin" });

test("split handle drag", async ({ page }) => {
  const game = createContainer();
  game.putResource(
    "picture",
    1,
    Uint8Array.of(0xf0, 3, 0xf8, 0, 0, 0xf2, 2, 0xf6, 0, 100, 159, 100, 0xff),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) { set(f200); new.room(1); } call.v(v0); return;`, {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "view",
    0,
    buildView({
      loops: [{ cels: [{ width: 8, height: 16, pixels: Array<number>(128).fill(12) }] }],
    }),
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) { assignn(v60,1); load.pic(v60); draw.pic(v60); show.pic(); load.view(0); animate.obj(o0); set.view(o0,0); position(o0,80,140); draw(o0); stop.cycling(o0); } return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: "split-probe",
    title: "x",
    provider: "stub",
    model: "local-playback",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await waitForCycles(page, 4);
  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  await page.getByTestId("dbg-mode-split").click();
  await page.keyboard.press("Escape");
  const handle = page.getByTestId("split-handle");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await handle.getAttribute("aria-valuenow")))
    .toBeGreaterThan(55);
});
