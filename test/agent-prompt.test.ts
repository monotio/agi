import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGI_SYSTEM_PROMPT,
  createGenesisPrompt,
  createOrientationPrompt,
} from "../src/agent/prompt.ts";
import { PICTURE_SOURCE_DOC } from "../src/picture/source.ts";
import { AGENT_TOOLS } from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

describe("agent system prompt", () => {
  it("fits the lean frontier-model startup budget", () => {
    assert.ok(
      AGI_SYSTEM_PROMPT.length <= 10_000,
      `system prompt is ${AGI_SYSTEM_PROMPT.length} characters; expected at most 10000`,
    );
  });

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

  it("keeps behavior with each tool instead of the system prompt", () => {
    for (const tool of AGENT_TOOLS) {
      assert.ok(tool.description.trim(), `${tool.name}: missing tool description`);
    }
  });

  it("keeps the cross-tool workflow rules the picture eval proved", () => {
    assert.ok(AGI_SYSTEM_PROMPT.includes("Working with the tools"), "workflow section");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Register vocabulary before writing a said() handler"),
      "vocabulary before said()",
    );
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("NEVER call finish_genesis in a game that is already running"),
      "genesis gate invariant",
    );
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
    assert.ok(AGI_SYSTEM_PROMPT.includes("0 = unconditional barrier"), "priority 0");
    assert.ok(AGI_SYSTEM_PROMPT.includes("1 = conditional barrier"), "priority 1");
    assert.ok(AGI_SYSTEM_PROMPT.includes("2 = trigger"), "priority 2");
    assert.ok(AGI_SYSTEM_PROMPT.includes("3 = water"), "priority 3");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Default sprite priority is 4 at baseline rows 0..47"),
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
    assert.ok(AGI_SYSTEM_PROMPT.includes("Stop when the requested result is achieved"));
    assert.ok(!AGI_SYSTEM_PROMPT.includes("revise at least once"));
    assert.ok(!AGI_SYSTEM_PROMPT.includes("Use all the rounds"));
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("not as a quota"),
      "coverage is diagnostic, not an art constraint",
    );
    assert.ok(!AGI_SYSTEM_PROMPT.includes("hundreds of commands"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Enclose every region"), "enclose then fill");
    assert.ok(AGI_SYSTEM_PROMPT.includes("far to near"), "far-to-near ordering");
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("A priority fill floods the whole connected pri-4 region"),
      "priority band recipe warns about flooding",
    );
    assert.ok(
      AGI_SYSTEM_PROMPT.includes("Do not paint horizontal priority bands across open floor"),
      "open floor is not sliced into artificial priority bands",
    );
    assert.ok(
      !AGI_SYSTEM_PROMPT.includes("Bands must cover every walkable pixel"),
      "removes the harmful full-floor priority-band recipe",
    );
    assert.ok(AGI_SYSTEM_PROMPT.includes("Texture is an accent"), "stipple is capped");
  });

  it("couples scene scale, hybrid detail, visible boundaries and composed playtests", () => {
    for (const contract of [
      "same baseline",
      "composed frame",
      "visible obstacle",
      "add.to.pic",
      "draw.pic resets",
      "control/margin 4",
      "object-object collision",
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
      "real ego",
      "drafting aids",
      "compiled outputs",
      "bounded speedrun",
      "not a full solver guarantee",
    ]) {
      assert.ok(AGI_SYSTEM_PROMPT.includes(contract), `missing inspection contract '${contract}'`);
    }
  });

  it("requires native-resolution simplification and readable interactive objects", () => {
    for (const contract of [
      "broad enclosed fills",
      "avoid isolated speckles",
      "quiet contrast",
      "identify each interactive object",
    ]) {
      assert.ok(AGI_SYSTEM_PROMPT.includes(contract), `missing readability contract '${contract}'`);
    }
  });

  it("uses VIEW screen objects for interactive state and PICTUREs for painted scenery", () => {
    for (const contract of [
      "player manipulates, picks up or sees animate",
      "VIEW-backed screen object",
      "architecture, terrain, backdrops and broad static fills",
      "commit state when the action commits",
      "room re-entry",
      "static baked detail",
      "changing prop, pickup or actor",
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
    assert.ok(AGI_SYSTEM_PROMPT.includes("Direct second-person narration"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Humor is occasional"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("situation-specific"));
    assert.ok(AGI_SYSTEM_PROMPT.includes("Do not force a joke"));
  });

  it("keeps individual game briefs and phase framing outside the shared system prompt", () => {
    const brief = "A clockmaker searches for a silver pendulum.";
    assert.ok(createGenesisPrompt(brief).includes(brief));
    for (const banned of [brief, "GENESIS PHASE", "Genesis Workflow"]) {
      assert.ok(!AGI_SYSTEM_PROMPT.includes(banned), `system prompt must not mention '${banned}'`);
    }
  });
});

describe("first-turn prompts", () => {
  it("creates a genesis prompt carrying the instructions and the cartridge", () => {
    const userPrompt = createGenesisPrompt("# The Lost Kingdom\nA test adventure.");
    assert.ok(userPrompt.includes("# The Lost Kingdom"), "includes cartridge title");
    assert.ok(userPrompt.includes("GENESIS"), "includes genesis instruction");
    assert.ok(userPrompt.includes("finish_genesis"), "names the closing tool");
  });

  it("creates an orientation prompt for an installed original without genesis framing", () => {
    const prompt = createOrientationPrompt({
      gameId: "kq1",
      profile: "2.917",
      room: 1,
      resourceListing: "logic: 2 present [0-1]; next free: 2",
      logicSource: "return;",
      pictureSource: "vis 1\nend",
      wordsSummary: "Dictionary: 3 words in 2 synonym group(s).",
    });
    assert.ok(prompt.includes("ORIENTATION"), "orientation header");
    assert.ok(prompt.includes("kq1"), "game id");
    assert.ok(prompt.includes("2.917"), "interpreter profile");
    assert.ok(prompt.includes("next free: 2"), "resource listing");
    assert.ok(prompt.includes("vis 1"), "picture source");
    assert.ok(prompt.includes("Dictionary: 3 words"), "words summary");
    assert.ok(!prompt.includes("GENESIS"), "no genesis framing for an installed original");
    assert.ok(!prompt.includes("finish_genesis"), "installed originals never finish genesis");
    assert.ok(
      prompt.includes("read_command_reference"),
      "points to the on-demand command reference",
    );
    assert.ok(!prompt.includes("Complete command catalog"), "does not repeat the opcode catalog");
    assert.ok(prompt.length < 1_000, `orientation boilerplate is ${prompt.length} characters`);
  });
});
