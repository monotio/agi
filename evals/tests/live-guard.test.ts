/**
 * No harness starts a paid run on the strength of an API key in the
 * environment: each one refuses without both `--live` and `--budget-usd`
 * (`EVAL_LIVE=1` and a budget variable for the promptfoo lanes), naming the
 * flag, and sends nothing. The command-line harnesses are spawned with keys
 * set and their provider base URLs pointed at a local server that counts
 * requests; a leak is a request. Watched failing before the guard: the
 * harnesses ran against the local server (exit 0 or provider errors, hits
 * above zero).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLiveEnv, assertLiveRun, LiveRunRefused } from "../lib/live-guard.ts";
import { providerMatrix } from "../configs/providers.ts";
import { runGenesisSession, type GenesisOptions } from "../providers/genesis-session.ts";

const KEYS = {
  OPENAI_API_KEY: "sk-test-placeholder",
  ANTHROPIC_API_KEY: "sk-ant-test-placeholder",
};

test("the guard needs both --live and --budget-usd, whatever the environment holds", () => {
  const base = { plan: "a test", offline: "--dry-run" };
  assert.throws(
    () => assertLiveRun({ ...base, live: false, budgetUsd: 1 }),
    (error: unknown) => error instanceof LiveRunRefused && /--live/.test(error.message),
  );
  assert.throws(
    () => assertLiveRun({ ...base, live: true, budgetUsd: undefined }),
    (error: unknown) => error instanceof LiveRunRefused && /--budget-usd/.test(error.message),
  );
  assert.throws(() => assertLiveRun({ ...base, live: true, budgetUsd: 0 }), LiveRunRefused);
  assert.equal(assertLiveRun({ ...base, live: true, budgetUsd: 2.5 }), 2.5);
  assert.throws(
    () => assertLiveEnv({ ...KEYS, EVAL_BUDGET: "3" }, "EVAL_BUDGET", "x"),
    /EVAL_LIVE=1/,
  );
  assert.throws(
    () => assertLiveEnv({ ...KEYS, EVAL_LIVE: "1" }, "EVAL_BUDGET", "x"),
    /EVAL_BUDGET/,
  );
  assert.equal(assertLiveEnv({ EVAL_LIVE: "1", EVAL_BUDGET: "3" }, "EVAL_BUDGET", "x"), 3);
});

test("the promptfoo lanes list no paid provider without EVAL_LIVE", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, KEYS);
  delete process.env["EVAL_LIVE"];
  delete process.env["EVAL_RUN_BUDGET_USD"];
  assert.deepEqual(providerMatrix(), []);
  process.env["EVAL_LIVE"] = "1";
  process.env["EVAL_RUN_BUDGET_USD"] = "1";
  assert.ok(providerMatrix().length > 0);
});

test("the effort lane refuses a live session without EVAL_LIVE even with a key", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, KEYS);
  delete process.env["EVAL_LIVE"];
  await assert.rejects(
    runGenesisSession({
      provider: "openai",
      model: "gpt-6-sol",
      templateText: "x",
      promptVariant: "lean",
      budgetUsd: 1,
    } as GenesisOptions),
    /EVAL_LIVE=1/,
  );
});

const HARNESSES: readonly { file: string; args: (dir: string) => string[] }[] = [
  { file: "evals/cache-probe.ts", args: () => ["--provider", "openai", "--budget-usd", "1"] },
  {
    file: "evals/reference-benchmark.ts",
    args: () => ["--provider", "openai", "--budget-usd", "1"],
  },
  {
    file: "evals/studio-assist-benchmark.ts",
    args: () => ["--provider", "openai", "--budget-usd", "1"],
  },
  {
    file: "evals/remix-benchmark.ts",
    args: (dir) => ["--game", dir, "--provider", "openai", "--budget-usd", "1"],
  },
  { file: "evals/genesis-cli.ts", args: () => ["--provider", "openai", "--budget-usd", "1"] },
  {
    file: "evals/picture-fidelity.ts",
    args: () => ["--provider", "openai", "--budget-usd", "1"],
  },
];

test("every command-line harness refuses without --live and sends nothing", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"the live guard test must never be reached"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const directory = mkdtempSync(join(tmpdir(), "agi-live-guard-"));
  try {
    for (const harness of HARNESSES) {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", harness.file, ...harness.args(directory)],
        {
          env: {
            ...process.env,
            ...KEYS,
            OPENAI_BASE_URL: endpoint,
            ANTHROPIC_BASE_URL: endpoint,
          },
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
      const timer = setTimeout(() => child.kill(), 60000);
      const code = await new Promise((resolve) => child.on("close", resolve));
      clearTimeout(timer);
      assert.notEqual(code, 0, `${harness.file} exited 0:\n${output}`);
      assert.match(output, /--live/, `${harness.file} did not name --live:\n${output}`);
      assert.equal(hits, 0, `${harness.file} sent a provider request`);
    }
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
