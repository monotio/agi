import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { customizedLegacyBoot } from "../../test/released-template-fixtures.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { testProjectId } from "../test/identity.ts";
import { unstampedArchive } from "../test/unstampedArchive.ts";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";
import { expect, test } from "./test.ts";

for (const kind of ["public", "private"] as const)
  for (const stamp of ["released", "version-0"] as const)
    test(`${kind} ${stamp} legacy game imports through its busy opening and plays`, async ({
      page,
    }) => {
      const compiled = compileProjectDocuments({
        files: Object.fromEntries(createContainer().files),
        documents: {
          "logic:0": customizedLegacyBoot,
          "logic:1": `if (isset(f5)) { load.pic(1); draw.pic(1); load.view(1); ${"add.to.pic(1,0,0,0,0,9,0);".repeat(12)} show.pic(); } return;`,
          "picture:1": "vis 1\nfill 0,0\nend",
          "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
          words: JSON.stringify([["known", 1]]),
          inventory: "[]",
        },
        profileId: "2.936",
      });
      const data = {
        projectId: testProjectId("busy-legacy"),
        authoredAt: new Date(0).toISOString(),
        title: "Busy legacy",
        files: Object.fromEntries(compiled.files()),
        words: [] as [string, number][],
        provider: "stub",
        model: "stub",
        transcript: [{ role: "user", content: "Private creator notes" }],
      };
      const zip = kind === "public" ? buildPublicGameZip(data) : await buildProjectZip(data);
      await isolateStorage(page);
      await page.goto("/");
      await page.getByTestId("game-zip-input").setInputFiles({
        name: "busy-legacy.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(stamp === "released" ? unstampedArchive(zip) : zip),
      });
      const card = savedGameCard(page, data.title);
      await expect(card.getByTestId("btn-resume-cached")).toBeEnabled();
      await expect(card.getByTestId("library-thumbnail")).toHaveAttribute(
        "src",
        /^data:image\/png/,
      );
      await expect(page.getByTestId("game-zip-error")).toBeHidden();
      await card.getByTestId("btn-resume-cached").click();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect
        .poll(() =>
          page
            .getByTestId("game-canvas")
            .evaluate((canvas: HTMLCanvasElement) =>
              Array.from(canvas.getContext("2d")!.getImageData(100, 50, 1, 1).data),
            ),
        )
        .toEqual([0, 0, 170, 255]);
      await page.screenshot({ path: test.info().outputPath("busy-legacy-playing.png") });
    });

test("a raw import rechecks its opening if another tab removes the matched legacy edition", async ({
  page,
}) => {
  const { readGameZip } = await import("../src/archive/gameZip.ts");
  const { buildZip } = await import("../src/archive/zip.ts");
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: {
      "logic:0": 'display(5,2,"Edition changed"); return;',
      words: "[]",
      inventory: "[]",
    },
    profileId: "2.936",
  });
  const zip = buildPublicGameZip({
    title: "Edition changed",
    files: Object.fromEntries(compiled.files()),
    authoringConventions: { version: 0, legacyRoomMemory: true },
  });
  const opened = await readGameZip(zip);
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "legacy.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  const card = savedGameCard(page, "Edition changed");
  await expect(card.getByTestId("btn-resume-cached")).toBeEnabled();
  const projectId = (await card.getAttribute("data-project-id"))!;
  await page.evaluate((id) => {
    const state = { previews: 0, removed: false };
    Object.assign(window, { importRace: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes("preview.worker")) return;
        state.previews++;
        this.addEventListener("message", (event: MessageEvent) => {
          if (state.removed) return;
          event.stopImmediatePropagation();
          state.removed = true;
          // The inspection finished against the old edition; remove it before
          // the importing page receives the result and reaches publication.
          void import("/src/project/gameStorage.ts").then(async ({ clearCachedGame }) => {
            await clearCachedGame(id);
            this.dispatchEvent(new MessageEvent("message", { data: event.data }));
          });
        });
      }
    };
  }, projectId);
  const raw = buildZip(Object.entries(opened.files).map(([name, data]) => ({ name, data })));
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "current.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(raw),
  });
  await expect(page.getByTestId("game-import-ready")).toContainText(
    "current added to your library",
  );
  const current = savedGameCard(page, "current");
  await expect(current.getByTestId("btn-resume-cached")).toBeEnabled();
  expect(
    await page.evaluate(async () => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      const id = document
        .querySelector('[data-testid^="saved-game-card-"]')!
        .getAttribute("data-project-id")!;
      return {
        ...(window as unknown as { importRace: { previews: number; removed: boolean } }).importRace,
        conventions: (await loadAuthoredGame(id))!.authoringConventions,
      };
    }),
  ).toEqual({ previews: 2, removed: true, conventions: { version: 1 } });
});
