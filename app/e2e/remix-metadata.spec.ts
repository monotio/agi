import { providerReply } from "../../test/provider-stream.ts";
import type { EngineStateReport } from "../../src/runtime/engine.ts";
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The worker replies this test reads (engine.worker.ts, "Messages out"). */
type WorkerReply =
  | { type: "booted" }
  | { type: "metadataPatched" }
  | { type: "cycle"; cycle: number }
  | { type: "error"; message: string }
  | { type: "engineState"; id: number; state: EngineStateReport }
  | { type: "exportFiles"; id: number; files: Record<string, Uint8Array> };
type Reply<T extends WorkerReply["type"]> = Extract<WorkerReply, { type: T }>;

test("power-up vocabulary and inventory reach the live worker and exported game", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    const calls = [
      ["write_words", { words: ["sparkle"] }],
      [
        "write_inventory_objects",
        {
          objects: [
            { name: "Old key", startingRoom: 2 },
            { name: "Crystal", startingRoom: 255 },
          ],
        },
      ],
      [
        "write_logic_source",
        {
          room: 0,
          source: `
        accept.input();
        if (said("sparkle")) { assignn(v200, 77); }
        assignn(v202, 0); get.room.v(v202, v201);
        assignn(v202, 1); get.room.v(v202, v203);
        return;
      `,
        },
      ],
    ] as const;
    await route.fulfill(
      providerReply("openai", {
        id: `reply${requests}`,
        output:
          requests === 1
            ? calls.map(([name, args], i) => ({
                type: "function_call",
                id: `item${i}`,
                call_id: `call${i}`,
                name,
                arguments: JSON.stringify(args),
              }))
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Your crystal can sparkle." }],
                },
              ],
      }),
    );
  });
  await page.goto("/");
  const result = await page.evaluate(
    async ({ toolsPath, wordsPath }) => {
      const sessionPath = "/src/agent/agentSession.ts";
      const workerPath = "/src/engine.worker.ts?worker";
      const { AgentSession } = await import(sessionPath);
      const { default: EngineWorker } = await import(workerPath);
      const tools = await import(toolsPath);
      const { parseWordsTok } = await import(wordsPath);
      const state = tools.createAgentSessionState();
      const initial = [
        ["write_words", { words: ["look"] }],
        ["write_inventory_objects", { objects: [{ name: "Old key", startingRoom: 1 }] }],
        ["write_logic_source", { room: 0, source: "accept.input(); get(0); return;" }],
      ] as const;
      for (const [name, args] of initial) {
        const res = tools.executeAgentTool(state, name, args);
        if (!res.success) throw new Error(res.error);
      }
      const files = Object.fromEntries(
        [...state.getFiles()].map(([name, bytes]) => [name, bytes.slice()]),
      );
      const words = [...state.sources.words];
      const session = new AgentSession(
        { provider: "openai", apiKey: "test-placeholder", model: "test" },
        () => {},
        state,
      );
      const turn = await session.runPowerUp("Add a crystal and sparkle command", 0);
      const worker = new EngineWorker() as Worker;
      const sab = new SharedArrayBuffer(16 + 1024 * 1024);
      const control = new Int32Array(sab, 0, 4);
      const messages: WorkerReply[] = [];
      const waiters = new Set<() => void>();
      worker.onmessage = (event) => {
        messages.push(event.data);
        for (const wake of waiters) wake();
      };
      const wait = <T extends WorkerReply>(
        predicate: (message: WorkerReply) => message is T,
      ): Promise<T> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            waiters.delete(check);
            reject(new Error("Worker reply timed out"));
          }, 10000);
          const check = () => {
            const error = messages.find(
              (message): message is Reply<"error"> => message.type === "error",
            );
            const at = messages.findIndex(predicate);
            if (!error && at < 0) return;
            clearTimeout(timeout);
            waiters.delete(check);
            if (error) reject(new Error(error.message));
            else resolve(messages.splice(at, 1)[0] as T);
          };
          waiters.add(check);
          check();
        });
      let queryId = 0;
      const query = async <T extends WorkerReply>(type: string) => {
        const id = ++queryId;
        worker.postMessage({ type, id });
        return wait((message): message is T => "id" in message && message.id === id);
      };
      const cycle = async (minimum: number) => {
        await wait(
          (message): message is Reply<"cycle"> =>
            message.type === "cycle" && message.cycle >= minimum,
        );
        Atomics.store(control, 2, 1);
      };
      try {
        worker.postMessage({ type: "boot", files, words, sab });
        await wait((message): message is Reply<"booted"> => message.type === "booted");
        await cycle(5); // The old key has been picked up in this live session.
        for (const patch of turn.patched) worker.postMessage({ type: "patch", ...patch });
        // Negative control: exactly the old broken transport. Logic arrives but
        // parser vocabulary and inventory files do not, so sparkle cannot fire.
        worker.postMessage({ type: "input", text: "sparkle" });
        Atomics.store(control, 2, 0);
        await cycle(10);
        const before = (await query<Reply<"engineState">>("state")).state;
        worker.postMessage({ type: "patchMetadata", files: turn.files });
        await wait(
          (message): message is Reply<"metadataPatched"> => message.type === "metadataPatched",
        );
        worker.postMessage({ type: "input", text: "sparkle" });
        Atomics.store(control, 2, 0);
        await cycle(15);
        const after = (await query<Reply<"engineState">>("state")).state;
        const exported = (await query<Reply<"exportFiles">>("exportFiles")).files;
        return {
          before: before.vars[200],
          after: after.vars[200],
          oldLocation: after.vars[201],
          newLocation: after.vars[203],
          words: parseWordsTok(exported["WORDS.TOK"]!).map((entry: { word: string }) => entry.word),
          exportedObject: [...exported["OBJECT"]!],
          authoredObject: [...turn.files["OBJECT"]],
        };
      } finally {
        worker.terminate();
      }
    },
    {
      toolsPath: "/@fs" + fileURLToPath(new URL("../../src/agent/tools.ts", import.meta.url)),
      wordsPath: "/@fs" + fileURLToPath(new URL("../../src/logic/words.ts", import.meta.url)),
    },
  );
  expect(requests).toBe(2);
  expect(result.before).toBe(0);
  expect(result.after).toBe(77);
  expect(result.oldLocation).toBe(255);
  expect(result.newLocation).toBe(255);
  expect(result.words).toContain("sparkle");
  expect(result.exportedObject).toEqual(result.authoredObject);
});
