import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGI_SYSTEM_PROMPT,
  createGenesisPrompt,
  createOrientationPrompt,
} from "../src/agent/prompt.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { PICTURE_SOURCE_DOC } from "../src/picture/source.ts";
import { AGENT_TOOLS } from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

describe("agent system prompt", () => {
  it("loads opcode details on demand instead of embedding a catalog", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes("read_command_reference"));
    assert.ok(!AGI_SYSTEM_PROMPT.includes("Complete command catalog"));
  });

  it("demonstrates a picture operand using an initialized variable", () => {
    const example = AGI_SYSTEM_PROMPT.match(/For picture 1, use `([^`]+)`/)?.[1];
    assert.ok(example, "Include a compact example of the variable operand contract.");
    assert.deepEqual(
      [...assembleLogic(example, { dictionary: new Map() }).code],
      [3, 40, 1, 24, 40, 25, 40, 26],
      "assignn(v40,1), load.pic(v40), draw.pic(v40), show.pic()",
    );
  });

  /**
   * Declare once (see the prompt.ts header): per-tool facts live in the tool
   * description, the prompt carries only cross-tool workflow. The catalog is
   * still static, so the cached prefix never changes shape.
   */
  it("does not restate the tool catalog as name-and-description lines", () => {
    for (const tool of AGENT_TOOLS) {
      const enumerated = new RegExp(`^[-*\\s]*\`?${tool.name}\`?[^\\n]*:`, "m");
      assert.ok(
        !enumerated.test(AGI_SYSTEM_PROMPT),
        `system prompt must not carry a '${tool.name}: ...' description line; that fact belongs in the tool's description`,
      );
    }
  });

  it("explains every required parameter in the tool's own description", () => {
    for (const tool of AGENT_TOOLS) {
      assert.ok(tool.description.trim(), `${tool.name}: missing tool description`);
      for (const param of tool.parameters.required) {
        // A bare or backticked mention in the description, or a per-property
        // description string, explains the parameter; length is no proxy.
        const property = tool.parameters.properties[param] as { description?: unknown } | undefined;
        assert.ok(
          new RegExp(`\\b${param}\\b`).test(tool.description) ||
            typeof property?.description === "string",
          `${tool.name}: description does not explain its '${param}' parameter`,
        );
      }
    }
  });

  it("publishes the layout and actor comment grammars write_picture checks", () => {
    const tool = AGENT_TOOLS.find((candidate) => candidate.name === "write_picture")!;
    assert.match(tool.description, /# layout: <name> x<a>-<b> y<c>-<d> colou?r <n>/);
    assert.match(
      tool.description,
      /# actor: <name> x<X> y<baseline> width<W> height<H> priority<P>/,
    );
  });

  it("keeps the cross-tool workflow rules the picture eval proved", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes("Working with the tools"), "workflow section");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Register vocabulary before writing a said() handler"),
      "vocabulary before said()",
    );
    assert.ok(AGI_SYSTEM_PROMPT.includes("Call finish when the work is done"), "finish invariant");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes(
        "When patching a player-supplied game, preserve its existing content",
      ),
      "local patches preserve player content",
    );
    assert.ok(AGI_SYSTEM_PROMPT.includes("read before you patch"), "read before patch invariant");
  });

  it("keeps instructions direct and concise", () => {
    for (const banned of [
      "double-check",
      "double check",
      "make sure",
      "be careful",
      "be sure to",
    ]) {
      assert.ok(
        !AGI_SYSTEM_PROMPT.toLowerCase().includes(banned),
        `system prompt must not say '${banned}'`,
      );
    }
  });

  it("includes the engine's screen, palette and corrected priority bands", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes("Sierra AGI"), "mentions Sierra AGI");
    assert.ok(AGI_SYSTEM_PROMPT.includes("160 wide by 168 tall"), "states the surface size");
    assert.ok(AGI_SYSTEM_PROMPT.includes("x 0..159, y 0..167"), "states the coordinate ranges");
    assert.ok(AGI_SYSTEM_PROMPT.includes("EGA"), "mentions EGA");
    assert.ok(AGI_SYSTEM_PROMPT.includes("Wall 0"), "priority 0");
    assert.ok(AGI_SYSTEM_PROMPT.includes("Gate 1"), "priority 1");
    assert.ok(AGI_SYSTEM_PROMPT.includes("Trigger 2"), "priority 2");
    assert.ok(AGI_SYSTEM_PROMPT.includes("Water 3"), "priority 3");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Default actor depth is 4 at feet rows 0..47"),
      "priority 4..15 depth bands",
    );
  });

  it("carries the logic grammar including the assembler's escapes and the absent-message form", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes('#message <id> "<text>"'), "message directive");
    assert.ok(AGI_SYSTEM_PROMPT.includes("declares that slot ABSENT"), "absent message form");
    assert.ok(AGI_SYSTEM_PROMPT.includes("\\xNN"), "hex escape");
    assert.ok(AGI_SYSTEM_PROMPT.includes("said("), "said() operator");
  });

  it("embeds the picture source documentation verbatim and the picture quality bar", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes(PICTURE_SOURCE_DOC), "PICTURE_SOURCE_DOC verbatim");
    assert.ok(AGI_SYSTEM_PROMPT.includes("LOOK AT THE RETURNED IMAGE"), "look at the render");
    assert.ok(AGI_SYSTEM_PROMPT.includes("stop when the requested result is achieved"));
    assert.ok(!AGI_SYSTEM_PROMPT.includes("revise at least once"));
    assert.ok(!AGI_SYSTEM_PROMPT.includes("Use all the rounds"));
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Use fill coverage to diagnose enclosed regions"),
      "coverage is diagnostic, not an art constraint",
    );
    assert.ok(!AGI_SYSTEM_PROMPT.includes("hundreds of commands"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Enclose every region"), "enclose then fill");
    assert.ok(AGI_SYSTEM_PROMPT.includes("far to near"), "far-to-near ordering");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("A Depth fill floods the connected depth-4 region"),
      "priority band recipe warns about flooding",
    );
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Paint depth 4 across open walking floor"),
      "open floor is not sliced into artificial priority bands",
    );
    assert.ok(
      !AGI_SYSTEM_PROMPT.includes("Bands must cover every walkable pixel"),
      "removes the harmful full-floor priority-band recipe",
    );
    assert.ok(AGI_SYSTEM_PROMPT.includes("Use texture as a sparse accent"), "stipple is capped");
  });

  it("couples scene scale, hybrid detail, visible boundaries and composed playtests", () => {
    for (const contract of [
      "same baseline",
      "composed frame",
      "visible obstacle",
      "add.to.pic",
      "draw.pic resets",
      "Control/margin 4",
      "Actor collisions require animated actors",
      "wall contact",
      "walking behind",
    ]) {
      assert.ok(AGI_SYSTEM_PROMPT.includes(contract), `missing scene contract '${contract}'`);
    }
  });

  it("requires triptych inspection and bounded runtime evidence", () => {
    for (const contract of [
      "clean visual",
      "raw EGA priority/control",
      "semantic overlay",
      "numeric probes",
      "real hero",
      "drafting aids",
      "compiled outputs",
      "bounded speedrun",
      "Add tests for the other routes a player can take",
    ]) {
      assert.ok(AGI_SYSTEM_PROMPT.includes(contract), `missing inspection contract '${contract}'`);
    }
  });

  it("requires native-resolution simplification and readable interactive objects", () => {
    for (const contract of [
      "broad enclosed fills",
      "Use texture as a sparse accent",
      "quiet contrast",
      "identify each interactive object",
    ]) {
      assert.ok(AGI_SYSTEM_PROMPT.includes(contract), `missing readability contract '${contract}'`);
    }
  });

  it("uses VIEW screen objects for interactive state and PICTUREs for painted scenery", () => {
    for (const contract of [
      "player manipulates, picks up or sees animate",
      "VIEW-backed actor",
      "architecture, terrain, backdrops and broad static fills",
      "commit state when the action commits",
      "room re-entry",
      "static baked detail",
      "things that change, can be picked up or move",
      "recognizable silhouettes",
    ]) {
      assert.ok(
        AGI_SYSTEM_PROMPT.includes(contract),
        `missing VIEW/PICTURE contract '${contract}'`,
      );
    }
    assert.ok(
      !AGI_SYSTEM_PROMPT.includes("maximum number of sprite colours"),
      "sprite economy must not impose an arbitrary hard colour maximum",
    );
    assert.ok(
      !AGI_SYSTEM_PROMPT.includes("set a lasting state flag when it completes"),
      "persistent state timing depends on the interaction contract, not loop completion",
    );
  });

  it("requires an evidence loop for sparse environmental motion", () => {
    for (const contract of [
      "clean visual",
      "priority/control panel",
      "composed frame",
      "intermediate animation contact sheet",
      "captureTicks",
      "persistent interaction and room re-entry states",
      "Revise a concrete defect",
    ]) {
      assert.ok(
        AGI_SYSTEM_PROMPT.includes(contract),
        `missing evidence-loop contract '${contract}'`,
      );
    }
  });

  it("keeps prose concrete and humor restrained", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes("Write direct, concrete messages"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("name visible items, actions and immediate outcomes"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Keep narration inside the game world"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("variable 3 (v3)"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("humor grow from the situation"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Keep routine responses short"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Let character voices fit the setting"));
  });

  it("keeps individual game briefs and phase framing outside the shared system prompt", () => {
    const brief = "A clockmaker searches for a silver pendulum.";
    assert.ok(createGenesisPrompt(brief, createStarterProject("boilerplate")).includes(brief));
    for (const banned of [brief, "GENESIS PHASE", "Genesis Workflow"]) {
      assert.ok(!AGI_SYSTEM_PROMPT.includes(banned), `system prompt must not mention '${banned}'`);
    }
  });
});

