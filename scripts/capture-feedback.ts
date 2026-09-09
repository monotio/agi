/** Capture real agent-tool output from the original tutorial, without a provider call. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTutorial } from "../games/adventure-department/game.ts";
import { TUTORIAL_GAME_TESTS } from "../games/adventure-department/tests.ts";
import { Engine } from "../src/runtime/engine.ts";
import { openContainer } from "../src/container/container.ts";
import { planWalk, renderNavigationSnapshot } from "../src/agent/navigation.ts";
import {
  createAgentSessionState,
  executeAgentTool,
  type AgentToolResult,
} from "../src/agent/tools.ts";

const output = resolve(process.argv[2] ?? ".captures/feedback");
mkdirSync(output, { recursive: true });
const tutorial = buildTutorial();
const session = createAgentSessionState(openContainer(new Map(Object.entries(tutorial.files))));
const manifest: { name: string; message?: string; files: { name: string; caption: string }[] }[] =
  [];

function save(name: string, result: AgentToolResult): void {
  assert.equal(result.success, true, result.error ?? "Tool capture failed");
  const files: { name: string; caption: string }[] = [];
  for (const [index, image] of (result.images ?? []).entries()) {
    const file = `${name}-${index + 1}.png`;
    assert.deepEqual([...image.png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(resolve(output, file), image.png);
    files.push({ name: file, caption: image.caption });
  }
  for (const [index, audio] of (result.audio ?? []).entries()) {
    const file = `${name}-${index + 1}.wav`;
    assert.equal(Buffer.from(audio.wav.slice(0, 4)).toString("ascii"), "RIFF");
    writeFileSync(resolve(output, file), audio.wav);
    files.push({ name: file, caption: audio.caption });
  }
  assert.ok(files.length, `${name} returned no media`);
  manifest.push({ name, ...(result.message ? { message: result.message } : {}), files });
}

save("picture-controls", executeAgentTool(session, "read_picture", { num: 1, include: "both" }));
save(
  "sound-timeline",
  executeAgentTool(session, "read_sound", { num: 1, representation: "music" }),
);
save(
  "sound-preview",
  executeAgentTool(session, "preview_sound", {
    num: 1,
    startSeconds: 0,
    durationSeconds: 4,
    device: "tandy",
  }),
);
const lever = TUTORIAL_GAME_TESTS[1]!;
const result = executeAgentTool(session, "playtest_room", {
  room: lever.room,
  spawnX: lever.spawnX,
  spawnY: lever.spawnY,
  steps: lever.steps.map((step) =>
    step["action"] === "wait" ? { ...step, captureTicks: [1, 8, 16] } : step,
  ),
  expect: lever.expect,
});
assert.equal(result.details?.["simulation"], "passed", result.error ?? "Playtest did not pass");
assert.equal(result.images?.length, 2, "playtest must return a frame and checkpoint sheet");
save("playtest-lever", result);
const engine = new Engine(
  openContainer(new Map(Object.entries(tutorial.files))),
  {
    print() {
      engine.ackPrint();
    },
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  },
  new Map(tutorial.words),
);
for (let cycle = 0; cycle < 10; cycle++) engine.tick();
const navigation = {
  engine,
  state() {
    const ego = engine.screenObjects[0]!;
    return { room: engine.vars[0]!, x: ego.x, y: ego.y };
  },
};
const target = { x0: 120, x1: 120, y0: 140, y1: 140 };
const plan = planWalk(navigation, target);
const snapshot = renderNavigationSnapshot(navigation, target, plan);
writeFileSync(resolve(output, "gallery-navigation.png"), snapshot.png);
writeFileSync(resolve(output, "gallery-navigation.json"), snapshot.json);
manifest.push({
  name: "gallery-navigation",
  files: [
    {
      name: "gallery-navigation.png",
      caption:
        "Original tutorial scene and live controls, with an advisory candidate path in yellow. This image shows planning, not an executed walkthrough.",
    },
  ],
});
writeFileSync(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Captured ${manifest.length} tool results in ${output}`);
