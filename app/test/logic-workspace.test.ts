import assert from "node:assert/strict";
import { test } from "node:test";
import { documentLabel, derivedLogicSource } from "../src/studio/logic/logicWorkspace.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { PROFILES, type AgiProfile } from "../../src/runtime/profile.ts";

const profile: AgiProfile = PROFILES["2.411"];

test("document labels name resources canonically and auxiliaries plainly", () => {
  assert.equal(documentLabel("logic:0"), "LOGIC 0");
  assert.equal(documentLabel("logic:255"), "LOGIC 255");
  assert.equal(documentLabel("picture:12"), "PIC 12");
  assert.equal(documentLabel("view:3"), "VIEW 3");
  assert.equal(documentLabel("sound:7"), "SND 7");
  assert.equal(documentLabel("words"), "WORDS.TOK");
  assert.equal(documentLabel("inventory"), "OBJECT");
  assert.equal(documentLabel("bindings"), "Bindings");
  assert.equal(documentLabel("world"), "World");
  assert.equal(documentLabel("tests"), "Tests");
  assert.equal(documentLabel("references"), "References");
  assert.equal(documentLabel("notes"), "notes");
});

test("a bytes-only logic gets a clearly derived preview, never treated as source", () => {
  const compiled = compileProjectLogic("assignn(v40, 1);\nreturn;", {
    profile,
    dictionary: new Map(),
    bindings: {},
  });
  const preview = derivedLogicSource(compiled.assembly.payload, "2.411", []);
  assert.ok(preview.source.includes("return"), "the preview renders disassembly text");
});

test("an unreadable payload previews as a named failure instead of throwing", () => {
  const preview = derivedLogicSource(new Uint8Array([0xff, 0x00, 0xff]), "2.411", []);
  assert.ok(
    preview.source.startsWith("// The logic does not disassemble:"),
    `the failure is named in the preview: ${preview.source}`,
  );
});
