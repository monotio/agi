import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoImageData } from "../../test/modelText.ts";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createAgentSessionState, type AgentSessionState } from "../../src/agent/agentState.ts";
import {
  AUTHORING_TOOL_NAMES,
  executeAgentTool,
  executeAgentToolAsync,
  STUDIO_ASSIST_TASK_TOOLS,
  type AgentToolDeps,
} from "../../src/agent/tools.ts";
import { createStudioAssist } from "../../src/agent/studioAssistTools.ts";
import { referenceUnderFetch, type ReferenceSource } from "../../src/agent/referenceTools.ts";
import { pictureAssistScope, viewAssistScope } from "../../src/studio/assistScope.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import type { LensUnlocks, StudioLens } from "../../src/studio/lensRules.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import {
  anthropicToolContent,
  openAiToolContent,
  projectToolResult,
  splitToolResult,
} from "../../src/agent/toolTransport.ts";

/**
 * A case's `studio` focus: the Studio selection a Studio assist tool call
 * runs against. A picture gives its annotated `source`, `targetIds` and
 * `lens` with optional `unlocks` (and `draftSource` when the creator changed the draft
 * during the request); a view gives its `payload` bytes and `targetCels`.
 */
interface StudioCase {
  kind: "picture" | "view";
  num: number;
  source?: string;
  draftSource?: string;
  targetIds?: string[];
  lens?: StudioLens;
  unlocks?: LensUnlocks;
  payload?: number[];
  targetCels?: { loop: number; cel: number }[];
}

/**
 * A case's `references`: reference art the task may view, each a solid
 * `fill` colour at `width` x `height`, under the manifest fields it declares.
 */
interface ReferenceCase {
  id: string;
  label: string;
  target: { kind: "room" | "view"; num: number } | { kind: "general" };
  note: string;
  attached: boolean;
  width: number;
  height: number;
  fill: [number, number, number];
}

function referenceSource(cases: readonly ReferenceCase[]): ReferenceSource {
  return {
    art: cases.map(({ width, height, fill, ...art }) => ({
      ...art,
      pixels: () => {
        const rgba = new Uint8Array(width * height * 4);
        for (let at = 0; at < rgba.length; at += 4) rgba.set([...fill, 255], at);
        return { width, height, rgba };
      },
    })),
  };
}

function studioDeps(session: AgentSessionState, studio: StudioCase): AgentToolDeps {
  if (studio.kind === "picture") {
    const source = studio.source!;
    const compiled = compileEditDocument(parsePictureDocument(source).document, session.profile);
    const draft = studio.draftSource ?? source;
    return {
      allowedTools: STUDIO_ASSIST_TASK_TOOLS,
      studio: createStudioAssist({
        scope: pictureAssistScope({
          num: studio.num,
          compiled,
          targetIds: studio.targetIds ?? [],
          lens: studio.lens ?? "art",
          ...(studio.unlocks ? { unlocks: studio.unlocks } : {}),
        }),
        draft: () => ({ kind: "picture", source: draft }),
        lens: studio.lens,
      }),
    };
  }
  const payload = Uint8Array.from(studio.payload ?? []);
  return {
    allowedTools: STUDIO_ASSIST_TASK_TOOLS,
    studio: createStudioAssist({
      scope: viewAssistScope({
        num: studio.num,
        document: openSprite(payload, session.profile),
        targetCels: studio.targetCels ?? [],
      }),
      draft: () => ({ kind: "view", payload }),
    }),
  };
}

