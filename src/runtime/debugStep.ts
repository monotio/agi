import type { captureProjectBuild } from "../authoring/projectBuild.ts";
import type { ExecutionBoundary } from "./engine.ts";

/** Session-local execution plan. The controller pins the build and run identity. */
export function createDebugStepPlan(input: {
  readonly origin: ExecutionBoundary;
  readonly mode: "into" | "over" | "out" | "cycle";
  readonly granularity: "statement" | "instruction";
  readonly build: ReturnType<typeof captureProjectBuild>;
}) {
  const originSequence = input.origin.sequence;
  const originInvocation = input.origin.frames.at(-1)?.invocationId;
  if (originInvocation === undefined) throw new Error("A step requires a stopped invocation.");
  const ancestors = new Set(input.origin.frames.slice(0, -1).map((frame) => frame.invocationId));
  const mode = input.mode;
  const granularity = input.granularity;
  const generatedJumps = new Map(
    input.build.logics.map((logic) => [
      logic.num,
      new Set(
        logic.sourceMap?.entries
          .filter((entry) => entry.kind === "generated-jump")
          .map((entry) => entry.pc) ?? [],
      ),
    ]),
  );
  let finished = false;

  /**
   * Run after ordinary breakpoint/watchpoint checks. These decisions do not
   * execute predicates, alter PC, read gameplay input, or advance the engine.
   * Continue suppresses only the original encounter; a loop at the same source
   * span has a fresh sequence and can immediately stop again.
   */
  function atBoundary(boundary: ExecutionBoundary): "step" | "unwind" | null {
    if (finished || boundary.sequence <= originSequence || mode === "cycle") return null;
    if (
      granularity === "statement" &&
      (boundary.kind === "predicate" || generatedJumps.get(boundary.logic)?.has(boundary.pc))
    )
      return null;
    const top = boundary.frames.at(-1)?.invocationId;
    const originPresent = boundary.frames.some((frame) => frame.invocationId === originInvocation);
    if (!originPresent && !boundary.frames.some((frame) => ancestors.has(frame.invocationId))) {
      finished = true;
      return "unwind";
    }
    if (mode === "over" && originPresent && top !== originInvocation) return null;
    if (mode === "out" && originPresent) return null;
    finished = true;
    return "step";
  }

  /** Call only at a real completed cycle, never at a host wait or cooperative yield. */
  function atCycleEnd(): "cycle-end" | null {
    if (finished) return null;
    finished = true;
    return "cycle-end";
  }

  return { atBoundary, atCycleEnd };
}
