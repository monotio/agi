import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContainerFormat } from "../src/container/container.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { parseSound } from "../src/sound/sound.ts";
import { parseView } from "../src/view/view.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { createPictureSurface } from "../src/types.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Authentic v3 fixture: a local, gitignored Gold Rush! installation
 * (games/gr1: GRDIR, GRVOL.0-2, WORDS.TOK, OBJECT, plus the interpreter files
 * AGI/AGIDATA.OVL/SIERRA.COM). It is the 3.002.149 game of the compatibility
 * set, the last of the v3 line; AGIDATA.OVL carries the version string.
 * Counts were read from the fixture bytes; the opening was observed in a
 * headless run.
 */
const SLUG = "gr1";
const skip = fixtureSkip(SLUG);

class Host implements EngineHost {
  keys: number[] = [];
  prints: string[] = [];
  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

test(`${SLUG}: combined container, 3.002.149 profile by default, resource census`, { skip }, () => {
  const { container, files } = loadGame(SLUG, { interpreterFiles: true });
  assert.deepEqual(detectContainerFormat(files), { kind: "v3-combined", prefix: "GR" });
  assert.equal(detectVersionString(files), "3.002.149");
  const profile = detectProfile(files);
  assert.equal(profile.id, "3.002.149");
  const counts = { logic: 0, picture: 0, view: 0, sound: 0 };
  for (let n = 0; n < 256; n++) {
    const logic = container.getResource("logic", n);
    if (logic) {
      assert.ok(parseLogicResource(logic).code.length > 0, `logic ${n} has bytecode`);
      counts.logic++;
    }
    const picture = container.getResource("picture", n);
    if (picture) {
      renderPicture(picture, createPictureSurface(), { profile });
      counts.picture++;
    }
    const view = container.getResource("view", n);
    if (view) {
      assert.ok(parseView(view).loops.length > 0, `view ${n} has a loop`);
      counts.view++;
    }
    const sound = container.getResource("sound", n);
    if (sound) {
      parseSound(sound);
      counts.sound++;
    }
  }
  assert.deepEqual(counts, { logic: 182, picture: 186, view: 247, sound: 44 });
});

test(
  `${SLUG}: the opening runs from the title into the first street with its status line`,
  { skip },
  () => {
    const { container, dict, files } = loadGame(SLUG, { interpreterFiles: true });
    const host = new Host();
    const engine = new Engine(container, host, dict, { profile: detectProfile(files) });
    const rooms: number[] = [];
    for (let i = 0; i < 600; i++) {
      engine.advanceClock(50);
      for (let t = 0; t < 3; t++) engine.soundTick();
      engine.tick();
      if (host.prints.length && engine.modalKind === "print") {
        host.prints.length = 0;
        engine.ackPrint();
      }
      if (i === 40) host.keys.push(0x0d);
      if (rooms[rooms.length - 1] !== engine.vars[0]) rooms.push(engine.vars[0]!);
    }
    assert.deepEqual(rooms, [129, 73, 1]);
    assert.match(engine.textRow(0), /Score: 0 of 250/);
  },
);
