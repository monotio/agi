import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { createProgressPreview } from "../src/saves/progressPreview.ts";
import { iigsFontFixture } from "../test/iigsFontFixture.ts";

test("two tabs importing different font editions cannot overwrite each other's game", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic('display(3,2,"Two font editions"); return;', { dictionary: new Map() }).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = Object.fromEntries(game.files);
  const preferred = `imported-${await gameRevision(files)}`;
  const preview = createProgressPreview({
    visual: new Uint8Array(160 * 168).fill(1),
    text: new Uint8Array(2000),
    picRow: 1,
  });
  const arrivals: (() => void)[] = [];
  const barrier = () =>
    new Promise<void>((resolve) => {
      arrivals.push(resolve);
      if (arrivals.length === 2) for (const release of arrivals) release();
    });
  for (const tab of [page, other]) {
    await tab.exposeFunction("fontImportPreflight", barrier);
    await tab.evaluate((id) => {
      const get = IDBObjectStore.prototype.get;
      let held = false;
      IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
        const request = Reflect.apply(get, this, [key]) as IDBRequest;
        if (!held && this.transaction.mode === "readonly" && key === id) {
          held = true;
          const transaction = this.transaction;
          // Both tabs finish reading the empty slot before either import may
          // allocate it. The transaction has completed; its callback only resolves
          // the captured read, so no database transaction is held across an await.
          transaction.addEventListener(
            "complete",
            (event) => {
              event.stopImmediatePropagation();
              const complete = transaction.oncomplete;
              const gate = (window as typeof window & { fontImportPreflight: () => Promise<void> })
                .fontImportPreflight;
              void gate().then(() => complete?.call(transaction, event));
            },
            { once: true },
          );
        }
        return request;
      };
    }, preferred);
  }
  const serialized = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, [...bytes]]),
  );
  const [withFont, withoutFont] = await Promise.all(
    [page, other].map((tab, index) =>
      tab.evaluate(
        async ({ files, font, preview, index }) => {
          const { addLibraryGame } = await import("/src/library/gameLibrary.ts");
          const bytes = Object.fromEntries(
            Object.entries(files).map(([name, values]) => [name, new Uint8Array(values)]),
          );
          if (index === 0) bytes["AGIFONT"] = new Uint8Array(font);
          return addLibraryGame(
            { files: bytes, words: [], profile: "iigs-1.014" },
            index === 0 ? "Player font edition" : "Fallback edition",
            "zip",
            { preview, status: "ready", message: "Opening checked.", profile: "iigs-1.014" },
          );
        },
        { files: serialized, font: [...iigsFontFixture()], preview, index },
      ),
    ),
  );
  expect(arrivals).toHaveLength(2);
  expect(withFont).not.toBe(withoutFont);
  const stored = await page.evaluate(
    async (ids) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      return Promise.all(
        ids.map(async (id) => {
          const game = await loadAuthoredGame(id);
          return {
            title: game?.title,
            font: game?.files["AGIFONT"] ? [...game.files["AGIFONT"]] : null,
          };
        }),
      );
    },
    [withFont!, withoutFont!],
  );
  expect(stored).toEqual([
    { title: "Player font edition", font: [...iigsFontFixture()] },
    { title: "Fallback edition", font: null },
  ]);
  await page.reload();
  await expect(page.getByTestId(`saved-game-card-${withFont}`)).toBeVisible();
  await expect(page.getByTestId(`saved-game-card-${withoutFont}`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("two-font-editions.png"), fullPage: true });
  await other.close();
});
