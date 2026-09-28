import assert from "node:assert/strict";
import { test } from "node:test";
import { STUDIO_TERMS } from "../src/studio/studioTerms.ts";
import { HELP_SECTIONS } from "../src/shell/helpContent.ts";

/**
 * The Studios' explainers (studioTerms.ts) under the owner's copy rules: a
 * name of a few words, one or two short sentences that end in one full stop
 * and say what the thing is or does, and a "Learn more" that lands on a Help
 * topic that exists (a topic that moves would break it silently).
 */

/** Phrases the copy rules retire: dash asides and definitions by negation. */
const RETIRED = [" — ", "not a", "never", "no longer", "rather than", "instead of"];

const entries = Object.entries(STUDIO_TERMS);

test("every Studio term says what it is in at most 140 characters", () => {
  assert.ok(entries.length >= 33, `${entries.length} terms`);
  for (const [term, { name, says }] of entries) {
    assert.ok(says.length <= 140, `${term}: ${says.length} characters`);
    assert.match(says, /[^.]\.$/, `${term} ends in one full stop`);
    for (const phrase of RETIRED)
      assert.ok(!says.toLowerCase().includes(phrase), `${term} says "${phrase}"`);
    assert.ok(name.split(" ").length <= 4, `${term}: "${name}" is a name of a few words`);
    assert.ok(!/[.:]$/.test(name), `${term}: "${name}" is a name, not a sentence`);
  }
});

test("every Studio term's Learn more lands on a Help topic", () => {
  for (const [term, { help }] of entries) {
    const section = HELP_SECTIONS.find((entry) => entry.id === help.section);
    assert.ok(section, `${term}: section ${help.section}`);
    assert.ok(
      section.topics.some((topic) => topic.id === help.topic),
      `${term}: topic ${help.section}/${help.topic}`,
    );
  }
});

test("Help topic ids are unique within the guide", () => {
  const ids = HELP_SECTIONS.flatMap((section) => section.topics.map((topic) => topic.id));
  assert.deepEqual(
    ids.filter((id, index) => ids.indexOf(id) !== index),
    [],
  );
});
