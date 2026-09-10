import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { detectContainerFormat } from "../src/container/container.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { parseSound } from "../src/sound/sound.ts";
import { parseView } from "../src/view/view.ts";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { createPictureSurface } from "../src/types.ts";
import { fixtureDir, fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional Police Quest 2.903 fixture tests. This build uses the v2
 * container fallback profile, 2.936. Fixture names resolve case-insensitively.
 */
const GAME_ID = "pq1";
const TARGET_HASH = KNOWN_GAME_HASH.PQ1;
const skip = fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]);

test(
  `${GAME_ID}: lowercase installation names enumerate into canonical container files`,
  { skip },
  () => {
    const onDisk = readdirSync(fixtureDir(TARGET_HASH));
    assert.ok(
      onDisk.includes("logdir") && onDisk.includes("vol.0"),
      "the installation ships lowercase names",
    );
    const { files } = loadGame(TARGET_HASH, { interpreterFiles: true });
    assert.deepEqual([...files.keys()].sort(), [
      "AGIDATA.OVL",
      "LOGDIR",
      "OBJECT",
      "PICDIR",
      "SNDDIR",
      "VIEWDIR",
      "VOL.0",
      "VOL.1",
      "VOL.2",
      "VOL.3",
    ]);
  },
);

test(
  `${GAME_ID}: v2 split container, 2.936 profile by container shape, resource census`,
  { skip },
  () => {
    const { container, files } = loadGame(TARGET_HASH, { interpreterFiles: true });
    assert.deepEqual(detectContainerFormat(files), { kind: "v2-split", prefix: "" });
    assert.equal(detectVersionString(files), "2.903");
    const profile = detectProfile(files);
    assert.equal(profile.id, "2.936");
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
    assert.deepEqual(counts, { logic: 118, picture: 71, view: 220, sound: 36 });
  },
);
