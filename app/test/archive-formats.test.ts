import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readGameZip } from "../src/archive/gameZip.ts";
import {
  buildProjectZip,
  readProjectContext,
  buildPublicGameZip,
} from "../src/archive/projectArchive.ts";
import { historyBootSemantic, historyFingerprint } from "../../src/agent/history.ts";
import { progressEntries } from "../src/saves/gameProgress.ts";
import { mapArchiveData } from "../src/world/roomMapStore.ts";
import { historyArchiveData } from "../src/archive/historyArchive.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import {
  readProjectHistory,
  writeProjectHistory,
} from "../../src/authoring/projectHistoryCodec.ts";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { readStoredBody } from "../src/project/gameStorage.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { migrateAgentChats } from "../../src/agent/chats.ts";
import {
  traceImageChanges,
  makeCelsChanges,
  suggestImageFrames,
} from "../../src/creative/imageOperations.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { replayHistorySegment } from "./worker-ctx.ts";
import { testProjectId } from "./identity.ts";
import type { ProjectContent } from "../../src/authoring/projectContent.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";

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

test("the released 1.1.0 tutorial's Game download reads back as the game it was", async () => {
  // Written by the v1.1.0 Game download writer from the v1.1.0 tutorial
  // sources; never regenerated. Its revision is the 1.1.0 catalog release's.
  const zip = fixture("tutorial-1.1.zip");
  const game = await readGameZip(zip);
  assert.equal(game.title, "Adventure Department");
  assert.deepEqual(game.metadata, {
    description: "Learn pictures, sprites and priority in a three-room tutorial.",
    author: "Monotio",
    license: "MIT",
  });
  assert.equal(game.roomGeneration, false);
  assert.equal(game.project, undefined);
  assert.equal(
    await gameRevision(game.files),
    "dff9b56afa2c48180b8698dead64d2245333a3b3d829dddd931b3d38c60e7c9a",
  );
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

  for (const segment of project.history!.recording.segments) {
    assert.deepEqual(
      historyFingerprint(historyBootSemantic(segment.boot)),
      segment.boot.fingerprint,
    );
    assert.deepEqual(
      historyFingerprint(historyBootSemantic({ ...segment.boot, amigaRegion: "ntsc" })),
      segment.boot.fingerprint,
    );
  }

  // Re-exporting what was read writes the same sidecar bytes.
  assert.equal(mapArchiveData(project.map!), member(zip, "MAP.JSON"));
  assert.equal(historyArchiveData(project.history!), member(zip, "HISTORY.JSON"));
  const [autosaveEntry] = progressEntries(project.progress!);
  assert.equal(autosaveEntry?.data, member(zip, "SAVES/AUTOSAVE.JSON"));
});

test("the executed version-1 history in the released Project replays from its original bytes", async () => {
  const original = fixture("project-v1.zip");
  const before = original.slice();
  const project = await readGameZip(original);
  assert.equal(project.history?.recording.version, 1);
  let actions = 0;
  for (const segment of project.history!.recording.segments) {
    actions += segment.events.length;
    const drive = replayHistorySegment(segment);
    assert.equal(drive.error, null);
    assert.equal(drive.diverged, null);
    assert.equal(drive.applied, segment.events.length);
  }
  assert.ok(actions > 0);
  assert.deepEqual(original, before);
});

test("removed intermediate project formats refuse without changing their input", () => {
  const project = JSON.parse(member(fixture("project-v1.zip"), "PROJECT.JSON"));
  for (const version of [2, 3, 4]) {
    const offered = { ...project, version };
    const bytes = new TextEncoder().encode(JSON.stringify(offered));
    const before = bytes.slice();
    assert.throws(() => readProjectContext(bytes, new Map(), ""), /version is not supported/);
    assert.deepEqual(bytes, before);
    const body = { format: "monotio.agi.stored-project", version };
    assert.throws(() => readStoredBody(body, testProjectId("unknown")), /version is not supported/);
    assert.deepEqual(body, { format: "monotio.agi.stored-project", version });
  }
  const workspace = { ...writeProjectWorkspace({ notes: "Friendly tone." }), version: 2 };
  const before = structuredClone(workspace);
  assert.throws(() => readProjectWorkspace(workspace), /Unsupported project workspace version/);
  assert.deepEqual(workspace, before);
  const history = {
    ...writeProjectHistory(new ProjectHistory(sha256Hex).capture(), sha256Hex),
    version: 2,
  };
  assert.throws(
    () => readProjectHistory(history, sha256Hex),
    /Unsupported project history version/,
  );
});

test("version 1 optional chats, notes, images, native art and History round trip together", async () => {
  const original = await readGameZip(fixture("game-v1.zip"));
  const rgba = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255);
  const image = {
    title: "Two frames",
    mime: "image/png",
    encoded: encodePngRgba(2, 1, rgba),
    width: 2,
    height: 1,
    rgba,
  };
  const documents: Record<string, ProjectContent> = {
    notes: "Friendly tone.",
    "picture:1": Uint8Array.of(255),
  };
  for (const change of traceImageChanges(documents, "picture:1", image, 0.5))
    documents[change.key] = change.content!;
  for (const change of makeCelsChanges(
    documents,
    "view:255",
    image,
    suggestImageFrames(image, 2),
    PROFILES["2.936"]!,
  ))
    documents[change.key] = change.content!;
  const history = new ProjectHistory(sha256Hex);
  history.record(documents, {
    label: "Image task",
    origin: "agent",
    author: "agent",
    time: 1,
    chatId: "task",
    messageId: "reply",
  });
  const workspace = writeProjectWorkspace(documents);
  const projectHistory = writeProjectHistory(history.capture(), sha256Hex);
  const chats = migrateAgentChats({});
  const data = {
    projectId: testProjectId("optional-data"),
    title: "Optional data",
    authoredAt: "",
    files: original.files,
    words: original.words,
    workspace,
    projectHistory,
    chats,
  };
  const zip = await buildProjectZip(data);
  const envelope = JSON.parse(member(zip, "PROJECT.JSON"));
  assert.equal(envelope.version, 1);
  assert.equal(envelope.workspace.version, 1);
  assert.equal(envelope.projectHistory.version, 1);
  const opened = await readGameZip(zip);
  assert.deepEqual(opened.project?.workspace, workspace);
  assert.deepEqual(opened.project?.projectHistory, projectHistory);
  assert.deepEqual(opened.project?.chats, chats);
  assert.equal(opened.project?.provider, undefined);
  assert.deepEqual(readProjectWorkspace(opened.project!.workspace), documents);
  assert.equal(
    readProjectHistory(opened.project!.projectHistory, sha256Hex).commits[0]?.messageId,
    "reply",
  );
});
