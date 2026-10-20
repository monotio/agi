import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { baseParse, NodeTypes, type RootNode, type TemplateChildNode } from "@vue/compiler-dom";
import { ROOM_TOOL_HINTS, ROOM_TOOL_NAMES } from "../src/studio/studioHelp.ts";
import { ROOM_ACTION_LABELS } from "../src/studio/workspace/guidedActions.ts";
import { VOCABULARY, GLOSSARY, FORMAT_LITERALS } from "../../src/vocabulary.ts";

// These are persisted values, editor modes and resource identifiers, rather than visible copy.
const IDENTIFIERS: Readonly<Record<string, true>> = {
  ghost: true, // UiButton variant.
  stipple: true, // Picture source and pen field.
  onion: true, // Editor option id.
  snapshot: true, // State notification protocol discriminator.
  checkpoint: true, // Engine-state protocol discriminator.
  dictionary: true, // Stored history field.
  depth: true, // Annotated picture item kind.
  studio: true, // In-memory lesson target field.
  candidates: true, // Earlier-progress collection field.
  levels: true, // History recovery field.
  ask: true, // Conversation mode.
  candidate: true, // Validated edit identity.
  proposal: true, // Submitted edit identity.
  assistant: true, // Stored conversation role.
};

const escapePattern = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, (character) => String.fromCharCode(92) + character);

function copyPattern(key: string): RegExp {
  const entry = GLOSSARY[key]!;
  return new RegExp(
    entry.avoidPattern ?? `\\b(?:${entry.avoid.map(escapePattern).join("|")})s?\\b`,
    key === "history" || key === "saved" ? "" : "i",
  );
}

