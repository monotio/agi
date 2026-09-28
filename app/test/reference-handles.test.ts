/**
 * Reference art by handle at the session level: what a turn with stored
 * references sends to the provider (a manifest and one contact strip, never
 * the full images), a region the model views with view_reference, the
 * viewed image staying in the append-only transcript across later turns, the
 * scripted stub scenarios, and the character-sheet reference's handles.
 * Provider requests are read from the real OpenAI transport with fetch mocked.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { inflateSync } from "node:zlib";
import { providerSse } from "../../test/provider-stream.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAnthropicConversation } from "../src/agent/llmClient.ts";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { referenceArtId } from "../../src/agent/referenceTools.ts";
import { executeAgentToolAsync, REMIX_TOOLS, withReferences } from "../../src/agent/tools.ts";
import {
  normalizeReferences,
  roomReference,
  stageCharacterView,
  viewReference,
  type DecodedImage,
  type StoredReference,
} from "../src/references/referenceArt.ts";
import { referenceSource } from "../src/references/referenceHandles.ts";
import { base64ToBytes } from "../src/project/bytes.ts";
import { testProjectId, testRevision } from "./identity.ts";
import type { StudioFocus } from "../../src/agent/studioAssistTools.ts";
import { pictureAssistScope } from "../../src/studio/assistScope.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { BRIDGE_SOURCE } from "../../test/studioAssistFixtures.ts";

const IDENTITY = { project: testProjectId("refs"), revision: testRevision("rev-a") };

/** Opaque RGB art: `paint(x, y)` gives each pixel's colour. */
function upload(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): DecodedImage {
  const rgb = new Uint8Array(width * height * 3);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const colour = paint(x, y);
      rgb.set(colour, (y * width + x) * 3);
      rgba.set([...colour, 255], (y * width + x) * 4);
    }
  return { width, height, rgba, mime: "image/png", bytes: encodePngRgb(width, height, rgb) };
}

/** Node stand-in for the browser decoder: this repo's stored-deflate RGB PNGs. */
async function decodePng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "IDAT")
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rgba.set([raw[at]!, raw[at + 1]!, raw[at + 2]!, 255], (y * width + x) * 4);
    }
  return { width, height, rgba };
}

/** Three stored references: a harbour plate, a forest plate and a pose row. */
function references(): StoredReference[] {
  const harbour = roomReference(
    "ref-harbour",
    3,
    "a harbour at dawn",
    IDENTITY,
    upload(640, 400, (_x, y) => (y < 200 ? [0x55, 0xff, 0xff] : [0, 0, 0xaa])),
  );
  const forest = roomReference(
    "ref-forest",
    4,
    "dark forest",
    IDENTITY,
    upload(320, 200, (x) => (x < 160 ? [0, 0xaa, 0] : [0xaa, 0x55, 0])),
  );
  const hero = stageCharacterView(
    "ref-hero",
    0,
    "red jacket",
    IDENTITY,
    [
      {
        facing: "right",
        decoded: upload(64, 12, (x, y) =>
          x % 16 >= 5 && x % 16 < 11 && y >= 2 ? [0xff, 0x55, 0x55] : [0xff, 0, 0xff],
        ),
      },
    ],
    { poses: 4, celHeight: 10, symmetric: true },
  );
  return [harbour, forest, hero];
}

function sessionWith(
  config: ConstructorParameters<typeof AgentSession>[0],
  stored = references(),
): AgentSession {
  const session = new AgentSession(config, () => {}, createAgentSessionState());
  session.setRuntime({
    referenceArt: async (attached) => referenceSource(stored, attached, decodePng),
  });
  return session;
}

interface Body {
  input: Record<string, unknown>[];
  tool_choice?: { tools: { name: string }[] };
}

