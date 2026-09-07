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
 * Authentic v3 fixture: a local, gitignored King's Quest IV installation
 * (games/kq4: KQ4DIR, KQ4VOL.0-3, WORDS.TOK, OBJECT, plus the interpreter
 * files AGI/AGIDATA.OVL/SIERRA.COM). It is the 3.002.086 game of the
 * compatibility set. Counts were read from the fixture bytes; the opening
 * was observed in a headless run.
 */
const SLUG = "kq4";
const skip = fixtureSkip(SLUG, ["AGIDATA.OVL"]);

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
  randomWord(): number {
    // Logic 140 deals the copy protection with random(1, 79, v115) and sends
    // the run to room 141/142/143 by thirds (disassembly-verified). 40 lands
    // v115 at 41, the room-142 third; kq4-regressions uses 66 for room 143.
    return 40;
  }
}

test(`${SLUG}: combined container, 3.002.086 profile, resource census`, { skip }, () => {
  const { container, files } = loadGame(SLUG, { interpreterFiles: true });
  assert.deepEqual(detectContainerFormat(files), { kind: "v3-combined", prefix: "KQ4" });
  assert.equal(detectVersionString(files), "3.002.086");
  const profile = detectProfile(files);
  assert.equal(profile.id, "3.002.086");
  const counts = { logic: 0, picture: 0, view: 0, sound: 0 };
  const junk: string[] = [];
  for (let n = 0; n < 256; n++) {
    for (const kind of ["logic", "picture", "view", "sound"] as const) {
      let payload: Uint8Array | null;
      try {
        payload = container.getResource(kind, n);
      } catch (error) {
        // The one allowed census exception (JUNK_DIRECTORY_ENTRIES in
        // test/fixtures.ts): exactly these four entries reference volumes
        // that never shipped; anything else stays a hard failure.
        assert.match(String(error), /points to missing VOL/, `${kind} ${n}`);
        junk.push(`${kind} ${n}`);
        continue;
      }
      if (!payload) continue;
      if (kind === "logic")
        assert.ok(parseLogicResource(payload).code.length > 0, `logic ${n} has bytecode`);
      if (kind === "picture") renderPicture(payload, createPictureSurface(), { profile });
      if (kind === "view") assert.ok(parseView(payload).loops.length > 0, `view ${n} has a loop`);
      if (kind === "sound") parseSound(payload);
      counts[kind]++;
    }
  }
  assert.deepEqual(junk, ["picture 150", "picture 151", "view 198", "view 199"]);
  assert.deepEqual(counts, { logic: 177, picture: 146, view: 241, sound: 96 });
});

test(`${SLUG}: the opening deals the copy-protection question in room 142`, { skip }, () => {
  const { container, dict, files } = loadGame(SLUG, { interpreterFiles: true });
  const host = new Host();
  const engine = new Engine(container, host, dict, { profile: detectProfile(files) });
  const rooms: number[] = [];
  for (let i = 0; i < 300 && !engine.textRow(6).includes("legal"); i++) {
    engine.advanceClock(50);
    engine.soundTick();
    engine.tick();
    if (rooms[rooms.length - 1] !== engine.vars[0]) rooms.push(engine.vars[0]!);
  }
  assert.match(
    host.prints[0] ?? "",
    /legal ownership.*King's Quest IV manual.*On page 5, what is the seventh word in the fifth paragraph\?/s,
    "the room-142 manual question window is up",
  );
});
