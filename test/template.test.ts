import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildTemplateWordEntries, parseAdventureTemplate } from "../src/template/template.ts";
import { buildWordsTok, lookupWord, parseWordsTok } from "../src/logic/words.ts";

const MINIMAL_TEMPLATE = `---
name: test-template
description: A test template for unit testing.
---

# Test Adventure

## Premise
Escape the labyrinth before sunset.

## Tone
Whimsical and lighthearted. PG.

## Art direction
Bright EGA greens and earthy browns.

## Protagonist
Bob: a curious wanderer in blue overalls.

## Starting room
The stone foyer with exits east and west.

## Lexicon
- Verbs: look, take/get, open, talk
- Nouns: key, door, chest, coin

## Point table (max 100)
| Points | Beat |
| --- | --- |
| 20 | Open the chest |
| 80 | Unlock the door |

## Beats
1. Find the hidden key.
2. Open the iron door.

## NPC seeds
- **The Gatekeeper** — asleep on duty
- **The Owl** — offers cryptic hints

## Deaths
- Stepping into the spiked pit
- Drinking the unlabeled flask
`;

describe("parseAdventureTemplate", () => {
  it("parses minimal valid template with frontmatter and core sections", () => {
    const c = parseAdventureTemplate(MINIMAL_TEMPLATE);
    assert.equal(c.id, "test-template");
    assert.equal(c.description, "A test template for unit testing.");
    assert.equal(c.title, "Test Adventure");
    assert.equal(c.premise, "Escape the labyrinth before sunset.");
    assert.equal(c.tone, "Whimsical and lighthearted. PG.");
    assert.equal(c.artDirection, "Bright EGA greens and earthy browns.");
    assert.equal(c.protagonist, "Bob: a curious wanderer in blue overalls.");
    assert.equal(c.startingRoom, "The stone foyer with exits east and west.");
    assert.equal(c.maxPoints, 100);

    // Points table
    assert.equal(c.pointTable.length, 2);
    assert.deepEqual(c.pointTable[0], { points: 20, beat: "Open the chest" });
    assert.deepEqual(c.pointTable[1], { points: 80, beat: "Unlock the door" });

    // Beats
    assert.equal(c.beats.length, 2);
    assert.equal(c.beats[0], "Find the hidden key.");
    assert.equal(c.beats[1], "Open the iron door.");

    // NPC seeds
    assert.equal(c.npcSeeds.length, 2);
    assert.equal(c.npcSeeds[0]!.name, "The Gatekeeper");
    assert.equal(c.npcSeeds[0]!.description, "asleep on duty");

    // Deaths
    assert.equal(c.deaths.length, 2);
    assert.equal(c.deaths[0], "Stepping into the spiked pit");
  });

  it("parses synonym slashes into grouped vocabulary", () => {
    const c = parseAdventureTemplate(MINIMAL_TEMPLATE);
    assert.ok(c.lexicon.verbs.includes("look"));
    assert.ok(c.lexicon.verbs.includes("take"));
    assert.ok(c.lexicon.verbs.includes("get"));

    const takeGroup = c.lexicon.synonymGroups.find((g) => g.words.includes("take"));
    assert.ok(takeGroup, "take group exists");
    assert.deepEqual([...takeGroup.words].sort(), ["get", "take"]);
  });

  it("builds WORDS.TOK entries with shared IDs for synonyms", () => {
    const c = parseAdventureTemplate(MINIMAL_TEMPLATE);
    const entries = buildTemplateWordEntries(c);
    const dict = buildWordsTok(entries);
    const parsed = parseWordsTok(dict);

    const takeId = lookupWord(parsed, "take");
    const getId = lookupWord(parsed, "get");
    assert.ok(takeId !== null && takeId > 0);
    assert.equal(takeId, getId, "synonyms share the exact same word id");

    const lookId = lookupWord(parsed, "look");
    assert.notEqual(takeId, lookId, "distinct words have distinct ids");
  });

  it("parses all four committed templates without error", () => {
    const gamesDir = join(import.meta.dirname, "..", "games");
    const templates = [
      {
        id: "knights-trial",
        title: "Knight's Trial",
        max: 230,
        protoLead: "Wenna",
      },
      {
        id: "badge-of-millhaven",
        title: "Badge of Millhaven",
        max: 215,
        protoLead: "Dana",
      },
      {
        id: "mop-jockey",
        title: "Mop Jockey",
        max: 250,
        protoLead: "Pip",
      },
      {
        id: "polyester-nights",
        title: "Polyester Nights",
        max: 200,
        protoLead: "Dale",
      },
    ];

    for (const spec of templates) {
      const path = join(gamesDir, spec.id, "SKILL.md");
      const md = readFileSync(path, "utf-8");
      const c = parseAdventureTemplate(md);
      assert.equal(c.id, spec.id);
      assert.equal(c.title, spec.title);
      assert.equal(c.maxPoints, spec.max);
      assert.ok(c.protagonist.includes(spec.protoLead), `protagonist mentions ${spec.protoLead}`);
      assert.ok(c.pointTable.length > 0, "point table present");
      assert.equal(
        c.pointTable.reduce((total, entry) => total + entry.points, 0),
        c.maxPoints,
        `${spec.id}: the walkthrough's point awards add up to its maximum`,
      );
      assert.ok(c.beats.length > 0, "beats present");
      assert.ok(c.npcSeeds.length > 0, "npc seeds present");
      assert.ok(c.deaths.length > 0, "deaths present");
      assert.ok(c.lexicon.allWords.length > 10, "lexicon populated");
    }
  });

  it("validates missing required sections", () => {
    assert.throws(() => parseAdventureTemplate("Just some text"), Error);
    assert.throws(
      () =>
        parseAdventureTemplate(`---
name: missing-title
description: foo
---
## Premise
No h1 title here.
`),
      Error,
    );
  });
});
