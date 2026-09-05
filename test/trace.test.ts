import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { Engine } from "../src/runtime/engine.ts";

function game(source: string | Uint8Array) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    typeof source === "string"
      ? assembleLogic(source, { dictionary: new Map() }).payload
      : buildLogicResource(source, []),
  );
  const names: (string | null)[] = Array(178).fill(null);
  names[2] = "assignn";
  names[160] = "equaln";
  container.putResource("logic", 10, buildLogicResource(Uint8Array.of(0), names));
  let keys: number[] = [];
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => {
      const pending = keys;
      keys = [];
      return pending;
    },
  });
  return {
    engine,
    key: (key: number) => {
      keys.push(key);
    },
  };
}

const rows = (e: Engine) => Array.from({ length: 25 }, (_, row) => e.textRow(row));

test("trace appears in discovered controls only when enabled or active", () => {
  const { engine: e, key } = game("return;");
  assert.deepEqual(e.readControls(), []);
  e.flags[10] = 1;
  assert.equal(e.readControls().find((c) => c.key === 0x4600)?.label, "Show trace");
  key(0x4600);
  e.tick();
  e.flags[10] = 0;
  assert.equal(e.readControls().find((c) => c.key === 0x4600)?.label, "Hide trace");
  key(0x4600);
  e.tick();
  assert.deepEqual(e.readControls(), []);
});

test("f10 gates trace activation; numeric tracing leaves game variables and input intact", () => {
  const { engine: e, key } = game("if(!isset(f200)){set(f200);trace.on();}increment(v200);return;");
  e.tick();
  assert.ok(rows(e).every((row) => row.trim() === ""));
  e.flags[10] = 1;
  key(0x4600);
  e.tick();
  assert.ok(rows(e).some((row) => row.includes("Trace")));
  assert.ok(rows(e).some((row) => /1\(200\)/.test(row)));
  assert.equal(e.vars[200], 2);
  assert.equal(e.vars[19], 0, "Scroll Lock does not become parser input");
  key(0x4600);
  e.tick();
  assert.ok(rows(e).every((row) => row.trim() === ""));
});

test("trace.info supplies names and bounds a scrolling window, including tested conditions", () => {
  const { engine: e } = game(
    "trace.info(10,2,4);set(f10);trace.on();assignn(v200,42);if(equaln(v200,42)){assignn(v201,7);}return;",
  );
  e.tick();
  assert.match(e.textRow(2), /Trace/);
  assert.ok(
    rows(e)
      .slice(3, 6)
      .some((row) => row.includes("equaln") && row.includes("true")),
  );
  assert.ok(
    rows(e)
      .slice(3, 6)
      .some((row) => row.includes("assignn") && row.includes("201")),
  );
  assert.ok(
    rows(e)
      .slice(6)
      .every((row) => row.trim() === ""),
  );
  assert.equal(e.vars[201], 7);
});

test("active trace.on consumes its extra byte without interpreting it as an action", () => {
  // set(f10), trace.on, active trace.on + ignored invalid byte, assignn(v200,42), return
  const { engine: e } = game(Uint8Array.of(12, 10, 149, 149, 255, 3, 200, 42, 0));
  e.tick();
  assert.equal(e.vars[200], 42);
  assert.ok(rows(e).some((row) => row.includes("Trace")));
});

test("trace height clamps to two rows and its overlay never erases the underlying game text", () => {
  const { engine: e, key } = game(
    'if(!isset(f200)){set(f200);display(23,0,"Underneath");trace.info(10,255,0);set(f10);trace.on();}assignn(v200,1);return;',
  );
  e.tick();
  assert.match(e.textRow(23), /Trace/);
  key(0x4600);
  e.tick();
  assert.match(e.textRow(23), /^Underneath/);
});

test("a message remains readable above tracing and tracing resumes after acknowledgement", () => {
  const { engine: e } = game(
    'trace.info(10,1,24);set(f10);trace.on();print("Read this message.");assignn(v200,42);return;',
  );
  e.tick();
  assert.ok(rows(e).some((row) => row.includes("Read this message.")));
  e.ackPrint();
  e.tick();
  assert.ok(rows(e).some((row) => row.includes("assignn")));
  assert.equal(e.vars[200], 42);
});
