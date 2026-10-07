import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentMarkdown } from "../src/agent/agentMarkdown.ts";

test("agent Markdown renders paragraphs, emphasis, lists and literal code", () => {
  assert.deepEqual(parseAgentMarkdown("Hello **builder** and *player*.\n\nUse `said()`."), [
    {
      tag: "p",
      children: [
        "Hello ",
        { tag: "strong", children: ["builder"] },
        " and ",
        { tag: "em", children: ["player"] },
        ".",
      ],
    },
    { tag: "p", children: ["Use ", { tag: "code", children: ["said()"] }, "."] },
  ]);
  assert.deepEqual(parseAgentMarkdown("- **Look**\n- Walk\n\n1. Open\n2. Read"), [
    {
      tag: "ul",
      children: [
        { tag: "li", children: [{ tag: "strong", children: ["Look"] }] },
        { tag: "li", children: ["Walk"] },
      ],
    },
    {
      tag: "ol",
      children: [
        { tag: "li", children: ["Open"] },
        { tag: "li", children: ["Read"] },
      ],
    },
  ]);
  assert.deepEqual(parseAgentMarkdown("```agi\nif (v1 < 2) { **literal** }\n```"), [
    { tag: "pre", children: [{ tag: "code", children: ["if (v1 < 2) { **literal** }"] }] },
  ]);
});

test("agent Markdown keeps HTML and unsupported links in text nodes", () => {
  assert.deepEqual(
    parseAgentMarkdown('<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))'),
    [
      { tag: "p", children: ['<img src=x onerror="alert(1)">'] },
      { tag: "p", children: ["[click](javascript:alert(1))"] },
    ],
  );
  assert.deepEqual(parseAgentMarkdown("`<script>&</script>`"), [
    { tag: "p", children: [{ tag: "code", children: ["<script>&</script>"] }] },
  ]);
});
