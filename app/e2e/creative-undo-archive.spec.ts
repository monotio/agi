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
    assembleLogic('display(5, 2, "Undo room"); return;', { dictionary: new Map() }).payload,
  );
  return Object.fromEntries(
    [...container.files, ["WORDS.TOK", buildWordsTok([])] as const].map(([name, bytes]) => [
      name,
      [...bytes],
    ]),
  );
}

/**
 * Seed a project holding two retained snapshots of unfinished creative
 * preparation — no Keep — through the real storage seams, then private-export
 * its ZIP. Everything runs inside the browser's IndexedDB.
 */
async function seedSnapshotProject(
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
      const undos = await import("/src/project/creativeUndo.ts");
      const snap = await import("/src/project/creativeProjectSnapshot.ts");
      const archive = await import("/src/archive/projectArchive.ts");
      const data = {
        title: "Retained snapshots project",
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
        lease: { id: "lease-u", owner: "editor", workspace: "ws-undo" },
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
      const base = {
        revision: saved.revision,
        authoring: saved.authoring,
        profileId,
        kept: 0,
        pins: [],
      };
      for (const [snapshotId, notes] of [
        ["snap-e2e-1", "first retained state"],
        ["snap-e2e-2", "second retained state"],
      ] as const) {
        await undos.saveCreativeUndo({
          projectId,
          workspaceId: "ws-undo",
          snapshotId,
          expected: { generation: saved.generation, lifetime: saved.lifetime },
          authority: {
            kind: "lease",
            lease: { id: "lease-u", owner: "editor", workspace: "ws-undo" },
          },
          recovery: {
            base,
            sources: [art.source],
            derivatives: [],
            board: [],
            recipes: [],
            drafts: [
              {
                identity: { id: `draft-${snapshotId}`, incarnation: "inc", revision: 0 },
                sources: [art.source.identity],
                notes,
              },
            ],
          },
        } as never);
      }
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

/** The retained snapshots the live library stores, read through the real undo service. */
async function storedSnapshots(page: Page, projectId: ProjectId) {
  return page.evaluate(async (projectId) => {
    const undos = await import("/src/project/creativeUndo.ts");
    const snap = await import("/src/project/creativeProjectSnapshot.ts");
    const listed = await undos.listCreativeUndos(projectId);
    const reads = await Promise.all(
      listed.map((entry) => undos.readCreativeUndo(projectId, entry.snapshotId)),
    );
    const snapshot = await snap.captureCreativeProject(projectId);
    return {
      listed: listed.map((entry) => ({
        workspaceId: entry.workspaceId,
        status: entry.status,
      })),
      notes: reads.map((read) => read?.recovery.drafts[0]?.notes ?? null),
      undos: snapshot?.work?.undos.map((entry) => entry.status) ?? null,
      workBlobs: Object.fromEntries(
        Object.entries(snapshot?.workBlobs ?? {}).map(([hash, bytes]) => [hash, [...bytes]]),
      ),
    };
  }, projectId);
}

test("retained creative snapshots survive download, import, copy and reload with no provider @webkit-desktop", async ({
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
  const seeded = await seedSnapshotProject(
    page,
    art,
    files,
    requireProjectId("project-undo-e2e"),
    profileId,
  );

  // A cold reload proves the snapshot rows and held bytes are durable.
  await page.reload();
  const card = savedGameCard(page, "Retained snapshots project");
  await expect(card).toBeVisible();
  const cold = await storedSnapshots(page, seeded.projectId);
  expect(cold?.listed).toEqual([
    { workspaceId: "ws-undo", status: "current" },
    { workspaceId: "ws-undo", status: "current" },
  ]);
  expect(cold?.notes).toEqual(["first retained state", "second retained state"]);
  expect(cold?.undos).toEqual(["current", "current"]);
  expect(cold?.workBlobs).toEqual({
    [art.source.encoded.hash]: art.encoded,
    [art.source.normalized.blob.hash]: art.raster,
  });

  // The private download parses to the same ordered undo envelope and bytes.
  await openLibraryActions(page, card);
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-library-game").click();
  const opened = await readGameZip(
    new Uint8Array(await readFile((await (await downloadPromise).path())!)),
  );
  expect(opened.project?.creative).toBeUndefined();
  const work = opened.project?.creativeWork;
  expect(work?.work.undos.length).toBe(2);
  expect(work?.work.undos.map((entry) => entry.status)).toEqual(["current", "current"]);
  expect(work?.work.undos.map((entry) => entry.recovery.drafts[0]?.notes)).toEqual([
    "first retained state",
    "second retained state",
  ]);
  expect(
    Object.fromEntries(Object.entries(work?.blobs ?? {}).map(([h, b]) => [h, [...b]])),
  ).toEqual({
    [art.source.encoded.hash]: art.encoded,
    [art.source.normalized.blob.hash]: art.raster,
  });

  // The public export never carries the snapshots or their bytes.
  await openLibraryActions(page, card);
  const gameDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-library-game").click();
  const gameZip = await readGameZip(
    new Uint8Array(await readFile((await (await gameDownloadPromise).path())!)),
  );
  expect(gameZip.project).toBeUndefined();
  expect(Object.keys(gameZip.files).some((name) => name.startsWith("CREATIVE/"))).toBe(false);

  // Copy through the real library action: fresh snapshot ids, same state.
  await openLibraryActions(page, card);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Retained snapshots project Remix");
  await expect(remix).toBeVisible();
  const copyId = requireProjectId((await remix.getAttribute("data-project-id"))!);
  const copied = await storedSnapshots(page, copyId);
  expect(copied?.listed).toEqual(cold?.listed);
  expect(copied?.notes).toEqual(cold?.notes);
  expect(copied?.workBlobs).toEqual(cold?.workBlobs);

  // Import the downloaded ZIP through the real Add game path; the snapshots
  // republish as fresh target-local rows and holds, then survive reload.
  const knownIds: string[] = [seeded.projectId, copyId];
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "agi-retained-snapshots-project.zip",
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
  const imported = await storedSnapshots(page, requireProjectId(importedId));
  expect(imported?.listed).toEqual(cold?.listed);
  expect(imported?.notes).toEqual(cold?.notes);
  expect(imported?.workBlobs).toEqual(cold?.workBlobs);
  await page.reload();
  const afterReload = await storedSnapshots(page, requireProjectId(importedId));
  expect(afterReload?.listed).toEqual(cold?.listed);
  expect(afterReload?.notes).toEqual(cold?.notes);
  expect(providerCalls).toBe(0);
});
