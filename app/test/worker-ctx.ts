/**
 * Test harness for worker/* modules: a context whose ports record posted
 * messages, wired to a real Engine built from createContainer() plus
 * assembleLogic (the test/host-wait.test.ts pattern).
 */
import { Engine } from "../../src/runtime/engine.ts";
import { createContainer } from "../../src/container/container.ts";
import type { GameContainer } from "../../src/types.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import {
  createWorkerContext,
  type WorkerContext,
  type WorkerPorts,
} from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import type { WorkerControl, WorkerPresentation } from "../src/workerProtocol.ts";

export interface WorkerHarness {
  ctx: WorkerContext;
  control: WorkerControl[];
  presentation: WorkerPresentation[];
}

/** One logic resource per entry, numbered from 0. */
export function gameContainer(logics: string[], extra?: (c: GameContainer) => void): GameContainer {
  const container = createContainer();
  for (const [num, source] of logics.entries())
    container.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);
  extra?.(container);
  return container;
}

export function workerHarness(container: GameContainer): WorkerHarness {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => 0,
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  ctx.engine = new Engine(container, ctx.host, new Map());
  ctx.engine.flags[9] = 1;
  return { ctx, control, presentation };
}
