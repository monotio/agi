import { ACTION_BY_NAME } from "../../../src/logic/opcodes.ts";
import type { Engine } from "../../../src/runtime/engine.ts";
import type { TraceRecord } from "../../../src/runtime/engine.ts";
import type { WorkerContext } from "./context.ts";

export interface PendingSentence {
  engine: Engine;
  text: string;
  room: number;
  matched: boolean;
  unknown: string;
  parsed: boolean;
}
/** Read parser state and the existing instruction trace; never write interpreter state. */
export function observeSentence(ctx: WorkerContext, record?: TraceRecord, finished = false): void {
  const pending = ctx.input.sentence;
  if (!pending) return;
  const engine = ctx.engine;
  if (engine !== pending.engine || ctx.replay.replay) {
    ctx.input.sentence = null;
    return;
  }
  if (!pending.parsed) {
    pending.parsed = true;
    if (engine.vars[9]! > 0) pending.unknown = engine.parsedWordTexts.at(-1) ?? "";
  }
  if (record?.op === 14 && record.result === true) pending.matched = true;
  const reparsing =
    record?.result === undefined &&
    record?.op === ACTION_BY_NAME["parse"]!.code &&
    record.args[0]! < engine.profile.stringSlots;
  if (!pending.unknown && !finished && !reparsing && engine.flags[2] !== 0) return;
  ctx.input.sentence = null;
  if (pending.unknown || !pending.matched)
    ctx.ports.control({
      type: "missedSentence",
      text: pending.text,
      room: pending.room,
      unknown: pending.unknown,
    });
  ctx.fns.applyTraceChannel();
}
