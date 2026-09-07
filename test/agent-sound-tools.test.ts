import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState } from "../src/agent/tools.ts";
import { executeSoundTool, SOUND_TOOLS } from "../src/agent/soundTools.ts";
import { parseSound } from "../src/sound/sound.ts";

describe("compact music authoring tools", () => {
  it("advertises strict, bounded schemas", () => {
    assert.deepEqual(
      SOUND_TOOLS.map((tool) => tool.name),
      ["write_music", "read_sound", "preview_sound"],
    );
    for (const tool of SOUND_TOOLS) {
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(
        Object.keys(tool.parameters.properties).sort(),
        [...tool.parameters.required].sort(),
      );
    }
  });

  it("converts beats, repeats, named notes, roles, and human volume exactly", () => {
    const state = createAgentSessionState();
    const result = executeSoundTool(state, "write_music", {
      num: 5,
      tempo: 120,
      tracks: [
        {
          channel: "bass",
          volume: 5,
          events: [{ note: "C3", beats: 2, repeat: 1 }],
        },
        {
          channel: "melody",
          volume: 15,
          events: [{ note: "A4", beats: 1, repeat: 2 }],
        },
      ],
    });
    assert.equal(result?.success, true);
    const payload = state.container.getResource("sound", 5)!;
    const sound = parseSound(payload);
    assert.deepEqual(
      sound.channels.map((channel) => channel.notes.length),
      [2, 0, 1, 0],
    );
    assert.deepEqual(
      sound.channels[0]!.notes.map((note) => ({
        duration: note.duration,
        divisor: note.freqDivisor,
        attenuation: note.attenuation,
      })),
      [
        { duration: 30, divisor: 226, attenuation: 0 },
        { duration: 30, divisor: 226, attenuation: 0 },
      ],
    );
    assert.equal(sound.channels[2]!.notes[0]!.duration, 60);
    assert.equal(sound.channels[2]!.notes[0]!.freqDivisor, 760);
    assert.equal(sound.channels[2]!.notes[0]!.attenuation, 10);
    assert.deepEqual(result?.details?.["writtenResources"], [{ kind: "sound", num: 5 }]);
    assert.equal(typeof result?.details?.["revision"], "string");
    assert.equal(state.sources.sounds.get(5)?.length, 4);
  });

  it("maps all named noise modes to exact authentic control bits", () => {
    const state = createAgentSessionState();
    const names = [
      "periodic-low",
      "periodic-medium",
      "periodic-high",
      "white-low",
      "white-medium",
      "white-high",
    ];
    const result = executeSoundTool(state, "write_music", {
      num: 6,
      tempo: 120,
      tracks: [
        {
          channel: "noise",
          volume: 11,
          events: names.map((note) => ({ note, beats: 1, repeat: 1 })),
        },
      ],
    });
    assert.equal(result?.success, true);
    const payload = state.container.getResource("sound", 6)!;
    const start = payload[6]! | (payload[7]! << 8);
    const selectors: number[] = [];
    const latchBytes: number[] = [];
    const controls: number[] = [];
    for (let event = 0; event < names.length; event++) {
      const at = start + event * 5;
      selectors.push(payload[at + 2]!);
      latchBytes.push(payload[at + 3]!);
      controls.push(payload[at + 4]!);
    }
    assert.deepEqual(selectors, [2, 1, 0, 6, 5, 4]);
    assert.deepEqual(latchBytes, [0xe2, 0xe1, 0xe0, 0xe6, 0xe5, 0xe4]);
    assert.deepEqual(controls, new Array(6).fill(0xf4));

    const read = executeSoundTool(state, "read_sound", {
      num: 6,
      channel: 3,
      offset: 0,
      limit: 64,
    })!;
    assert.deepEqual(
      (read.details?.["events"] as Record<string, unknown>[]).map((event) => ({
        tone: event["tone"],
        freqDivisor: event["freqDivisor"],
        noiseSelector: event["noiseSelector"],
        noise: event["noise"],
        control: event["control"],
      })),
      names.map((noise, index) => ({
        tone: null,
        freqDivisor: null,
        noiseSelector: [2, 1, 0, 6, 5, 4][index],
        noise,
        control: 0xf4,
      })),
    );
    assert.doesNotMatch(read.message ?? "", /ch3 #/);
  });

  it("rejects invalid notes, duplicate roles, and oversized expansion atomically", () => {
    const badCases = [
      {
        num: 10,
        tempo: 120,
        tracks: [
          {
            channel: "melody",
            volume: 10,
            events: [{ note: "H4", beats: 1, repeat: 1 }],
          },
        ],
      },
      {
        num: 10,
        tempo: 120,
        tracks: [
          {
            channel: "melody",
            volume: 10,
            events: [{ note: "C4", beats: 1, repeat: 1 }],
          },
          {
            channel: "melody",
            volume: 10,
            events: [{ note: "D4", beats: 1, repeat: 1 }],
          },
        ],
      },
      {
        num: 10,
        tempo: 120,
        tracks: [
          {
            channel: "harmony",
            volume: 10,
            events: Array.from({ length: 129 }, () => ({ note: "C4", beats: 1, repeat: 32 })),
          },
        ],
      },
    ];
    for (const args of badCases) {
      const state = createAgentSessionState();
      const result = executeSoundTool(state, "write_music", args);
      assert.equal(result?.success, false);
      assert.equal(state.container.getResource("sound", 10), null);
      assert.equal(state.sources.sounds.has(10), false);
    }
  });

  it("reads bounded pages with original event fields and factual duration metadata", () => {
    const state = createAgentSessionState();
    executeSoundTool(state, "write_music", {
      num: 8,
      tempo: 90,
      tracks: [
        {
          channel: "melody",
          volume: 13,
          events: [
            { note: "C4", beats: 1, repeat: 1 },
            { note: "D4", beats: 0.5, repeat: 1 },
            { note: null, beats: 0.5, repeat: 1 },
          ],
        },
      ],
    });
    const result = executeSoundTool(state, "read_sound", {
      num: 8,
      channel: 0,
      offset: 1,
      limit: 1,
    });
    assert.equal(result?.success, true);
    const events = result?.details?.["events"] as Record<string, unknown>[];
    assert.deepEqual(
      events.map(({ channel, index, tone, control, freqDivisor, duration, attenuation }) => ({
        channel,
        index,
        tone,
        control,
        freqDivisor,
        duration,
        attenuation,
      })),
      [
        {
          channel: 0,
          index: 1,
          tone: 0x8315,
          control: 0x92,
          freqDivisor: 339,
          duration: 20,
          attenuation: 2,
        },
      ],
    );
    assert.equal(result?.details?.["totalNotes"], 3);
    assert.equal(result?.details?.["durationTicks"], 80);
    assert.equal(result?.details?.["durationSeconds"], 80 / 60);
    assert.equal(result?.details?.["hasMore"], true);
    assert.equal(typeof result?.details?.["revision"], "string");
  });

  it("returns undefined for tools outside its registry", () => {
    assert.equal(executeSoundTool(createAgentSessionState(), "read_logic", {}), undefined);
  });
});
