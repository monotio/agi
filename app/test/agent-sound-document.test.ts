import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { openContainer } from "../../src/container/container.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildSound } from "../../src/sound/build.ts";
import { SOUND_DOCUMENT_FORMAT } from "../../src/sound/document.ts";

const CONFIG = { provider: "stub", model: "offline-stub", apiKey: "" } as const;

// Lane 0 holds two tone records (30 ticks divisor 226 att 4, then 20 ticks
// divisor 380 att 9); lanes 1-3 are bare terminators. Offsets 8/20/22/24.
const ENVELOPE_BYTES = new Uint8Array([
  8, 0, 20, 0, 22, 0, 24, 0, 30, 0, 0x0e, 0x82, 0x94, 20, 0, 0x17, 0x8c, 0x99, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff,
]);

const ENVELOPE = {
  format: SOUND_DOCUMENT_FORMAT,
  version: 1,
  profileId: "2.936",
  payload: [...ENVELOPE_BYTES],
  eventIds: [["e7", "e9"], [], [], []],
  nextEventId: 10,
};

const TRACKS = [{ notes: [{ duration: 30, freqDivisor: 226, attenuation: 4 }] }];

function authoredFiles(): Record<string, Uint8Array> {
  const container = openContainer(new Map());
  container.putFile("WORDS.TOK", buildWordsTok([]));
  container.putResource("sound", 5, ENVELOPE_BYTES);
  container.putResource("sound", 7, buildSound(TRACKS));
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  return Object.fromEntries(container.files);
}

function authoredSnapshot(sounds: [number, unknown][]) {
  return {
    authoring: { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } },
    sources: {
      logics: [[0, "return;"]],
      sounds,
    },
  };
}

test("a tagged SoundDocument source hydrates, serializes and rehydrates beside legacy tracks and logic edits", () => {
  const session = AgentSession.fromAuthoredData(
    CONFIG,
    () => {},
    authoredFiles(),
    [],
    undefined,
    undefined,
    authoredSnapshot([
      [5, ENVELOPE],
      [7, TRACKS],
    ]),
    "2.936",
  );

  // Hydration admits the envelope under its own reading — ids, cursor and
  // payload intact — beside the legacy track body, never as one.
  assert.deepEqual(session.state.sources.sounds.get(5), ENVELOPE);
  assert.deepEqual(session.state.sources.sounds.get(7), TRACKS);
  assert.equal(session.state.sources.logics.get(0), "return;");

  // An unrelated source edit rides the same snapshot; the envelope is
  // serialized as the identical tagged body, not collapsed to tracks.
  session.state.sources.logics.set(1, "assignn(v40, 1); return;");
  const snapshot = session.getAuthoringState();
  const sources = snapshot["sources"] as {
    sounds: [number, unknown][];
    logics: [number, string][];
  };
  assert.deepEqual(sources.sounds, [
    [5, ENVELOPE],
    [7, TRACKS],
  ]);
  assert.deepEqual(sources.logics, [
    [0, "return;"],
    [1, "assignn(v40, 1); return;"],
  ]);

  // The serialized snapshot is what a reload or history adoption rehydrates:
  // the same envelope, still pinned, survives the second read.
  const rehydrated = AgentSession.fromAuthoredData(
    CONFIG,
    () => {},
    authoredFiles(),
    [],
    undefined,
    undefined,
    snapshot,
    "2.936",
  );
  assert.deepEqual(rehydrated.state.sources.sounds.get(5), ENVELOPE);
  assert.deepEqual(rehydrated.state.sources.sounds.get(7), TRACKS);
  assert.equal(rehydrated.state.sources.logics.get(1), "assignn(v40, 1); return;");
});

test("hydration owns the imported envelope: mutating the input cannot reach the stored source", () => {
  const claimed = structuredClone(ENVELOPE);
  const session = AgentSession.fromAuthoredData(
    CONFIG,
    () => {},
    authoredFiles(),
    [],
    undefined,
    undefined,
    authoredSnapshot([[5, claimed]]),
    "2.936",
  );
  (claimed.payload as number[])[8] = 99;
  (claimed.eventIds[0] as string[]).push("e99");
  const stored = session.state.sources.sounds.get(5);
  assert.deepEqual(stored, ENVELOPE);
  assert.notEqual(stored, claimed);
});

test("an envelope pinned to another profile refuses hydration instead of relabeling", () => {
  const mismatched = { ...ENVELOPE, profileId: "2.089" };
  assert.throws(
    () =>
      AgentSession.fromAuthoredData(
        CONFIG,
        () => {},
        authoredFiles(),
        [],
        undefined,
        undefined,
        authoredSnapshot([[5, mismatched]]),
        "2.936",
      ),
    /pinned to profile '2\.089'.*selects '2\.936'/,
  );
});

test("malformed envelope bodies refuse hydration instead of reading as tracks", () => {
  for (const body of [
    { ...ENVELOPE, version: 2 },
    { ...ENVELOPE, format: "agi.sound" },
    { ...ENVELOPE, extra: true },
    { ...ENVELOPE, eventIds: [["e7"], [], [], []] },
  ]) {
    assert.throws(
      () =>
        AgentSession.fromAuthoredData(
          CONFIG,
          () => {},
          authoredFiles(),
          [],
          undefined,
          undefined,
          authoredSnapshot([[5, body]]),
          "2.936",
        ),
      Error,
    );
  }
});
