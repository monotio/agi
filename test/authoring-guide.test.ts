import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTHORING_GUIDE, readAuthoringGuide } from "../src/agent/authoringGuide.ts";
import {
  ASK_TOOLS,
  AGENT_TOOLS,
  createAgentSessionState,
  executeAgentTool,
} from "../src/agent/tools.ts";
import { AGI_SYSTEM_PROMPT, createGenesisPrompt } from "../src/agent/prompt.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

/**
 * The guide carries the verified interpreter behaviors and the design notes
 * behind them. These tests pin the facts a topic must keep stating, so an
 * edit that drops or contradicts one fails here rather than in a game.
 */
test("every guide topic is listed, non-trivial and reachable through the tool", () => {
  const listing = readAuthoringGuide({ topic: null });
  assert.equal(listing.success, true);
  for (const [key, topic] of Object.entries(AUTHORING_GUIDE)) {
    assert.match(listing.message ?? "", new RegExp(`- ${key}: ${topic.title}`));
    assert.ok(topic.body.length > 800, `${key} has substantive notes`);
    const result = readAuthoringGuide({ topic: key });
    assert.equal(result.success, true);
    assert.ok(result.message?.includes(topic.body));
  }
  const unknown = readAuthoringGuide({ topic: "walking" });
  assert.equal(unknown.success, false);
  assert.match(unknown.error ?? "", /walking-barriers-and-water/);
});

test("the guide states the interpreter behaviors the engine follows", () => {
  const text = AUTHORING_GUIDE["text-and-captions"]!.body;
  assert.match(text, /next row at column 0/);
  assert.match(text, /show\.pic repaints the whole picture band/);
  assert.match(text, /every updating sprite's per-cycle redraw/);
  assert.match(text, /returns when the sprite moves on or is erased/);
  const sprites = AUTHORING_GUIDE["sprites-and-animation"]!.body;
  assert.match(sprites, /set\.view keeps the object's current loop/);
  assert.match(sprites, /call set\.cel\(o, 0\) explicitly/);
  const walking = AUTHORING_GUIDE["walking-barriers-and-water"]!.body;
  assert.match(walking, /f3 is set for ego when ANY baseline pixel touches control 2/);
  assert.match(walking, /f0 is set only when EVERY baseline pixel is on water/);
  assert.match(walking, /zero-distance move\.obj on ego/);
  const timing = AUTHORING_GUIDE["timing-and-pacing"]!.body;
  assert.match(timing, /have\.key\(\) polled once per cycle/);
  assert.match(timing, /ten minutes/);
  assert.match(timing, /pressing the direction the ego already walks stops it/);
});

test("the tool is catalogued for Ask turns and validates its topic argument", () => {
  assert.ok(ASK_TOOLS.includes("read_authoring_guide"));
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === "read_authoring_guide")!;
  assert.deepEqual(tool.parameters.required, ["topic"]);
  const state = createAgentSessionState();
  const listing = executeAgentTool(state, "read_authoring_guide", { topic: null });
  assert.equal(listing.success, true, listing.error ?? "");
  const notes = executeAgentTool(state, "read_authoring_guide", { topic: "sierra-craft" });
  assert.equal(notes.success, true, notes.error ?? "");
  assert.match(notes.message ?? "", /Composition first/);
  const rejected = executeAgentTool(state, "read_authoring_guide", { topic: "jokes" });
  assert.equal(rejected.success, false);
  assert.ok(AGI_SYSTEM_PROMPT.includes("read_authoring_guide"));
  assert.ok(createGenesisPrompt("A brief").includes("read_authoring_guide"));
});

test("the genesis prompt offers a boot skeleton without prescribing the opening's shape", () => {
  const prompt = createGenesisPrompt("# Night Train\nA sleeper car mystery.");
  assert.ok(prompt.startsWith("### GENESIS PHASE:"));
  assert.match(prompt, /yours to adapt or replace/);
  assert.match(prompt, /text-screen intro/);
  assert.ok(!/Use this logic 0 boot script/.test(prompt));
  assert.match(prompt, /assignn\(v10, 2\)/);
});

test("every code sketch in the guide assembles for the default profile", () => {
  let sketches = 0;
  for (const [key, topic] of Object.entries(AUTHORING_GUIDE)) {
    for (const match of topic.body.matchAll(/```agi\n([\s\S]*?)```/g)) {
      sketches++;
      assert.doesNotThrow(
        () => assembleLogic(match[1]!, { dictionary: new Map() }),
        `${key} sketch ${sketches}`,
      );
    }
  }
  assert.ok(sketches >= 2, "the guide carries worked sketches");
});
