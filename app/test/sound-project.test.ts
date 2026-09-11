import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAgentSessionState, executeAgentTool } from "../../src/agent/tools.ts";
import { buildProjectZip } from "../src/projectArchive.ts";
import { readGameZip } from "../src/gameZip.ts";

test("musical intent survives a saved project and resets after raw effect authoring", async () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_logic_source", { room: 0, source: "return;" });
  executeAgentTool(state, "write_music", {
    num: 5,
    tempo: 90,
    tracks: [
      {
        channel: "melody",
        volume: 12,
        events: [{ note: "A4", beats: 1, repeat: 1 }],
      },
    ],
  });
  const config = { provider: "openai" as const, apiKey: "test-placeholder", model: "test" };
  const session = new AgentSession(config, () => {}, state);
  const archive = await buildProjectZip({
    title: "Musical project",
    projectId: "music-test",
    provider: "openai",
    model: "test",
    authoredAt: "2026-09-06",
    files: { ...Object.fromEntries(state.getFiles()), "WORDS.TOK": new Uint8Array(52) },
    words: [],
    transcript: [],
    authoringState: session.getAuthoringState(),
  });
  const opened = await readGameZip(archive);
  const restored = AgentSession.fromAuthoredData(
    config,
    () => {},
    opened.files,
    [],
    [],
    undefined,
    opened.project!.authoringState,
  );
  const read = executeAgentTool(restored.state, "read_sound", { num: 5 });
  assert.equal(read.details?.["representation"], "music");
  assert.equal(read.details?.["tempo"], 90);
  const events = read.details?.["events"] as Record<string, unknown>[];
  assert.equal(events[0]?.["durationBeats"], 1);
  const written = executeAgentTool(restored.state, "write_sound", {
    num: 5,
    tracks: [{ notes: [{ note: null, freqDivisor: 37, duration: 10, attenuation: 0 }] }],
  });
  assert.equal(written.success, true, written.error ?? "effect should compile");
  const effect = executeAgentTool(restored.state, "read_sound", { num: 5 });
  assert.equal(effect.details?.["representation"], "sound");
  assert.equal(effect.details?.["tempo"], null);
  assert.equal(
    (effect.details?.["events"] as Record<string, unknown>[])[0]?.["noteName"],
    undefined,
  );
});
