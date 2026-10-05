import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  DISK_IMAGE_FIXTURES,
  diskImageFixture,
  diskImageSkip,
  fixtureDir,
  fixtureFiles,
  fixtureSkip,
} from "./fixtures.ts";
import { readGameFiles } from "../app/src/archive/gameZip.ts";
import { canonicalResourceName } from "../src/container/playableFiles.ts";
import { detectProfile } from "../src/runtime/profile.ts";

for (const [edition, hashes] of Object.entries(DISK_IMAGE_FIXTURES)) {
  const unpacked =
    edition === "sq2-tandy"
      ? "sq2"
      : edition.startsWith("sq2-iigs")
        ? "sq2-iigs"
        : edition === "ddp-booter"
          ? "ddp"
          : edition;
  test(
    `original ${edition} images match unpacked resources or report edition differences`,
    { skip: diskImageSkip(hashes) || fixtureSkip(unpacked) },
    (t) => {
      const images = hashes.map((hash) => diskImageFixture(hash)!);
      const game = readGameFiles(
        new Map(images.map((image, index) => [`${index}/${image.name}`, image.bytes])),
      );
      const files = fixtureFiles(unpacked)!;
      const expected = new Map(
        [...files.values()]
          .filter((name) => statSync(fixtureDir(unpacked) + name).isFile())
          .map((name) => [
            canonicalResourceName(name),
            new Uint8Array(readFileSync(fixtureDir(unpacked) + name)),
          ]),
      );
      const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const words = digest(game.files["WORDS.TOK"]!);
      const expectedWords = digest(expected.get("WORDS.TOK")!);
      if (words !== expectedWords) {
        t.diagnostic(
          `Version difference: disk WORDS.TOK ${words}; unpacked WORDS.TOK ${expectedWords}.`,
        );
        return;
      }
      assert.equal(
        detectProfile(new Map(Object.entries(game.files))).id,
        detectProfile(expected).id,
      );
      for (const [name, bytes] of Object.entries(game.files)) {
        if (!name.endsWith("DIR")) continue;
        const match = expected.get(name);
        assert.ok(match, `unpacked ${name}`);
        if (digest(bytes) !== digest(match)) {
          t.diagnostic(
            `Version difference: ${name} disk ${digest(bytes)}; unpacked ${digest(match)}.`,
          );
        } else assert.deepEqual(bytes, match, name);
      }
    },
  );
}
