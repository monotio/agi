import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { validateCompleteImage } from "../src/runtime/projectImageValidation.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const profile = PROFILES["2.936"]!;

test("complete image preserves an unreadable indexed SOUND during an unrelated LOGIC edit", () => {
  const files = new Map(createContainer().files);
  const directory = new Uint8Array(files.get("SNDDIR")!);
  directory.set([0x30, 0, 0], 34 * 3); // SOUND 34 points to missing VOL.3.
  files.set("SNDDIR", directory);
  const previous = openContainer(files);
  const candidate = openContainer(files);
  candidate.putResource(
    "logic",
    0,
    assembleLogic("assignn(v80,42); return;", { dictionary: new Map() }).payload,
  );
  assert.doesNotThrow(() => validateCompleteImage(candidate, profile, 1, previous));
  assert.throws(() => candidate.getResource("sound", 34), /corrupt/i);
  assert.throws(
    () => validateCompleteImage(candidate, profile, 1, createContainer()),
    /sound resource 34 cannot be read/,
  );
});

for (const kind of ["logic", "view"] as const) {
  test(`complete image preserves an unchanged opaque ${kind} during an unrelated LOGIC edit`, () => {
    const previous = createContainer();
    previous.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
    previous.putResource(kind, 255, new Uint8Array([0xff]));
    const candidate = openContainer(previous.files);
    candidate.putResource(
      "logic",
      0,
      assembleLogic('display(2,0,"Changed"); return;', { dictionary: new Map() }).payload,
    );
    assert.doesNotThrow(() => validateCompleteImage(candidate, profile, 1, previous));
  });

  test(`complete image rejects new and changed malformed ${kind} payloads`, () => {
    for (const existing of [false, true]) {
      const previous = createContainer();
      if (existing) previous.putResource(kind, 255, new Uint8Array([0xfe]));
      const candidate = openContainer(previous.files);
      candidate.putResource(kind, 255, new Uint8Array([0xff]));
      assert.throws(
        () => validateCompleteImage(candidate, profile, 1, previous),
        new RegExp(`${kind} resource 255 is invalid`),
      );
    }
  });
}

for (const name of ["WORDS.TOK", "OBJECT"] as const) {
  test(`complete image preserves unchanged opaque ${name} and rejects new or changed bytes`, () => {
    const previous = createContainer();
    previous.putFile(name, new Uint8Array([0xff]));
    const candidate = openContainer(previous.files);
    candidate.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
    assert.doesNotThrow(() => validateCompleteImage(candidate, profile, 1, previous));
    candidate.putFile(name, new Uint8Array([0xfe]));
    assert.throws(() => validateCompleteImage(candidate, profile, 1, previous));
    assert.throws(() => validateCompleteImage(candidate, profile, 1, createContainer()));
  });
}
