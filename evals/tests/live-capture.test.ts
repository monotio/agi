import assert from "node:assert/strict";
import { test } from "node:test";
import { captureLive } from "../lib/live-capture.ts";
import { sseEvent } from "../../test/provider-stream.ts";

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} live capture forwards the first bytes before stream completion`, async (t) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const first = new TextEncoder().encode(
      sseEvent(
        provider === "openai"
          ? { type: "response.created", response: { id: "resp_1", status: "in_progress" } }
          : { type: "message_start", message: { id: "msg_1", content: [] } },
      ),
    );
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller = c;
              c.enqueue(first);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const capture = captureLive(provider, true);
    let delivered = false;
    const work = fetch("https://provider.invalid", { method: "POST", body: "{}" }).then(
      async (response) => {
        const reader = response.body!.getReader();
        const chunk = await reader.read();
        delivered = true;
        return { reader, chunk };
      },
    );
    await new Promise(setImmediate);
    const early = delivered;
    const tail = new TextEncoder().encode(
      sseEvent(
        provider === "openai"
          ? {
              type: "response.completed",
              response: {
                id: "resp_1",
                prompt_cache_diagnostics: { reason: "café", nested: { hit: true } },
              },
            }
          : { type: "message_delta", diagnostics: { reason: "café", nested: { hit: true } } },
      ),
    );
    try {
      for (const byte of tail) controller.enqueue(Uint8Array.of(byte));
      controller.close();
      const { reader, chunk } = await work;
      const chunks = [chunk.value!];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      assert.equal(early, true, "first bytes must arrive while the provider is still open");
      assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, tail]));
      assert.deepEqual(capture.diagnostics, [{ reason: "café", nested: { hit: true } }]);
      const next = await fetch("https://provider.invalid", { method: "POST", body: "{}" });
      await next.body!.cancel();
    } finally {
      capture.restore();
    }
  });
}
