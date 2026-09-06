import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTutorial } from "../games/adventure-department/game.ts";
import { openContainer } from "../src/container/container.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { parseSound, type SoundOutput } from "../src/sound/sound.ts";
import { resourceRevision, validateAuthoringState } from "../src/agent/authoringState.ts";

function boot(soundEnabled = true) {
  const game = buildTutorial();
  const container = openContainer(new Map(Object.entries(game.files)));
  const started: number[] = [];
  const output: SoundOutput[] = [];
  const commands: string[] = [];
  const keys: number[] = [];
  const host: EngineHost = {
    print: () => engine.ackPrint(),
    displayAt() {},
    statusLine() {},
    takeInputLine: () => commands.shift() ?? null,
    takeKeys: () => keys.splice(0),
    playSound: (num) => started.push(num),
    soundOutput: (event) => output.push(event),
  };
  const engine = new Engine(container, host, new Map(game.words));
  engine.flags[9] = soundEnabled ? 1 : 0;
  engine.tick();
  return { engine, container, started, output, commands, keys };
}

test("tutorial ships a short melodic opening and compact point/lever effects with editable intent", () => {
  const game = buildTutorial();
  const container = openContainer(new Map(Object.entries(game.files)));
  const introBytes = container.getResource("sound", 1);
  assert.ok(introBytes, "the opening music must be a native SOUND resource");
  const intro = parseSound(introBytes);
  assert.ok(intro.durationSeconds >= 3 && intro.durationSeconds <= 4);
  assert.ok(intro.channels[0]!.notes.filter((note) => note.attenuation < 15).length >= 5);
  assert.ok(intro.channels[1]!.notes.some((note) => note.attenuation < 15));
  assert.equal(intro.channels[3]!.notes.filter((note) => note.attenuation < 15).length, 0);

  for (const num of [2, 3]) {
    const bytes = container.getResource("sound", num);
    assert.ok(bytes, `sound ${num} must be bundled for offline play`);
    const sound = parseSound(bytes);
    assert.ok(sound.durationSeconds >= 0.35 && sound.durationSeconds <= 1);
    assert.ok(sound.channels[0]!.notes.some((note) => note.attenuation < 15));
  }
  assert.notDeepEqual(container.getResource("sound", 2), container.getResource("sound", 3));
  const lever = parseSound(container.getResource("sound", 3)!);
  assert.ok(lever.channels[3]!.notes.some((note) => note.attenuation < 15));

  const saved = game.project!.authoringState!;
  const authoring = validateAuthoringState(saved["authoring"]);
  assert.equal(authoring.music?.["1"]?.revision, resourceRevision(introBytes));
  assert.ok(authoring.music!["1"]!.tempo > 0);
  assert.equal(authoring.music?.["2"], undefined, "confirmation effects are not inferred music");
  assert.equal(authoring.music?.["3"], undefined);
  const sources = saved["sources"] as { sounds: [number, unknown][] };
  assert.deepEqual(sources.sounds.map(([num]) => num).sort(), [1, 2, 3]);
});

test("opening tune starts in the displayed room once and never blocks movement or replays on return", () => {
  const { engine, container, started, output, commands, keys } = boot();
  assert.equal(engine.vars[0], 1);
  assert.deepEqual(started, [1]);
  engine.soundTick();
  assert.ok(output.some((event) => event.kind === "psg" && event.bytes.length === 2));
  const x = engine.readObjects()[0]!.x;
  keys.push(0x4d00);
  engine.tick();
  assert.ok(engine.readObjects()[0]!.x > x, "music must not wait before accepting movement");
  const ticks = parseSound(container.getResource("sound", 1)!).duration;
  for (let tick = 0; tick <= ticks; tick++) engine.soundTick();
  for (let cycle = 0; cycle < 20; cycle++) engine.tick();
  assert.deepEqual(started, [1], "the intro is not background music on a loop");
  const snapshot = engine.serialize();
  engine.restoreImage(snapshot);
  engine.tick();
  commands.push("east");
  engine.tick();
  commands.push("west");
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.deepEqual(
    started,
    [1],
    "restoring and returning to the gallery must not replay the intro",
  );
});

test("each earned repair plays exactly one success cue and repeated commands stay quiet", () => {
  const { engine, started, commands } = boot();
  commands.push("paint mural");
  engine.tick();
  assert.deepEqual(started, [1, 2], "the earned point cue replaces the opening immediately");
  assert.equal(engine.vars[3], 10);
  commands.push("paint mural");
  engine.tick();
  assert.deepEqual(started, [1, 2]);
  commands.push("east");
  engine.tick();
  commands.push("pull lever");
  engine.tick();
  assert.deepEqual(started, [1, 2, 3], "lever attack and confirmation share one sound resource");
  assert.equal(engine.vars[3], 20);
  for (let cycle = 0; cycle < 20; cycle++) engine.tick();
  commands.push("pull lever");
  engine.tick();
  assert.deepEqual(started, [1, 2, 3]);
  commands.push("east");
  engine.tick();
  commands.push("fix priority");
  engine.tick();
  assert.equal(engine.vars[3], 30);
  assert.deepEqual(started, [1, 2, 3, 2]);
  commands.push("fix priority");
  engine.tick();
  assert.deepEqual(started, [1, 2, 3, 2]);
  assert.equal(engine.vars[3], 30);
});

test("tutorial cues respect an already-muted game without suppressing progression", () => {
  const { engine, output, commands, started } = boot(false);
  assert.deepEqual(started, [1]);
  assert.equal(engine.flags[9], 0);
  engine.soundTick();
  assert.ok(output.length > 0, "the scheduler handles the muted cue rather than omitting it");
  assert.ok(
    output.every(
      (event) => event.kind === "psg" && event.bytes.every((byte) => (byte & 15) === 15),
    ),
  );
  commands.push("paint mural");
  engine.tick();
  engine.soundTick();
  assert.equal(engine.flags[9], 0);
  assert.equal(engine.vars[3], 10);
  assert.ok(
    output.every(
      (event) => event.kind === "psg" && event.bytes.every((byte) => (byte & 15) === 15),
    ),
  );
});
