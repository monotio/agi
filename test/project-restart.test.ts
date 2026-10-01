import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareProjectRestart } from "../src/runtime/projectRestart.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildObjectFile } from "../src/authoring/inventory.ts";

test("complete restart validation rejects a malformed VIEW even alongside an OBJECT removal", () => {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  container.putFile("OBJECT", buildObjectFile([{ name: "key" }]));
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      return null;
    },
    takeKeys() {
      return [];
    },
  });
  engine.vars[80] = 99;
  const before = new Map(engine.containerFiles);
  const candidate = openContainer(engine.containerFiles);
  candidate.putFile("OBJECT", buildObjectFile([]));
  candidate.putResource("view", 3, new Uint8Array([0xff]));
  assert.throws(
    () =>
      prepareProjectRestart(
        { files: candidate.files },
        {
          print() {},
          displayAt() {},
          statusLine() {},
          takeInputLine() {
            return null;
          },
          takeKeys() {
            return [];
          },
        },
        PROFILES["2.936"]!,
      ),
    /view resource 3 is invalid/,
  );
  assert.deepEqual(new Map(engine.containerFiles), before);
  assert.equal(engine.vars[80], 99);
  assert.equal(engine.itemLocation(0), 0);
});

test("restart preparation owns its bytes, accepts resource removal and a selected profile, and leaves the old run alive", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("assignn(v80,7); return;", { dictionary: new Map() }).payload,
  );
  container.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      return null;
    },
    takeKeys() {
      return [];
    },
  });
  engine.vars[80] = 99;
  const candidate = createContainer();
  candidate.putResource(
    "logic",
    0,
    assembleLogic("assignn(v80,8); return;", { dictionary: new Map() }).payload,
  );
  const replacement = prepareProjectRestart(
    { files: candidate.files, profile: "3.002.149" },
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine() {
        return null;
      },
      takeKeys() {
        return [];
      },
    },
    PROFILES["2.936"]!,
  );
  candidate.files.get("VOL.0")!.fill(0xff);
  assert.equal(replacement.profile.id, "3.002.149");
  assert.equal(openContainer(replacement.containerFiles).getResource("logic", 1), null);
  replacement.tick();
  assert.equal(replacement.vars[80], 8);
  assert.equal(engine.vars[80], 99);
  engine.tick();
  assert.equal(engine.vars[80], 7);
});
