import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSound, SoundPlayback } from "../src/sound/sound.ts";
import { detectProfile, type ProfileId } from "../src/runtime/profile.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

const games: { slug: string; profile: ProfileId; damaged: number[]; unreadable: number[] }[] = [
  { slug: "kq1", profile: "2.917", damaged: [], unreadable: [34, 35, 36, 37] },
  { slug: "kq2", profile: "2.411", damaged: [], unreadable: [] },
  { slug: "kq3", profile: "2.936", damaged: [36], unreadable: [] },
];

for (const game of games) {
  test(
    `${game.slug}: every installed sound completes bounded playback`,
    { skip: fixtureSkip(game.slug) },
    () => {
      const { container } = loadGame(game.slug);
      const damaged: number[] = [];
      const unreadable: number[] = [];
      let count = 0;
      for (let id = 0; id < 256; id++) {
        let payload: Uint8Array | null;
        try {
          payload = container.getResource("sound", id);
        } catch (error) {
          assert.match(String(error), /corrupt container/);
          unreadable.push(id);
          continue;
        }
        if (!payload) continue;
        count++;
        try {
          parseSound(payload);
        } catch {
          damaged.push(id);
        }
        for (const device of [0, 1]) {
          const playback: SoundPlayback = new SoundPlayback(
            detectProfile(new Map(), game.profile),
            payload,
            device,
          );
          let complete = false;
          for (let tick = 0; tick < 60_000 && !complete; tick++) {
            complete = playback.tick(true, 0).complete;
          }
          assert.equal(complete, true, `sound ${id}, device ${device}: playback must terminate`);
        }
      }
      assert.ok(count > 0, "the installation includes sound resources");
      assert.deepEqual(
        unreadable,
        game.unreadable,
        "only known directory entries are out of bounds",
      );
      assert.deepEqual(
        damaged,
        game.damaged,
        "strict validation identifies the known damaged resource",
      );
    },
  );
}
