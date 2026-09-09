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
