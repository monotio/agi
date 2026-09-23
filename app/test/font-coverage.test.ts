import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_GAMES } from "../../src/games/knownGames.ts";
import { parseLogicResource } from "../../src/logic/resource.ts";
import { fixtureSkip } from "../../test/fixtures.ts";
import { loadGame } from "../../test/game-fixture.ts";
import { HAS_GLYPH } from "../src/font8x8.ts";

/**
 * Every character a catalogued game's messages print has a glyph in the 8×8
 * font (docs/fidelity.md "Text beyond ASCII"). A newline breaks the line and
 * is never drawn; a tab, which three games print once each, has no evidence
 * of how the originals drew it, so it shows blank and is reported.
 */
const NOT_DRAWN = new Set([0x0a, 0x09]);

for (const game of KNOWN_GAMES.filter((entry) => !entry.builtin)) {
  const missing = fixtureSkip(game.alias, [], { checkVolumes: "shipped" });
  test(`${game.alias}: the font draws every character its messages print`, (t) => {
    if (missing) return t.skip(missing);
    const { container } = loadGame(game.alias, { checkVolumes: "shipped" });
    const undrawn = new Set<string>();
    for (let num = 0; num < 256; num++) {
      let payload: Uint8Array | null;
      try {
        payload = container.getResource("logic", num);
      } catch {
        continue; // a damaged record some releases ship; not text
      }
      if (!payload) continue;
      for (const message of parseLogicResource(payload).messages)
        for (const ch of message ?? "") {
          const code = ch.charCodeAt(0);
          if (!NOT_DRAWN.has(code) && !HAS_GLYPH[code])
            undrawn.add(`0x${code.toString(16)} in logic ${num}`);
        }
    }
    assert.deepEqual([...undrawn], []);
  });
}