const COPY_RULES = Object.entries(GLOSSARY)
  .filter(([, entry]) => entry.avoid.length > 0)
  .map(([key]) => ({ key, pattern: copyPattern(key) }));

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
      if (ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === "technical")
        return;
      const value = node.text;
      if (/^\.[\w-]+\s+(?:textarea|input)(?:, .*|)$/.test(value)) return;
      if (/^# @depth(?: |$)/.test(value)) return;
      // Import paths, selectors, CSS classes and test ids are explicitly identifier-shaped.
      if (
        !(value.trim() in IDENTIFIERS) &&
        (!/^[a-zA-Z0-9_./:@#*-]+$/.test(value) ||
          (!/[-./:@#*]/.test(value) && COPY_RULES.some(({ pattern }) => pattern.test(value)))) &&
        !/^\[(?:data-testid|aria-labelledby)=(["'])[-\w:]+\1\](?:\s+\[tabindex=(["'])-?\d+\2\])?$/.test(
          value,
        ) &&
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
  const fullSource = readFileSync(file, "utf8");
  const source =
    file === "src/vocabulary.ts" ? fullSource.split("/** One term per concept")[0]! : fullSource;
  if (!file.endsWith(".vue")) return strings(source);
  const script = /<script[^>]*>([\s\S]*?)<\/script\b[^>]*>/i.exec(source)?.[1] ?? "";
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

test("editor commit actions say Saved", () => {
  const pattern = copyPattern("saved");
  for (const label of ["Keep it", "Keep", "Keep changes", "Keep it and apply"])
    assert.ok(pattern.test(label), label);
});

const COPY_EXCEPTIONS: readonly {
  readonly file: string;
  readonly pattern: RegExp;
  readonly reason: string;
  readonly when?: RegExp;
}[] = [
  {
    file: "app/src/home/ProfileChoiceDialog.vue",
    pattern: /AGI Studio/g,
    reason: "Third-party authoring application's proper name.",
  },
  {
    file: "app/src/render/amigaAppearance.ts",
    pattern: /depth gadget row/g,
    reason: "Amiga window stacking gadget, distinct from AGI priority.",
  },
  {
    file: "src/agent/authoringGuide.ts",
    pattern: /gives depth to a flat picture/g,
    reason: "Visual depth created by composition, distinct from AGI priority values.",
  },
  {
    file: "src/agent/history.ts",
    pattern: /\bdictionary\b/g,
    reason: "Stored history field validation names the dictionary field.",
  },
  {
    file: "src/agent/transcript.ts",
    pattern: /\bassistant\b/g,
    when: /only user and assistant messages/,
    reason: "Stored conversation role literal.",
  },
  {
    file: "app/src/agent/workspaceAgentTools.ts",
    pattern: /\bframes\b/g,
    when: /explicit cel regions/,
    reason: "The preparation recipe's frames field.",
  },
  {
    file: "src/agent/coreToolDefinitions.ts",
    pattern: /\bframes\b/g,
    when: /^Inspect a room's compiled/,
    reason: "read_room captures rendered frames and can tile them into a sheet.",
  },
  {
    file: "src/agent/prompt.ts",
    pattern: /\bframes?\b/g,
    when: /(?:composed frames|frames section is unavailable)/,
    reason: "Rendered frame inspection, distinct from VIEW cels in the same contract.",
  },
  {
    file: "src/agent/commandReference.ts",
    pattern: /item = inventory/g,
    reason: "AGI command-signature operand kind; item denotes the OBJECT entry argument.",
  },
  {
    file: "src/agent/tools.ts",
    pattern: /is not in the dictionary/g,
    reason: "Compiler diagnostic matched to choose the next inspection tool.",
  },
];

test("copy uses the glossary in the app, editor kernels and tool prose", () => {
  const violations: string[] = [];
  for (const file of [
    ...files("app/src"),
    "src/vocabulary.ts",
    ...files("src/studio"),
    ...files("src/agent"),
  ]) {
    for (const original of visibleCopy(file)) {
      let copy = original;
      for (const exception of COPY_EXCEPTIONS)
        if (file === exception.file && (!exception.when || exception.when.test(copy)))
          copy = copy.replace(exception.pattern, " ");
      if (file.startsWith("src/agent/") && !/\s/.test(copy.trim())) continue;
      for (const { key, pattern } of COPY_RULES) {
        // Agent contracts use technical terms for submissions, validation, script buffers and pen bits.
        if (
          /^(?:app\/src|src)\/agent\//.test(file) &&
          ["changes", "speckled", "history", "saved"].includes(key)
        )
          continue;
        const conflict = pattern.exec(copy)?.[0];
        if (conflict) violations.push(`${file}: ${conflict} → see GLOSSARY.${key}`);
      }
    }
  }
  assert.equal(violations.length, 0, violations.join("\n"));
});

test("the meaning action uses the same Add meaning label as its accessible name", () => {
  assert.equal(VOCABULARY.meaningButton.label, "Add meaning");
  assert.equal(VOCABULARY.meaningButton.label, VOCABULARY.addGroup.label);
});

test("action labels use canonical verbs across app surfaces", () => {
  const violations: string[] = [];
  for (const file of files("app/src")) {
    for (const copy of visibleCopy(file)) {
      if (
        /\b(?:Name it|Save name)\b/.test(copy) ||
        /^(?:Not now|Stay|Back to game)$/.test(copy.trim())
      )
        violations.push(`${file}: ${copy.trim()}`);
    }
  }
  assert.equal(violations.length, 0, violations.join("\n"));
});

test("copy extraction detects visible text and dynamic tooltips while ignoring identifiers", () => {
  assert.deepEqual(
    strings(
      `const mode = "view"; const picker = "[data-testid='view-transparent-colour']"; const from = "[aria-labelledby='view-recolor-from'] [tabindex='0']"; const label = "Ghost probe"; const heading = "Sprites";`,
    ),
    ["Ghost probe", "Sprites"],
  );
});

// The three tool actions currently exposed by editor controls. These bindings
// must resolve to shared help; surrounding shortcut and refusal copy is separate.
test("editor action tooltips bind to shared action help", () => {
  assert.equal(ROOM_TOOL_NAMES.walk, VOCABULARY.testWalk.label);
  assert.equal(ROOM_TOOL_HINTS.walk, VOCABULARY.testWalk.help);
  assert.equal(ROOM_ACTION_LABELS["play-sound"], "Sound when…");
  const bindings: Readonly<Record<string, readonly string[]>> = {
    "app/src/studio/workspace/GuidedAdd.vue": [
      'import { ROOM_ACTION_LABELS as labels, type RoomActionKind } from "./guidedActions.ts";',
      'v-for="(label, actionKind) in labels"',
    ],
    "app/src/studio/workspace/guidedActions.ts": ['"play-sound": "Sound when…"'],
    "app/src/studio/StudioToolRail.vue": [
      'if (entry.id === "walk") return VOCABULARY.testWalk.help;',
      "label: VOCABULARY.testWalk.label",
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
    "app/src/studio/PictureStudio.vue": ["VOCABULARY.lens.label"],
    "app/src/studio/StudioCurrentValues.vue": [
      "VOCABULARY.drawingPriority.help",
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

test("download descriptions qualify available data and report limitations", () => {
  const help = visibleCopy("app/src/shell/helpContent.ts").find((copy) =>
    copy.includes("The project file adds"),
  );
  assert.ok(help);
  assert.match(help, /\bavailable\b/);
  assert.match(help, /\blimitations\b/);
  const readme = readFileSync("README.md", "utf8")
    .split("\n")
    .find((line) => line.includes("**Project file**"));
  assert.ok(readme);
  assert.match(readme, /\bavailable\b/);
  assert.match(readme, /\blimitations\b/);
});

test("unsupported project recovery uses version-neutral copy and plain actions", () => {
  const source = readFileSync("app/src/home/UnsupportedProject.vue", "utf8");
  assert.ok(source.includes("Saved project format needs another app version"));
  const copy = visibleCopy("app/src/home/UnsupportedProject.vue").map((text) => text.trim());
  for (const label of ["Download", "Remove"]) assert.ok(copy.includes(label));
});

test("commit actions say Saved while tab-open instructions remain clear", () => {
  const pattern = copyPattern("saved");
  for (const label of ["Keep", "Keep changes", "Keep edits", "Keep this tab open changes"])
    assert.ok(pattern.test(label), label);
  for (const copy of [
    "Keep this tab open",
    "Keep this tab open.",
    "Keep this tab open until it says Saved.",
    "Could not save. Keep this tab open until it says Saved.",
  ])
    assert.equal(pattern.test(copy), false, copy);
});

test("Playtest names only the agent's playtest; the room tool and the phone tab say what they do", () => {
  assert.equal(ROOM_TOOL_NAMES.walk, "Test walk");
  assert.doesNotMatch(ROOM_TOOL_HINTS.walk, /playtest/i);
  const workspace = readFileSync("app/src/studio/workspace/CreateWorkspace.vue", "utf8");
  assert.doesNotMatch(workspace, />\s*Playtest\s*</);
  assert.match(workspace, /phonePlaytest\.value = true"\s*>Game</);
});

test("reference roles use the shared analysis and presentation terms", () => {
  const paths = [
    ...files("src/logic"),
    ...files("src/agent"),
    ...files("app/src/shell"),
    ...files("app/src/studio"),
  ];
  const violations = paths.filter((file) => /\bChecked\b/.test(readFileSync(file, "utf8")));
  assert.equal(violations.length, 0, violations.join("\n"));
});

/** Each exception names a sense or a format, never a directory-wide waiver. */
const SWEEP_EXCEPTIONS: readonly {
  readonly file: string;
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  {
    file: "app/test/vocabulary-copy.test.ts",
    pattern: /[\s\S]+/g,
    reason: "The checker declares conflicting words and deliberately exercises them.",
  },
  {
    file: "src/vocabulary.ts",
    pattern: /export interface GlossaryEntry[\s\S]+/g,
    reason: "The glossary declares conflicting terms and format spellings as data.",
  },
  {
    file: "docs/fidelity.md",
    pattern: /BACKDROP \| BORDERLESS|borderless backdrop window/g,
    reason: "Amiga window flag and window type.",
  },
  {
    file: "app/src/studio/PixelInspector.vue",
    pattern: /\bdepth(?=:)/g,
    reason: "Label table indexed by the stored picture item kind.",
  },
  {
    file: "app/src/studio/StudioItemEditor.vue",
    pattern: /\bdepth(?=:)/g,
    reason: "Label table indexed by the stored picture item kind.",
  },
  {
    file: "src/studio/sideEffects.ts",
    pattern: /\bdepth(?=:)/g,
    reason: "Label table indexed by the stored picture item kind.",
  },
  {
    file: "app/src/ui/UiButton.vue",
    pattern: /\bghost\b/g,
    reason: "The button variant's API, documentation and CSS name.",
  },
  {
    file: "app/src/ui/ActionMenu.vue",
    pattern: /["']ghost["']/g,
    reason: "UiButton variant union.",
  },
  {
    file: "app/src/studio/view/ViewMirrorNote.vue",
    pattern: /["']ghost["']/g,
    reason: "UiButton variant in a conditional expression.",
  },
  {
    file: "app/src/studio/workspace/SoundPicker.vue",
    pattern: /["']ghost["']/g,
    reason: "UiButton variant in a conditional expression.",
  },
  {
    file: "test/speedrun/kq2.ts",
    pattern: /ghosts/g,
    reason: "King's Quest II castle guards in game dialogue.",
  },
  {
    file: "test/speedrun/kq4.ts",
    pattern: /\b\w*[Gg]host\w*\b/g,
    reason: "King's Quest IV manor characters, commands and route functions.",
  },
  {
    file: "test/tutorial-game.test.ts",
    pattern: /charging bay's sprite editor/g,
    reason: "Adventure Department's in-world dialogue.",
  },
];

const SWEEP_RULES: readonly {
  readonly key: string;
  readonly pattern: RegExp;
  readonly applies?: (file: string) => boolean;
}[] = [
  {
    key: "agent",
    pattern:
      /\b\w*Assist(?!ant)\w*\b|\b\w*assist(?!ant|ive|ance)\w*\b|\b(?:menu-assistant|assistant-host|assistant-open|assistantInputEl|ask-button|studio-ask|views-ask)\b|\bAsk (?:drawer|button|bubble|conversation)\b/g,
  },
  { key: "view", pattern: /\bsprites?\b/gi },
  { key: "background", pattern: /\bbackdrop\b/gi },
  { key: "standIn", pattern: /\bghost\b/gi },
  { key: "pictureEditor", pattern: /\b(?:Room|Sprite|Logic)\s+(?:\*\s*)?Studio\b|\broomStudio\b/g },
  { key: "lens", pattern: /\b(?:Art|Depth)\s+(?:\*\s*)?lens\b/g },
  { key: "room", pattern: /\b(?:createSceneBrief|sceneBrief)\b/g },
  { key: "ego", pattern: /\b[Aa] ego\b/g },
  { key: "items", pattern: /\b(?:sceneList|SceneList|sceneGroups)\b/g },
  {
    key: "ego",
    pattern: /\b\w*(?:hero[A-Z]|Hero[A-Z])\w*\b/g,
    applies: (file) => /^(?:app\/src|src)\//.test(file),
  },
  {
    key: "screenObject",
    pattern: /\bactors?\b/gi,
    applies: (file) => file.startsWith("src/runtime/") || file === "docs/fidelity.md",
  },
  {
    key: "priority",
    pattern: /\bdepth\b|[a-z]Depth\b/g,
    applies: (file) => /^(?:app\/src|src)\/studio\//.test(file),
  },
  {
    key: "saved",
    pattern:
      /\b(?:useStudioKeep|DraftKeepAdmission|EditableKeep(?:Result|Review)|Keep(?:Banner|Recovery|ableDraft)|ViewKeepFn|LessonKeep|admitKeep|acknowledgeAdmittedKeep|finishKeepAdmission|keepCandidate|keepStagedView|markKept)\b|\b(?:after|before|what|implies|past|on) Keep\b|\bKeep (?:writes|that|moves|rebases|is|must|refuses|reserves|owns|can)\b|\b(?:[Aa]|the|pending|staged|admitted|refused|unrelated|same|whole|resource|picture|view|editor|Studio|combined|native|in-place|source-only|byte-changing|lease-refused|storage-waiting|pre|next|through|across|at|may|cannot|versus|tab's|page's|own) Keep\b|\bKeep(?=['’]s\b|\/reload)/g,
  },
  { key: "cel", pattern: /\b(?:SheetFrame|sheetFrame)\w*\b/g },
];

function maskFormats(source: string): string {
  let masked = source;
  const hide = (match: string): string => match.replace(/[^\n]/g, " ");
  for (const literal of Object.keys(FORMAT_LITERALS).sort((a, b) => b.length - a.length))
    masked = masked.replace(new RegExp(`(?<![\\w])${escapePattern(literal)}(?![\\w])`, "g"), hide);
  return masked
    .replace(/\b[a-z]+(?:\.[a-z0-9]+)+\b/g, hide)
    .replace(/monotio_agi\.[\w.]+/g, hide)
    .replace(/hardware sprites?|pointer sprites?/gi, hide)
    .replace(/::backdrop/g, hide)
    .replace(/variant\s*(?:=\s*["']ghost["']|:\s*["']ghost["'])/g, hide);
}

function terminologyViolations(file: string, source: string): string[] {
  // Tutorial resource text is released game content; check its comments without changing bytes.
  const text =
    file === "games/adventure-department/game.ts"
      ? source
          .split("\n")
          .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? line : ""))
          .join("\n")
      : source;
  let masked = maskFormats(text);
  for (const exception of SWEEP_EXCEPTIONS)
    if (file === exception.file)
      masked = masked.replace(exception.pattern, (match) => match.replace(/[^\n]/g, " "));
  const violations: string[] = [];
  for (const { key, pattern, applies } of SWEEP_RULES) {
    if (applies && !applies(file)) continue;
    for (const match of masked.matchAll(pattern)) {
      const line = masked.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}: ${match[0]} → see GLOSSARY.${key}`);
    }
  }
  return violations;
}

test("tracked text uses the glossary's code and technical names", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(
      (file) =>
        /^(?:src|app\/src|test|app\/test|app\/e2e|scripts|docs)\//.test(file) ||
        [
          "README.md",
          "CONTRIBUTING.md",
          "games/adventure-department/lessons.ts",
          "games/adventure-department/game.ts",
        ].includes(file),
    );
  const violations: string[] = [];
  for (const file of paths) {
    if (
      /^(?:app\/test\/(?:formats|fixtures)|test\/formats)\//.test(file) ||
      !/\.(?:ts|vue|md|css|mjs|json|yml)$/.test(file)
    )
      continue;
    violations.push(...terminologyViolations(file, readFileSync(file, "utf8")));
    violations.push(...terminologyViolations(file, file));
  }
  assert.equal(violations.length, 0, violations.join("\n"));
});

test("the terminology sweep catches mixed names and preserves format literals", () => {
  assert.match(
    terminologyViolations("app/src/studio/example.ts", "const projectAssist = 1;")[0]!,
    /GLOSSARY.agent/,
  );
  assert.match(
    terminologyViolations("app/src/studio/example.ts", "/** Room\n * Studio */")[0]!,
    /GLOSSARY.pictureEditor/,
  );
  assert.match(
    terminologyViolations("app/src/studio/example.ts", "const sprite = 1;")[0]!,
    /GLOSSARY.view/,
  );
  assert.match(
    terminologyViolations("app/src/studio/example.ts", "const depth = 1;")[0]!,
    /GLOSSARY.priority/,
  );
  assert.deepEqual(
    terminologyViolations(
      "app/src/studio/example.ts",
      "const op = { spriteOps: null }; // # @depth base=48",
    ),
    [],
  );
});

test("lens, editor and commit names stay coherent in comments and identifiers", () => {
  for (const text of [
    "// the Art lens",
    "// try the Depth lens",
    "// Room Studio lesson",
    "const roomStudio = editor;",
    "// what Keep writes",
    "// implies Keep",
    "// a Keep that needs a reload",
    "// an A ego typo",
    "// a ego typo",
    "const sceneBrief = brief;",
    "function createSceneBrief() {}",
  ])
    assert.ok(terminologyViolations("app/src/example.ts", text).length > 0, text);
  for (const text of [
    "// Keep the tab open",
    "// A keeper of stories",
    "// in keeping with the story",
    "// ordinary visual depth",
    "// a night scene",
    "const scene = new Scene();",
  ])
    assert.deepEqual(terminologyViolations("app/src/example.ts", text), [], text);
});

test("VIEW labels use VIEW while story characters retain their ordinary meaning", () => {
  assert.ok(copyPattern("view").test("Shared character"));
  assert.ok(copyPattern("view").test("Character 5"));
  assert.equal(copyPattern("view").test("Let character voices fit the story."), false);
  assert.equal(copyPattern("room").test("Night scenes use a cool palette."), false);
});

test("actors name screen objects in visible movement help", () => {
  assert.equal(VOCABULARY.hero.help, "The actor the player controls.");
  assert.ok(copyPattern("screenObject").test("Where characters walk"));
});
