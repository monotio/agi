import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
} from "../../src/agent/tools.ts";
import {
  anthropicToolContent,
  openAiToolContent,
  projectToolResult,
  splitToolResult,
} from "../../src/agent/toolTransport.ts";

describe("stored bad cases regression suite (evals/fixtures/bad-cases)", () => {
  const badCasesDir = resolve("evals/fixtures/bad-cases");
  const files = readdirSync(badCasesDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(badCasesDir, file);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));

    it(`replays bad case: ${content.name} (${file})`, async () => {
      const session = createAgentSessionState();
      // A literal `result` replays a transport-level failure (no tool call).
      const res =
        content.result ??
        (await (content.async ? executeAgentToolAsync : executeAgentTool)(
          session,
          content.tool,
          content.args,
        ));

      if (content.projected) {
        const store = new Map<string, typeof res>();
        const projected = projectToolResult(res, store, "replay-1");
        const details = (projected.details ?? {}) as Record<string, unknown>;
        assert.equal(details["diagnosticId"], "replay-1", `${file}: no diagnostic pointer`);
        for (const [field, expected] of Object.entries(
          content.projected.details as Record<string, Record<string, unknown>>,
        )) {
          const actual = details[field] as Record<string, unknown>;
          assert.ok(actual, `${file}: projected details lost '${field}'`);
          for (const [key, want] of Object.entries(expected)) {
            if (want !== null && typeof want === "object") {
              assert.deepEqual(
                actual[key],
                { truncated: true, ...want },
                `${file}: ${field}.${key} count`,
              );
            } else {
              assert.deepEqual(actual[key], want, `${file}: ${field}.${key}`);
            }
          }
          assert.ok(
            JSON.stringify(actual).length <= (content.projected.maxFieldChars ?? 400),
            `${file}: projected '${field}' exceeds its field budget`,
          );
        }
        assert.equal(store.get("replay-1"), res, `${file}: full result not in diagnostics`);
        const wire = splitToolResult(projected);
        for (const blocks of [openAiToolContent(wire), anthropicToolContent(wire)]) {
          const text = (blocks[0] as { text: string }).text;
          assert.ok(
            text.includes('"diagnosticId":"replay-1"'),
            `${file}: provider payload lost the diagnostic pointer`,
          );
        }
        return;
      }
      if (content.expectedTextMaxChars !== undefined) {
        const wire = splitToolResult(res);
        assert.ok(
          wire.text.length <= content.expectedTextMaxChars,
          "tool text exceeds its byte-free budget",
        );
        assert.equal(wire.images.length, content.expectedImageCount);
      }

      if (content.expectedSuccess) {
        assert.equal(
          res.success,
          true,
          `Expected ${content.tool} to succeed for ${file}, but got error: ${res.error}`,
        );
      } else {
        assert.equal(
          res.success,
          false,
          `Expected ${content.tool} to fail for ${file}, but it unexpectedly succeeded`,
        );
        if (content.expectedErrorSnippet) {
          assert.ok(
            res.error?.includes(content.expectedErrorSnippet),
            `Expected error to contain '${content.expectedErrorSnippet}', got: '${res.error}'`,
          );
        }
      }
      if (content.expectedMessageSnippet) {
        assert.ok(
          res.message?.includes(content.expectedMessageSnippet),
          `Expected message to contain '${content.expectedMessageSnippet}', got: '${res.message}'`,
        );
      }
    });
  }
});
