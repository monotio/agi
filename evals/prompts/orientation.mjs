import { AGI_SYSTEM_PROMPT, createOrientationPrompt } from "../../src/agent/prompt.ts";

/**
 * The second opening: the
 * agent joins an installed original it did not author. The system prompt is
 * byte-identical to the genesis lane — only the first user turn differs, so
 * the cached prefix is shared across both openings.
 */
export default function ({ vars }) {
  return [
    {
      role: "system",
      content: AGI_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: createOrientationPrompt({
        gameId: vars.gameId || "unknown",
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
