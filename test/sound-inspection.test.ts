import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
} from "../src/agent/tools.ts";
import { resourceRevision, validateAuthoringState } from "../src/agent/authoringState.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
} from "../src/agent/toolTransport.ts";

function music() {
  const state = createAgentSessionState();
  assert.equal(
    executeAgentTool(state, "write_music", {
      num: 5,
      tempo: 120,
      tracks: [
        {
          channel: "melody",
          volume: 12,
          events: [
            { note: "A4", beats: 1, repeat: 1 },
            { note: "rest", beats: 0.5, repeat: 1 },
            { note: "C5", beats: 0.5, repeat: 1 },
          ],
        },
      ],
    }).success,
    true,
  );
  return state;
}

test("music intent survives validation and is trusted only for the matching compiled revision", () => {
  const state = music();
  const authoring = validateAuthoringState(JSON.parse(JSON.stringify(state.authoring)));
  assert.deepEqual(authoring.music?.["5"], {
    tempo: 120,
    revision: resourceRevision(state.container.getResource("sound", 5)),
  });
  state.authoring = authoring;
  const read = executeAgentTool(state, "read_sound", { num: 5, channel: 0, offset: 0, limit: 1 });
  assert.equal(read.success, true);
  assert.equal(read.details?.["representation"], "music");
  assert.equal(read.details?.["tempo"], 120);
  const events = read.details?.["events"] as Record<string, unknown>[];
  assert.equal(events[0]?.["noteName"], "A4");
  assert.equal(events[0]?.["startBeat"], 0);
  assert.equal(read.images?.length, 1);
  const payload = state.container.getResource("sound", 5)!.slice();
  payload[8] = 31;
  state.container.putResource("sound", 5, payload);
  const stale = executeAgentTool(state, "read_sound", { num: 5 });
  assert.equal(stale.details?.["representation"], "sound");
  assert.equal(stale.details?.["tempo"], null);
  assert.equal(
    (stale.details?.["events"] as Record<string, unknown>[])[0]?.["noteName"],
    undefined,
  );
});

test("unclassified effects retain frequency and noise timing without inventing a musical score", () => {
  const source = music();
  const imported = createAgentSessionState(source.container);
  const read = executeAgentTool(imported, "read_sound", { num: 5 });
  assert.equal(read.success, true);
  assert.equal(read.details?.["representation"], "sound");
  const events = read.details?.["events"] as Record<string, unknown>[];
  assert.equal(events[0]?.["noteName"], undefined);
  assert.equal(events[0]?.["startSeconds"], 0);
  assert.equal(events[0]?.["durationSeconds"], 0.5);
  assert.ok(Number(events[0]?.["frequencyHz"]) > 439);
  assert.equal(events[1]?.["rest"], true);
  assert.equal(read.images?.length, 1);
  const score = executeAgentTool(imported, "read_sound", { num: 5, representation: "music" });
  assert.equal(score.details?.["representation"], "music");
  assert.equal(score.details?.["tempo"], null);
  assert.equal((score.details?.["events"] as Record<string, unknown>[])[0]?.["noteName"], "A4");
  assert.equal(
    (score.details?.["events"] as Record<string, unknown>[])[0]?.["startBeat"],
    undefined,
  );
});

test("sound metadata rejects invalid imported tempos and revisions", () => {
  for (const entry of [
    { tempo: 0, revision: "31-abcdefab" },
    { tempo: 120, revision: "bad" },
    { tempo: Infinity, revision: "31-abcdefab" },
  ]) {
    assert.throws(
      () =>
        validateAuthoringState({
          version: 1,
          bindings: {},
          world: { rooms: {}, facts: {}, quests: {} },
          music: { "5": entry },
        }),
      /music/i,
    );
  }
});

test("sound previews are read-only WAV attachments and provider requests keep only their description", async () => {
  const state = music();
  const before = state.container.getResource("sound", 5)!.slice();
  const result = await executeAgentToolAsync(
    state,
    "preview_sound",
    { num: 5, startSeconds: 0, durationSeconds: 1, device: "tandy" },
    { readOnly: true },
  );
  assert.equal(result.success, true, result.error ?? "preview should succeed");
  assert.deepEqual(state.container.getResource("sound", 5), before);
  assert.equal(result.audio?.length, 1);
  assert.equal(new TextDecoder().decode(result.audio![0]!.wav.subarray(0, 4)), "RIFF");
  const content = splitToolResult(result);
  assert.ok(content.text.length < 3000);
  assert.match(content.text, /not sent to the model/i);
  assert.doesNotMatch(content.text, /"wav"|data:audio|"0":82/);
  assert.equal(openAiToolContent(content).length, 1);
  assert.equal(anthropicToolContent(content).length, 1);
});
