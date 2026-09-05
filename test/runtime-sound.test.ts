import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import type { SoundOutput } from "../src/sound/sound.ts";

function game(source: string, soundHost: Partial<EngineHost> = {}): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  // Channel0: duration2 tone0x8123 attenuation4; channels1..3 terminate.
  const sound = new Uint8Array([
    8, 0, 15, 0, 15, 0, 15, 0, 2, 0, 0x23, 0x81, 0x94, 0xff, 0xff, 0xff, 0xff,
  ]);
  container.putResource("sound", 1, sound);
  container.putResource("sound", 2, sound);
  return new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
    ...soundHost,
  });
}

test("sound starts without altering f9 and completes on sound ticks without an audio backend", () => {
  const engine = game("set(f9); load.sound(1); sound(1, f60); return;");
  engine.tick();
  assert.equal(engine.flags[9], 1);
  assert.equal(engine.flags[60], 0);
  engine.soundTick();
  engine.soundTick();
  assert.equal(engine.flags[60], 0);
  engine.soundTick();
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.flags[9], 1);
});

test("v23 controls attenuation on each sound tick without changing completion timing", () => {
  const outputs: SoundOutput[] = [];
  const engine = game("set(f9);load.sound(1);sound(1,f60);return;", {
    soundOutput: (output) => {
      outputs.push(output);
    },
  });
  engine.vars[23] = 15;
  engine.tick();
  engine.soundTick();
  assert.ok(outputs.some((output) => output.kind === "psg" && output.bytes[0] === 0x9f));
  assert.equal(engine.flags[60], 0);
  outputs.length = 0;
  engine.vars[23] = 0;
  engine.soundTick();
  // The second envelope entry is -3: base 4 - 3 + v23(0) = 1.
  assert.ok(outputs.some((output) => output.kind === "psg" && output.bytes[0] === 0x91));
  engine.soundTick();
  assert.equal(engine.flags[60], 1);
});

test("the sound operand selects any loaded resource, and replacing playback completes the old flag", () => {
  const started: number[] = [];
  const engine = game(
    "set(f9); load.sound(1); load.sound(2); sound(1, f60); sound(2, f61); return;",
    {
      playSound: (num) => {
        started.push(num);
      },
    },
  );
  engine.tick();
  assert.deepEqual(started, [1, 2]);
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.flags[61], 0);
  assert.equal(engine.flags[9], 1);
});

test("f9 off gates the next sound tick before any note event", () => {
  const outputs: SoundOutput[] = [];
  const engine = game("reset(f9); load.sound(1); sound(1, f60); return;", {
    soundOutput: (event) => {
      outputs.push(event);
    },
  });
  engine.tick();
  assert.equal(engine.flags[60], 0);
  engine.soundTick();
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.flags[9], 0);
  assert.deepEqual(outputs, [{ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] }]);
});

test("stop.sound is idempotent and does not enable sound", () => {
  let stops = 0;
  const engine = game(
    "reset(f9); load.sound(1); sound(1, f60); stop.sound(); stop.sound(); return;",
    {
      stopSound: () => {
        stops++;
      },
    },
  );
  engine.tick();
  assert.equal(stops, 1);
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.flags[9], 0);
});

test("sound refuses a resource that was never loaded", () => {
  const engine = game("sound(1, f60); return;");
  assert.throws(() => engine.tick(), /sound 1 is not loaded/);
});

test("a sound patch invalidates the cached sound before its next load", () => {
  const outputs: SoundOutput[] = [];
  const engine = game("set(f9); load.sound(1); sound(1, f60); return;", {
    soundOutput: (event) => {
      outputs.push(event);
    },
  });
  engine.tick();
  engine.stopSoundPlayback();
  engine.patchResource(
    "sound",
    1,
    new Uint8Array([8, 0, 15, 0, 15, 0, 15, 0, 2, 0, 0x24, 0x82, 0x94, 0xff, 0xff, 0xff, 0xff]),
  );
  engine.tick();
  outputs.length = 0;
  engine.soundTick();
  assert.deepEqual(outputs[0], { kind: "psg", bytes: [0x82, 0x24] });
});

test("a damaged sound completes its flag and the game continues after playback", () => {
  const logs: string[] = [];
  const engine = game(
    `
    if(!isset(f200)){set(f200);set(f9);load.sound(1);sound(1,f60);}
    if(isset(f60)){assignn(v61,42);}return;
  `,
    {
      logText: (text) => {
        logs.push(text);
      },
    },
  );
  engine.patchResource(
    "sound",
    1,
    Uint8Array.of(8, 0, 99, 0, 99, 0, 99, 0, 2, 0, 0x23, 0x81, 0x94, 255, 255),
  );
  engine.tick();
  assert.equal(engine.flags[60], 0);
  engine.soundTick();
  engine.soundTick();
  assert.equal(engine.flags[60], 0);
  engine.soundTick();
  engine.tick();
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.vars[61], 42);
  assert.ok(logs.some((line) => line.includes("Sound 1") && line.includes("channel")));
});
