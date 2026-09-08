import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const finish = [
  { name: "write_words", args: { words: ["look"] } },
  {
    name: "write_view",
    args: {
      num: 0,
      spec: { loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [5] }] }] },
    },
  },
  {
    name: "write_logic_source",
    args: { room: 0, source: "if (!isset(f200)) {set(f200);new.room(1);} call.v(v0);return;" },
  },
  {
    name: "write_logic_source",
    args: {
      room: 1,
      source:
        "if (isset(f5)) {load.pic(v0);draw.pic(v0);show.pic();load.view(0);animate.obj(0);set.view(0,0);position(0,80,120);draw(0);accept.input();} return;",
    },
  },
  { name: "finish_genesis", args: { notes: "ready" } },
];

for (const provider of ["openai", "anthropic"]) {
  test(
    `Genesis CLI sends PNG image blocks to ${provider} on the correction turn`,
    { timeout: 20000 },
    async () => {
      const requests: unknown[] = [];
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const calls =
          requests.length === 1
            ? [
                { name: "write_picture", args: { room: 1, source: "vis 1\nfill 0,0\nend" } },
                {
                  name: "write_logic_source",
                  args: { room: 1, source: "invalid opcode nonsense" },
                },
              ]
            : finish;
        const reply =
          provider === "openai"
            ? {
                id: "test",
                status: "completed",
                usage: {
                  input_tokens: requests.length === 1 ? 100 : 200,
                  output_tokens: requests.length === 1 ? 20 : 30,
                  input_tokens_details: {
                    cached_tokens: requests.length === 1 ? 10 : 90,
                    cache_write_tokens: requests.length === 1 ? 5 : 0,
                  },
                },
                output: calls.map((c, i) => ({
                  type: "function_call",
                  id: `fc${i}`,
                  call_id: `call${i}`,
                  name: c.name,
                  arguments: JSON.stringify(c.args),
                })),
              }
            : {
                id: "test",
                role: "assistant",
                type: "message",
                content: calls.map((c, i) => ({
                  type: "tool_use",
                  id: `call${i}`,
                  name: c.name,
                  input: c.args,
                })),
                stop_reason: "tool_use",
                usage: {
                  input_tokens: requests.length === 1 ? 100 : 200,
                  output_tokens: requests.length === 1 ? 20 : 30,
                  cache_read_input_tokens: requests.length === 1 ? 10 : 90,
                  cache_creation_input_tokens: requests.length === 1 ? 5 : 0,
                },
              };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const directory = mkdtempSync(join(tmpdir(), "agi-transport-"));
      try {
        const child = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "scripts/eval-genesis.ts",
            "--provider",
            provider,
            "--api-key",
            "test-placeholder",
            "--trace",
            join(directory, "trace.json"),
          ],
          {
            env: { ...process.env, OPENAI_BASE_URL: endpoint, ANTHROPIC_BASE_URL: endpoint },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const timer = setTimeout(() => child.kill(), 15000);
        const code = await new Promise((resolve) => child.on("close", resolve));
        clearTimeout(timer);
        assert.equal(code, 0, output);
        assert.equal(requests.length, 2);
        if (provider === "openai")
          assert.deepEqual(record(requests[0])["prompt_cache_options"], {
            mode: "implicit",
            ttl: "30m",
          });
        const second = record(requests[1]);
        let result: unknown;
        if (provider === "openai") {
          const input = second["input"];
          assert.ok(Array.isArray(input));
          result = record(
            input.find((item: unknown) => record(item)["type"] === "function_call_output"),
          )["output"];
        } else {
          const messages = second["messages"];
          assert.ok(Array.isArray(messages));
          const content = record(
            messages.find(
              (item: unknown) =>
                record(item)["role"] === "user" && Array.isArray(record(item)["content"]),
            ),
          )["content"];
          assert.ok(Array.isArray(content));
          result = record(content[0])["content"];
        }
        assert.ok(Array.isArray(result), "tool response must use multimodal blocks");
        const text = record(result[0])["text"];
        assert.ok(typeof text === "string" && text.length < 2000);
        let encoded: unknown;
        if (provider === "openai") {
          const imageUrl = record(result[2])["image_url"];
          assert.equal(typeof imageUrl, "string");
          encoded = (imageUrl as string).split(",")[1];
        } else encoded = record(record(result[2])["source"])["data"];
        assert.ok(typeof encoded === "string");
        assert.deepEqual(
          [...Buffer.from(encoded, "base64").subarray(0, 8)],
          [137, 80, 78, 71, 13, 10, 26, 10],
        );
        const trace = readFileSync(join(directory, "trace.json"), "utf8");
        assert.ok(trace.length < 70000, "trace must summarize binary output");
        const report = JSON.parse(trace);
        assert.deepEqual(report.metrics.usage, {
          input: provider === "openai" ? 300 : 405,
          output: 50,
          cachedInput: 100,
          cacheWriteInput: 5,
        });
        assert.equal(report.metrics.modelTurns, 2);
        assert.equal(report.metrics.repairTurns, 1);
        assert.equal(report.metrics.toolFailures, 1);
        assert.ok(report.metrics.modelLatencyMs >= 0);
        assert.equal(report.metrics.playtest.success, true);
        assert.equal(report.metrics.playtest.simulation, "passed");
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const provider of ["openai", "anthropic"]) {
  for (const defect of ["incomplete", "invalid arguments"]) {
    test(
      `Genesis CLI preserves usage and rejects ${provider} ${defect} before executing any tools`,
      { timeout: 20000 },
      async () => {
        const server = createServer(async (req, res) => {
          for await (const chunk of req) {
            void chunk;
          }
          const valid = { name: "write_words", args: { words: ["look"] } };
          const calls = [
            valid,
            ...(defect === "invalid arguments" ? [{ name: "write_words", args: [] }] : []),
          ];
          const reply =
            provider === "openai"
              ? {
                  id: "rejected",
                  status: defect === "incomplete" ? "incomplete" : "completed",
                  incomplete_details:
                    defect === "incomplete" ? { reason: "max_output_tokens" } : null,
                  usage: {
                    input_tokens: 50,
                    output_tokens: 10,
                    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 },
                  },
                  output: calls.map((call, i) => ({
                    type: "function_call",
                    id: `fc${i}`,
                    call_id: `call${i}`,
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  })),
                }
              : {
                  id: "rejected",
                  type: "message",
                  role: "assistant",
                  stop_reason: defect === "incomplete" ? "max_tokens" : "tool_use",
                  usage: {
                    input_tokens: 27,
                    output_tokens: 10,
                    cache_read_input_tokens: 20,
                    cache_creation_input_tokens: 3,
                  },
                  content: calls.map((call, i) => ({
                    type: "tool_use",
                    id: `call${i}`,
                    name: call.name,
                    input: call.args,
                  })),
                };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(reply));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const directory = mkdtempSync(join(tmpdir(), "agi-rejected-"));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const endpoint = `http://127.0.0.1:${address.port}`;
        try {
          const child = spawn(
            process.execPath,
            [
              "--experimental-strip-types",
              "scripts/eval-genesis.ts",
              "--provider",
              provider,
              "--api-key",
              "test-placeholder",
              "--trace",
              join(directory, "trace.json"),
            ],
            {
              env: { ...process.env, OPENAI_BASE_URL: endpoint, ANTHROPIC_BASE_URL: endpoint },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          const timer = setTimeout(() => child.kill(), 15000);
          const code = await new Promise((resolve) => child.on("close", resolve));
          clearTimeout(timer);
          assert.equal(code, 1, output);
          const report = JSON.parse(readFileSync(join(directory, "trace.json"), "utf8"));
          assert.equal(
            report.trace.filter((entry: { type: string }) => entry.type === "tool_execution")
              .length,
            0,
          );
          assert.deepEqual(report.metrics.usage, {
            input: 50,
            output: 10,
            cachedInput: 20,
            cacheWriteInput: 3,
          });
          assert.equal(report.metrics.modelTurns, 1);
          assert.equal(report.genesisComplete, false);
          assert.match(
            report.error,
            defect === "incomplete" ? /output limit/ : /invalid.*arguments/i,
          );
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
}
