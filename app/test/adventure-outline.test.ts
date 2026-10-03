import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseOutline } from "../src/home/adventureOutline.ts";

test("outline preview strips front matter and keeps title, headings and paragraphs", () => {
  const source =
    "---\r\nname: secret\r\ndescription: metadata\r\n---\r\n\r\n# A lantern\r\n\r\n## Premise\r\nFind **a light**\r\nbefore dusk.\r\n\r\nAnother paragraph.\r\n\r\n### Clue\r\nTry `look`.";
  assert.deepEqual(parseOutline(source), [
    { kind: "heading", level: 1, text: "A lantern" },
    { kind: "heading", level: 2, text: "Premise" },
    { kind: "paragraph", text: "Find a light before dusk." },
    { kind: "paragraph", text: "Another paragraph." },
    { kind: "heading", level: 3, text: "Clue" },
    { kind: "paragraph", text: "Try look." },
  ]);
  assert.ok(source.includes("name: secret"), "preview keeps the source intact");
});

test("all built-in outlines keep every section and render lists and point tables", () => {
  for (const id of ["knights-trial", "badge-of-millhaven", "mop-jockey", "polyester-nights"]) {
    const source = readFileSync(new URL(`../../games/${id}/SKILL.md`, import.meta.url), "utf8");
    const blocks = parseOutline(source);
    assert.deepEqual(
      blocks.filter((block) => block.kind === "heading").map((block) => block.text),
      [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]),
    );
    assert.equal(JSON.stringify(blocks).includes("name:"), false);
    assert.ok(blocks.some((block) => block.kind === "list"));
    const table = blocks.find((block) => block.kind === "table");
    assert.ok(table);
    assert.deepEqual(table.rows[0], ["Points", "Milestone"]);
    assert.ok(table.rows.length >= 7);
  }
});

test("outline accepts edited plain text and leaves HTML as inert text", () => {
  assert.deepEqual(parseOutline("A plain premise.\n\n## Direction\n<script>alert(1)</script>"), [
    { kind: "paragraph", text: "A plain premise." },
    { kind: "heading", level: 2, text: "Direction" },
    { kind: "paragraph", text: "<script>alert(1)</script>" },
  ]);
  assert.deepEqual(parseOutline(""), []);
});
