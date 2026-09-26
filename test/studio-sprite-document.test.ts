import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { TUTORIAL_VIEW_SOURCES } from "../games/adventure-department/game.ts";
import { KNOWN_GAME_HASH, type GameHash } from "../src/games/knownGames.ts";
import { DEFAULT_V2_PROFILE, detectProfile, PROFILES } from "../src/runtime/profile.ts";
import { buildView, parseView } from "../src/view/view.ts";
import {
  buildSprite,
  openSprite,
  reencodeSprite,
  type SpriteProfile,
} from "../src/studio/sprite/spriteDocument.ts";
import { applySpriteEdit } from "../src/studio/sprite/spriteOperations.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";
import { mirroredView } from "./studio-sprite-fixture.ts";

const V2 = DEFAULT_V2_PROFILE;

/** Every loop's displayed cels as plain arrays, for comparing decodes. */
function displays(payload: Uint8Array, profile: SpriteProfile): number[][][] {
  return parseView(payload, profile).loops.map((loop) =>
    loop.cels.map((cel) => [cel.width, cel.height, cel.transparentColor, ...cel.pixels]),
  );
}

describe("sprite document", () => {
  it("opens loops, aliases, display pixels and mirror bits", () => {
    const document = openSprite(mirroredView(), V2);
    assert.equal(document.loops.length, 3);
    const [owner, mirror, plain] = document.loops;
    assert.equal(owner!.alias, null);
    assert.equal(owner!.mirroredDisplay, false);
    assert.equal(mirror!.alias, 0);
    assert.equal(mirror!.mirroredDisplay, true);
    assert.equal(plain!.alias, null);
    // Loop 0 cel 0 stores [1,2 / 3,0]; its mirror shows each row reversed.
    assert.deepEqual([...owner!.cels[0]!.pixels], [1, 2, 3, 0]);
    assert.deepEqual([...mirror!.cels[0]!.pixels], [2, 1, 0, 3]);
    assert.deepEqual([...mirror!.cels[1]!.pixels], [6, 5, 4, 8, 7, 0]);
    const cel = owner!.cels[1]!;
    assert.deepEqual(
      [cel.width, cel.height, cel.transparent, cel.mirrorBit, cel.mirrored],
      [3, 2, 0, true, false],
    );
    assert.equal(mirror!.cels[1]!.mirrored, true);
    // The builder marks only mirrored carriers mirrorable.
    assert.equal(plain!.cels[0]!.mirrorBit, false);
    assert.equal(plain!.cels[0]!.transparent, 15);
    assert.deepEqual(
      document.groups.map((group) => group.members),
      [[0, 1], [2]],
    );
  });

  it("builds the original bytes for an untouched document and guards the encoding", () => {
    const payload = mirroredView();
    const built = buildSprite(openSprite(payload, V2), V2);
    assert.deepEqual(built, payload);
    assert.notEqual(built, payload);
    assert.throws(
      () => buildSprite(openSprite(payload, V2), PROFILES["2.230"]),
      /different VIEW loop-header encoding/,
    );
  });

  it("returns to the original bytes where the builder would pack differently", () => {
    // One loop, one 3x1 cel shown [1,1,0], stored as split runs 0x11 0x11 and
    // an explicit transparent run 0x01; the builder would write 0x12. Header
    // bytes 0..1 hold 1,1 where the builder writes 0,0.
    // prettier-ignore
    const original = Uint8Array.of(
      1, 1, 1, 0, 0, 7, 0, // header, loop offset 7
      1, 3, 0, // loop: 1 cel at +3
      3, 1, 0x00, 0x11, 0x11, 0x01, 0x00, // cel: 3x1, transparent 0
    );
    const document = openSprite(original, V2);
    assert.deepEqual([...document.loops[0]!.cels[0]!.pixels], [1, 1, 0]);
    const paint = (color: number) =>
      applySpriteEdit(document, {
        type: "setPixels",
        loop: 0,
        cel: 0,
        changes: [{ x: 0, y: 0, color }],
      });
    const edited = paint(2);
    assert.ok("document" in edited);
    // prettier-ignore
    assert.deepEqual([...edited.document.payload], [
      1, 1, 1, 0, 0, 7, 0,
      1, 3, 0,
      3, 1, 0x00, 0x21, 0x11, 0x00,
    ]);
    const back = applySpriteEdit(edited.document, {
      type: "setPixels",
      loop: 0,
      cel: 0,
      changes: [{ x: 0, y: 0, color: 1 }],
    });
    assert.ok("document" in back);
    assert.deepEqual(back.document.payload, original);
    assert.notDeepEqual(reencodeSprite(back.document), original);
  });

  it("round-trips every tutorial and synthetic-game view byte for byte", () => {
    const payloads: Uint8Array[] = Object.values(TUTORIAL_VIEW_SOURCES).map((input) =>
      buildView(input),
    );
    const synthetic = loadGame(KNOWN_GAME_HASH.SYNTHETIC).container;
    for (let num = 0; num < 256; num++) {
      const view = synthetic.getResource("view", num);
      if (view) payloads.push(view);
    }
    assert.equal(payloads.length, Object.keys(TUTORIAL_VIEW_SOURCES).length + 2);
    for (const payload of payloads) {
      const document = openSprite(payload, V2);
      assert.deepEqual(buildSprite(document, V2), payload);
      // Re-encoding without the short cut still displays the same pixels.
      assert.deepEqual(displays(reencodeSprite(document), V2), displays(payload, V2));
    }
  });
});

const COMMERCIAL = Object.entries(KNOWN_GAME_HASH).filter(
  ([name]) => name !== "SYNTHETIC" && name !== "ADVENTURE_DEPARTMENT",
) as [string, GameHash][];

for (const [name, hash] of COMMERCIAL) {
  test(
    `sprite document round trip: every ${name} view`,
    { skip: fixtureSkip(hash, [], { checkVolumes: "shipped" }) },
    (t) => {
      const { container, files } = loadGame(hash, {
        interpreterFiles: true,
        checkVolumes: "shipped",
      });
      const profile = detectProfile(files);
      let views = 0;
      let reencodedIdentical = 0;
      const undecodable: number[] = [];
      const unencodable: number[] = [];
      for (let num = 0; num < 256; num++) {
        let payload: Uint8Array | null;
        try {
          payload = container.getResource("view", num);
        } catch {
          continue; // A volume the edition never shipped.
        }
        if (!payload) continue;
        let document;
        try {
          document = openSprite(payload, profile);
        } catch {
          undecodable.push(num);
          continue;
        }
        views++;
        assert.deepEqual(buildSprite(document, profile), payload, `${name} view ${num}`);
        let reencoded: Uint8Array;
        try {
          reencoded = reencodeSprite(document);
        } catch {
          unencodable.push(num);
          continue;
        }
        assert.deepEqual(
          displays(reencoded, profile),
          displays(payload, profile),
          `${name} view ${num} re-encoded`,
        );
        if (reencoded.length === payload.length && reencoded.every((b, i) => b === payload[i]))
          reencodedIdentical++;
      }
      t.diagnostic(
        `${name} (${profile.id}): ${views} views byte-identical untouched; ${reencodedIdentical} also byte-identical re-encoded; undecodable ${JSON.stringify(undecodable)}; unencodable ${JSON.stringify(unencodable)}`,
      );
      assert.ok(views > 0);
    },
  );
}
