import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { readGameZip } from "../src/archive/gameZip.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import { cacheGame } from "./engineProbe.ts";

/** Where Play stored the 1.0.0 tutorial (addLibraryGame's catalog project id). */
export const TUTORIAL_1_0 = "catalog-adventure-department-1.0.0";

/**
 * A browser that played the released 1.0.0 tutorial: the library copy Play
 * stored and its autosave, both from the released 1.0 Project download
 * (app/test/formats/project-v1.zip, never regenerated). With `remix`, also a
 * remix of that copy stored under that project id. Seeded through the
 * production storage boundary; the caller reloads.
 */
export async function seedTutorial10(page: Page, remix?: string): Promise<void> {
  const project = await readGameZip(
    new Uint8Array(await readFile(new URL("../test/formats/project-v1.zip", import.meta.url))),
  );
  const revision = await gameRevision(project.files);
  expect(revision, "the fixture is the released 1.0.0 tutorial").toBe(
    getKnownGameByAlias("adventure-department-1.0")?.targetRevision,
  );
  const stored = {
    title: "Adventure Department",
    provider: "stub",
    model: "offline-tutorial",
    imported: true,
    roomGeneration: false,
    authoringState: project.project?.authoringState,
    files: project.files,
    words: project.words,
  };
  const library = {
    ...project.metadata,
    version: 1 as const,
    revision,
    validation: { status: "ready" as const, message: "Checked.", profile: "2.936" },
  };
  await cacheGame(page, {
    ...stored,
    projectId: TUTORIAL_1_0 as never,
    library: {
      ...library,
      source: "catalog",
      catalog: { id: "adventure-department", version: "1.0.0" },
    },
  });
  if (remix)
    await cacheGame(page, {
      ...stored,
      projectId: remix as never,
      title: "Adventure Department Remix",
      library: {
        ...library,
        source: "remix",
        parent: { project: TUTORIAL_1_0 as never, revision },
      },
    });
  const autosave = project.progress?.autosave;
  expect(autosave?.game.identity.project, "the 1.0 download carries its autosave").toBe(
    TUTORIAL_1_0,
  );
  await page.evaluate(
    async ({ id, revision, progress }) => {
      const path = "/src/saves/gameProgress.ts";
      const { storeImportedProgress } = await import(path);
      storeImportedProgress(localStorage, id, revision, progress);
    },
    { id: TUTORIAL_1_0, revision, progress: { saves: {}, autosave } },
  );
}

/** Where Play stored the 1.1.0 tutorial. */
export const TUTORIAL_1_1 = "catalog-adventure-department-1.1.0";

/**
 * A browser that played the released 1.1.0 tutorial: the library copy Play
 * stored, from the released 1.1.0 Game download (app/test/formats/
 * tutorial-1.1.zip, never regenerated), and an autosave at the unscoped
 * address 1.1.0 wrote it to. Seeded through the production storage boundary;
 * the caller reloads. Returns the stored autosave string.
 */
export async function seedTutorial11(page: Page): Promise<string> {
  const game = await readGameZip(
    new Uint8Array(await readFile(new URL("../test/formats/tutorial-1.1.zip", import.meta.url))),
  );
  const revision = await gameRevision(game.files);
  expect(revision, "the fixture is the released 1.1.0 tutorial").toBe(
    getKnownGameByAlias("adventure-department-1.1")?.targetRevision,
  );
  await cacheGame(page, {
    title: "Adventure Department",
    provider: "stub",
    model: "offline-tutorial",
    imported: true,
    roomGeneration: false,
    files: game.files,
    words: game.words,
    projectId: TUTORIAL_1_1 as never,
    library: {
      ...game.metadata,
      version: 1 as const,
      revision,
      validation: { status: "ready" as const, message: "Checked.", profile: "2.936" },
      source: "catalog",
      catalog: { id: "adventure-department", version: "1.1.0" },
    },
  });
  const autosave = JSON.stringify({
    format: "monotio.agi.autosave",
    version: 1,
    image: "AA==",
    room: 2,
    cycle: 480,
    savedAt: 1_759_000_000_000,
    game: { installed: false, identity: { project: TUTORIAL_1_1, revision } },
  });
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key!, value!),
    [`monotio_agi.autosave.${TUTORIAL_1_1}`, autosave],
  );
  return autosave;
}
