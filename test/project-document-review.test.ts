import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileProjectDocuments,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { buildObjectFile } from "../src/authoring/inventory.ts";
import { decodeInventoryFile } from "../src/runtime/inventoryFile.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function blank() {
  return Object.fromEntries(createStarterProject("blank").files());
}

test("opening an unreadable indexed picture never turns its absence into implicit deletion", () => {
  const files = blank();
  const directory = new Uint8Array(files["PICDIR"]!);
  directory.set([0x30, 0, 0], 15); // PIC 5 points to missing VOL.3.
  files["PICDIR"] = directory;
  const before = structuredClone(files);
  const read = readProjectDocuments({ files, profileId: "2.936" });
  assert.ok(read.diagnostics.some(({ key }) => key === "picture:5"));
  assert.throws(
    () => compileProjectDocuments({ files, profileId: "2.936", documents: read.documents }),
    /unreadable|corrupt/i,
  );
  assert.deepEqual(files, before);
});

test("editing inventory names preserves the original drawable-object limit", () => {
  const files = blank();
  files["OBJECT"] = buildObjectFile([{ name: "key", startingRoom: 1 }], PROFILES["2.936"], 24);
  const read = readProjectDocuments({ files, profileId: "2.936" });
  const candidate = compileProjectDocuments({
    files,
    profileId: "2.936",
    documents: {
      ...read.documents,
      inventory: JSON.stringify([{ name: "brass key", startingRoom: 1 }]),
    },
  });
  assert.equal(decodeInventoryFile(candidate.files().get("OBJECT")!, PROFILES["2.936"])[2], 24);
});

test("inventory source refuses name offsets that cannot fit the native format", () => {
  const files = blank();
  const read = readProjectDocuments({ files, profileId: "2.936" });
  assert.throws(
    () =>
      compileProjectDocuments({
        files,
        profileId: "2.936",
        documents: {
          ...read.documents,
          inventory: JSON.stringify([{ name: "a".repeat(65536) }, { name: "b" }]),
        },
      }),
    /inventory|OBJECT|offset|large|limit/i,
  );
});

test("changed native inventory bytes must have valid names as well as a fitting table", () => {
  const files = blank();
  const read = readProjectDocuments({ files, profileId: "2.936" });
  // Plain stub with one fitting entry whose name points outside the file.
  const broken = Uint8Array.of(3, 0, 24, 250, 0, 0);
  assert.throws(
    () =>
      compileProjectDocuments({
        files,
        profileId: "2.936",
        documents: {
          ...read.documents,
          inventory: broken,
        },
      }),
    /inventory|OBJECT|name/i,
  );
});
