import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  inventoryInterpreters,
  inspectInterpreter,
  readMzHeader,
} from "../scripts/interpreter-inventory.ts";

function executable(headerBytes = 32, declaredBytes = 96): Uint8Array {
  const data = new Uint8Array(Math.max(declaredBytes, headerBytes + 64));
  const words = new DataView(data.buffer);
  words.setUint16(0, 0x5a4d, true);
  words.setUint16(2, declaredBytes % 512, true);
  words.setUint16(4, Math.ceil(declaredBytes / 512), true);
  words.setUint16(8, headerBytes / 16, true);
  words.setUint16(20, 48, true);
  words.setUint16(24, 28, true);
  data.set(new TextEncoder().encode("Adventure Game Interpreter\nVersion 2.936"), headerBytes);
  return data;
}

test("MZ addresses use paragraph count and last-page convention, preserving trailing bytes", () => {
  const header = readMzHeader(executable(64, 512));
  assert.equal(header.headerBytes, 64);
  assert.equal(header.declaredFileBytes, 512);
  assert.equal(header.declaredLoadBytes, 448);
  assert.equal(header.entryModuleOffset, 48);
  assert.equal(header.entryFileOffset, 112);
  assert.equal(header.actualLoadBytes, 448);
  assert.equal(header.fileSizeDelta, 0);
  const appended = new Uint8Array(515);
  appended.set(executable(64, 512));
  assert.equal(readMzHeader(appended).fileSizeDelta, 3);
  assert.equal(readMzHeader(appended).actualLoadBytes, 448);
  assert.equal(readMzHeader(executable().subarray(0, 95)).fileSizeDelta, -1);
  assert.throws(() => readMzHeader(new Uint8Array(10)), /MZ/);
  const bad = executable();
  bad[8] = 1;
  assert.throws(() => readMzHeader(bad), /header/);
});

test("inventory pins raw, loader, overlay and corrected decoded images separately", () => {
  const decoded = executable();
  // One block, independently XORed with a constant key; no decoder used to author it.
  const scrambled = decoded.map((value) => value ^ 0x80);
  const loader = new Uint8Array(0x41 + 128);
  loader.fill(0x80, 0x41);
  const row = inspectInterpreter(
    "arbitrary-name",
    new Map([
      ["AGI", scrambled],
      ["GAME.COM", loader],
      ["UNRELATED.COM", new Uint8Array(193)],
      ["AGIDATA.OVL", new TextEncoder().encode("Version 2.936")],
      ["WORDS.TOK", new TextEncoder().encode("abc")],
    ]),
  );
  assert.equal(row.status, "inventoried");
  assert.equal(
    row.words?.sha256,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(row.knownGame, null, "folder names do not assign game identity");
  assert.equal(row.build, "2.936");
  assert.equal(row.profile, "2.936");
  assert.equal(row.overlayAssociation, "co-located-unverified");
  assert.deepEqual(row.decoded?.loaderCandidates, ["GAME.COM"]);
  assert.equal(
    row.decoded?.sha256,
    inspectInterpreter("other", new Map([["AGI", decoded]])).decoded?.sha256,
  );
  assert.notEqual(row.raw?.sha256, row.decoded?.sha256);
  assert.equal(row.loaders.length, 2);
  assert.equal(row.evidence, "static-inventory");
});

test("missing interpreters, unsupported decodes and conflicting build evidence stay explicit", () => {
  assert.equal(inspectInterpreter("kq1", new Map()).status, "missing");
  const broken = inspectInterpreter("kq1", new Map([["AGI", new Uint8Array(200)]]));
  assert.equal(broken.status, "unsupported");
  assert.equal(broken.decoded, null);
  const conflict = inspectInterpreter(
    "kq1",
    new Map([
      ["AGI", executable()],
      ["AGIDATA.OVL", new TextEncoder().encode("Version 3.002.149")],
    ]),
  );
  assert.equal(conflict.build, null);
  assert.equal(conflict.profile, null);
  assert.match(conflict.issues.join(" "), /Conflicting/);
  const unknown = executable();
  unknown.set(new TextEncoder().encode("2.999"), 32 + 35);
  const unsupportedBuild = inspectInterpreter("kq1", new Map([["AGI", unknown]]));
  assert.equal(unsupportedBuild.build, "2.999");
  assert.equal(unsupportedBuild.profile, null);
});

test("filesystem scan reports empty libraries and case ambiguity without guessing", () => {
  const root = mkdtempSync(join(tmpdir(), "agi-interpreter-inventory-"));
  try {
    assert.match(inventoryInterpreters(root).issues.join(" "), /No .*fixtures/);
    mkdirSync(join(root, "renamed"));
    writeFileSync(join(root, "renamed", "words.tok"), "abc");
    const row = inventoryInterpreters(root).interpreters[0]!;
    assert.equal(row.status, "missing");
    assert.equal(
      row.words?.sha256,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal(row.knownGame, null);
    const ambiguous = inspectInterpreter(
      "case",
      new Map([
        ["AGI", executable()],
        ["agi", executable()],
      ]),
    );
    assert.equal(ambiguous.status, "unsupported");
    assert.match(ambiguous.issues.join(" "), /Ambiguous/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
