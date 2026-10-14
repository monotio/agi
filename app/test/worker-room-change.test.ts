import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoomResourceUses, roomsUsingResources } from "../src/worker/roomChange.ts";
import { createWorkspaceResourceUses } from "../src/studio/workspace/workspaceResourceUses.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { scanStaticExits } from "../../src/agent/roomMap.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";

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

for (const native of [false, true]) {
  test(`Show Room finds definite variable-selected VIEWs in ${native ? "native bytecode" : "authored LOGIC"}`, async () => {
    const source = "v50 = 7; load.view.v(v50); set.view.v(o0,v50); return;";
    const documents = {
      "logic:2": native ? assembleLogic(source, { dictionary: new Map() }).payload : source,
    };
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents,
      profileId: "2.936",
    });
    const dependencies = await createRoomResourceUses(compiled.files(), DEFAULT_V2_PROFILE);
    assert.deepEqual(roomsUsingResources(["view:7"], [1, 2], 1, dependencies), [2]);
  });
}

test("Show Room finds a PICTURE when either branch selects the same constant", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: {
      "logic:2":
        "if (isset(f80)) { v50 = 7; } else { v50 = 7; } load.pic(v50); draw.pic(v50); return;",
    },
    profileId: "2.936",
  });
  const dependencies = await createRoomResourceUses(compiled.files(), DEFAULT_V2_PROFILE);
  assert.deepEqual(roomsUsingResources(["picture:7"], [1, 2], 1, dependencies), [2]);
});

test("a called LOGIC carries a definite resource value into and back to its room", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: {
      "logic:2": "v50 = 7; call(9); load.pic(v51); draw.pic(v51); return;",
      "logic:9": "load.view.v(v50); v51 = v50; return;",
    },
    profileId: "2.936",
  });
  const dependencies = await createRoomResourceUses(compiled.files(), DEFAULT_V2_PROFILE);
  assert.deepEqual(roomsUsingResources(["view:7"], [1, 2], 1, dependencies), [2]);
  assert.deepEqual(roomsUsingResources(["picture:7"], [1, 2], 1, dependencies), [2]);
});

for (const source of [
  "if (isset(f80)) { v50 = 7; } load.view.v(v50); return;",
  "if (isset(f80)) { v50 = 7; } else { v50 = 8; } load.view.v(v50); return;",
  "v50 = 7; random(1,9,v50); load.view.v(v50); return;",
  "v50 = 7; call.v(v51); load.view.v(v50); return;",
  "v50 = 7; lindirectn(v51,8); load.view.v(v50); return;",
]) {
  test(`runtime resource choices stay unresolved: ${source}`, async () => {
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents: { "logic:2": source },
      profileId: "2.936",
    });
    const dependencies = await createRoomResourceUses(compiled.files(), DEFAULT_V2_PROFILE);
    assert.deepEqual(roomsUsingResources(["view:7", "view:8"], [1, 2], 1, dependencies), []);
  });
}
