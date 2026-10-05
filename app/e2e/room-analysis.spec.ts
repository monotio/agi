import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { cacheGame, enterCreateMode, openWorldRoom } from "./engineProbe.ts";
import { testProjectId } from "../test/identity.ts";

test.use({ headless: true });

/** A room dispatch like classic games, with two rooms reached through shared exits. */
function mapGame() {
  const game = createContainer();
  const sources: [number, string][] = [
    [0, "if(v0==0){new.room(1);}assignn(v76,0);call.v(v0);if(v76>0){new.room.v(v76);}return;"],
    [
      1,
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();accept.input();}if(v2==2){assignn(v76,2);}return;",
    ],
    [2, "if(isset(f5)){position(0,10,20);}if(v2==4){assignn(v76,1);}call(9);return;"],
    [9, "if(isset(f6)){assignn(v60,3);new.room.v(v60);}return;"],
    [3, "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}return;"],
    [4, "if(isset(f5)){load.pic(v0);draw.pic(v0);}new.room.v(v61);return;"],
  ];
  for (const [num, source] of sources)
    game.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);
  for (const num of [1, 3, 4])
    game.putResource("picture", num, Uint8Array.of(0xf0, num, 0xf8, 0, 0, 0xff));
  return game;
}

test("the full map and ROOMS include shared and picture-free rooms @webkit-desktop", async ({
  page,
}) => {
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("room-analysis"),
    title: "Room paths",
    imported: true,
    files: Object.fromEntries(mapGame().files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId("world-map")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`room-map-${width}.png`) });
  }
  await openWorldRoom(page.getByTestId("world-map"), 4);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId("map-detail")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`room-detail-${width}.png`) });
  }
  await expect(page.getByTestId("map-computed-exit")).toBeVisible();
  await expect(page.getByTestId("map-computed-exit")).toContainText("Computed at runtime");
  await page.getByTestId("world-all-rooms").click();
  await expect(page.getByTestId("map-room-2")).toBeVisible();
  await expect(page.getByTestId("map-room-3")).toBeVisible();
  await expect(page.getByTestId("map-room-4")).toBeVisible();
  await expect(page.getByTestId("map-runtime-exits")).toBeVisible();
  await expect(page.getByTestId("map-runtime-exits")).toHaveText(
    "Some exits are worked out while you play.",
  );
  await page.getByTestId("map-close").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterCreateMode(page);
  for (const room of [1, 2, 3, 4]) {
    const row = page.getByTestId(`part-room:${room}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`ROOM ${room}`);
  }
  await expect(page.getByTestId("part-logic:9")).toBeVisible();
});

test("an incoming exit identifies ROOM 255 in the parts list", async ({ page }) => {
  const game = mapGame();
  game.putResource(
    "logic",
    1,
    assembleLogic(
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();accept.input();}if(isset(f7)){new.room(255);}return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("logic", 255, assembleLogic("return;", { dictionary: new Map() }).payload);
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("room-255"),
    title: "Room 255",
    imported: true,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await enterCreateMode(page);
  const room = page.getByTestId("part-room:255");
  await expect(room).toBeVisible();
  await expect(room).toContainText("ROOM 255");
});

test("a staged room answer preserves the selected room and graph viewport", async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = new Proxy(Worker, {
      construct(Target, args: ConstructorParameters<typeof Worker>) {
        const worker = new Target(...args);
        if (!String(args[0]).includes("roomAnalysis.worker")) return worker;
        Object.defineProperty(worker, "onmessage", {
          set(listener: (event: MessageEvent) => void) {
            worker.addEventListener("message", (event) => {
              if (event.data.phase === "resolved")
                (window as unknown as { releaseRoomScan: () => void }).releaseRoomScan = () =>
                  listener(event);
              else listener(event);
            });
          },
        });
        return worker;
      },
    });
  });
  const game = mapGame();
  game.putResource(
    "logic",
    0,
    assembleLogic("if(v0==0){new.room(1);}call(1);return;", { dictionary: new Map() }).payload,
  );
  game.putResource("logic", 4, assembleLogic("return;", { dictionary: new Map() }).payload);
  game.putResource(
    "logic",
    1,
    assembleLogic(
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();accept.input();}if(v2==4){assignn(v60,5);new.room.v(v60);}return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("logic", 5, assembleLogic("return;", { dictionary: new Map() }).payload);
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("staged-map"),
    title: "Room paths",
    imported: true,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  await expect(page.getByTestId("world-map")).toHaveAttribute("data-analysis", "literal");
  await openWorldRoom(page.getByTestId("world-map"), 1);
  const node = page.getByTestId("map-node-1");
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  expect(before).not.toBeNull();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { releaseRoomScan?: () => void }).releaseRoomScan,
      ),
    )
    .toBe("function");
  await page.evaluate(() =>
    (window as unknown as { releaseRoomScan: () => void }).releaseRoomScan(),
  );
  await expect(page.getByTestId("world-map")).toHaveAttribute("data-analysis", "resolved");
  await expect(page.getByTestId("map-runtime-exits")).not.toBeVisible();
  await expect(page.getByTestId("map-detail")).toBeVisible();
  await expect(page.getByTestId("map-detail")).toContainText("Room 1");
  await expect
    .poll(async () => {
      const after = await node.boundingBox();
      return after ? Math.abs(after.x - before!.x) + Math.abs(after.y - before!.y) : Infinity;
    })
    .toBeLessThan(2);
});
