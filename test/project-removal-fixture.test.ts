import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthoringState } from "../src/authoring/authoringState.ts";
import { inspectProjectReferences } from "../src/authoring/projectReferences.ts";
import { inspectProjectRemoval } from "../src/authoring/projectRemoval.ts";
import { decodeLogicInsns } from "../src/logic/disassembler.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { loadGame } from "./game-fixture.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";

// Each edition has a numeric room jump in its debug LOGIC. A fresh resource
// without incoming constant routes can still be chosen by that game code.
for (const [name, logic, variable, offset] of [
  ["SQ1", 99, 121, 22],
  ["KQ1", 99, 78, 22],
  ["LSL1", 52, 45, 245],
] as const) {
  test(
    `${name} identifies the computed jump review for a fresh unconnected room`,
    { skip: fixtureSkip(KNOWN_GAME_HASH[name]) },
    () => {
      const { container, files } = loadGame(KNOWN_GAME_HASH[name], { interpreterFiles: true });
      const profile = detectProfile(files);
      assert.equal(container.getResource("logic", 254), null);
      const image = inspectProjectReferences({ container, profile });
      assert.equal(
        image.references.some(
          ({ target }) => target.kind === "logic" && "num" in target && target.num === 254,
        ),
        false,
      );
      const instructions = decodeLogicInsns(container.getResource("logic", logic)!, { profile });
      assert.equal(
        instructions.find(({ at }) => at === offset - 3)?.text,
        `get.num(m1, v${variable});`,
      );
      assert.equal(instructions.find(({ at }) => at === offset)?.text, `new.room.v(v${variable});`);
      const findings = inspectProjectRemoval({
        removals: ["logic:254"],
        image,
        profile,
        authoring: createAuthoringState(),
        tests: undefined,
        references: undefined,
        drafts: [],
        keptBindings: {},
      });
      assert.ok(
        findings.some(
          ({ document, message, computedRoomJump }) =>
            document === `logic:${logic}` &&
            computedRoomJump === "logic:254" &&
            message.includes(
              `Room 254 can still be reached by a computed room jump in LOGIC ${logic}`,
            ) &&
            message.includes("computed"),
        ),
        JSON.stringify(findings),
      );
    },
  );
}
