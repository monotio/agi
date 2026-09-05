/**
 * Promptfoo Evaluation Lane: Genesis Cartridge Authoring.
 *
 * Compares OpenAI GPT-5.6 Sol/Terra and Claude Opus-5 / Fable-5 models on authoring
 * foundational game resources directly from authentic pastiche cartridge specifications.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerMatrix } from "./providers.mjs";

function loadCartridge(slug) {
  return readFileSync(resolve(`games/${slug}/SKILL.md`), "utf-8");
}

export default {
  description: "agi-genesis: authentic resource compilation across frontier models",
  prompts: [{ id: "file://../prompts/genesis.mjs", label: "genesis" }],
  providers: providerMatrix({
    effort: "medium",
  }),
  defaultTest: {
    assert: [
      {
        type: "javascript",
        value: "file://../lib/asserts.mjs:validateGenesisToolCalls",
      },
    ],
  },
  tests: [
    {
      description: "Genesis - Knights Trial (KQ pastiche)",
      vars: {
        cartridgeSlug: "knights-trial",
        cartridgeText: loadCartridge("knights-trial"),
      },
    },
    {
      description: "Genesis - Badge of Millhaven (PQ pastiche)",
      vars: {
        cartridgeSlug: "badge-of-millhaven",
        cartridgeText: loadCartridge("badge-of-millhaven"),
      },
    },
    {
      description: "Genesis - Mop Jockey (SQ pastiche)",
      vars: {
        cartridgeSlug: "mop-jockey",
        cartridgeText: loadCartridge("mop-jockey"),
      },
    },
    {
      description: "Genesis - Polyester Nights (LSL pastiche)",
      vars: {
        cartridgeSlug: "polyester-nights",
        cartridgeText: loadCartridge("polyester-nights"),
      },
    },
  ],
};
