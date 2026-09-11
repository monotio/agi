import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState, executeAgentTool, AGENT_TOOLS } from "../src/agent/tools.ts";

describe("agent tools", () => {
  it("exports tool definitions with required schemas", () => {
    assert.ok(AGENT_TOOLS.length >= 5);
    const names = AGENT_TOOLS.map((t) => t.name);
    assert.ok(names.includes("write_words"));
    assert.ok(names.includes("write_logic_source"));
    assert.ok(names.includes("write_picture"));
    assert.ok(names.includes("write_view"));
    assert.ok(names.includes("handover"));
    assert.ok(names.includes("write_inventory_objects"));
    assert.ok(names.includes("write_sound"));
    assert.ok(names.includes("inspect_world_bible"));
    assert.ok(names.includes("playtest_room"));
    // Read tools: orientation and live patching.
    assert.ok(names.includes("read_picture"));
    assert.ok(names.includes("read_logic"));
    assert.ok(names.includes("list_resources"));
    assert.ok(names.includes("read_words"));
    // Runtime perception: frames, objects, state.
    assert.ok(names.includes("read_frames"));
    assert.ok(names.includes("read_objects"));
    assert.ok(names.includes("read_state"));
    assert.ok(names.includes("read_view"));
    for (const name of [
      "write_actor",
      "upsert_inventory_item",
      "write_music",
      "edit_resource_source",
      "reserve_binding",
      "update_world",
    ])
      assert.ok(names.includes(name));
    assert.equal(new Set(names).size, names.length, "tool names are unique");
  });

  it("conforms strictly to OpenAI and Anthropic strict structured tool calling schemas", () => {
    function assertStrictSchema(schema: unknown, path: string) {
      assert.ok(schema && typeof schema === "object", `${path}: schema must be an object`);
      const s = schema as Record<string, unknown>;

      if (s["type"] === "object" || s["properties"] !== undefined) {
        assert.equal(
          s["additionalProperties"],
          false,
          `${path}: object schema must explicitly set additionalProperties: false`,
        );
        const props = (s["properties"] as Record<string, unknown>) || {};
        const required = Array.isArray(s["required"]) ? (s["required"] as string[]) : [];
        for (const propName of Object.keys(props)) {
          assert.ok(
            required.includes(propName),
            `${path}: property '${propName}' must be included in required array for strict mode`,
          );
          assertStrictSchema(props[propName], `${path}.${propName}`);
        }
      }

      if (s["type"] === "array" || s["items"] !== undefined) {
        assert.ok(s["items"] !== undefined, `${path}: array schema must define items`);
        assertStrictSchema(s["items"], `${path}[*]`);
      }
    }

    for (const tool of AGENT_TOOLS) {
      assertStrictSchema(tool.parameters, tool.name);
    }
  });

  it("rejects handover when initial resources are missing", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "handover", {});
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("missing required initial resources"));
    assert.equal(session.genesisComplete, false);
  });

  it("handles syntax error in write_logic_source and returns exact diagnostics", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_logic_source", {
      room: 1,
      source: "this is completely invalid logic code !!!",
    });
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("Assembler error in logic 1"));
  });

  it("completes full genesis authoring cycle through tool calls", () => {
    const session = createAgentSessionState();

    // 1. write words
    const wordsRes = executeAgentTool(session, "write_words", {
      words: ["look", "take/get", "open", "door", "candle"],
    });
    assert.equal(wordsRes.success, true);
    assert.ok(session.getFiles().has("WORDS.TOK"));

    // 2. write view 0 (ego)
    const viewRes = executeAgentTool(session, "write_view", {
      num: 0,
      spec: {
        loops: [
          {
            cels: [
              {
                width: 2,
                height: 2,
                transparentColor: 0,
                pixels: [1, 1, 1, 1],
              },
            ],
          },
        ],
      },
    });
    assert.equal(viewRes.success, true);
    assert.ok(session.container.getResource("view", 0));

    // 3. write picture 1
    const picRes = executeAgentTool(session, "write_picture", {
      room: 1,
      source: "vis 1\nline 0,0 159,167\nend\n",
    });
    assert.equal(picRes.success, true);
    assert.ok(session.container.getResource("picture", 1));

    // 4. write logic 0
    const logic0Res = executeAgentTool(session, "write_logic_source", {
      room: 0,
      source: `
      if (!isset(f200)) {
        set(f200);
        assignn(v0, 1);
        new.room.v(v0);
      }
      call.v(v0);
      return;
      `,
    });
    assert.equal(logic0Res.success, true);
    assert.ok(session.container.getResource("logic", 0));

    // 5. write logic 1
    const logic1Res = executeAgentTool(session, "write_logic_source", {
      room: 1,
      source: `
      #message 1 "Starting room."
      if (isset(f5)) {
        load.pic(v0);
        draw.pic(v0);
        show.pic();
        load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
        print(1);
      }
      return;
      `,
    });
    assert.equal(logic1Res.success, true);
    assert.ok(session.container.getResource("logic", 1));

    // 6. finish genesis
    const finishRes = executeAgentTool(session, "handover", {
      notes: "Starting room and ego initialized.",
    });
    assert.equal(finishRes.success, true);
    assert.equal(session.genesisComplete, true);
  });

  it("incrementally patches room 2 while preserving room 1", () => {
    const session = createAgentSessionState();

    // Setup minimal room 1
    executeAgentTool(session, "write_words", { words: ["look", "east"] });
    executeAgentTool(session, "write_view", {
      num: 0,
      spec: { loops: [{ cels: [{ width: 1, height: 1, pixels: [2] }] }] },
    });
    executeAgentTool(session, "write_picture", { room: 1, source: "end\n" });
    executeAgentTool(session, "write_logic_source", {
      room: 0,
      source: "if (!isset(f200)) {set(f200);new.room(1);} call.v(v0); return;",
    });
    executeAgentTool(session, "write_logic_source", {
      room: 1,
      source:
        "if (isset(f5)) {load.pic(v0); draw.pic(v0); show.pic(); load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();} return;",
    });
    executeAgentTool(session, "handover", {});
    assert.equal(session.genesisComplete, true);

    // Incrementally author room 2
    const pic2Res = executeAgentTool(session, "write_picture", {
      room: 2,
      source: "vis 4\nend\n",
    });
    assert.equal(pic2Res.success, true);

    const logic2Res = executeAgentTool(session, "write_logic_source", {
      room: 2,
      source: `
      #message 1 "Room 2 is alive."
      print(1);
      return;
      `,
    });
    assert.equal(logic2Res.success, true);

    // Both room 1 and room 2 exist in container
    assert.ok(session.container.getResource("picture", 1));
    assert.ok(session.container.getResource("picture", 2));
    assert.ok(session.container.getResource("logic", 1));
    assert.ok(session.container.getResource("logic", 2));

    // Source store retains code for both rooms
    assert.equal(session.sources.logics.size, 3); // 0, 1, 2
    assert.ok(session.sources.logics.get(2)?.includes("Room 2 is alive."));
  });

  it("write_picture returns a rendered PNG image block and metrics with the source stored", () => {
    const session = createAgentSessionState();
    const source = [
      "# sky",
      "vis 1",
      "pri 4",
      "rect 0,0 159,40",
      "fill 80,20",
      "# ground",
      "vis 2",
      "pri 8",
      "rect 0,41 159,167",
      "fill 80,100",
      "end",
    ].join("\n");
    const res = executeAgentTool(session, "write_picture", { room: 3, source });
    assert.equal(res.success, true, res.error ?? "");

    // The SOURCE is what is stored for revision; the container gets the bytes.
    assert.equal(session.sources.pictures.get(3), source);
    const bytes = session.container.getResource("picture", 3);
    assert.ok(bytes);
    assert.equal(bytes[bytes.length - 1], 0xff);

    // Metrics summary in the text.
    assert.ok(res.message?.includes("fill coverage"), res.message ?? "");
    assert.ok(res.message?.includes("distinct colours"), res.message ?? "");
    assert.equal(typeof res.details?.["fillCoverage"], "number");
    assert.ok((res.details?.["fillCoverage"] as number) > 0.9);

    // Provider-neutral image block: PNG signature, native 2:1 logical-pixel aspect.
    assert.equal(res.images?.length, 1);
    const png = res.images![0]!.png;
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = (png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!;
    const height = (png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!;
    assert.deepEqual([width, height], [960, 168]);
    assert.ok(res.images![0]!.caption.includes("Picture 3"));
    assert.match(res.images![0]!.caption, /native 2:1/);
    assert.match(
      res.images![0]!.caption,
      /Left: clean visual.*Middle: raw priority.*Right: overlay/,
    );
    assert.match(res.images![0]!.caption, /0 barrier.*1 conditional barrier.*2 trigger.*3 water/);
    assert.doesNotMatch(res.message!, /fill seeds did nothing/);
  });

  it("write_picture reports blocked fill seeds concisely", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_picture", {
      room: 4,
      source: [
        "vis 9",
        "fill 0,0",
        "vis 8",
        "line 10,10",
        "fill 10,10 1,1 2,2 3,3 4,4 5,5 6,6",
        "end",
      ].join("\n"),
    });
    assert.equal(res.success, true, res.error ?? "");
    assert.match(
      res.message!,
      /6 visual fill seeds did nothing: 1,1 selected 8, found 9 \(needs 15\); 2,2 selected 8, found 9 \(needs 15\); 3,3 selected 8, found 9 \(needs 15\); 4,4 selected 8, found 9 \(needs 15\); 5,5 selected 8, found 9 \(needs 15\); \+1 more\. Enclose and fill regions while their interiors still have the target value\./,
    );
    assert.doesNotMatch(res.message!, /10,10 selected/);
  });

  it("write_picture result carries the rendered colour grid, ahead of the revision line", () => {
    const session = createAgentSessionState();
    // Sky colour 1 above y40, ground colour 2 below: the grid must show it.
    const res = executeAgentTool(session, "write_picture", {
      room: 7,
      source: "vis 1\nrect 0,0 159,40\nfill 80,20\nvis 2\nrect 0,41 159,167\nfill 80,100\nend",
    });
    assert.equal(res.success, true, res.error ?? "");
    const message = res.message!;
    assert.ok(
      message.includes("Dominant colour per cell, 8x7 (x left→right, y top→bottom):"),
      message,
    );
    const grid = message
      .split("\n")
      .filter((line) => line.startsWith("y"))
      .map((line) => line.split(":")[1]!.trim().replace(/\s+/g, " "));
    assert.equal(grid.length, 7);
    assert.equal(grid[0], "1 1 1 1 1 1 1 1", message);
    assert.equal(grid[6], "2 2 2 2 2 2 2 2", message);
    // No `# layout:` comments and no earlier revision: neither block appears.
    assert.ok(!message.includes("Declared `# layout:` masses"), message);
    assert.ok(!message.includes("Original commands preserved"), message);
    // The harness round counter stays the last line of the result.
    assert.equal(
      message.trim().split("\n").pop(),
      "Revision 1. Inspect the image; revise when it would improve the requested result.",
    );
  });

  it("write_picture reports each declared `# layout:` mass against what rendered", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_picture", {
      room: 8,
      source: [
        "# layout: ground x0-159 y100-167 colour 2",
        "# layout: moon x10-30 y10-30 colour 15",
        "vis 2",
        "rect 0,100 159,167",
        "fill 80,140",
        "end",
      ].join("\n"),
    });
    assert.equal(res.success, true, res.error ?? "");
    const message = res.message!;
    assert.ok(message.includes("Declared `# layout:` masses vs what rendered:"), message);
    assert.ok(
      message.includes("- ground x0-159 y100-167 colour 2: dominant 2, coverage 100%"),
      message,
    );
    assert.ok(message.includes("-> OK"), message);
    // Nothing was drawn for the moon: white is still the declared colour there,
    // but the region that carries it is the whole unpainted sky, not the box.
    assert.ok(message.includes("- moon x10-30 y10-30 colour 15:"), message);
    assert.ok(message.includes("-> SHIFTED"), message);
  });

  it("write_picture reports spatial priority extents and actor placement probes", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_picture", {
      room: 8,
      source: [
        "# actor: ego x20 y120 width8 height24 priority11",
        "pri 0",
        "line 20,120 21,120",
        "pri 12",
        "rect 20,97 27,100",
        "end",
      ].join("\n"),
    });
    assert.equal(res.success, true, res.error ?? "");
    assert.match(res.message ?? "", /Display geometry: 160x168 logical -> 320x168/);
    assert.match(res.message ?? "", /0 barrier: 2 cells in 1 component, x20-21 y120-120/);
    assert.match(
      res.message ?? "",
      /ego: logical x20-27 y97-120 \(8x24\), display x40-55 y97-120 \(16x24\)/,
    );
    assert.match(res.message ?? "", /controls \[0@x20-21\]/);
    // A rect draws its 8x4 outline: 8 + 8 + 2 + 2 = 20 distinct cells.
    assert.match(res.message ?? "", /higher-priority scenery 20\/192 cells/);
  });

  it("write_picture reports preservation and leak metrics when revising the same picture", () => {
    const session = createAgentSessionState();
    const first = "vis 2\nrect 0,100 159,167\nfill 80,140\nend";
    executeAgentTool(session, "write_picture", { room: 9, source: first });
    // Pure append: every original command survives and one small block moves.
    const res = executeAgentTool(session, "write_picture", {
      room: 9,
      source: `${first.slice(0, -3)}vis 4\nrect 20,20 29,29\nfill 25,25\nend`,
    });
    assert.equal(res.success, true, res.error ?? "");
    const message = res.message!;
    assert.ok(message.includes("Original commands preserved in order: 4 of 4"), message);
    assert.ok(
      message.includes("Changed cells: 100 in region x20-29 y20-29; stray cells outside it: 0"),
      message,
    );
    assert.ok(message.includes("in 1 components"), message);
    assert.equal(
      message.trim().split("\n").pop(),
      "Revision 2. Inspect the image; revise when it would improve the requested result.",
    );
  });

  it("write_picture returns line-numbered compile errors verbatim and stores nothing", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_picture", {
      room: 4,
      source: "vis 1\nline 0,0 159,0\nbogus 1,2\nend\n",
    });
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("line 3"), res.error ?? "");
    assert.ok(res.error?.includes("bogus"), res.error ?? "");
    assert.equal(session.container.getResource("picture", 4), null);
    assert.equal(session.sources.pictures.has(4), false);
  });

  it("read_picture round-trips an authored room back to picture source", () => {
    const session = createAgentSessionState();
    executeAgentTool(session, "write_picture", {
      room: 5,
      source: "vis 6\nline 10,10 20,20\nend\n",
    });

    const res = executeAgentTool(session, "read_picture", { num: 5 });
    assert.equal(res.success, true, res.error ?? "");
    const source = res.details?.["source"] as string;
    assert.ok(source.includes("vis 6"), source);
    assert.ok(source.includes("10,10"), source);
    const png = res.images![0]!.png;
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.deepEqual([header.getUint32(16), header.getUint32(20)], [960, 168]);
    assert.match(res.message ?? "", /Priority\/control map/);

    const missing = executeAgentTool(session, "read_picture", { num: 6 });
    assert.equal(missing.success, false);
    assert.ok(missing.error?.includes("not present"));
  });

  it("read_logic disassembles compiled bytecode back to re-assemblable source", () => {
    const session = createAgentSessionState();
    executeAgentTool(session, "write_words", { words: ["look", "door"] });
    executeAgentTool(session, "write_logic_source", {
      room: 7,
      source:
        '#message 1 "A plain wooden door."\nif (said("look", "door")) { print(1); }\nreturn;\n',
    });

    const res = executeAgentTool(session, "read_logic", { num: 7 });
    assert.equal(res.success, true, res.error ?? "");
    const source = res.details?.["source"] as string;
    assert.ok(source.includes("A plain wooden door."), source);
    assert.ok(source.includes('said("look", "door")'), source);

    // The contract is byte identity: re-writing the disassembly must recompile.
    const again = executeAgentTool(session, "write_logic_source", { room: 8, source });
    assert.equal(again.success, true, again.error ?? "");
    assert.deepEqual(
      [...session.container.getResource("logic", 8)!],
      [...session.container.getResource("logic", 7)!],
    );

    const missing = executeAgentTool(session, "read_logic", { num: 9 });
    assert.equal(missing.success, false);
    assert.ok(missing.error?.includes("not present"));
  });

  it("list_resources reports present numbers and free numbers per family", () => {
    const session = createAgentSessionState();
    executeAgentTool(session, "write_logic_source", { room: 0, source: "return;" });
    executeAgentTool(session, "write_logic_source", { room: 1, source: "return;" });
    executeAgentTool(session, "write_picture", { room: 1, source: "end\n" });

    const res = executeAgentTool(session, "list_resources", { kind: null });
    assert.equal(res.success, true);
    const present = res.details?.["present"] as Record<string, number[]>;
    assert.deepEqual(present["logic"], [0, 1]);
    assert.deepEqual(present["picture"], [1]);
    assert.deepEqual(present["view"], []);
    const free = res.details?.["free"] as Record<string, number[]>;
    assert.equal(free["logic"]![0], 2);
    assert.equal(free["picture"]![0], 2);
    assert.ok(res.message?.includes("logic: 2 present"), res.message ?? "");

    const one = executeAgentTool(session, "list_resources", { kind: "picture" });
    assert.deepEqual(Object.keys(one.details?.["present"] as object), ["picture"]);

    const bad = executeAgentTool(session, "list_resources", { kind: "spaceship" });
    assert.equal(bad.success, false);
    assert.ok(bad.error?.includes("Unknown resource kind"));
  });

  it("read_words summarises the dictionary by synonym group", () => {
    const session = createAgentSessionState();
    const empty = executeAgentTool(session, "read_words", { prefix: null });
    assert.equal(empty.success, true);
    assert.ok(empty.message?.includes("empty"), empty.message ?? "");

    executeAgentTool(session, "write_words", { words: ["take/get/grab", "door"] });
    const res = executeAgentTool(session, "read_words", { prefix: null });
    assert.equal(res.success, true);
    const groups = res.details?.["groups"] as { id: number; words: string[] }[];
    const takeGroup = groups.find((g) => g.words.includes("take"));
    assert.deepEqual(takeGroup?.words, ["get", "grab", "take"]);
    assert.ok(res.message?.includes("get/grab/take"), res.message ?? "");
    assert.equal(res.details?.["compiled"], true);

    const filtered = executeAgentTool(session, "read_words", { prefix: "doo" });
    const filteredGroups = filtered.details?.["groups"] as { words: string[] }[];
    assert.deepEqual(
      filteredGroups.map((g) => g.words),
      [["door"]],
    );
  });

  it("a new authoring session includes an empty inventory for external interpreters", () => {
    const session = createAgentSessionState();
    assert.deepEqual(session.getFiles().get("OBJECT"), Uint8Array.of(65, 118, 150));
  });

  it("authors inventory objects and sets OBJECT file in session files", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_inventory_objects", {
      objects: [
        { name: "Magic Sword", startingRoom: 255 },
        { name: "Brass Key", startingRoom: 1 },
      ],
    });
    assert.equal(res.success, true);
    assert.ok(session.getFiles().has("OBJECT"));
    assert.equal(session.sources.objects?.length, 2);
  });

  it("write_inventory_objects rejects malformed calls instead of replacing the table", () => {
    const session = createAgentSessionState();
    assert.equal(
      executeAgentTool(session, "write_inventory_objects", {
        objects: [{ name: "Brass Key", startingRoom: 1 }],
      }).success,
      true,
    );
    const before = session.getFiles().get("OBJECT");
    for (const args of [
      {},
      { objects: "Brass Key" },
      { objects: [{ startingRoom: 1 }] },
      { objects: [{ name: "  ", startingRoom: 1 }] },
      { objects: [{ name: "Lamp", startingRoom: "2" }] },
      { objects: [null] },
      { objects: [{ name: "Lamp", startingRoom: 256 }] },
      { objects: [{ name: "Lamp", startingRoom: -1 }] },
      { objects: [{ name: "Lamp", startingRoom: 1, extra: true }] },
    ]) {
      const res = executeAgentTool(session, "write_inventory_objects", args);
      assert.equal(res.success, false, JSON.stringify(args));
      assert.match(res.error ?? "", /not changed|nothing was changed/);
    }
    assert.deepEqual(session.getFiles().get("OBJECT"), before);
    assert.equal(session.sources.objects?.length, 1);
    const nullRoom = executeAgentTool(session, "write_inventory_objects", {
      objects: [{ name: "Lamp", startingRoom: null }],
    });
    assert.equal(nullRoom.success, true);
    assert.deepEqual(session.sources.objects, [{ name: "Lamp", startingRoom: 0 }]);
  });

  it("write_sound rejects malformed tracks instead of storing a silent resource", () => {
    const session = createAgentSessionState();
    for (const args of [
      { num: 3 },
      { num: 3, tracks: "loud" },
      { num: 3, tracks: [{ notes: "C4" }] },
      { num: 3, tracks: [{ notes: [{ note: "C4", duration: "long" }] }] },
      { num: 3, tracks: [{ notes: [{ note: "C4", duration: 4, volume: 1 }] }] },
    ]) {
      const res = executeAgentTool(session, "write_sound", args);
      assert.equal(res.success, false, JSON.stringify(args));
      assert.match(res.error ?? "", /nothing was changed/);
    }
    assert.equal(session.container.getResource("sound", 3), null);
    assert.equal(session.sources.sounds.has(3), false);
  });

  it("inspect_world_bible summarizes rooms, objects, and vocabulary", () => {
    const session = createAgentSessionState();
    executeAgentTool(session, "write_words", { words: ["look", "take"] });
    executeAgentTool(session, "write_picture", { room: 1, source: "end\n" });
    executeAgentTool(session, "write_logic_source", { room: 1, source: "return;" });

    const res = executeAgentTool(session, "inspect_world_bible", {});
    assert.equal(res.success, true);
    assert.ok(res.details);
    assert.ok(Array.isArray(res.details["rooms"]));
    assert.ok((res.details["rooms"] as number[]).includes(1));
  });

  it("playtest_room rejects incomplete games instead of claiming a tested spawn", () => {
    const session = createAgentSessionState();
    executeAgentTool(session, "write_picture", {
      room: 1,
      source: "vis 1\nline 0,0 159,167\nend\n",
    });
    executeAgentTool(session, "write_logic_source", { room: 1, source: "return;" });

    const res = executeAgentTool(session, "playtest_room", { room: 1 });
    assert.equal(res.success, false);
    assert.ok(res.error);
  });

  it("authors authentic 4-channel sound tracks into container", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_sound", {
      num: 1,
      tracks: [
        {
          notes: [
            { duration: 10, freqDivisor: 200, attenuation: 0 },
            { duration: 20, freqDivisor: 250, attenuation: 2 },
          ],
        },
      ],
    });
    assert.equal(res.success, true);
    const soundData = session.container.getResource("sound", 1);
    assert.ok(soundData);
    assert.ok(soundData.length >= 8 + 2 * 5 + 2);
    // Header channel 0 offset should be 8
    assert.equal(soundData[0], 8);
    assert.equal(soundData[1], 0);
  });

  it("compiles MIDI notes and note names into AGI sound frequency divisors", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_sound", {
      num: 2,
      tracks: [
        {
          notes: [
            { note: "A4", duration: 30, attenuation: 0 }, // A440 -> divisor 226
            { note: "C4", duration: 30, attenuation: null }, // C4 (Middle C) -> divisor 380
            { note: "rest", duration: 15, attenuation: null }, // Rest -> silence
            { note: 72, duration: 60, attenuation: 1 }, // MIDI 72 = C5 -> divisor 190
          ],
        },
      ],
    });
    assert.equal(res.success, true);
    const soundData = session.container.getResource("sound", 2);
    assert.ok(soundData);
    const ch0Offset = soundData[0]! | (soundData[1]! << 8);
    assert.equal(ch0Offset, 8);

    // Note 1: A4 (divisor 226 = 0x00e2) -> tone low: (226>>4)&0x3f = 14, tone latch: 0x80|(226&0x0f) = 0x82
    // Duration: 30 (0x001e)
    assert.equal(soundData[8], 30);
    assert.equal(soundData[9], 0);
    assert.equal(soundData[10], (226 >> 4) & 0x3f);
    assert.equal(soundData[11], 0x82);
    assert.equal(soundData[12], 0x90); // channel 0, attenuation 0

    // Note 2: C4 (divisor 380 = 0x017c) -> tone low: (380>>4)&0x3f = 23, tone latch: 0x80|(380&0x0f) = 0x8c
    assert.equal(soundData[13], 30);
    assert.equal(soundData[14], 0);
    assert.equal(soundData[15], (380 >> 4) & 0x3f);
    assert.equal(soundData[16], 0x8c);
    assert.equal(soundData[17], 0x90);

    // Note 3: rest (silence) -> attenuation 0x9f
    assert.equal(soundData[18], 15);
    assert.equal(soundData[19], 0);
    assert.equal(soundData[22], 0x9f); // 0x90 | 15 (silence)
  });

  it("handles write_view when model supplies mirrorLoop: null alongside cels, or mirrored loop with cels: null", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_view", {
      num: 0,
      spec: {
        description: "Ego sprite",
        loops: [
          {
            mirrorLoop: null,
            cels: [
              {
                width: 2,
                height: 2,
                transparentColor: null,
                mirror: null,
                pixels: [1, 1, 1, 1],
              },
            ],
          },
          {
            mirrorLoop: 0,
            cels: null,
          },
        ],
      },
    });
    assert.equal(res.success, true);
    assert.ok(session.container.getResource("view", 0));
  });

  it("handles write_view when model supplies redundant mirrorLoop alongside non-empty cels on loop 0", () => {
    const session = createAgentSessionState();
    const res = executeAgentTool(session, "write_view", {
      num: 0,
      spec: {
        description: "Ego sprite redundant mirror",
        loops: [
          {
            mirrorLoop: 0,
            cels: [
              {
                width: 2,
                height: 2,
                transparentColor: 0,
                pixels: [1, 1, 1, 1],
              },
            ],
          },
        ],
      },
    });
    assert.equal(res.success, true);
    assert.ok(session.container.getResource("view", 0));
  });
});

