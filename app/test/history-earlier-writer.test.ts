import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../../src/runtime/engine.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import {
  stampBoot,
  validateHistoryBoot,
  historyBootSemantic,
  historyFingerprint,
} from "../../src/agent/history.ts";
import { gameContainer } from "./worker-ctx.ts";
import { readHistoryArchive, historyArchiveData } from "../src/archive/historyArchive.ts";
import { testProjectId, testRevision } from "./identity.ts";

function boot(region: "ntsc" | "pal") {
  const container = gameContainer(["load.pic(v0);draw.pic(v0);show.pic();return;"], (c) =>
    c.putResource("picture", 0, Uint8Array.of(0xff)),
  );
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine() {
        return null;
      },
      takeKeys() {
        return [];
      },
    },
    new Map(),
    { profile: PROFILES["amiga-2.082"] },
  );
  engine.amigaRegion = region;
  engine.tick();
  return stampBoot({
    files: {},
    dictionary: [],
    authorRooms: false,
    profile: "amiga-2.082",
    amigaRegion: region,
    rng: 7,
    soundDevice: 1,
    resourceSet: "early-pal",
    requestSerial: 0,
    replay: engine.captureReplayState(),
  });
}

test("an earlier PAL writer's fingerprint stays readable when replay state also binds PAL", () => {
  const input = boot("pal");
  // Produced by stampBoot at 2e56c86, before the boot region joined its hash.
  input.fingerprint = { v: 1, hash: "7c4e9b73bee88ba4" };
  const before = structuredClone(input);
  const read = validateHistoryBoot(input);
  assert.deepEqual(read, input);
  assert.deepEqual(input, before);
  assert.deepEqual(historyFingerprint(historyBootSemantic(read)), input.fingerprint);
  const archive = JSON.stringify({
    format: "monotio.agi.history",
    version: 1,
    recording: {
      version: 2,
      identity: {
        project: testProjectId("earlier-writer"),
        revision: testRevision("earlier-writer"),
      },
      profile: "amiga-2.082",
      resourceSet: "early-pal",
      startedAt: 1,
      segments: [{ id: "earlier", boot: input, anchors: [], events: [], marks: [], sync: [] }],
    },
  });
  assert.equal(historyArchiveData(readHistoryArchive(new TextEncoder().encode(archive))), archive);
});

test("NTSC fingerprints stay readable and changing the region still fails validation", () => {
  const input = boot("ntsc");
  assert.deepEqual(input.fingerprint, { v: 1, hash: "9a3018b93fa2b042" });
  assert.deepEqual(validateHistoryBoot(input), input);
  assert.throws(() => validateHistoryBoot({ ...input, amigaRegion: "pal" }), /fingerprint/);
  const pal = boot("pal");
  assert.deepEqual(validateHistoryBoot(pal), pal);
  assert.throws(() => validateHistoryBoot({ ...pal, rng: 8 }), /fingerprint/);
});
