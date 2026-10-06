import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../src/container/container.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "../src/authoring/authoringState.ts";
import { inspectProjectReferences } from "../src/authoring/projectReferences.ts";
import {
  inspectProjectRemoval,
  type ProjectRemovalInput,
} from "../src/authoring/projectRemoval.ts";
import { serializeGameTests } from "../src/agent/gameTestFormat.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const profile = PROFILES["2.936"];

/** Compile each source into a bare container and inventory the image's references. */
function imageFor(logics: Record<string, string>): ProjectRemovalInput["image"] {
  const container = openContainer(new Map(), { profile });
  for (const [num, source] of Object.entries(logics)) {
    const compiled = compileProjectLogic(source, {
      profile,
      dictionary: new Map(),
      bindings: {},
    });
    container.putResource("logic", Number(num), compiled.assembly.payload);
  }
  return inspectProjectReferences({ container, profile });
}

function authoring(over: {
  bindings?: AuthoringState["bindings"];
  world?: AuthoringState["world"];
  music?: AuthoringState["music"];
}): AuthoringState {
  const base = createAuthoringState();
  return validateAuthoringState({
    version: 1,
    bindings: over.bindings ?? base.bindings,
    world: over.world ?? base.world,
    ...(over.music === undefined ? {} : { music: over.music }),
  });
}

function review(over: Partial<ProjectRemovalInput>) {
  return inspectProjectRemoval({
    removals: [],
    image: imageFor({}),
    authoring: authoring({}),
    tests: undefined,
    references: undefined,
    drafts: [],
    keptBindings: {},
    profile,
    ...over,
  });
}

function world(rooms: AuthoringState["world"]["rooms"]): AuthoringState["world"] {
  return { rooms, facts: {}, quests: {} };
}

test("an unreferenced removal leaves no findings", () => {
  assert.deepEqual(review({ removals: ["sound:42"], image: imageFor({ "0": "return;" }) }), []);
});

test("a literal use in the compiled image blocks its removal", () => {
  const image = imageFor({ "0": "return;", "1": "sound(42, f90); return;" });
  const findings = review({ removals: ["sound:42"], image });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.document, "logic:1");
  assert.match(findings[0]!.message, /sound:42 is still used/);
});

test("a variable-operand target blocks only its own family's removal", () => {
  const image = imageFor({ "0": "load.view.v(v9); load.pic(v8); return;" });
  assert.ok(review({ removals: ["view:5"], image }).length > 0, "same-family v-operand blocks");
  assert.ok(review({ removals: ["picture:5"], image }).length > 0);
  assert.deepEqual(
    review({ removals: ["sound:5"], image }),
    [],
    "an unresolved picture/view operand says nothing about a SOUND removal",
  );
});

test("resolved variable room, call and load targets allow an unrelated LOGIC removal", () => {
  const image = imageFor({
    "0": "assignn(v60,1);load.logics.v(v60);call.v(v60);return;",
    "1": "assignn(v61,7);new.room.v(v61);return;",
    "7": "return;",
  });
  assert.deepEqual(review({ removals: ["logic:42"], image }), []);
  assert.ok(review({ removals: ["logic:7"], image }).length > 0);
});

test("boot and resolved transitions bound the current-room dispatch across shared calls", () => {
  const image = imageFor({
    "0": "if(v0==0){assignn(v0,1);new.room.v(v0);}assignn(v60,7);call.v(v0);return;",
    "1": "call(9);return;",
    "9": "new.room.v(v60);return;",
    "7": "return;",
  });
  assert.deepEqual(review({ removals: ["logic:42"], image }), []);
  assert.ok(review({ removals: ["logic:7"], image }).length > 0);
});

test("a computed room target reports its LOGIC and the reviewable room", () => {
  const image = imageFor({ "0": "call(1);return;", "1": "get.num(1,v60);new.room.v(v60);return;" });
  const findings = review({ removals: ["logic:42"], image });
  assert.ok(
    findings.some(
      ({ message, document, computedRoomJump }) =>
        document === "logic:1" &&
        computedRoomJump === "logic:42" &&
        /Room 42.*LOGIC 1.*debug teleport/.test(message),
    ),
  );
});

for (const write of ["get.num(1,v0);", "assignn(v60,0);lindirectn(v60,42);"]) {
  test(`a current-room clobber keeps dispatch uncertain: ${write}`, () => {
    const image = imageFor({
      "0": "if(v0==0){new.room(1);}call.v(v0);return;",
      "1": `${write}return;`,
    });
    const findings = review({ removals: ["logic:42"], image });
    assert.ok(findings.some(({ message }) => /offset.*call.v.*computed/.test(message)));
  });
}

test("a saved scan start keeps a skipped target assignment uncertain", () => {
  const image = imageFor({
    "0": "call(1);return;",
    "1": "assignn(v60,7);set.scan.start();new.room.v(v60);return;",
  });
  assert.ok(
    review({ removals: ["logic:42"], image }).some(
      ({ document, computedRoomJump }) => document === "logic:1" && computedRoomJump === "logic:42",
    ),
  );
});

test("a binding reservation blocks removal until removed or reassigned", () => {
  const bindings = { theme: { kind: "sound" as const, num: 42 } };
  const findings = review({ removals: ["sound:42"], authoring: authoring({ bindings }) });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.document, "bindings");
  assert.match(findings[0]!.message, /theme/);
  assert.deepEqual(
    review({ removals: ["sound:42"], authoring: authoring({}) }),
    [],
    "reassigning the binding clears the reservation",
  );
});

