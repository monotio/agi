/**
 * Pass provider requests through to the real fetch, keeping each body for
 * the prefix analysis and, when asked, requesting the provider's own cache
 * diagnostics: Anthropic's cache-diagnosis beta header with
 * `diagnostics.previous_message_id`, OpenAI's
 * `prompt_cache_options.comparison_response_id`. Install it before the
 * session builds its client, which binds fetch at construction.
 */
import type { ScriptProvider } from "./scripted-provider.ts";

export interface Captured {
  readonly bodies: Record<string, unknown>[];
  /** Whatever cache diagnostics the provider returned, per request. */
  readonly diagnostics: unknown[];
  restore(): void;
}

/**
 * Pass requests through to the real provider, keeping each body and, with
 * --diagnostics, asking the provider to compare it with the previous one.
 */
export function captureLive(provider: ScriptProvider, diagnostics: boolean): Captured {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  const found: unknown[] = [];
  let previousId: string | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : null;
    if (raw === null) return original(input, init);
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(structuredClone(body));
    let request = init;
    if (diagnostics) {
      const headers = new Headers(init?.headers);
      if (provider === "anthropic") {
        const betas = headers.get("anthropic-beta");
        headers.set(
          "anthropic-beta",
          betas ? `${betas},cache-diagnosis-2026-04-07` : "cache-diagnosis-2026-04-07",
        );
        body["diagnostics"] = { previous_message_id: previousId };
      } else {
        body["prompt_cache_options"] = {
          ...(body["prompt_cache_options"] as object),
          comparison_response_id: previousId,
        };
      }
      request = { ...init, headers, body: JSON.stringify(body) };
    }
    const response = await original(input, request);
    const index = found.length;
    found.push(null);
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let pending = "";
    let data: string[] = [];
    const key = provider === "anthropic" ? "diagnostics" : "prompt_cache_diagnostics";
    function inspect(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record[key] !== undefined) found[index] = record[key];
      for (const child of Object.values(record)) inspect(child);
    }
    function event(text: string): void {
      try {
        const value = JSON.parse(text) as Record<string, unknown>;
        const message = (value["response"] ?? value["message"] ?? value) as Record<string, unknown>;
        if (typeof message["id"] === "string") previousId = message["id"];
        inspect(value);
      } catch {
        // Diagnostics are optional; the provider client parses the original bytes.
      }
    }
    function consume(text: string, final = false): void {
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line) {
          if (data.length) event(data.join("\n"));
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (final) {
        if (pending.startsWith("data:")) data.push(pending.slice(5).trimStart());
        if (data.length) event(data.join("\n"));
        else if (pending) event(pending);
      }
    }
    const bodyStream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          consume(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          consume(decoder.decode(), true);
        },
      }),
    );
    return new Response(bodyStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
  return {
    bodies,
    diagnostics: found,
    restore() {
      globalThis.fetch = original;
    },
  };
}
