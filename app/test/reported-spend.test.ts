import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSpent } from "../src/agent/reportedSpend.ts";
import { imageReportedSpend } from "../src/studio/creative/imageSpend.ts";

test("spent copy uses cents, small amounts, unknown prices and lower bounds", () => {
  const exact = { amount: 0.07, priceKnown: true, incomplete: false, budget: 5 };
  assert.equal(formatSpent(exact), "$0.07 of $5 spent");
  assert.equal(formatSpent({ ...exact, amount: 0.009 }), "less than $0.01 of $5 spent");
  assert.equal(formatSpent({ ...exact, amount: 0 }), "$0.00 of $5 spent");
  assert.equal(formatSpent({ ...exact, priceKnown: false }), "Spent: see your usage");
  assert.equal(
    formatSpent({ ...exact, incomplete: true }),
    "Spent at least $0.07; see your usage for the total",
  );
});

test("image spend prices only reported text, image input and output tokens", () => {
  // 2,000 × $5/M + 3,000 × $8/M + 1,200 × $30/M = $0.07.
  const usage = { inputTextTokens: 2000, inputImageTokens: 3000, outputTokens: 1200 };
  assert.deepEqual(imageReportedSpend("gpt-image-2.5-sunburst", usage), {
    amount: 0.07,
    priceKnown: true,
    incomplete: false,
  });
  assert.equal(imageReportedSpend("gpt-image-2", usage).amount, 0.07);
  assert.equal(
    imageReportedSpend("gpt-image-2", {
      inputTextTokens: 2000,
      inputImageTokens: 3000,
      outputImageTokens: 1200,
    }).amount,
    0.07,
  );
});

test("unknown image prices and missing image usage never invent spend", () => {
  assert.equal(
    formatSpent(imageReportedSpend("unknown", { outputTokens: 1200 })),
    "Spent: see your usage",
  );
  assert.equal(
    formatSpent(imageReportedSpend("gpt-image-2.5-sunburst")),
    "Spent at least $0.00; see your usage for the total",
  );
  assert.equal(imageReportedSpend("gpt-image-2", { totalTokens: 9999 }).amount, 0);
});

test("partial completed image usage contributes a measured lower bound", () => {
  const spend = imageReportedSpend("gpt-image-2", { outputImageTokens: 1200 });
  // The returned 1,200 output image tokens cost $30/M; input usage was absent.
  assert.equal(spend.amount, 0.036);
  assert.equal(spend.incomplete, true);
});

test("lower bounds round down to cents and identify reported fractions of a cent", () => {
  assert.equal(
    formatSpent({ amount: 0.018, priceKnown: true, incomplete: true }),
    "Spent at least $0.01; see your usage for the total",
  );
  assert.equal(
    formatSpent({ amount: 0.009, priceKnown: true, incomplete: true }),
    "Spent at least $0.00 (less than $0.01 reported); see your usage for the total",
  );
});

test("cached image input is charged once at the cached rate", () => {
  // 2,000 text × $5/M + 2,000 fresh images × $8/M + 1,000 cached × $2/M
  // + 1,200 output × $30/M = $0.064.
  for (const model of ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"])
    assert.deepEqual(
      imageReportedSpend(model, {
        inputTextTokens: 2000,
        inputImageTokens: 3000,
        inputCachedTokens: 1000,
        outputTokens: 1200,
      }),
      { amount: 0.064, priceKnown: true, incomplete: false },
    );
});

test("a finished message without reported usage says so instead of waiting", () => {
  // The compact label is written once, when the task ends; nothing updates it later.
  assert.equal(
    formatSpent({ amount: 0, priceKnown: true, incomplete: true }, "compact"),
    "Usage not reported",
  );
  assert.equal(
    formatSpent({ amount: 0.018, priceKnown: true, incomplete: true, budget: 5 }, "compact"),
    "$0.01+ / $5 spent",
  );
});
