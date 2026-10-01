import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import {
  prepareGuidedRespondToCommand,
  type GuidedContext,
} from "../src/authoring/guidedProject.ts";

function context(pattern?: string): GuidedContext {
  const seed = createStarterProject("starter");
  const sources: Record<string, string> = {};
  for (const [number, source] of seed.sources.logics) sources[`logic:${number}`] = source;
  for (const [number, source] of seed.sources.pictures) sources[`picture:${number}`] = source;
  const files = Object.fromEntries(seed.files());
  const read = readProjectDocuments({
    files,
    sources,
    profileId: seed.profileId,
    bindings: seed.bindings,
  });
  assert.deepEqual(read.diagnostics, []);
  const draft = new ProjectDraft(read.documents);
  if (pattern !== undefined) {
    const captured = draft.capture();
    const source = captured.read("logic:1")!.content as string;
    assert.ok(source.includes('said("look")'));
    draft.edit("logic:1", source.replace('said("look")', pattern), captured.version("logic:1"));
  }
  return { draft, files, profileId: seed.profileId };
}

test("a literal one-word reply does not block a longer guided command", () => {
  const outcome = prepareGuidedRespondToCommand(context(), {
    room: 1,
    command: "look north",
    response: "Trees to the north.",
  });
  assert.equal(
    outcome.ok,
    true,
    outcome.ok ? "A longer literal command is available" : outcome.message,
  );
});

test("a same-length wildcard reply blocks a matching guided command", () => {
  const outcome = prepareGuidedRespondToCommand(context("said(100, 1)"), {
    room: 1,
    command: "look north",
    response: "Trees to the north.",
  });
  assert.equal(outcome.ok, false, "the existing look/any-word reply can consume this command");
  if (!outcome.ok) assert.equal(outcome.code, "conflict");
});

test("a rest-of-line reply blocks a longer matching guided command", () => {
  const outcome = prepareGuidedRespondToCommand(context("said(100, 9999)"), {
    room: 1,
    command: "look north forest",
    response: "The forest stands north.",
  });
  assert.equal(outcome.ok, false, "the existing look/rest-of-line reply can consume this command");
  if (!outcome.ok) assert.equal(outcome.code, "conflict");
});

for (const [spelling, command] of [
  ["*", "look north"],
  ["...", "look north forest"],
] as const) {
  test(`a reserved ${spelling} operand keeps its assembler meaning even with a dictionary entry`, () => {
    const ctx = context(`said("look", "${spelling}")`);
    const captured = ctx.draft.capture();
    const original = captured.read("words")!.content;
    assert.ok(original instanceof Uint8Array);
    const words = parseWordsTok(original).map(({ word, id }) => [word, id] as [string, number]);
    words.push([spelling, 222]);
    ctx.draft.edit("words", JSON.stringify(words), captured.version("words"));
    const outcome = prepareGuidedRespondToCommand(ctx, {
      room: 1,
      command,
      response: "Trees to the north.",
    });
    assert.equal(outcome.ok, false, "reserved operands take precedence over dictionary entries");
    if (!outcome.ok) assert.equal(outcome.code, "conflict");
  });
}