describe("stored bad cases regression suite (evals/fixtures/bad-cases)", () => {
  const badCasesDir = resolve("evals/fixtures/bad-cases");
  const files = readdirSync(badCasesDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(badCasesDir, file);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));

    it(`replays bad case: ${content.name} (${file})`, async () => {
      // A turn's tool log and reply, graded by the under-fetch rule.
      if (content.referenceTurn) {
        assert.deepEqual(
          referenceUnderFetch(content.referenceTurn),
          content.expectedUnviewed,
          `${file}: unviewed references`,
        );
        return;
      }
      const session = createAgentSessionState();
      for (const setup of content.setup ?? []) {
        const result = executeAgentTool(session, setup.tool, setup.args);
        assert.equal(result.success, true, `${file}: setup ${setup.tool}: ${result.error ?? ""}`);
      }
      // A literal `result` replays a transport-level failure (no tool call).
      const res =
        content.result ??
        (content.studio
          ? await executeAgentToolAsync(
              session,
              content.tool,
              content.args,
              studioDeps(session, content.studio),
            )
          : content.async
            ? await executeAgentToolAsync(session, content.tool, content.args, {
                allowedTools: AUTHORING_TOOL_NAMES,
                ...(content.references ? { references: referenceSource(content.references) } : {}),
              })
            : executeAgentTool(session, content.tool, content.args));

      for (const [path, expected] of Object.entries(content.expectedFields ?? {})) {
        let actual: unknown = res;
        for (const key of path.split(".")) {
          assert.ok(actual !== null && typeof actual === "object", `${file}: missing ${path}`);
          actual = (actual as Record<string, unknown>)[key];
        }
        assert.deepEqual(actual, expected, `${file}: ${path}`);
      }

      if (content.projected) {
        const store = new Map<string, typeof res>();
        const projected = projectToolResult(res, store, "replay-1");
        const details = (projected.details ?? {}) as Record<string, unknown>;
        assert.equal(details["diagnosticId"], "replay-1", `${file}: no diagnostic pointer`);
        for (const [field, expected] of Object.entries(
          content.projected.details as Record<string, Record<string, unknown>>,
        )) {
          const actual = details[field] as Record<string, unknown>;
          assert.ok(actual, `${file}: projected details lost '${field}'`);
          for (const [key, want] of Object.entries(expected)) {
            if (want !== null && typeof want === "object") {
              assert.deepEqual(
                actual[key],
                { truncated: true, ...want },
                `${file}: ${field}.${key} count`,
              );
            } else {
              assert.deepEqual(actual[key], want, `${file}: ${field}.${key}`);
            }
          }
          assert.ok(
            JSON.stringify(actual).length <= (content.projected.maxFieldChars ?? 400),
            `${file}: projected '${field}' exceeds its field budget`,
          );
        }
        assert.equal(store.get("replay-1"), res, `${file}: full result not in diagnostics`);
        const wire = splitToolResult(projected);
        for (const blocks of [openAiToolContent(wire), anthropicToolContent(wire)]) {
          const text = (blocks[0] as { text: string }).text;
          assert.ok(
            text.includes('"diagnosticId":"replay-1"'),
            `${file}: provider payload lost the diagnostic pointer`,
          );
        }
        return;
      }
      if (content.expectedImageCount !== undefined) {
        const wire = splitToolResult(res);
        assertNoImageData(wire.text, `${file}: tool text`);
        assert.equal(wire.images.length, content.expectedImageCount);
      }

      if (content.expectedSuccess) {
        assert.equal(
          res.success,
          true,
          `Expected ${content.tool} to succeed for ${file}, but got error: ${res.error}`,
        );
      } else {
        assert.equal(
          res.success,
          false,
          `Expected ${content.tool} to fail for ${file}, but it unexpectedly succeeded`,
        );
        if (content.expectedErrorSnippet) {
          assert.ok(
            res.error?.includes(content.expectedErrorSnippet),
            `Expected error to contain '${content.expectedErrorSnippet}', got: '${res.error}'`,
          );
        }
      }
      if (content.expectedMessageSnippet) {
        assert.ok(
          res.message?.includes(content.expectedMessageSnippet),
          `Expected message to contain '${content.expectedMessageSnippet}', got: '${res.message}'`,
        );
      }
    });
  }
});