/** A provider that plays `replies` in order, recording each request body. */
function scriptProvider(t: TestContext, replies: Record<string, unknown>[][]): Body[] {
  const bodies: Body[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    const output = replies[bodies.length - 1] ?? [];
    return new Response(providerSse("openai", { id: `r${bodies.length}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  return bodies;
}

const say = (text: string) => [
  { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
];
const call = (id: string, args: Record<string, unknown>) => [
  { type: "function_call", call_id: id, name: "view_reference", arguments: JSON.stringify(args) },
];

/** Every image block in a request's input, as its PNG width and height. */
function imageSizes(value: unknown): { width: number; height: number }[] {
  const sizes: { width: number; height: number }[] = [];
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string" && item.startsWith("data:image/png;base64,")) {
      const png = base64ToBytes(item.slice("data:image/png;base64,".length));
      const view = new DataView(png.buffer);
      sizes.push({ width: view.getUint32(16), height: view.getUint32(20) });
    }
    return item;
  });
  return sizes;
}

const MODEL = { provider: "openai", apiKey: "test-placeholder", model: "test" } as const;

test("a remix turn with three references sends manifests and one strip, and views a region", async (t) => {
  const stored = references();
  const ids = stored.flatMap((reference) =>
    reference.images.map((image) => referenceArtId(base64ToBytes(image.png))),
  );
  const bodies = scriptProvider(t, [
    call("v1", { id: ids[0], size: "full", region: { x: 0, y: 180, w: 32, h: 40 }, grid: true }),
    say("The waterline sits at y 200."),
  ]);
  const session = sessionWith(MODEL, stored);
  const result = await session.runPowerUp("Paint room 3 like the harbour.", 3, {
    referenceIds: ["ref-harbour"],
  });
  assert.equal(result.text, "The waterline sits at y 200.");

  const first = bodies[0]!;
  const request = JSON.stringify(first.input);
  for (const id of ids) assert.match(request, new RegExp(`${id} · `), `manifest line for ${id}`);
  assert.match(request, /Room plate · room 3 · 640x400 · blue 50%, light cyan 50% · attached/);
  assert.match(request, /Character sheet, right-facing row · view 0 · 64x12/);
  // No full image: only the contact strip, three 64-pixel tiles and a 4-pixel gutter.
  assert.deepEqual(imageSizes(first.input), [{ width: 3 * 64 + 4 * 4, height: 64 + 2 * 4 }]);
  assert.ok(first.tool_choice!.tools.some((tool) => tool.name === "view_reference"));

  // The region comes back enlarged by floor(512 / 40) = 12: 384x480.
  const second = bodies[1]!;
  const output = second.input.find((item) => item["type"] === "function_call_output");
  assert.deepEqual(imageSizes(output), [{ width: 32 * 12, height: 40 * 12 }]);
  assert.match(JSON.stringify(output), /Colours here: blue 50%, light cyan 50%/);
});

test("a viewed reference stays in the transcript across later turns, unrewritten", async (t) => {
  const stored = references();
  const id = referenceArtId(base64ToBytes(stored[0]!.images[0]!.png));
  const bodies = scriptProvider(t, [
    call("v1", { id, size: "small", region: null, grid: null }),
    say("Seen."),
    say("Still here."),
    say("Still here too."),
  ]);
  const session = sessionWith(MODEL, stored);
  await session.runPowerUp("Look at the harbour.", 3, { referenceIds: ["ref-harbour"] });
  const small = { width: 256, height: 160 };
  const viewed = bodies[1]!.input.find((item) => item["type"] === "function_call_output")!;
  assert.deepEqual(imageSizes(viewed), [small]);
  // Two player messages later the request still carries the exact same
  // item: a rewrite would invalidate every cached block after it, and the
  // cached image costs a fraction of re-sending the history without it.
  await session.runPowerUp("Anything else?", 3);
  await session.runPowerUp("Check the harbour once more.", 3);
  const third = bodies[3]!.input;
  assert.deepEqual(
    third.find((item) => item["type"] === "function_call_output"),
    viewed,
  );
  assert.doesNotMatch(JSON.stringify(third), /left the conversation/);
  assert.doesNotMatch(JSON.stringify(session.getTranscript()), /left the conversation/);
});

test("a turn without references neither lists nor runs view_reference", async (t) => {
  const bodies = scriptProvider(t, [
    call("v1", { id: "art-0123456789", size: "small", region: null, grid: null }),
    say("Done."),
  ]);
  const session = sessionWith(MODEL, []);
  await session.runPowerUp("Add a lamp.", 1);
  assert.ok(!bodies[0]!.tool_choice!.tools.some((tool) => tool.name === "view_reference"));
  assert.deepEqual(imageSizes(bodies[0]!.input), []);
  assert.match(JSON.stringify(bodies[1]!.input), /'view_reference' is not available in this phase/);
  // The dispatcher refuses it the same way for any list the helper narrowed.
  const refused = await executeAgentToolAsync(
    createAgentSessionState(),
    "view_reference",
    { id: "art-0123456789", size: "small", region: null, grid: null },
    { allowedTools: withReferences(REMIX_TOOLS, undefined) },
  );
  assert.match(refused.error ?? "", /not available in this phase/);
});

test("the manifest rides again only when the art changes or the player attaches some", async (t) => {
  const bodies = scriptProvider(t, [say("One."), say("Two."), say("Three.")]);
  const session = sessionWith(MODEL);
  await session.runPowerUp("First.", 1);
  await session.runPowerUp("Second.", 1);
  await session.runPowerUp("Third.", 1, { referenceIds: ["ref-forest"] });
  const lastUser = (body: Body) =>
    JSON.stringify(body.input.filter((item) => item["role"] === "user").at(-1));
  assert.match(lastUser(bodies[0]!), /### REFERENCE ART/);
  assert.doesNotMatch(lastUser(bodies[1]!), /### REFERENCE ART/);
  assert.match(
    lastUser(bodies[2]!),
    /Room plate · room 4 · 320x200 · [^"]*attached to this request/,
  );
});

test("the region stub views a region and uses it; the manifest is all the request carried", async () => {
  const events: { kind: string; message: string }[] = [];
  const session = new AgentSession(
    { provider: "stub", apiKey: "", model: "offline-stub", stubScript: "reference-region" },
    (kind, message) => events.push({ kind, message }),
    createAgentSessionState(),
  );
  const stored = references();
  session.setRuntime({
    referenceArt: async (attached) => referenceSource(stored, attached, decodePng),
  });
  const result = await session.runPowerUp("Use the forest.", 4, { referenceIds: ["ref-forest"] });
  const transcript = session.getTranscript() as {
    role: string;
    images?: { width: number; height: number; caption: string }[];
  }[];
  const request = transcript[0]!;
  assert.equal(request.role, "user");
  assert.deepEqual(
    request.images!.map(({ width, height }) => ({ width, height })),
    [{ width: 208, height: 72 }],
  );
  // The forest plate is attached: the stub views its top-left 64x64 at 8x.
  const tool = transcript.find((entry) => entry.role === "tool")!;
  assert.deepEqual(
    tool.images!.map(({ width, height }) => ({ width, height })),
    [{ width: 512, height: 512 }],
  );
  assert.match(result.text, /is green 100%; I used those colours/);
  assert.ok(!events.some((event) => /was not viewed/.test(event.message)));
});

test("the never-fetch stub's claim is flagged as unviewed attached art", async () => {
  const events: { kind: string; message: string; data?: unknown }[] = [];
  const session = new AgentSession(
    { provider: "stub", apiKey: "", model: "offline-stub", stubScript: "reference-never" },
    (kind, message, data) => events.push({ kind, message, data }),
    createAgentSessionState(),
  );
  const stored = references();
  session.setRuntime({
    referenceArt: async (attached) => referenceSource(stored, attached, decodePng),
  });
  const result = await session.runPowerUp("Use the forest.", 4, { referenceIds: ["ref-forest"] });
  assert.equal(result.text, "The change matches the reference art.");
  const flagged = events.find((event) => /was not viewed/.test(event.message));
  assert.deepEqual((flagged?.data as { unviewedReferences: string[] }).unviewedReferences, [
    referenceArtId(base64ToBytes(stored[1]!.images[0]!.png)),
  ]);
});

test("stored references keep their handles through storage, and the pose row is one of them", async () => {
  const stored = references();
  const source = referenceSource(stored, ["ref-hero"], decodePng)!;
  const again = referenceSource(
    normalizeReferences(JSON.parse(JSON.stringify(stored))),
    [],
    decodePng,
  )!;
  assert.deepEqual(
    again.art.map((art) => art.id),
    source.art.map((art) => art.id),
    "ids come from the stored bytes, not the record",
  );
  const hero = source.art[2]!;
  assert.equal(hero.label, "Character sheet, right-facing row");
  assert.deepEqual(hero.target, { kind: "view", num: 0 });
  assert.equal(hero.attached, true);
  assert.equal(source.art[0]!.attached, false);
  // The staged VIEW the sheet converted to is untouched by the handle.
  assert.equal(stored[2]!.staged?.num, 0);
  // The same bytes in a second record share one handle.
  const copy = { ...stored[0]!, id: "ref-copy", target: 9 };
  assert.equal(referenceSource([...stored, copy], [], decodePng)!.art.length, 3);
});

test("the Anthropic transcript keeps a viewed reference on later user messages", async (t) => {
  const requests: { messages: unknown[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      providerSse("anthropic", {
        id: String(requests.length),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const caption =
    "Reference art-0123456789 viewed at small (256x160 of 640x400). art-0123456789 · Room plate";
  const viewed = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: false,
        content: [
          { type: "text", text: "{}" },
          { type: "text", text: caption },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  };
  const conversation = createAnthropicConversation(
    { provider: "anthropic", model: "test", apiKey: "placeholder" },
    [
      { role: "user", content: "Look at the harbour." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "view_reference", input: {} }],
      },
      viewed,
      { role: "assistant", content: [{ type: "text", text: "Seen." }] },
    ],
  );
  await conversation.sendUserMessage("Anything else?");
  await conversation.sendUserMessage("Once more.");
  // The earlier messages are byte-identical in both requests: the second
  // request extends the first, so its cached prefix holds.
  assert.deepEqual(requests[1]!.messages.slice(0, 5), requests[0]!.messages);
  assert.deepEqual(requests[1]!.messages[2], viewed);
});

test("a Studio assist request carries attached art as a handle, and the stub views it", async () => {
  const events: string[] = [];
  const robot = viewReference(
    "ref-robot",
    1,
    "",
    IDENTITY,
    upload(40, 60, (_x, y) => (y < 30 ? [0xaa, 0xaa, 0xaa] : [0, 0, 0xaa])),
  );
  // A view's reference is a character reference without a pose manifest:
  // the stored shape released records already read.
  assert.deepEqual(normalizeReferences(JSON.parse(JSON.stringify([robot]))), [robot]);
  const stored = [...references(), robot];
  const session = new AgentSession(
    { provider: "stub", apiKey: "", model: "offline-stub" },
    (_kind, message) => events.push(message),
    createAgentSessionState(),
  );
  session.setRuntime({
    referenceArt: async (attached) => referenceSource(stored, attached, decodePng),
  });
  const focus: StudioFocus = {
    scope: pictureAssistScope({
      num: 1,
      compiled: compileEditDocument(
        parsePictureDocument(BRIDGE_SOURCE).document,
        DEFAULT_V2_PROFILE,
      ),
      targetIds: ["bridge"],
      lens: "walk",
    }),
    draft: () => ({ kind: "picture", source: BRIDGE_SOURCE }),
    lens: "walk",
  };
  const id = referenceArtId(base64ToBytes(robot.images[0]!.png));
  const result = await session.runStudioAssist({
    instruction: "Match the reference",
    focus,
    referenceIds: ["ref-robot"],
  });
  // The stub names the art the manifest marked attached, views it (the turn
  // offers view_reference: the host dispatcher refuses tools off its list),
  // and reports the images the request itself carried: one contact strip
  // of the four 64 px thumbnails, a 4 px gutter before each 64 px cell and
  // after the last (4 + 4 × 68 = 276 wide), none of the art itself.
  assert.equal(
    result.text,
    `I viewed ${id} and left the selection as it is; this request carried its reference list and one image (276x72).`,
  );
  assert.equal(result.candidate, null);
  assert.ok(events.some((message) => message.startsWith("[Studio] view_reference -> ")));
  assert.ok(
    !events.some((message) => /view_reference -> .*(not available|not allowed)/.test(message)),
  );
  // The manifest rode that request; the next one on the same art does not repeat it.
  const again = await session.runStudioAssist({ instruction: "Match the reference", focus });
  assert.equal(again.text, "No reference art was attached to this request.");
});
