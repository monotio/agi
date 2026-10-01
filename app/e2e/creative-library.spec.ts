import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { sha256Hex } from "../../src/crypto.ts";
import { requireProjectId, type ProjectId } from "../../src/gameIdentity.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { isolateStorage, openLibraryActions, savedGameCard, waitForFrames } from "./engineProbe.ts";

/** An independently authored 1x1 PNG source plus its exact canonical raster. */
function artFixture() {
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  return {
    encoded: [...encoded],
    raster: [...raster],
    source: {
      format: "agi.creative-source",
      version: 1,
      identity: { id: "red-source", incarnation: "original", revision: 0 },
      encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
      availability: "original",
      normalized: {
        blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
        format: "rgba8-srgb-unpremultiplied-v1",
        width: 1,
        height: 1,
      },
      origin: { kind: "import", title: "Synthetic red pixel" },
    },
  };
}

function gameFiles(): Record<string, number[]> {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('display(5, 2, "Art room"); return;', { dictionary: new Map() }).payload,
  );
  return Object.fromEntries(
    [...container.files, ["WORDS.TOK", buildWordsTok([])] as const].map(([name, bytes]) => [
      name,
      [...bytes],
    ]),
  );
}

/**
 * Seed a kept creative project through the real storage seams — durable
 * commit, staged blobs, a Keep and a coherent capture — then private-export
 * its ZIP. Everything runs inside the browser's real IndexedDB.
 */
async function seedKeptProject(
  page: Page,
  art: ReturnType<typeof artFixture>,
  files: Record<string, number[]>,
  projectId: ProjectId,
) {
  return page.evaluate(
    async ({ art, files, projectId }) => {
      const storage = await import("/src/project/gameStorage.ts");
      const store = await import("/src/project/creativeStore.ts");
      const snap = await import("/src/project/creativeProjectSnapshot.ts");
      const archive = await import("/src/archive/projectArchive.ts");
      const data = {
        title: "Synthetic art project",
        provider: "stub",
        model: "stub",
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
        ),
        words: [],
      };
      const request = {
        projectId,
        commitId: "initial",
        workspaceId: "workspace",
        buildId: "a".repeat(64),
        expected: null,
        documents: [{ key: "logic:0", version: 1 }],
        data,
      };
      const first = await storage.commitProject(request as never);
      const encoded = new Uint8Array(art.encoded);
      const raster = new Uint8Array(art.raster);
      const staged = await store.stageCreativeBlobs({
        projectId,
        expectedHead: 0,
        lease: { id: "art", owner: "editor", workspace: "workspace" },
        staged: { sources: [art.source] },
        blobs: [
          { hash: art.source.encoded.hash, mime: "image/png", bytes: encoded },
          {
            hash: art.source.normalized.blob.hash,
            mime: "application/x-rgba8",
            bytes: raster,
          },
        ],
      });
      await storage.commitProject({
        ...request,
        commitId: "keep-art",
        expected: first.receipt.saved,
        creative: {
          expectedHead: staged.head,
          asOf: Date.now(),
          lease: { id: "art", owner: "editor", workspace: "workspace" },
          keep: {
            sources: [art.source.identity],
            derivatives: [],
            recipes: [],
            board: [],
          },
        },
      } as never);
      const snapshot = await snap.captureCreativeProject(projectId);
      if (!snapshot) throw new Error("seeded project did not capture its kept art");
      const zip = await archive.buildProjectZip(
        snapshot.data,
        undefined,
        undefined,
        undefined,
        undefined,
        snapshot,
      );
      return { projectId, zip: [...zip], manifest: snapshot.manifest };
    },
    { art, files, projectId },
  );
}

/** Read back what the live library stores for a project: the captured manifest plus blob hex/bytes. */
async function storedArt(page: Page, projectId: ProjectId) {
  return page.evaluate(async (projectId) => {
    const snap = await import("/src/project/creativeProjectSnapshot.ts");
    const snapshot = await snap.captureCreativeProject(projectId);
    if (!snapshot) return null;
    return {
      manifest: snapshot.manifest,
      blobs: Object.fromEntries(
        Object.entries(snapshot.blobs).map(([hash, bytes]) => [hash, [...bytes]]),
      ),
    };
  }, projectId);
}

