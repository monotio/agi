import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { loadGame } from "./game-fixture.ts";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { fixtureDir, fixtureFiles, fixtureSkip } from "./fixtures.ts";

// Local binary evidence only; no interpreter bytes are embedded in the repo.
// docs/fidelity.md: print-handler-output-modes records the independent analysis.
test(
  "MH2 and Gold Rush independently identify the verified print-handler builds",
  {
    skip:
      fixtureSkip("mh2", ["AGI", "AGIDATA.OVL"], { resourceFiles: false }) ||
      fixtureSkip("gr1", ["AGI", "AGIDATA.OVL"], { resourceFiles: false }),
  },
  () => {
    const fixtures = [
      ["mh2", "3a2a02fd4effd2c045137d232441dd29adb3f8dc79088add2b5acefd43cf41d8"],
      ["gr1", "12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41"],
    ] as const;
    const binaries: Uint8Array[] = [];
    for (const [slug, digest] of fixtures) {
      const onDisk = fixtureFiles(slug)!;
      const files = new Map(
        ["AGI", "AGIDATA.OVL"].map((name) => [
          name,
          new Uint8Array(readFileSync(fixtureDir(slug) + onDisk.get(name.toLowerCase())!)),
        ]),
      );
      assert.equal(detectVersionString(files), "3.002.149", `${slug} reports its own build`);
      const binary = files.get("AGI")!;
      assert.equal(
        createHash("sha256").update(binary).digest("hex"),
        digest,
        `${slug}: new interpreter binary requires independent handler verification`,
      );
      const profile = detectProfile(files);
      assert.equal(profile.printConsumesF15, true);
      assert.equal(profile.timedPrintClearsV21, true);
      assert.equal(
        profile.roomAliases,
        null,
        "neither local binary is the spec's Gold Rush alias build",
      );
      binaries.push(binary);
    }
    for (const [start, end] of [
      [0x1f70, 0x201e],
      [0x7804, 0x785e],
    ])
      assert.deepEqual(
        binaries[0]!.subarray(0x200 + start!, 0x200 + end!),
        binaries[1]!.subarray(0x200 + start!, 0x200 + end!),
        "independently identified builds share the verified handler and flag accessors",
      );
  },
);

test(
  "MH2's complete logic census never loads either unavailable sound-tail record",
  {
    skip: fixtureSkip("mh2", ["AGIDATA.OVL"]),
  },
  () => {
    const { container, files } = loadGame("mh2", { interpreterFiles: true });
    assert.equal(detectVersionString(files), "3.002.149");
    const directory = files.get("MH2DIR")!;
    const soundStart = directory[6]! | (directory[7]! << 8);
    assert.equal((directory.length - soundStart) / 3, 217);
    for (const [id, offset] of [
      [215, 79513],
      [216, 79997],
    ] as const) {
      const at = soundStart + id * 3;
      assert.equal(directory[at]! >> 4, 6);
      assert.equal(
        ((directory[at]! & 15) << 16) | (directory[at + 1]! << 8) | directory[at + 2]!,
        offset,
      );
    }
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
        assert.notEqual(sound, 215, `logic ${id} would require the missing volume`);
        assert.notEqual(sound, 216, `logic ${id} would require the missing volume`);
        assert.ok(container.getResource("sound", sound), `logic ${id}'s sound ${sound} exists`);
      }
    }
    assert.equal(logics, 96, "every present logic was decoded");
    assert.equal(highestSound, 211);
  },
);
