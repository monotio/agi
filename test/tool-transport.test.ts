import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_TOOLS,
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
  type AgentToolResult,
} from "../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
  anthropicToolDefinitions,
  anthropicToolResult,
  serializeAgentLog,
} from "../src/agent/toolTransport.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { buildView } from "../src/view/view.ts";

const picture = { room: 1, source: "vis 1\nfill 0,0\nend" };

test("picture revisions send compact text and byte-exact images to both providers", () => {
  const session = createAgentSessionState();
  for (let round = 1; round <= 4; round++) {
    const result = executeAgentTool(session, "write_picture", picture);
    assert.equal(result.success, true);
    const content = splitToolResult(result);
    assert.ok(content.text.length < 2000, `picture text is ${content.text.length} characters`);
    assert.match(content.text, new RegExp(`Revision ${round}.`));
    assert.equal(content.images.length, 1);
    for (const blocks of [openAiToolContent(content), anthropicToolContent(content)]) {
      assert.equal(blocks.length, 3);
      const image = blocks[2]!;
      const encoded =
        image.type === "input_image"
          ? image.image_url.split(",")[1]!
          : image.type === "image"
            ? image.source.data
            : "";
      assert.deepEqual(new Uint8Array(Buffer.from(encoded, "base64")), result.images![0]!.png);
    }
  }
});

test("tool transport refuses binary fields outside image attachments", () => {
  assert.throws(
    () =>
      splitToolResult({
        success: true,
        details: { nested: { pixels: new Uint8Array([1, 2, 3]) } },
      }),
    /binary.*image/i,
  );
});

test("source reads carry the source once without dropping other metadata", () => {
  const source = "return;";
  const result = splitToolResult({
    success: true,
    message: `Source:\n${source}`,
    details: { source, bytes: 1 },
  });
  assert.deepEqual(JSON.parse(result.text), {
    success: true,
    message: `Source:\n${source}`,
    details: { bytes: 1 },
  });
});

test("debug logs summarize image bytes without expanding them into JSON properties", () => {
  const result = executeAgentTool(createAgentSessionState(), "write_picture", picture);
  const logged = serializeAgentLog({ result });
  assert.ok(logged.length < 2200);
  assert.deepEqual(JSON.parse(logged).result.images[0].png, {
    binaryBytes: result.images![0]!.png.byteLength,
  });
});

test("maximum sprite and sound read pages stay within the transport bound", () => {
  const session = createAgentSessionState();
  session.container.putResource(
    "view",
    3,
    buildView({
      loops: [
        {
          cels: [
            {
              width: 160,
              height: 168,
              transparentColor: 0,
              pixels: new Uint8Array(160 * 168).fill(1),
            },
          ],
        },
      ],
    }),
  );
  const cel = executeAgentTool(session, "read_view_cel", {
    num: 3,
    loop: 0,
    cel: 0,
    rowOffset: 64,
    rowLimit: 64,
  });
  assertTransport("read_view_cel", "maximum page", cel);

  const events = Array.from({ length: 128 }, () => ({ note: "C4", beats: 16, repeat: 32 }));
  assert.equal(
    executeAgentTool(session, "write_music", {
      num: 4,
      tempo: 40,
      tracks: [{ channel: "melody", volume: 15, events }],
    }).success,
    true,
  );
  const sound = executeAgentTool(session, "read_sound", {
    num: 4,
    channel: 0,
    offset: 4032,
    limit: 64,
  });
  assertTransport("read_sound", "maximum page", sound);
});

function bootedSession() {
  const session = createAgentSessionState();
  session.wordsPayload = buildWordsTok([{ word: "look", id: 10 }]);
  session.sources.words.set("look", 10);
  session.container.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [2] }] }] }),
  );
  session.container.putResource("picture", 1, compilePictureSource("vis 1\nfill 0,0\nend").bytes);
  session.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) { set(f200); new.room(1); } call.v(v0); return;", {
      dictionary: session.sources.words,
    }).payload,
  );
  session.container.putResource(
    "logic",
    1,
    assembleLogic(
      "if (isset(f5)) { assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic(); load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input(); } return;",
      { dictionary: session.sources.words },
    ).payload,
  );
  session.container.putResource(
    "logic",
    2,
    assembleLogic("return;", { dictionary: session.sources.words }).payload,
  );
  return session;
}