test("private project archives keep creative assets through import, copy, download and reload @webkit-desktop", async ({
  page,
}) => {
  let providerCalls = 0;
  await page.route("**/api/**", (route) => {
    providerCalls++;
    return route.abort();
  });
  const art = artFixture();
  const files = gameFiles();
  await isolateStorage(page);
  await page.goto("/");
  const seeded = await seedKeptProject(page, art, files, requireProjectId("project-creative-e2e"));

  // A cold reload proves the seeded catalog and blobs are durable storage,
  // not incidental cache.
  await page.reload();
  const card = savedGameCard(page, "Synthetic art project");
  await expect(card).toBeVisible();
  const cold = await storedArt(page, seeded.projectId);
  expect(cold?.manifest).toEqual(seeded.manifest);
  expect(cold?.blobs).toEqual(
    Object.fromEntries(
      [art.source.encoded.hash, art.source.normalized.blob.hash].map((hash) => [
        hash,
        hash === art.source.encoded.hash ? art.encoded : art.raster,
      ]),
    ),
  );

  // The real copy action produces an independently readable kept catalog.
  await openLibraryActions(page, card);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Synthetic art project Remix");
  await expect(remix).toBeVisible();
  const copyId = requireProjectId((await remix.getAttribute("data-project-id"))!);
  expect(copyId).not.toBe(seeded.projectId);
  const copied = await storedArt(page, copyId);
  expect(copied?.manifest).toEqual(seeded.manifest);
  expect(copied?.blobs).toEqual(cold?.blobs);

  // Downloading the project writes the actual ZIP: creative manifest and
  // exact blob entries, verified by parsing the downloaded file itself.
  await openLibraryActions(page, card);
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-library-game").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-project\.zip$/);
  const opened = await readGameZip(new Uint8Array(await readFile((await download.path())!)));
  expect(opened.project?.creative?.manifest).toEqual(seeded.manifest);
  expect(
    Object.fromEntries(
      Object.entries(opened.project?.creative?.blobs ?? {}).map(([hash, bytes]) => [
        hash,
        [...bytes],
      ]),
    ),
  ).toEqual(cold?.blobs);

  // The public export stays art-free: no creative context, no binary entries.
  await openLibraryActions(page, card);
  const gameDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-library-game").click();
  const gameZip = await readGameZip(
    new Uint8Array(await readFile((await (await gameDownloadPromise).path())!)),
  );
  expect(gameZip.project).toBeUndefined();
  expect(Object.keys(gameZip.files).some((name) => name.startsWith("CREATIVE/"))).toBe(false);

  // Importing the downloaded private ZIP through the real Add game path
  // publishes its declared creative assets durably. The import keeps its
  // own title, so the card is picked by project identity, not name.
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "agi-synthetic-art-project.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(seeded.zip),
  });
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(3);
  const knownIds: string[] = [seeded.projectId, copyId];
  const importedId = (await page
    .locator("[data-project-id]")
    .evaluateAll(
      (cards, known) =>
        cards
          .map((card) => card.getAttribute("data-project-id"))
          .find((id) => id !== null && !known.includes(id)),
      knownIds,
    ))!;
  expect(importedId).toBeTruthy();
  const importedArt = await storedArt(page, requireProjectId(importedId));
  expect(importedArt?.manifest).toEqual(seeded.manifest);
  expect(importedArt?.blobs).toEqual(cold?.blobs);

  // Removing one creative project leaves the copy's catalog readable.
  await page.evaluate(async (id) => {
    const storage = await import("/src/project/gameStorage.ts");
    await storage.clearCachedGame(id);
  }, seeded.projectId);
  const surviving = await storedArt(page, copyId);
  expect(surviving?.manifest).toEqual(seeded.manifest);
  expect(providerCalls).toBe(0);
});

/**
 * The modules a creative action loads on demand — coherent capture,
 * publication, archive preparation and the authoring removal codec a
 * commit consults. A Home shelf and a bundled Play frame never need them;
 * the dev server answers each dynamic import with a real request, so the
 * request log is the startup graph. `projectBuild.ts` is intentionally
 * absent: the dev-mode module worker fetches it through `debugController`
 * on boot — the production worker asset the worker budget measures — which
 * is unrelated to the main-thread creative boundary.
 */
const LAZY_CREATIVE_MODULES = [
  "creativeProjectSnapshot.ts",
  "creativeProjectPublication.ts",
  "projectArchiveWriter.ts",
  "projectRemoval.ts",
  "projectDocuments.ts",
  "projectReferences.ts",
  "projectSourceDependencies.ts",
];

/**
 * The archive reader chain and creative codecs: game ZIP reading, project
 * context recovery and the catalog/project codecs. Listing a shelf needs
 * none of them; a file/folder import or export loads them on the action.
 * `projectArchiveShared.ts`/`projectConversation.ts` stay eagerly loaded —
 * the entry composables' transcript check uses them — and
 * `gameZipLimits.ts` is a constant module.
 */
