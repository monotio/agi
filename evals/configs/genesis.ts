/**
 * Promptfoo Evaluation Lane: Genesis Adventure Authoring.
 *
 * Compares OpenAI GPT-5.6 Sol/Terra and Claude Opus-5 / Fable-5 models on authoring
 * foundational game resources directly from authentic pastiche adventure specifications.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerMatrix } from "./providers.ts";

function loadTemplate(id: string) {
  return readFileSync(resolve(import.meta.dirname, `../../games/${id}/SKILL.md`), "utf-8");
}

export default {
  description: "agi-genesis: authentic resource compilation across frontier models",
  prompts: [{ id: "file://../prompts/genesis.ts", label: "genesis" }],
  providers: providerMatrix({
    effort: "medium",
  }),
  defaultTest: {
    assert: [
      {
        type: "javascript",
        value: "file://../lib/asserts.ts:validateGenesisToolCalls",
      },
    ],
  },
  tests: [
    {
      description: "Genesis - Knights Trial (KQ pastiche)",
      vars: {
        templateId: "knights-trial",
        templateText: loadTemplate("knights-trial"),
      },
    },
    {
      description: "Genesis - Badge of Millhaven (PQ pastiche)",
      vars: {
        templateId: "badge-of-millhaven",
        templateText: loadTemplate("badge-of-millhaven"),
      },
    },
    {
      description: "Genesis - Mop Jockey (SQ pastiche)",
      vars: {
        templateId: "mop-jockey",
        templateText: loadTemplate("mop-jockey"),
      },
    },
    {
      description: "Genesis - Polyester Nights (LSL pastiche)",
      vars: {
        templateId: "polyester-nights",
        templateText: loadTemplate("polyester-nights"),
      },
    },
  ],
};