function assertTransport(name: string, path: string, result: AgentToolResult): void {
  const content = splitToolResult(result);
  assert.ok(content.text.length < 12000, `${name} ${path}: oversized metadata`);
  assert.equal(
    JSON.parse(content.text).images,
    undefined,
    `${name} ${path}: images leaked to JSON`,
  );
  assert.equal(content.images.length, result.images?.length ?? 0);
  for (const image of content.images) {
    assert.ok(image.png.length < 500_000, `${name} ${path}: oversized image`);
    assert.deepEqual([...image.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  for (const blocks of [openAiToolContent(content), anthropicToolContent(content)]) {
    assert.equal(blocks.length, 1 + content.images.length * 2);
    for (let image = 0; image < content.images.length; image++) {
      const block = blocks[2 + image * 2]!;
      const encoded =
        block.type === "input_image"
          ? block.image_url.split(",")[1]!
          : block.type === "image"
            ? block.source.data
            : "";
      assert.deepEqual(
        new Uint8Array(Buffer.from(encoded, "base64")),
        content.images[image]!.png,
        `${name} ${path}: provider image changed bytes`,
      );
    }
  }
}

interface TransportCase {
  /** Args, or a thunk when they embed a revision read at call time. */
  good: Record<string, unknown> | (() => Record<string, unknown>);
  bad: Record<string, unknown> | (() => Record<string, unknown>);
}

test("every catalog tool produces bounded binary-free transport on real success and failure paths", async () => {
  const session = bootedSession();
  const logicRead = executeAgentTool(session, "read_logic", { num: 2, offset: null, limit: null });
  const celRead = executeAgentTool(session, "read_view_cel", {
    num: 0,
    loop: 0,
    cel: 0,
    rowOffset: null,
    rowLimit: null,
  });
  const roomRead = executeAgentTool(session, "read_logic", { num: 1, offset: null, limit: null });
  assert.equal(logicRead.success, true);
  assert.equal(celRead.success, true);
  assert.equal(roomRead.success, true);

  const cases: Record<string, TransportCase | Record<string, unknown>> = {
    reserve_binding: {
      good: { name: "gate_open", kind: "flag", id: null },
      bad: { name: "Not valid", kind: "flag", id: null },
    },
    upsert_inventory_item: {
      good: { id: null, name: "Brass key", location: "room", room: 1 },
      bad: { id: -1, name: "Bad", location: "room", room: 1 },
    },
    edit_resource_source: {
      // The revision covers text plus compilation context; earlier cases may
      // have moved the dictionary or bindings, so read it fresh at call time.
      good: () => ({
        kind: "logic",
        num: 2,
        expectedRevision: executeAgentTool(session, "read_logic", {
          num: 2,
          offset: null,
          limit: null,
        }).details?.["revision"],
        edits: [{ find: "return;", replace: "set(f10); return;" }],
      }),
      bad: {
        kind: "logic",
        num: 2,
        expectedRevision: "stale",
        edits: [{ find: "return;", replace: "set(f10); return;" }],
      },
    },
    update_world: {
      good: {
        rooms: [{ num: 1, title: "Start", description: "A start room.", exits: [] }],
        facts: [],
        quests: [],
      },
      bad: { rooms: null, facts: [], quests: [] },
    },
    write_actor: {
      good: {
        num: 2,
        description: null,
        transparentColor: 0,
        mirrorLeftFromRight: true,
        mirrorUpFromDown: null,
        right: [["20"]],
        left: null,
        down: [["30"]],
        up: [["40"]],
      },
      bad: {
        num: -1,
        description: null,
        transparentColor: 0,
        mirrorLeftFromRight: true,
        mirrorUpFromDown: null,
        right: [["20"]],
        left: null,
        down: [["30"]],
        up: [["40"]],
      },
    },
    read_view_cel: {
      good: { num: 0, loop: 0, cel: 0, rowOffset: null, rowLimit: null },
      bad: { num: 0, loop: 99, cel: 0, rowOffset: null, rowLimit: null },
    },
    patch_view_cels: {
      good: {
        num: 0,
        expectedRevision: celRead.details?.["revision"],
        patches: [{ loop: 0, cel: 0, rows: ["3"] }],
      },
      bad: { num: 0, expectedRevision: "stale", patches: [{ loop: 0, cel: 0, rows: ["4"] }] },
    },
    write_music: {
      good: {
        num: 6,
        tempo: 120,
        tracks: [
          {
            channel: "melody",
            volume: 12,
            events: [{ note: "C4", beats: 1, repeat: 1 }],
          },
        ],
      },
      bad: {
        num: 6,
        tempo: 0,
        tracks: [
          {
            channel: "melody",
            volume: 12,
            events: [{ note: "C4", beats: 1, repeat: 1 }],
          },
        ],
      },
    },
    read_sound: {
      good: { num: 6, channel: null, offset: null, limit: null },
      bad: { num: 255, channel: null, offset: null, limit: null },
    },
    preview_sound: {
      good: { num: 6, startSeconds: null, durationSeconds: null, device: null },
      bad: { num: 255, startSeconds: null, durationSeconds: null, device: null },
    },
    write_scene: {
      good: { room: 5, backgroundColor: 1, shapes: [] },
      bad: { room: 5, backgroundColor: 16, shapes: [] },
    },
    read_room_context: {
      good: { room: 1 },
      bad: { room: 999 },
    },
    write_words: { words: ["look", "east"] },
    write_view: {
      num: 3,
      spec: {
        description: null,
        loops: [
          {
            mirrorLoop: null,
            cels: [
              {
                width: 1,
                height: 1,
                transparentColor: 0,
                mirror: null,
                pixels: [5],
              },
            ],
          },
        ],
      },
    },
    write_logic_source: { room: 3, source: "return;" },
    write_picture: { room: 4, source: "vis 1\nfill 0,0\nend" },
    write_inventory_objects: { objects: [{ name: "key", startingRoom: 1 }] },
    write_sound: {
      num: 7,
      tracks: [{ notes: [{ note: "C4", duration: 4, freqDivisor: null, attenuation: null }] }],
    },
    read_logic: { num: 1, offset: null, limit: null },
    read_picture: { num: 1, offset: null, limit: null, include: null },
    read_view: { num: 0 },
    read_words: { prefix: null, exact: null, offset: null, limit: null },
    list_resources: { kind: null },
    inspect_world_bible: { filter: null },
    read_command_reference: {
      good: { query: "priority", kind: null, offset: null },
      bad: { query: null, kind: "invalid", offset: null },
    },
    read_authoring_guide: {
      good: { topic: "text-and-captions" },
      bad: { topic: "jokes" },
    },
    read_game_tests: { good: { names: null }, bad: { names: 42 } },
    run_game_tests: { good: { names: null }, bad: { names: ["no such test"] } },
    write_game_tests: {
      good: {
        mode: "merge",
        names: null,
        tests: [
          {
            name: "look around",
            room: 1,
            spawnX: null,
            spawnY: null,
            steps: [
              { action: "wait", command: null, direction: null, ticks: 2, captureTicks: null },
            ],
            expect: {
              room: 1,
              carriedItems: null,
              flags: null,
              vars: null,
              printed: null,
              text: null,
            },
            cycleBudget: null,
          },
        ],
      },
      bad: { mode: "remove", names: ["never stored"], tests: null },
    },
    playtest_room: {
      room: 1,
      spawnX: null,
      spawnY: null,
      steps: null,
      expect: { room: 1, carriedItems: [], flags: [] },
    },
    read_frames: { count: 1, stride: 1, sheet: false, plane: null },
    read_objects: {},
    read_state: {},
    finish_genesis: { notes: "Booted synthetic room." },
    write_room: {
      good: () => ({
        room: 1,
        picture: 1,
        egoView: 0,
        title: "Start",
        description: "A start room.",
        expectedRevision: executeAgentTool(session, "read_logic", {
          num: 1,
          offset: null,
          limit: null,
        }).details?.["revision"],
        spawn: { x: 80, y: 120, horizon: 36 },
        exits: [],
        interactions: [],
      }),
      bad: { room: 99 },
    },
  };
  const directCases = cases;
  for (const [name, value] of Object.entries(directCases)) {
    if ("good" in value && "bad" in value) continue;
    const good = value;
    let bad: Record<string, unknown>;
    if (name === "write_words" || name === "read_words" || name === "write_inventory_objects")
      bad = { ...good, offset: -1 };
    else if (name === "write_view") bad = { ...good, num: -1 };
    else if (name === "write_logic_source") bad = { room: 3, source: "not valid !!!" };
    else if (name === "write_picture") bad = { room: -1, source: "end" };
    else if (name === "write_sound") bad = { ...good, num: -1 };
    else if (name === "read_logic" || name === "read_picture" || name === "read_view")
      bad = { ...good, num: 255 };
    else if (name === "list_resources") bad = { kind: "invalid" };
    else if (name === "inspect_world_bible") bad = { filter: "invalid" };
    else if (name === "playtest_room") bad = { ...good, room: 0 };
    else if (name === "read_frames") bad = { ...good, plane: "invalid" };
    else bad = good;
    directCases[name] = { good, bad };
  }
  const deps = {
    frames: {
      read: async () => [
        {
          cycle: 1,
          visual: new Uint8Array(160 * 168),
          priority: new Uint8Array(160 * 168).fill(4),
          text: new Uint8Array(40 * 25 * 2),
          picRow: 1,
        },
      ],
    },
    engine: {
      objects: async () => [{ num: 0, x: 80, y: 120 }],
      state: async () => ({
        room: 1,
        previousRoom: 0,
        profile: "2.936",
        egoX: 80,
        egoY: 120,
        egoDirection: 0,
        horizon: 36,
        modalKind: null,
        lastInputLine: "",
      }),
    },
  };
  const expectedCatalog = [
    "edit_resource_source",
    "finish_genesis",
    "inspect_world_bible",
    "list_resources",
    "patch_view_cels",
    "playtest_room",
    "preview_sound",
    "read_authoring_guide",
    "read_command_reference",
    "read_frames",
    "read_game_tests",
    "read_logic",
    "read_objects",
    "read_picture",
    "read_room_context",
    "read_sound",
    "read_state",
    "read_view",
    "read_view_cel",
    "read_words",
    "reserve_binding",
    "run_game_tests",
    "update_world",
    "upsert_inventory_item",
    "write_actor",
    "write_game_tests",
    "write_inventory_objects",
    "write_logic_source",
    "write_music",
    "write_picture",
    "write_room",
    "write_scene",
    "write_sound",
    "write_view",
    "write_words",
  ];
  assert.deepEqual(AGENT_TOOLS.map((tool) => tool.name).sort(), expectedCatalog);
  assert.deepEqual(Object.keys(directCases).sort(), expectedCatalog);
  for (const [name, value] of Object.entries(directCases)) {
    assert.ok("good" in value && "bad" in value);
    const paths = value as unknown as TransportCase;
    const goodArgs = typeof paths.good === "function" ? paths.good() : paths.good;
    const good = await executeAgentToolAsync(session, name, goodArgs, deps);
    assert.equal(good.success, true, `${name}: ${good.error}`);
    assertTransport(name, "success", good);
    const failureState = name === "finish_genesis" ? createAgentSessionState() : session;
    const failureDeps = name === "read_objects" || name === "read_state" ? undefined : deps;
    const badArgs = typeof paths.bad === "function" ? paths.bad() : paths.bad;
    const failure = await executeAgentToolAsync(failureState, name, badArgs, failureDeps);
    assert.equal(failure.success, false, `${name}: invalid args unexpectedly succeeded`);
    assertTransport(name, "failure", failure);
  }
});

test("Anthropic tool definitions send the catalog schemas verbatim and never strict", () => {
  const definitions = anthropicToolDefinitions(AGENT_TOOLS);
  assert.equal(definitions.length, AGENT_TOOLS.length);
  for (const [index, tool] of definitions.entries()) {
    assert.deepEqual(tool, {
      name: AGENT_TOOLS[index]!.name,
      description: AGENT_TOOLS[index]!.description,
      input_schema: AGENT_TOOLS[index]!.parameters,
    });
    assert.ok(!("strict" in tool), `${tool.name}: strict tools exceed Anthropic grammar limits`);
  }
});

test("Anthropic error results with images are not flagged is_error", () => {
  // The Messages API rejects `is_error: true` unless every block is text; a
  // failed playtest still returns frames, and the JSON text carries success:false.
  const png = new Uint8Array([137, 80, 78, 71]);
  const failed: AgentToolResult = {
    success: false,
    error: "steps[0]: the print modal pauses animation.",
    images: [{ png, caption: "Frame after step 0" }],
  };
  assert.deepEqual(anthropicToolResult("call-1", failed), {
    type: "tool_result",
    tool_use_id: "call-1",
    is_error: false,
    content: [
      { type: "text", text: JSON.stringify({ success: false, error: failed.error }) },
      { type: "text", text: "Frame after step 0" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
    ],
  });
  assert.deepEqual(anthropicToolResult("call-2", { success: false, error: "bad" }), {
    type: "tool_result",
    tool_use_id: "call-2",
    is_error: true,
    content: [{ type: "text", text: JSON.stringify({ success: false, error: "bad" }) }],
  });
  assert.equal(anthropicToolResult("call-3", { success: true, message: "ok" }).is_error, false);
});
