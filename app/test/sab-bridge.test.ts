import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBridge,
  BRIDGE_STATE_IDLE,
  BRIDGE_STATE_REQUEST,
  BRIDGE_STATE_CLAIMED,
  BRIDGE_STATE_CANCELLED,
  WorkerBridgeAbortError,
} from "../src/agent/sabBridge.ts";

test("WorkerBridgeAbortError has correct name and inheritance", () => {
  const err = new WorkerBridgeAbortError();
  assert.equal(err.name, "WorkerBridgeAbortError");
  assert.equal(err.message, "Worker bridge call cancelled");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkerBridgeAbortError);

  const custom = new WorkerBridgeAbortError("Custom cancellation");
  assert.equal(custom.message, "Custom cancellation");
  assert.equal(custom.name, "WorkerBridgeAbortError");
});

test("bridge.cancel() transitions active request to cancelled state and notifies", () => {
  const bridge = createBridge(
    {
      handle: async () => "ok",
    },
    () => {},
  );

  try {
    const i32 = new Int32Array(bridge.sab, 0, 4);

    // Idle state: cancel is a no-op
    assert.equal(Atomics.load(i32, 0), BRIDGE_STATE_IDLE);
    bridge.cancel();
    assert.equal(Atomics.load(i32, 0), BRIDGE_STATE_IDLE);

    // Request state: cancel sets BRIDGE_STATE_CANCELLED
    Atomics.store(i32, 0, BRIDGE_STATE_REQUEST);
    bridge.cancel();
    assert.equal(Atomics.load(i32, 0), BRIDGE_STATE_CANCELLED);

    // Claimed state: cancel sets BRIDGE_STATE_CANCELLED
    Atomics.store(i32, 0, BRIDGE_STATE_CLAIMED);
    bridge.cancel();
    assert.equal(Atomics.load(i32, 0), BRIDGE_STATE_CANCELLED);
  } finally {
    bridge.dispose();
  }
});

test("bridge.pollNow() handles pending requests immediately without timer delay", () => {
  let handled = false;
  const bridge = createBridge(
    {
      handle: async (req) => {
        handled = true;
        return "result-" + req.op;
      },
    },
    () => {},
  );

  try {
    const i32 = new Int32Array(bridge.sab, 0, 4);
    const bytes = new Uint8Array(bridge.sab, 16);

    const payload = new TextEncoder().encode(JSON.stringify({ op: "waitkey", context: {} }));
    bytes.set(payload);
    Atomics.store(i32, 1, payload.length);
    Atomics.store(i32, 0, BRIDGE_STATE_REQUEST);

    assert.equal(handled, false);
    bridge.pollNow();
    assert.equal(handled, true);
    assert.equal(Atomics.load(i32, 0), BRIDGE_STATE_CLAIMED);
  } finally {
    bridge.dispose();
  }
});
