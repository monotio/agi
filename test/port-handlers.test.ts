import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

// docs/fidelity.md "Amiga profile fields verified from the handlers" and
// "IIgs profile fields verified from the handlers": behaviors the Amiga and
// IIgs handlers decide differently from the PC base their profiles inherit.

const DICT = new Map<string, number>();

class LogHost implements EngineHost {
  logs: string[] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  logText(text: string): void {
    this.logs.push(text);
  }
}

function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

/** Logic 0 runs `setup` once, then `after` every cycle; sounds 1..3 exist. */
function boot(profile: ProfileId, setup: string, after = "") {
  const source = `
    if (!isset(f200)) { set(f200); ${setup} }
    ${after}
    return;
  `;
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: DICT, profile: PROFILES[profile] }).payload,
  );
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource("view", 0, solidView(4, 10));
  // IIgs type-2 streams: the header's high byte is the first delta, then the
  // 0xfc terminator (docs/fidelity.md "Sound format").
  for (const n of [1, 2, 3]) container.putResource("sound", n, Uint8Array.of(0x02, 0, 0, 0xfc));
  const host = new LogHost();
  const engine = new Engine(container, host, DICT, { profile });
  engine.tick();
  return { engine, host };
}

const TWO_OBJECTS = `
  load.pic(v250); draw.pic(v250); show.pic(); load.view(0); assignn(v251, 1);
  animate.obj(o0); set.view(o0, 0); position(o0, 0, 40);
  step.size(o0, v251); step.time(o0, v251); draw(o0);
  animate.obj(o1); set.view(o1, 0); position(o1, 150, 160);
  step.size(o1, v251); step.time(o1, v251); draw(o1);
`;

test("restart.game on 2.082 prompts even with f16 set; 2.176 restarts", () => {
  // f6 marks the restarted pass, so the one-time setup does not loop.
  const source = "if (!isset(f6)) { set(f16); assignn(v210, 9); restart.game(); }";
  assert.equal(boot("amiga-2.082", source).engine.vars[210], 9, "2.082 waits at the prompt");
  assert.equal(boot("amiga-2.176", source).engine.vars[210], 0, "2.176 restarted");
});

test("distance saturates at 254 on Amiga 2.176+, 255 on the IIgs, and wraps on 2.082", () => {
  // Centers (2, 40) and (152, 160): |150| + |120| = 270.
  for (const [id, expected] of [
    ["amiga-2.316", 254],
    ["iigs-1.014", 255],
    ["amiga-2.082", 270 & 0xff],
  ] as const) {
    const { engine } = boot(id, TWO_OBJECTS, "distance(o0, o1, v100);");
    engine.tick();
    assert.equal(engine.vars[100], expected, id);
  }
});

test("move.obj steers in its own cycle on 2.176 and waits a cycle on 2.082", () => {
  for (const [id, heading] of [
    ["amiga-2.176", 1],
    ["amiga-2.082", 0],
  ] as const) {
    const { engine } = boot(id, `${TWO_OBJECTS} move.obj(o1, 150, 20, 1, f230);`);
    assert.equal(engine.screenObjects[1]!.direction, heading, id);
  }
});

test("IIgs discard.sound releases the named sound and every later one", () => {
  const { engine } = boot(
    "iigs-1.014",
    "load.sound(1); load.sound(2); load.sound(3); discard.sound(2);",
    "if (isset(f201)) { reset(f201); sound(1, f210); } if (isset(f202)) { reset(f202); sound(3, f211); }",
  );
  engine.flags[201] = 1;
  assert.doesNotThrow(() => engine.tick(), "sound 1 stays loaded");
  engine.flags[202] = 1;
  assert.throws(() => engine.tick(), /sound 3 is not loaded/);
});

test("IIgs discard.sound replays on restore", () => {
  const { engine } = boot("iigs-1.014", "load.sound(1); load.sound(2); discard.sound(2);");
  const image = engine.autosaveImage();
  assert.ok(image);
  const restored = boot(
    "iigs-1.014",
    "",
    "if (isset(f202)) { reset(f202); sound(2, f211); }",
  ).engine;
  restored.restoreImage(image);
  restored.flags[202] = 1;
  assert.throws(() => restored.tick(), /sound 2 is not loaded/);
});

test("show.mem prints no rm.0 line on the Amiga and IIgs", () => {
  for (const [id, lines] of [
    ["amiga-2.316", 3],
    ["iigs-1.014", 3],
    ["2.936", 4],
  ] as const) {
    const { host } = boot(id, "show.mem();");
    assert.equal(host.logs.at(-1)?.split("\n").length, lines, id);
  }
});
