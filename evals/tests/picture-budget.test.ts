/**
 * The picture-fidelity lane stops at its budget between requests, not only
 * between entries: a scripted model behind a mocked `fetch` answers every
 * request through the real OpenAI client with a fixed bill, and no request
 * starts once the run has spent its cap. Nothing leaves the process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../picture-fidelity.ts";
import { providerSse } from "../../test/provider-stream.ts";

/**
 * gpt-6-sol is priced at $2 input and $10 output per million tokens, so
 * each scripted response bills 100 000 × 2 / 1e6 + 20 000 × 10 / 1e6 =
 * $0.20 + $0.20 = $0.40.
 */
const BILL = { input_tokens: 100_000, output_tokens: 20_000 };

function scriptedResponse(n: number): Response {
  return new Response(
    providerSse("openai", {
      id: `resp_${n}`,
      object: "response",
      created_at: 0,
      status: "completed",
      model: "gpt-6-sol",
      output: [
        {
          type: "function_call",
          id: `fc_${n}`,
          call_id: `call_${n}`,
          name: "write_picture",
          arguments: JSON.stringify({ room: 1, source: "vis 1\nend\n" }),
          status: "completed",
        },
      ],
      usage: {
        ...BILL,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: BILL.input_tokens + BILL.output_tokens,
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("a paid picture run sends no request once its spending reaches the budget", async (t) => {
  const key = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "sk-test-placeholder";
  t.after(() => {
    if (key === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = key;
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => scriptedResponse(++requests));

  const provider = createProvider("openai", "gpt-6-sol", undefined, "medium");
  provider.budgetUsd = 1;
  let rounds = 0;
  // Six revision rounds would cost $2.40; the cap is $1.
  await assert.rejects(
    provider.recreate(
      "system",
      "user",
      () => {
        rounds++;
        return { success: true };
      },
      6,
    ),
    /Budget reached/,
  );
  // $0.40, $0.80, $1.20: the third request crossed the cap, so no fourth started.
  assert.equal(requests, 3);
  assert.equal(rounds, 3);
  assert.equal(provider.spentUsd.toFixed(2), "1.20");
  // The brief and the judge pass the same gate.
  await assert.rejects(
    provider.complete("judge", [{ type: "text", text: "?" }], "gpt-6-sol"),
    /Budget reached/,
  );
  assert.equal(requests, 3);
});