describe("write_picture revision counter", () => {
  /** Smallest source that compiles and renders: one filled box. */
  const SOURCE = ["vis 1", "line 0,0 159,0 159,167 0,167 0,0", "fill 80,80", "end"].join("\n");

  /** Last line of the tool message, which is where the counter lives. */
  function lastLine(result: { message?: string | undefined }): string {
    const lines = (result.message ?? "").split("\n");
    return lines[lines.length - 1]!;
  }

  it("reports revisions without imposing an allowance", () => {
    const session = createAgentSessionState();

    // Remaining rounds permit correction; they do not require another pass.
    for (const round of [1, 2, 3]) {
      const res = executeAgentTool(session, "write_picture", { room: 1, source: SOURCE });
      assert.equal(res.success, true);
      assert.equal(
        lastLine(res),
        `Revision ${round}. Inspect the image; revise when it would improve the requested result.`,
      );
      assert.equal(res.details?.["round"], round);
    }
    // Revisions keep working beyond the former allowance.
    assert.equal(
      lastLine(executeAgentTool(session, "write_picture", { room: 1, source: SOURCE })),
      "Revision 4. Inspect the image; revise when it would improve the requested result.",
    );
    // Past the budget it stays terminal rather than going negative.
    assert.equal(
      lastLine(executeAgentTool(session, "write_picture", { room: 1, source: SOURCE })),
      "Revision 5. Inspect the image; revise when it would improve the requested result.",
    );
  });

  it("counts each picture number separately", () => {
    const session = createAgentSessionState();
    executeAgentTool(session, "write_picture", { room: 1, source: SOURCE });
    executeAgentTool(session, "write_picture", { room: 1, source: SOURCE });
    const other = executeAgentTool(session, "write_picture", { room: 7, source: SOURCE });
    assert.equal(
      lastLine(other),
      "Revision 1. Inspect the image; revise when it would improve the requested result.",
    );
    assert.equal(session.pictureRounds.get(1), 2);
    assert.equal(session.pictureRounds.get(7), 1);
  });

  it("does not count a source that failed to compile", () => {
    const session = createAgentSessionState();
    const bad = executeAgentTool(session, "write_picture", { room: 4, source: "vis notacolour" });
    assert.equal(bad.success, false);
    assert.equal(session.pictureRounds.has(4), false);
    assert.equal(
      lastLine(executeAgentTool(session, "write_picture", { room: 4, source: SOURCE })),
      "Revision 1. Inspect the image; revise when it would improve the requested result.",
    );
  });
});
