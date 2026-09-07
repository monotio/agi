import { providerReply } from "../../test/provider-stream.ts";
import { configureAi, openGameOptions, savedGameCard } from "./engineProbe.ts";
import { test, expect } from "@playwright/test";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { readGameZip } from "../src/gameZip.ts";
import { readFile } from "node:fs/promises";
import { textHook, isolateStorage } from "./engineProbe.ts";

test("an installed-game remix survives immediate Menu, Resume, reload and project export", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("assignn(v10,1);if(equaln(v0,0)){new.room(1);}call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  const original =
    "if(isset(f5)){assignn(v60,1);load.pic(v60);draw.pic(v60);show.pic();accept.input();}return;";
  game.putResource("logic", 1, assembleLogic(original, { dictionary: new Map() }).payload);
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  let fixtureReads = 0;
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/") return route.fulfill({ json: ["sample"] });
    if (path === "/fixtures/sample/") return route.fulfill({ json: [...game.files.keys()] });
    fixtureReads++;
    const bytes = game.files.get(path.split("/").at(-1)!);
    return route.fulfill(
      bytes
        ? { body: Buffer.from(bytes), contentType: "application/octet-stream" }
        : { status: 404 },
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  let requests = 0;
  const sprite = { loops: [{ cels: [{ width: 3, height: 2, pixels: [4, 4, 4, 4, 0, 4] }] }] };
  const remixed =
    'if(isset(f5)){assignn(v60,1);load.pic(v60);draw.pic(v60);show.pic();load.view(11);animate.obj(13);set.view(13,11);position(13,30,130);draw(13);accept.input();}display(4,2,"ALLIGATOR REMIX");return;';
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    const calls = [
      ["write_view", { num: 11, spec: sprite }],
      ["write_logic_source", { room: 1, source: remixed }],
    ];
    await route.fulfill(
      providerReply("openai", {
        id: `response-${requests}`,
        output:
          requests === 1
            ? calls.map(([name, args], i) => ({
                type: "function_call",
                id: `item-${i}`,
                call_id: `call-${i}`,
                name,
                arguments: JSON.stringify(args),
              }))
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Ready." }],
                },
              ],
      }),
    );
  });
  await page.getByTestId("boot-sample").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("Add an alligator");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("ALLIGATOR REMIX");
  // Delay actual IndexedDB completion callbacks: Menu must await storage, not just the worker reply.
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      ...descriptor,
      set(this: IDBTransaction, handler: (event: Event) => void) {
        descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          setTimeout(() => handler.call(this, event), 250);
        });
      },
    });
  });
  await page.getByTestId("btn-eject").click();
  const card = savedGameCard(page, "SAMPLE Remix");
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  const record = await page.evaluate(() => {
    const slug = localStorage.getItem("monotio_agi.lastGame")!;
    return JSON.parse(localStorage.getItem("monotio_agi.autosave." + slug)!);
  });
  expect(record.game.installed).toBe(false);
  expect(record.game.slug).not.toBe("sample");
  const reads = fixtureReads;
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("ALLIGATOR REMIX");
  expect(fixtureReads).toBe(reads);
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"))).toBe(
    record.game.slug,
  );
  await page.reload();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("ALLIGATOR REMIX");
  expect(fixtureReads).toBe(reads);
  const pending = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-save-live-project").click();
  const download = await pending;
  const archive = await readGameZip(new Uint8Array(await readFile((await download.path())!)));
  expect(openContainer(new Map(Object.entries(archive.files))).getResource("view", 11)).toEqual(
    buildView(sprite),
  );
  expect(JSON.stringify(archive.project?.transcript)).toContain("Add an alligator");
  expect(archive.roomGeneration).toBe(false);
  expect(requests).toBe(2);
});
