import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, buildObjectFile } from "../src/agent/agentState.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { pcDisplaysFor, type PcDisplay } from "../src/runtime/display.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { validateEngineReplayState } from "../src/runtime/replayState.ts";
import { decodePng } from "../scripts/png.ts";

// Rule from docs/fidelity.md "PC fonts and display adapters": a game the
// player started on the CGA card stays on it. Recorded tests and history
// replay carry the card in the replay state, so a recording made on CGA
// replays on CGA (v26 reads the CGA RGB monitor type 1, EGA reads 3).

const HOST: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function engine(pcDisplay: PcDisplay): Engine {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary }).payload);
  const e = new Engine(container, HOST, dictionary, { profile: "2.936", pcDisplay });
  e.tick();
  return e;
}

test("a CGA session's replay state names the card and an EGA one leaves it out", () => {
  const cga = engine("cga-rgb");
  assert.equal(cga.pcDisplay, "cga-rgb");
  const state = cga.captureReplayState(true);
  assert.equal(state.pcDisplay, "cga-rgb");
  const ega = engine("ega").captureReplayState(true);
  assert.equal(Object.hasOwn(ega, "pcDisplay"), false, "EGA is the default and stays implicit");

  // The stored form round-trips, and only the CGA card is a valid value.
  const stored = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  assert.deepEqual(validateEngineReplayState(stored), state);
  assert.equal(validateEngineReplayState(stored).pcDisplay, "cga-rgb");
  assert.equal(
    Object.hasOwn(validateEngineReplayState(JSON.parse(JSON.stringify(ega))), "pcDisplay"),
    false,
  );
  for (const bad of ["ega", "cga", "CGA-RGB", "cga-composite", "", 1, null, true]) {
    assert.throws(
      () => validateEngineReplayState({ ...stored, pcDisplay: bad }),
      /Replay display must be cga-rgb/,
      `rejects ${JSON.stringify(bad)}`,
    );
  }
});

/** One loop, two cels: cel 0 is colour 1 over transparent 5, cel 1 is colour 5 over transparent 0. */
const TWO_CEL_VIEW = new Uint8Array([
  0, 0, 1, 0, 0, 7, 0,
  // loop at 7: two cels at loop+5 and loop+10
  2, 5, 0, 10, 0,
  // cel 0 at 12: width 2, height 1, transparent 5, run colour 1 × 2
  2, 1, 0x05, 0x12, 0,
  // cel 1 at 17: width 2, height 1, transparent 0, run colour 5 × 2
  2, 1, 0x00, 0x52, 0,
]);

/**
 * A room that stamps cel 1 of TWO_CEL_VIEW at picture (20,100) on a white
 * picture, recorded on the CGA card. The CGA driver's view conversion turns
 * that cel's colour 5 transparent (docs/fidelity.md "PC fonts and display
 * adapters"), so the white picture shows where EGA draws magenta.
 */
function cgaRecording() {
  const state = createAgentSessionState();
  state.objectPayload = buildObjectFile([], state.profile, 20);
  state.container.putResource("picture", 1, Uint8Array.of(0xff));
  state.container.putResource("view", 3, TWO_CEL_VIEW);
  state.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) {set(f200);new.room(1);} call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      "if (isset(f5)) {load.pic(v0);draw.pic(v0);show.pic();load.view(3);add.to.pic(3,0,1,20,100,15,4);} increment(v40); return;",
      { dictionary: new Map() },
    ).payload,
  );
  const recorder = new Engine(openContainer(state.getFiles()), HOST, undefined, {
    profile: state.profile,
    pcDisplay: "cga-rgb",
  });
  recorder.tick();
  assert.equal(recorder.pcDisplay, "cga-rgb", `${state.profile} offers the CGA card`);
  return {
    state,
    image: recorder.autosaveImage()!,
    replay: recorder.captureReplayState(),
  };
}

test("a recorded test made on the CGA card replays on the CGA card", () => {
  const { state, image, replay } = cgaRecording();
  assert.ok(pcDisplaysFor(state.profile).includes("cga-rgb"));
  assert.equal(replay.pcDisplay, "cga-rgb");
  /** The playtest's final frame at the stamped cel, as [r, g, b]. */
  const stamped = (recorded: typeof replay): number[] => {
    const result = playtestRoom(
      state,
      { room: 1, steps: [] },
      { setupImage: image, replay: { state: recorded, operations: [["clock", 1]] } },
    );
    assert.equal(result.success, true, result.error ?? result.message ?? "");
    const frame = decodePng(result.images![0]!.png);
    // One picture pixel is two frame pixels wide; the picture starts at text row 1.
    const at = ((100 + 8) * frame.width + 40) * 4;
    return Array.from(frame.rgba.slice(at, at + 3));
  };
  assert.deepEqual(stamped(replay), [255, 255, 255], "CGA hides the cel's colour 5");
  // The same recording without the card replays on EGA, which draws colour 5.
  const withoutCard = { ...replay };
  delete withoutCard.pcDisplay;
  assert.deepEqual(stamped(withoutCard), [170, 0, 170], "EGA draws the cel's colour 5");
});
