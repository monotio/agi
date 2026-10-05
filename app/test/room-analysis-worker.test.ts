import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, reactive } from "vue";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { createContainer } from "../../src/container/container.ts";
import type { RoomAnalysisAnswer, RoomAnalysisInput } from "../src/world/roomAnalysisRunner.ts";
import { useRoomMap } from "../src/world/useRoomMap.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import { testRevision } from "./identity.ts";

test("a pending room scan keeps positions and rejects cancelled revision answers", async () => {
  const files = Object.fromEntries(createContainer().files);
  let game = { installed: true, title: "Paths", revision: testRevision("one"), files, words: [] };
  const state = reactive({
    phase: "running",
    patchTick: 0,
    worldTick: 0,
    roomJournal: [],
    walkthrough: { active: false },
  }) as unknown as EngineState;
  const requests: { answer: (result: RoomAnalysisAnswer) => void; cancelled: boolean }[] = [];
  const map = useRoomMap({
    state,
    hook: reactive({ room: 1 }) as TextHook,
    getBootedGame: () => game,
    getSession: () => null,
    pauseEngine() {},
    resumeEngine() {},
    pauseWalkthrough() {},
    resumeWalkthrough() {},
    startAnalysis: (_input, answer) => {
      const request = { answer, cancelled: false };
      requests.push(request);
      return () => {
        request.cancelled = true;
      };
    },
  });
  assert.equal(requests.length, 0, "Play boot waits for a map or Create activity");
  map.openMap({ experience: "create" });
  void map.resources.value;
  assert.equal(requests.length, 1);
  const scan = {
    targets: [{ to: 2 }],
    variableTarget: false,
    calls: [],
    unresolvedCall: false,
    pictures: [],
    unresolvedPicture: false,
    roomEvidence: true,
  };
  requests[0]!.answer({ phase: "literal", scans: new Map([[1, scan]]), shared: new Set([0]) });
  await nextTick();
  map.select(1);
  const position = map.positionFor(1);
  requests[0]!.answer({
    phase: "resolved",
    scans: new Map([[1, { ...scan, targets: [{ to: 2 }, { to: 3 }] }]]),
    shared: new Set([0]),
  });
  await nextTick();
  assert.deepEqual(map.positionFor(1), position);
  assert.equal(map.selected.value, 1);
  game.revision = testRevision("two");
  state.patchTick++;
  await nextTick();
  void map.resources.value;
  assert.equal(requests[0]!.cancelled, true);
  requests[0]!.answer({ phase: "resolved", scans: new Map([[99, scan]]), shared: new Set() });
  await nextTick();
  assert.equal(map.resources.value.scans.has(99), false);
  game = { ...game, title: "Another game" };
  state.patchTick++;
  await nextTick();
  assert.equal(requests[1]!.cancelled, true);
  requests[1]!.answer({ phase: "resolved", scans: new Map([[99, scan]]), shared: new Set() });
  void map.resources.value;
  assert.equal(map.resources.value.scans.has(99), false);
  assert.equal(
    requests.length,
    3,
    "another game owns a fresh scan even with the same resource bytes",
  );
  game.files = { LOGDIR: Uint8Array.of(0, 0, 0), "VOL.0": Uint8Array.of(0) };
  state.patchTick++;
  await nextTick();
  assert.equal(requests[2]!.cancelled, true);
  assert.equal(map.resources.value.scans.size, 0);
  void map.resources.value;
  assert.equal(
    requests.length,
    3,
    "a corrupt container keeps the observed graph and sends no old payloads",
  );
  state.phase = "idle";
  await nextTick();
});

test("the module worker posts literal routes before its resolved answer", async () => {
  const messages: RoomAnalysisAnswer[] = [];
  const port = {
    onmessage: null as null | ((event: MessageEvent<RoomAnalysisInput>) => void),
    postMessage: (message: RoomAnalysisAnswer) => messages.push(message),
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", { value: port, configurable: true });
  try {
    await import("../src/world/roomAnalysis.worker.ts");
    port.onmessage!({
      data: {
        logics: new Map([
          [
            1,
            assembleLogic("assignn(v60,2);new.room.v(v60);return;", { dictionary: new Map() })
              .payload,
          ],
        ]),
      },
    } as unknown as MessageEvent<RoomAnalysisInput>);
    assert.deepEqual(
      messages.map((message) => message.phase),
      ["literal", "resolved"],
    );
    const [literal, resolved] = messages;
    assert.ok(literal && literal.phase === "literal");
    assert.ok(resolved && resolved.phase === "resolved");
    assert.deepEqual(literal.scans.get(1)?.targets, []);
    assert.deepEqual(resolved.scans.get(1)?.targets, [{ to: 2 }]);
  } finally {
    if (original) Object.defineProperty(globalThis, "self", original);
    else Reflect.deleteProperty(globalThis, "self");
  }
});
