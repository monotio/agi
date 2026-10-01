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
import { detectProfile } from "../../src/runtime/profile.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

/** An independently authored 1x1 PNG source plus its exact canonical raster. */
function artFixture() {
  const encoded = encodePngRgb(1, 1, Uint8Array.of(0, 96, 255));
  const raster = Uint8Array.of(0, 96, 255, 255);
  return {
    encoded: [...encoded],
    raster: [...raster],
    source: {
      format: "agi.creative-source",
      version: 1,
      identity: { id: "blue-source", incarnation: "original", revision: 0 },
      encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
      availability: "original",
      normalized: {
        blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
        format: "rgba8-srgb-unpremultiplied-v1",
        width: 1,
        height: 1,
      },
      origin: { kind: "import", title: "Synthetic blue pixel" },
    },
  };
}

function gameFiles(): Record<string, number[]> {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('display(5, 2, "Work room"); return;', { dictionary: new Map() }).payload,
  );
  return Object.fromEntries(
    [...container.files, ["WORDS.TOK", buildWordsTok([])] as const].map(([name, bytes]) => [
      name,
      [...bytes],
    ]),
  );
}

/**
 * Seed a project holding ONLY durable unfinished work — a recovery draft
 * and a retained-undo hold, no Keep — through the real storage seams, then
 * private-export its ZIP. Everything runs inside the browser's IndexedDB.
 */
async function seedWorkProject(
  page: Page,
  art: ReturnType<typeof artFixture>,
  files: Record<string, number[]>,
  projectId: ProjectId,
  profileId: string,
) {
  return page.evaluate(
    async ({ art, files, projectId, profileId }) => {
      const storage = await import("/src/project/gameStorage.ts");
      const store = await import("/src/project/creativeStore.ts");
      const drafts = await import("/src/project/creativeDrafts.ts");
      const snap = await import("/src/project/creativeProjectSnapshot.ts");
      const archive = await import("/src/archive/projectArchive.ts");
      const data = {
        title: "Unfinished art project",
        provider: "stub",
        model: "stub",
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
        ),
        words: [],
      };
      const first = await storage.commitProject({
        projectId,
        commitId: "initial",
        workspaceId: "workspace",
        buildId: "a".repeat(64),
        expected: null,
        documents: [{ key: "logic:0", version: 1 }],
        data,
      } as never);
      const encoded = new Uint8Array(art.encoded);
      const raster = new Uint8Array(art.raster);
      await store.stageCreativeBlobs({
        projectId,
        expectedHead: 0,
        lease: { id: "lease-w", owner: "editor", workspace: "ws-work" },
        staged: { sources: [art.source], derivatives: [], recipes: [] },
        blobs: [
          { hash: art.source.encoded.hash, mime: "image/png", bytes: encoded },
          {
            hash: art.source.normalized.blob.hash,
            mime: "application/x-rgba8",
            bytes: raster,
          },
        ],
      } as never);
      const saved = first.receipt.saved;
      await drafts.saveCreativeDraft({
        projectId,
        workspaceId: "ws-work",
        expectedReceipt: null,
        expected: { generation: saved.generation, lifetime: saved.lifetime },
        authority: {
          kind: "lease",
          lease: { id: "lease-w", owner: "editor", workspace: "ws-work" },
        },
        recovery: {
          base: {
            revision: saved.revision,
            authoring: saved.authoring,
            profileId,
            kept: 0,
            pins: [],
          },
          sources: [art.source],
          derivatives: [],
          board: [],
          recipes: [],
          drafts: [
            {
              identity: { id: "draft-ws-work", incarnation: "inc", revision: 0 },
              sources: [art.source.identity],
              notes: "unfinished shading pass",
            },
          ],
        },
      } as never);
      // A retained-undo hold pins the source bytes as bare inventory.
      await store.holdCreativeBlobs({
        projectId,
        hold: { id: "undo-e2e", kind: "retained-undo", hashes: [art.source.encoded.hash] },
      } as never);
      const snapshot = await snap.captureCreativeProject(projectId);
      if (!snapshot?.work) throw new Error("seeded project did not capture its durable work");
      const zip = await archive.buildProjectZip(
        snapshot.data,
        undefined,
        undefined,
        undefined,
        undefined,
        snapshot,
      );
      return { projectId, zip: [...zip] };
    },
    { art, files, projectId, profileId },
  );
}

