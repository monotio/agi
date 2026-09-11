import { parseAdventureTemplate, type AdventureTemplate } from "../../src/template/template.ts";

// Import built-in pastiche templates as raw text at compile time
import knightsTrialRaw from "../../games/knights-trial/SKILL.md?raw";
import badgeOfMillhavenRaw from "../../games/badge-of-millhaven/SKILL.md?raw";
import mopJockeyRaw from "../../games/mop-jockey/SKILL.md?raw";
import polyesterNightsRaw from "../../games/polyester-nights/SKILL.md?raw";

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

export const BUILTIN_TEMPLATES: GameTemplate[] = Object.entries(BUILTIN_TEMPLATE_TEXTS).map(
  ([id, text]) => {
    try {
      const parsed: AdventureTemplate = parseAdventureTemplate(text);
      return {
        id,
        title: parsed.title,
        description: parsed.description,
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
