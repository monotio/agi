import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { fatDisk } from "../../test/disk-images.ts";
import { readGameFiles, readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";
import { detectProfile } from "../../src/runtime/profile.ts";

function disks(): [Uint8Array, Uint8Array, Map<string, Uint8Array>] {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("accept.input(); return;", { dictionary: new Map() }).payload,
  );
  container.putFile("WORDS.TOK", new Uint8Array(52));
  // A directory reference to a resource on the second disk.
  container.files.get("PICDIR")!.set([0x20, 0, 0], 0);
  const second = new Map([["VOL.2", new Uint8Array([0x12, 0x34, 2, 1, 0, 255])]]);
  return [fatDisk(container.files), fatDisk(second), new Map([...container.files, ...second])];
}
test("two disk images merge exact playable files and keep file profile detection", () => {
  const [first, second, expected] = disks();
  const opened = readGameFiles(
    new Map([
      ["disk1.img", first],
      ["disk2.ima", second],
    ]),
  );
  assert.deepEqual(new Map(Object.entries(opened.files)), expected);
  assert.equal(detectProfile(new Map(Object.entries(opened.files))).id, "2.936");
});
test("one disk names the missing referenced volume", () => {
  const [first] = disks();
  assert.throws(
    () => readGameFiles(new Map([["disk1.img", first]])),
    /VOL\.2 is on another disk\. Add all the game's disks together\./,
  );
});
test("a duplicate game file with different bytes names both disks", () => {
  const [first] = disks();
  const second = fatDisk(new Map([["VOL.0", new Uint8Array([55])]]));
  assert.throws(
    () =>
      readGameFiles(
        new Map([
          ["first.img", first],
          ["second.img", second],
        ]),
      ),
    /VOL\.0.*FIRST\.IMG.*SECOND\.IMG/,
  );
});
test("identical duplicate bytes from disks are accepted inside a ZIP", async () => {
  const [first, second, expected] = disks();
  const zip = buildZip([
    { name: "set/disk1.img", data: first },
    { name: "set/disk2.img", data: second },
    { name: "set/copy.img", data: second },
  ]);
  assert.deepEqual(new Map(Object.entries((await readGameZip(zip)).files)), expected);
});
test("a disk without AGI files gives the next action", () => {
  assert.throws(
    () => readGameFiles(new Map([["empty.img", fatDisk(new Map())]])),
    /This disk has no AGI game files\. Add the disk with VOL\.0 and WORDS\.TOK\./,
  );
});

test("unreadable needed file names its disk while unrelated disk damage is ignored", () => {
  const [first, second] = disks();
  const irrelevant = fatDisk(new Map([["NOTES.TXT", new Uint8Array([17])]]));
  new DataView(irrelevant.buffer).setUint16(5 * 512 + 26, 356, true);
  assert.ok(
    readGameFiles(
      new Map([
        ["first.img", first],
        ["second.img", second],
        ["extra.img", irrelevant],
      ]),
    ).files["WORDS.TOK"],
  );
  const bad = fatDisk(new Map([["VOL.2", new Uint8Array([17])]]));
  new DataView(bad.buffer).setUint16(5 * 512 + 26, 356, true);
  assert.throws(
    () =>
      readGameFiles(
        new Map([
          ["first.img", first],
          ["bad.img", bad],
        ]),
      ),
    /VOL\.2 on BAD\.IMG is unreadable/,
  );
  // An intact duplicate of the damaged file can supply the missing bytes.
  assert.ok(
    readGameFiles(
      new Map([
        ["first.img", first],
        ["bad.img", bad],
        ["second.img", second],
      ]),
    ).files["VOL.2"],
  );
});

for (const edition of ["kq4", "mh2"]) {
  test(`disk import preserves the exact original ${edition} unshipped-volume allowance`, async (t) => {
    const { fixtureSkip, fixtureFiles, fixtureDir } = await import("../../test/fixtures.ts");
    const missing = fixtureSkip(edition, [], { checkVolumes: "shipped" });
    if (missing) {
      t.skip(missing);
      return;
    }
    const { readFileSync, statSync } = await import("node:fs");
    const files = new Map<string, Uint8Array>(
      [...fixtureFiles(edition)!.values()]
        .filter((name) => statSync(fixtureDir(edition) + name).isFile())
        .map((name) => [name, new Uint8Array(readFileSync(fixtureDir(edition) + name))]),
    );
    files.set("disk.img", fatDisk(new Map()));
    assert.ok(readGameFiles(files).files["WORDS.TOK"]);
  });
}