describe("first-turn prompts", () => {
  it("creates a genesis prompt carrying the instructions and the adventure template", () => {
    const userPrompt = createGenesisPrompt(
      "# The Lost Kingdom\nA test adventure.",
      createStarterProject("boilerplate"),
    );
    assert.ok(userPrompt.includes("# The Lost Kingdom"), "includes template title");
    assert.ok(userPrompt.includes("GENESIS"), "includes genesis instruction");
    assert.ok(userPrompt.includes("finish"), "names the closing tool");
    assert.match(userPrompt, /author the opening room/i, "enforces single-room genesis boundary");
    assert.ok(userPrompt.includes("update_plan"), "mandates world storage for roadmap");
    assert.ok(
      userPrompt.includes("visible items and immediate outcomes"),
      "mandates name visible items, actions and immediate outcomes",
    );
  });

  it("describes the installed Boilerplate seed's inventory instead of an absent room", () => {
    const seed = createStarterProject("boilerplate");
    const prompt = createGenesisPrompt("# Night Train\nA sleeper car mystery.", seed);
    assert.ok(prompt.includes(seed.seed.templateId), "names the seed's template identity");
    assert.ok(prompt.includes(seed.profileId), "names the seed's profile");
    assert.match(prompt, /VIEWS is empty/);
    assert.match(prompt, /WORDS.TOK knows 0 words/);
    assert.match(prompt, /Your game starts here/);
    assert.doesNotMatch(prompt, /boots, walks/);
    for (const name of ["boot_logic", "first_room", "first_pic", "death_logic", "death_sound"])
      assert.ok(prompt.includes(name), `names the '${name}' binding`);
    assert.ok(
      !/no room exists|does not yet exist|nothing is authored/i.test(prompt),
      "must not describe the session as empty",
    );
  });

  it("creates an orientation prompt for an installed original without genesis framing", () => {
    const prompt = createOrientationPrompt({
      game: "kq1",
      profile: "2.917",
      room: 1,
      sceneBrief:
        'Staged set 42-abcd1234: logic [0-1] (next free 2); dictionary 3 words; bindings none\nRoom 1: logic revision "10-1", picture revision "5-2"\nLive: room 1, ego (80,120); objects o0=view0@(80,120); controls F1=Help',
    });
    assert.ok(prompt.includes("ORIENTATION"), "orientation header");
    assert.ok(prompt.includes("kq1"), "game id");
    assert.ok(prompt.includes("2.917"), "interpreter profile");
    assert.ok(prompt.includes("next free 2"), "scene brief index");
    assert.ok(prompt.includes("F1=Help"), "scene brief controls");
    assert.ok(prompt.includes("read_room"), "points at the deep read");
    assert.ok(!prompt.includes("GENESIS"), "no genesis framing for an installed original");
    assert.ok(!prompt.includes("finish_genesis"), "installed originals do not finish genesis");
    assert.ok(
      prompt.includes("read_command_reference"),
      "points to the on-demand command reference",
    );
    assert.ok(!prompt.includes("Complete command catalog"), "does not repeat the opcode catalog");
  });
});
