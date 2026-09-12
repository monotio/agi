import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge, BRIDGE_HEADER_BYTES, BRIDGE_PAUSE_SLOT } from "../src/agent/sabBridge.ts";

test("the shared buffer is the pause slot only", () => {
  const bridge = createBridge();
  try {
    // No payload region: host requests travel as worker messages now.
    assert.equal(bridge.sab.byteLength, BRIDGE_HEADER_BYTES);
    const i32 = new Int32Array(bridge.sab, 0, 4);
    assert.equal(Atomics.load(i32, BRIDGE_PAUSE_SLOT), 0);
    assert.equal(bridge.isPaused(), false);
  } finally {
    bridge.dispose();
  }
});

test("setPaused writes the pause slot the worker polls", () => {
  const bridge = createBridge();
  try {
    const i32 = new Int32Array(bridge.sab, 0, 4);
    bridge.setPaused(true);
    assert.equal(Atomics.load(i32, BRIDGE_PAUSE_SLOT), 1);
    assert.equal(bridge.isPaused(), true);
    bridge.setPaused(false);
    assert.equal(Atomics.load(i32, BRIDGE_PAUSE_SLOT), 0);
    assert.equal(bridge.isPaused(), false);
  } finally {
    bridge.dispose();
  }
});

test("dispose leaves the pause slot clear", () => {
  const bridge = createBridge();
  const i32 = new Int32Array(bridge.sab, 0, 4);
  bridge.setPaused(true);
  bridge.dispose();
  assert.equal(Atomics.load(i32, BRIDGE_PAUSE_SLOT), 0);
});
