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
import { fixtureDir, fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Authentic v2 fixture: a local, gitignored Police Quest installation
 * (games/pq1). Every file ships lowercase (logdir, vol.0, words.tok,
 * agidata.ovl, ...), so the fixture loader resolves installation names
 * case-insensitively; macOS path lookup masks part of that, Linux does not.
 * The interpreter is the observed 2.903 build, which names no promoted
 * profile, so the v2 container shape selects 2.936. Counts were read from
 * the fixture bytes.
 */
const SLUG = "pq1";
const skip = fixtureSkip(SLUG, ["AGIDATA.OVL"]);

test(
  `${SLUG}: lowercase installation names enumerate into canonical container files`,
  { skip },
  () => {
    const onDisk = readdirSync(fixtureDir(SLUG));
    assert.ok(
      onDisk.includes("logdir") && onDisk.includes("vol.0"),
      "the installation ships lowercase names",
    );
    const { files } = loadGame(SLUG, { interpreterFiles: true });
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
  `${SLUG}: v2 split container, 2.936 profile by container shape, resource census`,
  { skip },
  () => {
    const { container, files } = loadGame(SLUG, { interpreterFiles: true });
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
