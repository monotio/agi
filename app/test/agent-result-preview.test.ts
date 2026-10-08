import assert from "node:assert/strict";
import test from "node:test";
import { compileCapturedResource } from "../src/agent/agentResultPreview.ts";
import { PROFILES } from "../../src/runtime/profile.ts";

test("a malformed captured dependency does not hide valid sibling native bytes", () => {
  const picture = Uint8Array.of(0xff);
  const captured = { "logic:1": "if (", words: "[ unfinished", "picture:7": picture };
  const preview = compileCapturedResource(captured, "picture:7", PROFILES["2.936"]);
  assert.deepEqual(preview?.getResource("picture", 7), picture);
  assert.equal(preview?.getResource("logic", 1), null);
  assert.equal(compileCapturedResource(captured, "logic:1", PROFILES["2.936"]), undefined);
  assert.deepEqual(picture, Uint8Array.of(0xff));
});
