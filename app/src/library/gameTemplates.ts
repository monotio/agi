import { parseAdventureTemplate, type AdventureTemplate } from "../../../src/template/template.ts";

// Import built-in pastiche templates as raw text at compile time
import knightsTrialRaw from "../../../games/knights-trial/SKILL.md?raw";
import badgeOfMillhavenRaw from "../../../games/badge-of-millhaven/SKILL.md?raw";
import mopJockeyRaw from "../../../games/mop-jockey/SKILL.md?raw";
import polyesterNightsRaw from "../../../games/polyester-nights/SKILL.md?raw";

export interface GameTemplate {
  id: string;
  title: string;
  description: string;
  rawMarkdown: string;
}

const BUILTIN_TEMPLATE_TEXTS: Record<string, string> = {
  "knights-trial": knightsTrialRaw,
  "badge-of-millhaven": badgeOfMillhavenRaw,
  "mop-jockey": mopJockeyRaw,
  "polyester-nights": polyesterNightsRaw,
};

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  "knights-trial":
    "A squire errant must recover three impossible treasures before the last candle burns out.",
  // Adventure story synopsis: the weapon's reliability is part of the premise.
  "badge-of-millhaven":
    // ast-grep-ignore: plain-copy-literal
    "A rookie patrol officer learns that procedure is the only weapon that never jams.",
  "mop-jockey": "Sanitation technician Pip Scrubb meets the universe's least competent invasion.",
  "polyester-nights": "Dale Dorsey, one good suit and no good plans, steps into Neon Gulch.",
};

export const BUILTIN_TEMPLATES: GameTemplate[] = Object.entries(BUILTIN_TEMPLATE_TEXTS).map(
  ([id, text]) => {
    try {
      const parsed: AdventureTemplate = parseAdventureTemplate(text);
      return {
        id,
        title: parsed.title,
        description: TEMPLATE_DESCRIPTIONS[id] ?? parsed.description,
        rawMarkdown: text,
      };
    } catch {
      return {
        id,
        title: id,
        description: "Adventure template",
        rawMarkdown: text,
      };
    }
  },
);

export function parseCustomTemplate(rawMarkdown: string): GameTemplate {
  const parsed = parseAdventureTemplate(rawMarkdown);
  const id = parsed.id || "custom-adventure";
  return {
    id,
    title: parsed.title || "Custom Adventure",
    description: parsed.description || "A user-authored adventure template",
    rawMarkdown,
  };
}

/** Show the complete custom outline before the same markdown enters Genesis. */
export function completeAdventureOutline(source: string, title: string): string {
  try {
    parseAdventureTemplate(source);
    return source;
  } catch {
    return `---\nname: custom\n---\n# ${title}\n\n## Premise\n${source}`;
  }
}
