import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { testProjectId } from "./identity.ts";

function offeredProject() {
  const native = Uint8Array.of(0xde, 0xad, 0xbe);
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  container.putResource("sound", 5, native);
  container.putFile("WORDS.TOK", new Uint8Array(52));
  const envelope = {
    format: "agi.sound-document",
    version: 1,
    profileId: "2.936",
    payload: [...native],
    eventIds: null,
    nextEventId: 3,
  };
  return {
    projectId: testProjectId("sound-backup-ownership"),
    title: "Original title",
    provider: "stub",
    model: "offline-stub",
    transcript: [],
    authoredAt: "2026-01-01",
    files: Object.fromEntries(container.files),
    words: [] as [string, number][],
    authoringState: { sources: { sounds: [[5, envelope] as [number, typeof envelope]] } },
    library: {
      version: 1 as const,
      revision: requireResourceRevision("a".repeat(64)),
      source: "authored" as const,
      profile: "2.936" as const,
      validation: { status: "unverified" as const, message: "" },
    },
  };
}

test("Sound backup captures native bytes and source metadata before its first await", async () => {
  const data = offeredProject();
  const before = structuredClone(data);
  const pending = buildProjectZip(data);
  data.authoringState.sources.sounds[0]![1].payload[0] = 0;
  data.files["VOL.0"]!.fill(0);
  data.title = "Changed title";
  const opened = await readGameZip(await pending);
  assert.equal(opened.title, before.title);
  assert.deepEqual(opened.files, before.files);
  assert.deepEqual(opened.project!.authoringState, before.authoringState);
  assert.deepEqual(
    openContainer(new Map(Object.entries(opened.files))).getResource("sound", 5),
    Uint8Array.of(0xde, 0xad, 0xbe),
  );
});

test("Sound backup refuses duplicate tagged source resource identities", async () => {
  const data = offeredProject();
  const second = structuredClone(data.authoringState.sources.sounds[0]!);
  second[1].nextEventId = 8;
  data.authoringState.sources.sounds.push(second);
  await assert.rejects(buildProjectZip(data), /duplicate|twice|identity/i);
});

test("a maximum-size retained Sound payload remains readable in its Project backup", async () => {
  const data = offeredProject();
  const payload = new Uint8Array(65535);
  const container = openContainer(new Map(Object.entries(data.files)));
  container.putResource("sound", 5, payload);
  data.files = Object.fromEntries(container.files);
  data.authoringState.sources.sounds[0]![1].payload = [...payload];
  const opened = await readGameZip(await buildProjectZip(data));
  assert.deepEqual(
    openContainer(new Map(Object.entries(opened.files))).getResource("sound", 5),
    payload,
  );
  assert.deepEqual(opened.project!.authoringState, data.authoringState);
});
