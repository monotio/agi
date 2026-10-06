import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { workspaceStudioContext } from "../src/studio/workspace/studioContext.ts";

test("open pictures share one Walk context per room and admitted build", () => {
  const files = new Map(Object.entries(buildTutorial().files));
  const context = workspaceStudioContext(files, {}, DEFAULT_V2_PROFILE, []);
  const room = context.room(1);
  for (let keystroke = 0; keystroke < 20; keystroke++) assert.equal(context.room(1), room);
  const next = workspaceStudioContext(files, {}, DEFAULT_V2_PROFILE, []);
  assert.notEqual(next.room(1), room);
});
