import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { baseParse, NodeTypes, type RootNode, type TemplateChildNode } from "@vue/compiler-dom";
import { ROOM_TOOL_HINTS, ROOM_TOOL_NAMES } from "../src/studio/studioHelp.ts";
import { VOCABULARY, VOCABULARY_ACTIONS, RETIRED_UI_TERMS } from "../../src/vocabulary.ts";

// These are persisted values, editor modes and resource identifiers, rather than visible copy.
const IDENTIFIERS: Readonly<Record<string, true>> = {
  sprite: true,
  ghost: true,
  keep: true,
  onion: true,
  backdrop: true,
  stipple: true,
  "studio-ghost": true,
  "studio-keep": true,
  "sprites-loops": true,
  ask: true,
  candidate: true,
  proposal: true,
  assistant: true,
};

function strings(source: string): string[] {
  const output: string[] = [];
  const ast = ts.createSourceFile("copy.ts", source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const value = node.text;
      // Import paths, selectors, CSS classes and test ids are explicitly identifier-shaped.
      if (
        !(value in IDENTIFIERS) &&
        (!/^[a-zA-Z0-9_./:@#*-]+$/.test(value) ||
          Object.keys(RETIRED_UI_TERMS).some(
            (term) =>
              value.toLowerCase() === term.toLowerCase() ||
              value.toLowerCase() === term.toLowerCase() + "s",
          )) &&
        !/^\[data-testid=(["'])[-\w:]+\1\]$/.test(value) &&
        !/\.(?:ts|vue)$/.test(value)
      )
        output.push(value);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return output;
}

function visibleCopy(file: string): string[] {
  const source = readFileSync(file, "utf8");
  if (!file.endsWith(".vue")) return strings(source);
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? "";
  const template = source.slice(
    source.indexOf("<template>") + "<template>".length,
    source.lastIndexOf("</template>"),
  );
  const output = strings(script);
  function visit(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.TEXT) output.push(node.content);
    if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION)
      output.push(...strings(node.content.content));
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        if (
          prop.type === NodeTypes.ATTRIBUTE &&
          ["title", "label", "name", "aria-label", "placeholder"].includes(prop.name)
        )
          output.push(prop.value?.content ?? "");
        if (prop.type === NodeTypes.DIRECTIVE && prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION)
          output.push(...strings(prop.exp.content));
      }
    }
    if (node.type === NodeTypes.ELEMENT || node.type === NodeTypes.ROOT)
      node.children.forEach(visit);
  }
  visit(baseParse(template));
  return output;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(path) : /\.(vue|ts)$/.test(path) ? [path] : [];
  });
}

test("visible editor copy uses the shared vocabulary, allowing internal identifiers", () => {
  const violations: string[] = [];
  for (const file of [...files("app/src/studio"), "app/src/shell/helpContent.ts"]) {
    for (const copy of visibleCopy(file)) {
      for (const retired of Object.keys(RETIRED_UI_TERMS)) {
        const pattern = new RegExp(
          `\\b${retired}${["sprite", "proposal", "candidate", "drawing element"].includes(retired) ? "s?" : ""}\\b${retired === "Onion" ? "(?! skin)" : ""}`,
          retired === "Keep" ? "" : "i",
        );
        if (pattern.test(copy)) violations.push(`${file}: ${copy.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("copy extraction detects visible text and dynamic tooltips while ignoring identifiers", () => {
  assert.deepEqual(
    strings(
      `const mode = "sprite"; const picker = "[data-testid='sprite-transparent-colour']"; const label = "Ghost probe"; const heading = "Sprites";`,
    ),
    ["Ghost probe", "Sprites"],
  );
});

// The three tool actions currently exposed by editor controls. These bindings
// must resolve to shared help; surrounding shortcut and refusal copy is separate.
test("editor action tooltips bind to shared action help", () => {
  assert.equal(ROOM_TOOL_NAMES.walk, VOCABULARY_ACTIONS.playtest_room.label);
  assert.equal(ROOM_TOOL_HINTS.walk, VOCABULARY_ACTIONS.playtest_room.help);
  const bindings: Readonly<Record<string, readonly string[]>> = {
    "app/src/studio/workspace/GuidedAdd.vue": ['"play-sound": VOCABULARY_ACTIONS.play_sound.label'],
    "app/src/studio/StudioToolRail.vue": [
      'if (entry.id === "walk") return VOCABULARY_ACTIONS.playtest_room.help;',
      "label: VOCABULARY_ACTIONS.playtest_room.label",
      ':title="toolTitle(entry)"',
    ],
  };
  for (const [file, expressions] of Object.entries(bindings)) {
    const source = readFileSync(file, "utf8");
    for (const expression of expressions)
      assert.ok(source.includes(expression), `${file}: ${expression}`);
  }
});

test("workspace copy shares vocabulary labels and explainers", () => {
  const bindings: Readonly<Record<string, readonly string[]>> = {
    "app/src/shell/commands/CreateKeyboard.vue": ["VOCABULARY.closeEditor.label"],
    "app/src/studio/RoomStudio.vue": ["VOCABULARY.lens.label"],
    "app/src/studio/StudioCurrentValues.vue": [
      "VOCABULARY.drawingDepth.help",
      "VOCABULARY.none.label",
    ],
    "app/src/App.vue": ["VOCABULARY.waitingUpdate.label"],
    "app/src/studio/workspace/TableEditor.vue": [
      "VOCABULARY.objectColumn.label",
      "VOCABULARY.roomColumn.label",
    ],
    "app/src/studio/workspace/SoundPanel.vue": [
      "VOCABULARY.voice.label",
      "VOCABULARY.drums.label",
      "VOCABULARY.grid.label",
      "VOCABULARY.tracker.label",
      "VOCABULARY.importMusic.label",
      "VOCABULARY.exportMidi.label",
    ],
  };
  for (const [file, expressions] of Object.entries(bindings)) {
    const source = readFileSync(file, "utf8");
    for (const expression of expressions)
      assert.ok(source.includes(expression), `${file}: ${expression}`);
  }
});

test("Words editor copy binds to the approved vocabulary", () => {
  const source = readFileSync("app/src/studio/workspace/WordsEditor.vue", "utf8");
  for (const term of [
    "meanings",
    "trySentence",
    "playersTried",
    "findWord",
    "skippedWords",
    "typeSentence",
    "readyResponse",
    "predictCommands",
    "suggestWords",
  ])
    assert.ok(source.includes(`VOCABULARY.${term}`), term);
  assert.equal(
    VOCABULARY.skippedWords.help,
    "The parser passes over these, so “look at the tree” reads as “look tree”.",
  );
});
