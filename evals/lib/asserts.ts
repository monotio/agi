/**
 * Custom assertions for AGI Genesis and runtime agent evaluations.
 * Three-layer assertion discipline (AGENTS.md):
 *   1. Structure: schema-valid parameters and exact bytes/pixels
 *   2. Behavior: real engine assembler and compilers accept the resource
 *   3. Semantics: all required starting resources exist
 *
 * Tool schemas are the engine's, not a copy: `write_picture` takes the picture
 * DSL `source` (compiled by compilePictureSource) and returns metrics plus a
 * rendered PNG, so a model still emitting a raw byte array fails here.
 */

import { createAgentSessionState, executeAgentTool } from "../../src/agent/tools.ts";

import type { EntryResult } from "../../scripts/eval-picture.ts";

interface ToolOutput {
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string | Record<string, unknown> };
    name?: string;
    input?: Record<string, unknown>;
  }>;
  output?: ResponseCall[];
  content?: Array<{ type: string; name: string; input: Record<string, unknown> }>;
}
interface ResponseCall {
  type: string;
  name: string;
  arguments?: string | Record<string, unknown>;
}
interface AssertionContext {
  providerResponse?: ToolOutput | ResponseCall[];
}

function extractToolCalls(
  output: unknown,
  providerResponse: ToolOutput | ResponseCall[] | undefined,
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  // Check parsed output tool calls (Anthropic or OpenAI in promptfoo)
  if (output && typeof output === "object") {
    const value = output as ToolOutput;
    if (Array.isArray(value.tool_calls)) {
      for (const tc of value.tool_calls) {
        calls.push({
          name: (tc.function?.name || tc.name)!,
          args:
            typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || tc.input || {},
        });
      }
    }
  }

  // Check providerResponse if available
  if (providerResponse && typeof providerResponse === "object") {
    const response = providerResponse as ToolOutput;
    const raw = response.output || providerResponse;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item.type === "function_call") {
          calls.push({
            name: item.name,
            args:
              typeof item.arguments === "string"
                ? JSON.parse(item.arguments)
                : item.arguments || {},
          });
        }
      }
    }
    if (Array.isArray(response.content)) {
      for (const c of response.content) {
        if (c.type === "tool_use") {
          calls.push({
            name: c.name,
            args: c.input || {},
          });
        }
      }
    }
  }

  return calls;
}

/**
 * Validates that all tool calls in the turn compile cleanly through the real engine compiler.
 */
export function validateGenesisToolCalls(output: unknown, context?: AssertionContext) {
  const calls = extractToolCalls(output, context?.providerResponse);
  if (calls.length === 0) {
    return {
      pass: false,
      score: 0,
      reason: "Model did not emit any tool calls for Genesis",
    };
  }

  const session = createAgentSessionState();
  const errors = [];
  const executed = [];

  for (const call of calls) {
    // write_picture takes the picture DSL source; a byte array is the old
    // schema and means the model is working from a stale tool contract.
    if (call.name === "write_picture" && typeof call.args?.["source"] !== "string") {
      errors.push(
        `write_picture called without a 'source' string (got keys: ${Object.keys(call.args ?? {}).join(", ") || "none"})`,
      );
      continue;
    }
    const res = executeAgentTool(session, call.name, call.args);
    if (!res.success) {
      errors.push(`${call.name} error: ${res.error}`);
    } else {
      executed.push(call.name);
    }
  }

  if (errors.length > 0) {
    return {
      pass: false,
      score: 0,
      reason: `Tool compilation failures:\n${errors.join("\n")}`,
    };
  }

  return {
    pass: true,
    score: 1,
    reason: `Successfully compiled ${executed.length} tool calls: ${executed.join(", ")}`,
  };
}

/**
 * Validates that view 0 (Ego) was authored and compiled cleanly with no RangeError.
 */
export function validateEgoView(output: unknown, context?: AssertionContext) {
  const calls = extractToolCalls(output, context?.providerResponse);
  const viewCalls = calls.filter((c) => c.name === "write_view");

  if (viewCalls.length === 0) {
    return { pass: false, score: 0, reason: "No write_view call found" };
  }

  const session = createAgentSessionState();
  for (const call of viewCalls) {
    const res = executeAgentTool(session, call.name, call.args);
    if (!res.success) {
      return { pass: false, score: 0, reason: `View compilation failed: ${res.error}` };
    }
  }

  return { pass: true, score: 1, reason: "Ego view compiled cleanly" };
}

/**
 * Picture fidelity (evals/configs/picture.ts). Three layers, cheapest first:
 *   1. structure: at least one round compiled and rendered;
 *   2. exact metrics: fill coverage >= 90% and >= 6 distinct colours
 *      (an original Sierra room is ~95-100% painted with 10+ colours);
 *   3. vision-judge rubric: overall >= 6/10 to pass; score = overall / 10.
 */
export function validatePictureFidelity(
  output: string | Pick<EntryResult, "recreation" | "judge" | "error">,
) {
  const r = (typeof output === "string" ? JSON.parse(output) : output) as Pick<
    EntryResult,
    "recreation" | "judge" | "error"
  >;
  if (!r.recreation) {
    return { pass: false, score: 0, reason: r.error ?? "no successful write_picture_source round" };
  }
  const fill = r.recreation.fillCoverage;
  const colours = r.recreation.distinctColors;
  if (fill < 0.9 || colours < 6) {
    return {
      pass: false,
      score: 0.1,
      reason: `metric floor: fill ${(fill * 100).toFixed(0)}% (need 90), colours ${colours} (need 6)`,
    };
  }
  if (!r.judge) return { pass: false, score: 0.2, reason: "judge output unparseable" };
  const overall = r.judge.overall;
  return {
    pass: overall >= 6,
    score: overall / 10,
    reason: `judge overall ${overall}/10 (c${r.judge.composition} f${r.judge.fill} d${r.judge.detail} p${r.judge.palette} g${r.judge.ground}); ${r.judge.notes}`,
  };
}