/** The durable work the live library stores for a project, read through the real draft service. */
async function storedWork(page: Page, projectId: ProjectId) {
  return page.evaluate(async (projectId) => {
    const drafts = await import("/src/project/creativeDrafts.ts");
    const snap = await import("/src/project/creativeProjectSnapshot.ts");
    const listed = await drafts.listCreativeDrafts(projectId);
    const snapshot = await snap.captureCreativeProject(projectId);
    const read = listed.length
      ? await drafts.readCreativeDraft(projectId, listed[0]!.workspaceId)
      : null;
    return {
      listed: listed.map((row) => ({ workspaceId: row.workspaceId, status: row.status })),
      notes: read?.recovery.drafts[0]?.notes ?? null,
      retained: snapshot?.work?.retained.map((inventory) => [...inventory]) ?? null,
      workBlobs: Object.fromEntries(
        Object.entries(snapshot?.workBlobs ?? {}).map(([hash, bytes]) => [hash, [...bytes]]),
      ),
    };
  }, projectId);
}

test("durable creative work survives download, import, copy and reload with no provider @webkit-desktop", async ({
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
  const profileId = detectProfile(
    new Map(Object.entries(gameFiles()).map(([name, bytes]) => [name, new Uint8Array(bytes)])),
  ).id;
  const seeded = await seedWorkProject(
    page,
    art,
    files,
    requireProjectId("project-work-e2e"),
    profileId,
  );

  // A cold reload proves the recovery row and held bytes are durable.
  await page.reload();
  const card = savedGameCard(page, "Unfinished art project");
  await expect(card).toBeVisible();
  const cold = await storedWork(page, seeded.projectId);
  expect(cold?.listed).toEqual([{ workspaceId: "ws-work", status: "current" }]);
  expect(cold?.notes).toBe("unfinished shading pass");
  expect(cold?.retained).toEqual([[art.source.encoded.hash]]);
  expect(cold?.workBlobs).toEqual({
    [art.source.encoded.hash]: art.encoded,
    [art.source.normalized.blob.hash]: art.raster,
  });

  // The private download parses to the same work envelope and exact bytes.
  await openLibraryActions(page, card);
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-library-game").click();
  const opened = await readGameZip(
    new Uint8Array(await readFile((await (await downloadPromise).path())!)),
  );
  expect(opened.project?.creative).toBeUndefined();
  const work = opened.project?.creativeWork;
  expect(work?.work.drafts.map((draft) => draft.workspace)).toEqual(["ws-work"]);
  expect(work?.work.drafts[0]?.status).toBe("current");
  expect(work?.work.retained).toEqual([[art.source.encoded.hash]]);
  expect(
    Object.fromEntries(Object.entries(work?.blobs ?? {}).map(([h, b]) => [h, [...b]])),
  ).toEqual({
    [art.source.encoded.hash]: art.encoded,
    [art.source.normalized.blob.hash]: art.raster,
  });

  // The public export never carries the work envelope or its bytes.
  await openLibraryActions(page, card);
  const gameDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-library-game").click();
  const gameZip = await readGameZip(
    new Uint8Array(await readFile((await (await gameDownloadPromise).path())!)),
  );
  expect(gameZip.project).toBeUndefined();
  expect(Object.keys(gameZip.files).some((name) => name.startsWith("CREATIVE/"))).toBe(false);

  // Copy through the real library action: fresh authority, same work.
  await openLibraryActions(page, card);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Unfinished art project Remix");
  await expect(remix).toBeVisible();
  const copyId = requireProjectId((await remix.getAttribute("data-project-id"))!);
  const copied = await storedWork(page, copyId);
  expect(copied?.listed).toEqual([{ workspaceId: "ws-work", status: "current" }]);
  expect(copied?.notes).toBe("unfinished shading pass");
  expect(copied?.retained).toEqual([[art.source.encoded.hash]]);
  expect(copied?.workBlobs).toEqual(cold?.workBlobs);

  // Import the downloaded ZIP through the real Add game path; the work
  // republishes as fresh target-local rows and holds, then survives reload.
  const knownIds: string[] = [seeded.projectId, copyId];
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "agi-unfinished-art-project.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(seeded.zip),
  });
  await expect(page.locator("[data-project-id]")).toHaveCount(3);
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
  const imported = await storedWork(page, requireProjectId(importedId));
  expect(imported?.listed).toEqual([{ workspaceId: "ws-work", status: "current" }]);
  expect(imported?.notes).toBe("unfinished shading pass");
  expect(imported?.workBlobs).toEqual(cold?.workBlobs);
  await page.reload();
  const afterReload = await storedWork(page, requireProjectId(importedId));
  expect(afterReload?.listed).toEqual([{ workspaceId: "ws-work", status: "current" }]);
  expect(afterReload?.workBlobs).toEqual(cold?.workBlobs);
  expect(providerCalls).toBe(0);
});
