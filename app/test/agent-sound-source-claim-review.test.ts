import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createContainer } from "../../src/container/container.ts";
import { importSoundDocument } from "../../src/sound/document.ts";
import { buildSound } from "../../src/sound/build.ts";

for (const missing of [false, true]) {
  test(`a versioned sound source refuses a ${missing ? "missing" : "different"} native resource`, () => {
    const container = createContainer();
    if (!missing)
      container.putResource(
        "sound",
        5,
        buildSound([{ notes: [{ duration: 2, freqDivisor: 226, attenuation: 4 }] }]),
      );
    const claimed = importSoundDocument(
      buildSound([{ notes: [{ duration: 3, freqDivisor: 226, attenuation: 4 }] }]),
      { profileId: "2.936" },
    ).serialize();
    const state = { sources: { sounds: [[5, claimed]] } };
    const before = structuredClone(state);
    assert.throws(
      () =>
        AgentSession.fromAuthoredData(
          { provider: "stub", model: "offline-stub", apiKey: "" },
          () => {},
          Object.fromEntries(container.files),
          [],
          undefined,
          undefined,
          state,
          "2.936",
        ),
      /sound.*5|source.*(match|missing|native|payload)/i,
    );
    assert.deepEqual(state, before);
  });
}
