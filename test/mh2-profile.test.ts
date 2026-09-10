import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { loadGame } from "./game-fixture.ts";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { fixtureDir, fixtureFiles, fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";

// Optional 3.002.149 fixture comparison; handler offsets are documented in docs/fidelity.md.
test(
  "3.002.149 fixture binaries select the shared print and room behavior",
  {
    skip:
      fixtureSkip(KNOWN_GAME_HASH.MH2, ["AGI", "AGIDATA.OVL"], { resourceFiles: false }) ||
      fixtureSkip(KNOWN_GAME_HASH.GR1, ["AGI", "AGIDATA.OVL"], { resourceFiles: false }),
  },
  () => {
    const binaries: Uint8Array[] = [];
    for (const gameHash of [KNOWN_GAME_HASH.MH2, KNOWN_GAME_HASH.GR1]) {
      const onDisk = fixtureFiles(gameHash)!;
      const files = new Map(
        ["AGI", "AGIDATA.OVL"].map((name) => [
          name,
          new Uint8Array(readFileSync(fixtureDir(gameHash) + onDisk.get(name.toLowerCase())!)),
        ]),
      );
      assert.equal(detectVersionString(files), "3.002.149", `${gameHash} reports its own build`);
      const binary = files.get("AGI")!;
      const profile = detectProfile(files);
      assert.equal(profile.printConsumesF15, true);
      assert.equal(profile.timedPrintClearsV21, true);
      assert.equal(profile.roomAliases, null, `${gameHash}: room destinations pass through`);
      binaries.push(binary);
    }
    for (const [start, end] of [
      [0x1f70, 0x201e],
      [0x7804, 0x785e],
    ])
      assert.deepEqual(
        binaries[0]!.subarray(0x200 + start!, 0x200 + end!),
        binaries[1]!.subarray(0x200 + start!, 0x200 + end!),
        "fixture binaries share the print handler and flag accessors",
      );
  },
);

test(
  "MH2 logic resources reference available sounds",
  {
    skip: fixtureSkip(KNOWN_GAME_HASH.MH2, ["AGIDATA.OVL"], { checkVolumes: false }),
  },
  () => {
    const { container, files } = loadGame(KNOWN_GAME_HASH.MH2, {
      interpreterFiles: true,
      checkVolumes: false,
    });
    assert.equal(detectVersionString(files), "3.002.149");
    let logics = 0;
    let highestSound = 0;
    for (let id = 0; id < 256; id++) {
      const payload = container.getResource("logic", id);
      if (!payload) continue;
      logics++;
      const source = disassembleLogic(payload, { profile: detectProfile(files) });
      assert.doesNotMatch(source, /\/\/ !!/, `logic ${id} decoded every instruction`);
      // Both sound actions take an immediate resource ID; there is no variable
      // sound opcode whose values could evade this exhaustive instruction scan.
      for (const match of source.matchAll(/^\s*(?:load\.sound|sound)\((\d+)/gm)) {
        const sound = Number(match[1]);
        highestSound = Math.max(highestSound, sound);
        assert.ok(container.getResource("sound", sound), `logic ${id}'s sound ${sound} exists`);
      }
    }
    assert.equal(logics, 96, "every present logic was decoded");
    assert.equal(highestSound, 211);
  },
);
