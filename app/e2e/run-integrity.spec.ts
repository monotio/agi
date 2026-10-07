import { test, expect } from "./test.ts";
import { cacheGame, enterCreateMode, screenText, textHook } from "./engineProbe.ts";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

test("return from Create refuses changed parked LOGIC and Restart starts current files @webkit-desktop", async ({
  page,
}) => {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource("logic", 0, logic("if(equaln(v0,0)){new.room(1);}call.v(v0);return;"));
  game.putResource(
    "logic",
    1,
    logic(
      'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}increment(v80);print("Original moment");return;',
    ),
  );
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("run-integrity"),
    title: "Run integrity",
    provider: "stub",
    model: "offline-stub",
    files: Object.fromEntries(game.files),
    words: [],
    roomGeneration: false,
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(() => screenText(page)).toContain("Original moment");
  await enterCreateMode(page);
  await expect(page.getByTestId("part-room:1:logic")).toBeVisible();
  const updated = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return session.update([
      {
        key: "logic:1",
        content:
          'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}increment(v80);print("Changed moment");return;',
      },
    ]);
  });
  expect(updated.status, JSON.stringify(updated)).toBe("committed");
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const notice = page.getByTestId("return-notice");
  await expect(notice).toContainText("LOGIC 1 changed");
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect((await textHook(page)).room).toBe(1);
  await page.screenshot({ path: test.info().outputPath("return-refused.png") });
  await notice.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByRole("radio", { name: "Play", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect.poll(() => screenText(page)).toContain("Changed moment");
});
