import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSpent } from "../src/agent/reportedSpend.ts";
import { imageReportedSpend } from "../src/studio/creative/imageSpend.ts";

test("spent copy uses cents, small amounts, unknown prices and lower bounds", () => {
  const exact = { amount: 0.07, priceKnown: true, incomplete: false, budget: 5 };
  assert.equal(formatSpent(exact), "Spent $0.07 of your $5.00 budget");
  assert.equal(
    formatSpent({ ...exact, amount: 0.009 }),
    "Spent less than $0.01 of your $5.00 budget",
  );
  assert.equal(formatSpent({ ...exact, amount: 0 }), "Spent $0.00 of your $5.00 budget");
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
  assert.equal(imageReportedSpend("gpt-image-2", usage).amount, 0.052);
  assert.equal(
    imageReportedSpend("gpt-image-2", {
      inputTextTokens: 2000,
      inputImageTokens: 3000,
      outputImageTokens: 1200,
    }).amount,
    0.052,
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
  // The returned 1,200 output image tokens cost $15/M; input usage was absent.
  assert.equal(spend.amount, 0.018);
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
