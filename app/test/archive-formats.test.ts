import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readGameZip } from "../src/gameZip.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import { progressEntries } from "../src/gameProgress.ts";
import { mapArchiveData } from "../src/roomMapStore.ts";
import { historyArchiveData } from "../src/historyArchive.ts";

/**
 * The first released archive formats, as the 1.0 app wrote them: a Game and
 * a Project download of the bundled tutorial after a short play session
 * (a walk, a command, an autosave). They are never regenerated. Every later
 * version must keep reading them; a format change that cannot is a new
 * version with a migration, and these bytes stay as its input.
 */
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./formats/${name}`, import.meta.url)));

/** A ZIP member's text, walking the local headers (the writer stores, never deflates). */
function member(zip: Uint8Array, name: string): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    assert.equal(view.getUint16(at + 8, true), 0, "stored, not compressed");
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const start = at + 30 + nameLength + view.getUint16(at + 28, true);
    if (new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLength)) === name)
      return new TextDecoder().decode(zip.subarray(start, start + size));
    at = start + size;
  }
  assert.fail(`${name} is not in the archive`);
}

test("a 1.0 Game download reads back as the game it was", async () => {
  const zip = fixture("game-v1.zip");
  const game = await readGameZip(zip);
  assert.equal(game.title, "Adventure Department");
  assert.deepEqual(game.metadata, {
    description: "Learn pictures, sprites and priority in a three-room tutorial.",
    author: "Monotio",
    license: "MIT",
  });
  assert.equal(game.roomGeneration, false);
  assert.equal(game.project, undefined);
  assert.deepEqual(Object.keys(game.files).sort(), [
    "LOGDIR",
    "OBJECT",
    "PICDIR",
    "SNDDIR",
    "VIEWDIR",
    "VOL.0",
    "WORDS.TOK",
  ]);
  // The writer still produces the same GAME.JSON for the same game.
  const again = buildPublicGameZip({
    files: game.files,
    title: game.title!,
    roomGeneration: false,
    library: {
      ...game.metadata,
      version: 1,
      revision: "0".repeat(64) as never,
      source: "zip",
      validation: { status: "unverified", message: "" },
    },
  });
  assert.equal(member(again, "GAME.JSON"), member(zip, "GAME.JSON"));
});

test("a 1.0 Project download restores its session, map, progress and tests", async () => {
  const zip = fixture("project-v1.zip");
  const project = await readGameZip(zip);
  assert.equal(project.title, "Adventure Department");
  assert.equal(project.project?.provider, "stub");
  assert.equal(project.project?.model, "offline-tutorial");
  assert.deepEqual(project.project?.transcript, []);
  assert.equal((project.project?.authoringState?.["authoring"] as { version?: number }).version, 1);
  assert.ok(project.files["TESTS.JSON"], "stored game tests travel with the project");
  assert.equal(project.backupWarning, undefined);
  assert.equal(project.mapWarning, undefined);
  const autosave = project.progress?.autosave;
  assert.equal(autosave?.format, "monotio.agi.autosave");
  assert.equal(autosave?.version, 1);
  assert.ok(autosave && autosave.room >= 1);
  assert.equal(project.history?.recording.version, 1);
  assert.equal(project.history?.recording.profile, "2.936");
  assert.ok(project.history && project.history.recording.segments.length >= 1);
  assert.ok(project.map, "the world map is readable");

  // Re-exporting what was read writes the same sidecar bytes.
  assert.equal(mapArchiveData(project.map!), member(zip, "MAP.JSON"));
  assert.equal(historyArchiveData(project.history!), member(zip, "HISTORY.JSON"));
  const [autosaveEntry] = progressEntries(project.progress!);
  assert.equal(autosaveEntry?.data, member(zip, "SAVES/AUTOSAVE.JSON"));
});
