import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGenesisToolCalls } from "../lib/asserts.ts";

const readOpeningRoom = {
  type: "function_call",
  name: "read_logic",
  arguments: JSON.stringify({ num: 1, offset: 0, limit: 5 }),
};

test("Genesis tool-call assertions inspect the complete Boilerplate promised by the prompt", () => {
  const result = validateGenesisToolCalls("", { providerResponse: { output: [readOpeningRoom] } });
  assert.equal(result.pass, true, result.reason);
});

test(
  "Genesis CLI offers its promised Boilerplate to the first real tool request",
  { timeout: 20000 },
  async () => {
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Uint8Array[] = [];
      for await (const bytes of req) chunks.push(bytes);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (requests.length === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "seed-review",
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1 },
            output: [{ ...readOpeningRoom, id: "fc1", call_id: "call1" }],
          }),
        );
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "End this offline inspection.", type: "invalid_request_error" },
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const dir = mkdtempSync(join(tmpdir(), "agi-seed-review-"));
    try {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "evals/genesis-cli.ts",
          "--provider",
          "openai",
          "--api-key",
          "test-placeholder",
          "--live",
          "--budget-usd",
          "1",
          "--trace",
          join(dir, "trace.json"),
        ],
        {
          env: { ...process.env, OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const timer = setTimeout(() => child.kill(), 15000);
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      clearTimeout(timer);
      assert.equal(code, 1, output);
      assert.equal(requests.length, 2, output);
      assert.match(JSON.stringify(requests[0]), /agihere\.boilerplate/);
      const report = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8")) as {
        trace: {
          type: string;
          payload: { tool?: string; result?: { success: boolean; error?: string } };
        }[];
      };
      const inspected = report.trace.find(
        (row) => row.type === "tool_execution" && row.payload.tool === "read_logic",
      );
      assert.ok(inspected, output);
      assert.equal(
        inspected.payload.result?.success,
        true,
        inspected.payload.result?.error ?? "The promised opening room must be present.",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
