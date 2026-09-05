import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGI_SYSTEM_PROMPT,
  createGenesisPrompt,
  createOrientationPrompt,
} from "../src/agent/prompt.ts";
import { PICTURE_SOURCE_DOC } from "../src/picture/source.ts";
import { AGENT_TOOLS } from "../src/agent/tools.ts";

describe("agent system prompt", () => {
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

  it("gives every tool a description detailed enough to stand alone", () => {
    for (const tool of AGENT_TOOLS) {
      // Useful descriptions explain behavior; sentence counts reward padding.
      assert.ok(
        tool.description.length >= 150,
        `${tool.name}: missing standalone behavior description`,
      );
      for (const param of tool.parameters.required) {
        assert.ok(
          tool.description.includes(param) ||
            JSON.stringify(tool.parameters.properties[param]).includes("description"),
          `${tool.name}: description does not explain its '${param}' parameter`,
        );
      }
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
    assert.ok(AGI_SYSTEM_PROMPT.includes("Texture is an accent"), "stipple is capped");
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
  });
});
