import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
} from "../../src/agent/tools.ts";
import { splitToolResult } from "../../src/agent/toolTransport.ts";

describe("stored bad cases regression suite (evals/fixtures/bad-cases)", () => {
  const badCasesDir = resolve("evals/fixtures/bad-cases");
  const files = readdirSync(badCasesDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(badCasesDir, file);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));

    it(`replays bad case: ${content.name} (${file})`, async () => {
      const session = createAgentSessionState();
      const execute = content.async ? executeAgentToolAsync : executeAgentTool;
      const res = await execute(session, content.tool, content.args);
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
