import assert from "node:assert/strict";
import test from "node:test";
import {
  compileCapturedResource,
  capturedResourceDocuments,
} from "../src/agent/agentResultPreview.ts";
import { PROFILES } from "../../src/runtime/profile.ts";

test("a malformed captured dependency does not hide valid sibling native bytes", () => {
  const picture = Uint8Array.of(0xff);
  const captured = { "logic:1": "if (", words: "[ unfinished", "picture:7": picture };
  const preview = compileCapturedResource(captured, "picture:7", PROFILES["2.936"]);
  assert.deepEqual(preview?.getResource("picture", 7), picture);
  assert.equal(preview?.getResource("logic", 1), null);
  assert.equal(compileCapturedResource(captured, "logic:1", PROFILES["2.936"]), undefined);
  assert.deepEqual(picture, Uint8Array.of(0xff));
});

test("captured image references retain their trace targets and immutable attachments", async () => {
  const { resourceRenderingDependencies } = await import("../src/agent/agentResults.ts");
  const { traceImageChanges } = await import("../../src/creative/imageOperations.ts");
  const { encodePngRgba } = await import("../../src/creative/composite.ts");
  const rgba = Uint8Array.of(0, 0, 255, 255);
  const image = {
    title: "Blue",
    mime: "image/png",
    width: 1,
    height: 1,
    rgba,
    encoded: encodePngRgba(1, 1, rgba),
  };
  const base = { "picture:7": "end", "logic:2": "if (" };
  const changes = traceImageChanges(base, "picture:7", image);
  const documents = {
    ...base,
    ...Object.fromEntries(changes.map(({ key, content }) => [key, content!])),
  };
  const captured = resourceRenderingDependencies(documents);
  assert.equal(captured["picture:7"], "end");
  assert.equal(captured["logic:2"], undefined);
  assert.ok(Object.keys(captured).some((key) => key.startsWith("attachment:")));
  const preview = compileCapturedResource(captured, "images", PROFILES["2.936"]);
  assert.deepEqual(preview?.getResource("picture", 7), Uint8Array.of(0xff));
});

test("resource snapshots validate their own content and preserve legacy snapshot fallback", async () => {
  const { readAgentChats } = await import("../../src/agent/chats.ts");
  const { writeProjectWorkspace } = await import("../../src/authoring/projectWorkspace.ts");
  const snapshot = writeProjectWorkspace({ "logic:0": "return;" });
  const result = {
    kind: "resources" as const,
    documentId: "a".repeat(64),
    resources: ["logic:0"],
    snapshot,
  };
  const store = {
    format: "monotio.agi.chats",
    version: 1,
    active: "chat",
    chats: [
      {
        id: "chat",
        title: "Captured",
        provider: "stub",
        model: "stub",
        transcript: [],
        messages: [{ id: "reply", role: "assistant", text: "Captured", result }],
      },
    ],
  };
  assert.equal(capturedResourceDocuments(result, "logic:0")["logic:0"], "return;");
  const perResource = {
    ...result,
    snapshot: undefined,
    resourceSnapshots: { "logic:0": writeProjectWorkspace({ "logic:0": "print(1); return;" }) },
  };
  const loaded = readAgentChats(
    JSON.parse(
      JSON.stringify({
        ...store,
        chats: [
          {
            ...store.chats[0],
            messages: [{ ...store.chats[0]!.messages[0], result: perResource }],
          },
        ],
      }),
    ),
  );
  const captured = loaded.chats[0]!.messages[0]!.result;
  if (captured?.kind !== "resources") assert.fail("Missing loaded resource capture");
  assert.equal(capturedResourceDocuments(captured, "logic:0")["logic:0"], "print(1); return;");
  for (const resourceSnapshots of [
    [],
    { "logic:1": snapshot },
    { "logic:0": writeProjectWorkspace({ words: "[]" }) },
    {},
  ]) {
    assert.throws(
      () =>
        readAgentChats({
          ...store,
          chats: [
            {
              ...store.chats[0],
              messages: [
                { ...store.chats[0]!.messages[0], result: { ...perResource, resourceSnapshots } },
              ],
            },
          ],
        }),
      /captured resource/,
    );
  }
});
