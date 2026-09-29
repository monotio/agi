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
    // Read the stream whole to find the response id and any diagnostics,
    // then hand the client an identical body; the harness has no display.
    const text = await response.text();
    const id = /"id":"((?:msg|resp)_[^"]+)"/.exec(text)?.[1];
    if (id) previousId = id;
    const key = provider === "anthropic" ? "diagnostics" : "prompt_cache_diagnostics";
    const match = new RegExp(`"${key}":(\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\})`).exec(text);
    found.push(match ? JSON.parse(match[1]!) : null);
    return new Response(text, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  return {
    bodies,
    diagnostics: found,
    restore() {
      globalThis.fetch = original;
    },
  };
}