test("world room plans and exits are LOGIC uses", () => {
  const planned = world({
    "42": { title: "Tower", description: "", exits: { down: 7 } },
  });
  assert.ok(
    review({ removals: ["logic:42"], authoring: authoring({ world: planned }) }).length > 0,
  );
  assert.ok(
    review({ removals: ["logic:7"], authoring: authoring({ world: planned }) }).length > 0,
    "an exit destination is a room use",
  );
  assert.deepEqual(
    review({ removals: ["sound:42"], authoring: authoring({ world: planned }) }),
    [],
  );
});

test("music intent is a SOUND use the same candidate must drop", () => {
  const music = { "42": { revision: "1-00000000", tempo: 120 } };
  assert.ok(review({ removals: ["sound:42"], authoring: authoring({ music }) }).length > 0);
  assert.deepEqual(review({ removals: ["sound:42"], authoring: authoring({ music: {} }) }), []);
});

test("required LOGIC 0 can never be removed", () => {
  const findings = review({ removals: ["logic:0"], image: imageFor({}) });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /logic:0/);
});

test("stored tests contribute room uses, expectations and opaque save images", () => {
  const tests = new TextDecoder().decode(
    serializeGameTests([
      {
        name: "tower walk",
        room: 7,
        spawnX: null,
        spawnY: null,
        steps: [
          {
            action: "wait",
            command: null,
            direction: null,
            key: null,
            x: null,
            y: null,
            answer: null,
            until: { room: 42, flag: null, var: null },
            waypoints: null,
            target: null,
            ticks: 5,
            captureTicks: null,
          },
        ],
        expect: null,
        cycleBudget: null,
      },
    ]),
  );
  const waiting = review({ removals: ["logic:42"], tests });
  assert.equal(waiting.length, 1);
  assert.match(waiting[0]!.message, /waits for logic:42/);
  const entered = review({ removals: ["logic:7"], tests });
  assert.equal(entered.length, 1);
  assert.match(entered[0]!.message, /enters logic:7/);
  assert.deepEqual(
    review({ removals: ["logic:9"], tests }),
    [],
    "an unrelated test room does not block",
  );
});

test("an unreadable tests document cannot prove removal safe", () => {
  const findings = review({ removals: ["sound:9"], tests: "not json" });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /cannot be enumerated/);
  const bytes = review({ removals: ["sound:9"], tests: Uint8Array.of(0xff, 0xfe) });
  assert.equal(bytes.length, 1);
});

test("reference-art metadata blocks removal of its association and refuses unknown shapes", () => {
  const references = JSON.stringify([
    { id: "r1", kind: "room", target: 42, brief: "tower", images: [], attachedAt: {} },
  ]);
  const findings = review({ removals: ["logic:42"], references });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /targets logic:42/);
  assert.deepEqual(review({ removals: ["sound:42"], references }), []);
  assert.ok(
    review({ removals: ["sound:42"], references: '[{"kind":"note"}]' }).length > 0,
    "an unrecognized entry cannot be inventoried",
  );
  assert.ok(review({ removals: ["sound:42"], references: "not json" }).length > 0);
});

test("an unselected dirty source draft still names uses the candidate repaired away", () => {
  const findings = review({
    removals: ["sound:42"],
    image: imageFor({ "0": "return;" }),
    drafts: [{ key: "logic:7", content: "sound(42, f90); return;" }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.document, "logic:7");
  assert.match(findings[0]!.message, /still used by draft logic:7/);
});

test("a syntax-damaged draft cannot prove it holds no use", () => {
  const findings = review({
    removals: ["sound:42"],
    drafts: [{ key: "logic:7", content: "if (unfinished" }],
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /syntax damage/);
});

test("an unresolved same-family operand in a dirty draft blocks only that family", () => {
  const drafts = [{ key: "logic:7", content: "set.view.v(o0, v9); return;" }];
  const sameFamily = review({ removals: ["view:5"], drafts });
  assert.equal(sameFamily.length, 1);
  assert.match(sameFamily[0]!.message, /view:5 may still be used/);
  assert.deepEqual(
    review({ removals: ["sound:42"], drafts }),
    [],
    "an unresolved view operand says nothing about a SOUND removal",
  );
});

test("a dirty bindings draft reserves against removal too", () => {
  const drafts = [
    { key: "bindings", content: JSON.stringify({ cue: { kind: "sound", num: 42 } }) },
  ];
  assert.ok(review({ removals: ["sound:42"], drafts }).length > 0);
});

test("a dirty byte-carried LOGIC draft is disassembled for its uses", () => {
  const payload = compileProjectLogic("sound(42, f90); return;", {
    profile,
    dictionary: new Map(),
    bindings: {},
  }).assembly.payload;
  const findings = review({
    removals: ["sound:42"],
    drafts: [{ key: "logic:7", content: payload }],
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /sound:42 is still used by draft logic:7/);
});

test("a damaged image document cannot prove removal safe", () => {
  const container = openContainer(new Map(), { profile });
  container.putResource("logic", 3, Uint8Array.of(0xff, 0xff, 0x01, 0x02));
  const image = inspectProjectReferences({ container, profile });
  assert.ok(image.unknownDocuments.length > 0, "the truncated logic is unreadable");
  const findings = review({ removals: ["sound:42"], image });
  assert.ok(findings.length > 0);
});
