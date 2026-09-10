import { AGI_SYSTEM_PROMPT, createOrientationPrompt } from "../../src/agent/prompt.ts";

/**
 * The second opening: the
 * agent joins an installed original it did not author. The system prompt is
 * byte-identical to the genesis lane — only the first user turn differs, so
 * the cached prefix is shared across both openings.
 */
interface PromptMessage {
  role: "system" | "user";
  content: string;
}

/** Orientation lane variables; every field falls back when promptfoo omits it. */
export interface OrientationVars {
  vars: {
    game?: string;
    gameId?: string;
    profile?: string;
    room?: number | string;
    resourceListing?: string;
    logicSource?: string;
    pictureSource?: string;
    wordsSummary?: string;
  };
}

export default function ({ vars }: OrientationVars): PromptMessage[] {
  return [
    {
      role: "system",
      content: AGI_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: createOrientationPrompt({
        game: vars.game || vars.gameId || "unknown",
        profile: vars.profile || "2.936",
        room: Number(vars.room ?? 1),
        resourceListing: vars.resourceListing || "",
        logicSource: vars.logicSource || "",
        pictureSource: vars.pictureSource || "",
        wordsSummary: vars.wordsSummary || "",
      }),
    },
  ];
}
