import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { configureAi, isolateStorage, textHook } from "./engineProbe.ts";
import { expect, keepDetectedProfile, test } from "./test.ts";

const ANSWER = "The well holds a silver key.";

test("an installed game's answer is back after its tab closes before the save commits @webkit-desktop", async ({
  page,
  context,
}) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("if(equaln(v0,0)){new.room(1);}call(1);return;", { dictionary: new Map() })
      .payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic("if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();accept.input();}return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const revision = await gameRevision(Object.fromEntries(game.files));
  await context.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/") return route.fulfill({ json: [{ folder: "sample", revision }] });
    if (path === "/fixtures/sample/") return route.fulfill({ json: [...game.files.keys()] });
    const bytes = game.files.get(path.split("/").at(-1)!);
    return route.fulfill(
      bytes
        ? { body: Buffer.from(bytes), contentType: "application/octet-stream" }
        : { status: 404 },
    );
  });
  await context.route("**/api/openai/v1/responses", (route) =>
    route.fulfill(
      providerReply("openai", {
        id: "answer",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: ANSWER }] },
        ],
      }),
    ),
  );
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("boot-sample").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("menu-assistant").click();
  const message = page.getByTestId("agent-message");
  await expect(message).toBeEnabled();
  // From here the conversation's IndexedDB write starts but never commits: its
  // transaction stays busy until the tab closes, which aborts it.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (String((value as { projectId?: unknown })?.projectId).startsWith("conversation/")) {
        Reflect.set(window, "conversationWriteHeld", true);
        const spin = () => {
          this.get("conversation-write-held").onsuccess = spin;
        };
        spin();
      }
      return request;
    };
  });
  await message.fill("Where is the key?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    (answer) =>
      Reflect.get(window, "conversationWriteHeld") === true &&
      Object.keys(localStorage).some((key) => localStorage.getItem(key)!.includes(answer)),
    ANSWER,
  );
  await page.close();

  const reopened = await context.newPage();
  await keepDetectedProfile(reopened);
  await reopened.goto("/");
  // Page close precedes the lock manager's cleanup; wait for the closed tab's ownership to end.
  await reopened.waitForFunction(async () =>
    ((await navigator.locks.query()).held ?? []).every(
      (lock) => !lock.name?.startsWith("monotio_agi.conversation-writes."),
    ),
  );
  await reopened.getByTestId("boot-sample").click();
  await expect.poll(async () => (await textHook(reopened)).room).toBe(1);
  await reopened.getByTestId("menu-assistant").click();
  const conversation = reopened.getByTestId("agent-conversation");
  await expect(conversation).toBeVisible();
  await expect(conversation).toContainText("Where is the key?");
  await expect(conversation).toContainText(ANSWER);
});
