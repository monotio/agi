import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerPorts } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerControl, WorkerPresentation } from "../src/workerProtocol.ts";

test("worker boot with a profile override reports the chosen profile and detection kind", () => {
  const container = gameContainer(["assignn(v0, 1); accept.input(); return;"]);
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  onWorkerMessage(ctx, {
    type: "boot",
    profile: "2.411",
    files: Object.fromEntries(container.files),
    words: [],
  });
  ctx.fns.stopTimers();

  const booted = control.find((msg) => msg.type === "booted");
  assert.ok(booted, "booted message received");
  assert.equal(booted.profile, "2.411");
  assert.equal(booted.kind, "default");
});

test("worker boot without override reports detected profile and kind", () => {
  const container = gameContainer(["assignn(v0, 1); accept.input(); return;"]);
  const files = Object.fromEntries(container.files);
  files["AGIDATA.OVL"] = new TextEncoder().encode("Adventure Game Interpreter\nVersion 2.917\n");

  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  onWorkerMessage(ctx, {
    type: "boot",
    files,
    words: [],
  });
  ctx.fns.stopTimers();

  const booted = control.find((msg) => msg.type === "booted");
  assert.ok(booted, "booted message received");
  assert.equal(booted.profile, "2.917");
  assert.equal(booted.kind, "binary");
});

test("worker boot with an invalid profile surfaces as error message", () => {
  const container = gameContainer(["assignn(v0, 1); accept.input(); return;"]);
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  onWorkerMessage(ctx, {
    type: "boot",
    profile: "unknown-999" as never,
    files: Object.fromEntries(container.files),
    words: [],
  });

  const err = control.find((msg) => msg.type === "error");
  assert.ok(err, "error message received");
});
