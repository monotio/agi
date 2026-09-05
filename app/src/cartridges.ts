import { parseCartridge, type Cartridge } from "../../src/cartridge/cartridge.ts";

// Import built-in pastiche cartridges as raw text at compile time
import knightsTrialRaw from "../../games/knights-trial/SKILL.md?raw";
import badgeOfMillhavenRaw from "../../games/badge-of-millhaven/SKILL.md?raw";
import mopJockeyRaw from "../../games/mop-jockey/SKILL.md?raw";
import polyesterNightsRaw from "../../games/polyester-nights/SKILL.md?raw";

export interface CartridgeMetadata {
  slug: string;
  title: string;
  description: string;
  rawMarkdown: string;
}

const BUILTIN_CARTRIDGE_TEXTS: Record<string, string> = {
  "knights-trial": knightsTrialRaw,
  "badge-of-millhaven": badgeOfMillhavenRaw,
  "mop-jockey": mopJockeyRaw,
  "polyester-nights": polyesterNightsRaw,
};

export const BUILTIN_CARTRIDGES: CartridgeMetadata[] = Object.entries(BUILTIN_CARTRIDGE_TEXTS).map(
  ([slug, text]) => {
    try {
      const parsed: Cartridge = parseCartridge(text);
      return {
        slug,
        title: parsed.title,
        description: parsed.description,
        rawMarkdown: text,
      };
    } catch {
      return {
        slug,
        title: slug,
        description: "Cartridge specification",
        rawMarkdown: text,
      };
    }
  },
);

export function parseCustomCartridge(rawMarkdown: string): CartridgeMetadata {
  const parsed = parseCartridge(rawMarkdown);
  return {
    slug: parsed.slug || "custom-adventure",
    title: parsed.title || "Custom Adventure",
    description: parsed.description || "A user-authored adventure cartridge",
    rawMarkdown,
  };
}
