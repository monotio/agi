import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCustomizedWordFeedback } from "../src/authoring/scriptSizeMigration.ts";
import { releasedTemplates } from "./released-template-fixtures.ts";

test("only customized one-based word feedback needs the counting hint", () => {
  const released = releasedTemplates.at(-1)!.source;
  assert.equal(
    hasCustomizedWordFeedback({
      "logic:0": released.replace("I don't know the word", "Unknown word"),
    }),
    true,
  );
  assert.equal(hasCustomizedWordFeedback({ "logic:0": released }), false);
  assert.equal(
    hasCustomizedWordFeedback({
      "logic:0": 'if (equaln(v9,1)) { word.to.string(s1,0); print("Unknown %s1"); } return;',
    }),
    false,
  );
  assert.equal(hasCustomizedWordFeedback({ "logic:0": "word.to.string(s1,1); return;" }), false);
  assert.equal(hasCustomizedWordFeedback({}), false);
  assert.equal(hasCustomizedWordFeedback({ "logic:0": "if (" }), false);
});