const LAZY_READER_MODULES = [
  "archive/gameZip.ts",
  "archive/projectArchive.ts",
  "creative/catalog.ts",
  "creative/project.ts",
];

test("bundled Play fetches no creative preparation modules; copy, export, import and reload preserve exact art @webkit-desktop", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(".ts")) requested.push(request.url());
  });
  const fetchedLazy = (since = 0) =>
    requested
      .slice(since)
      .filter((url) => LAZY_CREATIVE_MODULES.some((name) => url.includes(name)));
  const fetchedReaders = (since = 0) =>
    requested.slice(since).filter((url) => LAZY_READER_MODULES.some((name) => url.includes(name)));

  // A no-key Home → bundled game first frame never touches the optional
  // creative implementation, the archive reader chain or its codecs.
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForFrames(page, 1);
  expect(fetchedLazy()).toEqual([]);
  expect(fetchedReaders()).toEqual([]);
  await page.getByTestId("btn-exit").click();

  // A kept-art project seeded through the real storage seams survives a
  // cold reload; the shelf that shows its card still fetches none of the
  // optional modules or the reader chain merely to list games.
  const art = artFixture();
  const files = gameFiles();
  const seeded = await seedKeptProject(page, art, files, requireProjectId("project-creative-e2e"));
  const expectedBlobs = Object.fromEntries(
    [art.source.encoded.hash, art.source.normalized.blob.hash].map((hash) => [
      hash,
      hash === art.source.encoded.hash ? art.encoded : art.raster,
    ]),
  );
  await page.reload();
  const fresh = requested.length;
  const card = savedGameCard(page, "Synthetic art project");
  await expect(card).toBeVisible();
  expect(fetchedLazy(fresh)).toEqual([]);
  expect(fetchedReaders(fresh)).toEqual([]);

  // The copy action fetches the capture, publication and archive
  // preparation modules on demand and writes an independently readable
  // kept catalog with the exact canonical art.
  await openLibraryActions(page, card);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Synthetic art project Remix");
  await expect(remix).toBeVisible();
  for (const name of [
    "creativeProjectSnapshot.ts",
    "creativeProjectPublication.ts",
    "projectArchiveWriter.ts",
  ])
    expect(
      fetchedLazy(fresh).some((url) => url.includes(name)),
      `the copy action must fetch ${name}`,
    ).toBe(true);
  const copyId = requireProjectId((await remix.getAttribute("data-project-id"))!);
  const copied = await storedArt(page, copyId);
  expect(copied?.manifest).toEqual(seeded.manifest);
  expect(copied?.blobs).toEqual(expectedBlobs);

  // A private export carries the exact manifest and blob bytes; the writer
  // module was fetched by the first action that needed it.
  await openLibraryActions(page, card);
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-library-game").click();
  const opened = await readGameZip(
    new Uint8Array(await readFile((await (await downloadPromise).path())!)),
  );
  expect(opened.project?.creative?.manifest).toEqual(seeded.manifest);
  expect(
    Object.fromEntries(
      Object.entries(opened.project?.creative?.blobs ?? {}).map(([hash, bytes]) => [
        hash,
        [...bytes],
      ]),
    ),
  ).toEqual(expectedBlobs);

  // Importing that ZIP through the real Add game path fetches the game ZIP
  // reader on the action — it was not loaded before — and republishes the
  // same art; a cold reload proves the imported catalog is durable.
  const beforeImport = requested.length;
  const knownIds = (await page
    .locator("[data-project-id]")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-project-id")))) as string[];
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "agi-synthetic-art-project.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(seeded.zip),
  });
  await expect(page.locator("[data-project-id]")).toHaveCount(knownIds.length + 1);
  const importedId = (await page
    .locator("[data-project-id]")
    .evaluateAll(
      (cards, known) =>
        cards
          .map((card) => card.getAttribute("data-project-id"))
          .find((id) => id !== null && !known.includes(id)),
      knownIds,
    ))!;
  expect(
    fetchedReaders(beforeImport).some((url) => url.includes("archive/gameZip.ts")),
    "the file import action must fetch archive/gameZip.ts",
  ).toBe(true);
  const imported = await storedArt(page, requireProjectId(importedId));
  expect(imported?.manifest).toEqual(seeded.manifest);
  expect(imported?.blobs).toEqual(expectedBlobs);
  await page.reload();
  const cold = await storedArt(page, requireProjectId(importedId));
  expect(cold?.manifest).toEqual(seeded.manifest);
  expect(cold?.blobs).toEqual(expectedBlobs);
});
