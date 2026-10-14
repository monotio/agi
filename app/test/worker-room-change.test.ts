import assert from "node:assert/strict";
import { test } from "node:test";
import { roomsUsingResources } from "../src/worker/roomChange.ts";
import { createWorkspaceResourceUses } from "../src/studio/workspace/workspaceResourceUses.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { scanStaticExits } from "../../src/agent/roomMap.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";

test("applied picture and VIEW changes offer each other room that uses them once", () => {
  const documents = {
    "logic:1": "load.view(7); return;",
    "logic:2": "assignn(v50,3); draw.pic(v50); call(9); return;",
    "logic:3": assembleLogic("call(9); return;", { dictionary: new Map() }).payload,
    "logic:9": "load.view(7); call(10); return;",
    "logic:10": "call(9); return;",
    "logic:4": "new.room(2); return;",
  };
  const uses = createWorkspaceResourceUses();
  const dependencies = (key: string) => {
    const source = documents[key as keyof typeof documents];
    const bytes =
      typeof source === "string"
        ? assembleLogic(source, { dictionary: new Map() }).payload
        : source;
    const scan = bytes ? scanStaticExits(bytes, DEFAULT_V2_PROFILE) : undefined;
    return [
      ...uses(key, source, undefined, DEFAULT_V2_PROFILE).filter(
        (use) => !use.startsWith("logic:"),
      ),
      ...(scan?.pictures ?? []).map((num) => `picture:${num}`),
      ...(scan?.calls ?? []).map((num) => `logic:${num}`),
    ];
  };
  assert.deepEqual(
    roomsUsingResources(["picture:3", "view:7"], [1, 2, 3, 4], 1, dependencies),
    [2, 3],
  );
  assert.deepEqual(roomsUsingResources(["picture:3"], [1, 2, 3], 1, dependencies), [2]);
  assert.deepEqual(roomsUsingResources(["view:8"], [1, 2, 3], 1, dependencies), []);
});
