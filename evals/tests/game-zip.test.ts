import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { buildZip, crc32 } from "../../app/src/zip.ts";
import { readGameZip } from "../../app/src/gameZip.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";

function cartridgeFiles() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const files = Object.fromEntries(container.files);
  files["WORDS.TOK"] = buildWordsTok([{ word: "look", id: 100 }]);
  return files;
}

test("imports a nested ZIP and retains exact AGI bytes", async () => {
  const files = cartridgeFiles();
  const zip = buildZip(
    Object.entries(files).map(([name, data]) => ({ name: `my-game/${name.toLowerCase()}`, data })),
  );
  assert.deepEqual((await readGameZip(zip)).files, files);
});

test("rejects corrupt archives, duplicate files, traversal and non-games", async () => {
  const files = cartridgeFiles();
  const entries = Object.entries(files).map(([name, data]) => ({ name, data }));
  const broken = buildZip(entries);
  broken[30 + "LOGDIR".length] = broken[30 + "LOGDIR".length]! ^ 1;
  await assert.rejects(readGameZip(broken), /checksum/i);
  await assert.rejects(readGameZip(buildZip([...entries, entries[0]!])), /duplicate/i);
  await assert.rejects(readGameZip(buildZip([{ name: "../LOGDIR", data: "x" }])), /path/i);
  await assert.rejects(
    readGameZip(buildZip([{ name: "README.TXT", data: "not a game" }])),
    /resource directories/i,
  );
  await assert.rejects(readGameZip(new Uint8Array(8)), /ZIP/i);
});

test("imports deflated files from ordinary ZIP applications", async () => {
  const files = cartridgeFiles();
  const entries = Object.entries(files);
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name),
      compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  assert.deepEqual((await readGameZip(Buffer.concat([...locals, directory, end]))).files, files);
});

test("does not reject a bootable local game for an unused broken sound reference", async () => {
  const files = cartridgeFiles();
  files["SNDDIR"] = Uint8Array.of(0x20, 0, 0);
  const zip = buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
  assert.deepEqual((await readGameZip(zip)).files["SNDDIR"], files["SNDDIR"]);
});
