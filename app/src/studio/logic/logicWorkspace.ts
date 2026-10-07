/**
 * The workspace's document labels and the clearly-derived disassembly
 * preview for a bytes-only LOGIC. Nothing here mutates a draft — these are
 * pure reads over the editable project.
 */
import { disassembleLogic } from "../../../../src/logic/disassembler.ts";
import { PROFILES, type ProfileId } from "../../../../src/runtime/profile.ts";

const RESOURCE_KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;
const RESOURCE_LABELS = { logic: "LOGIC", picture: "PIC", view: "VIEW", sound: "SND" } as const;
const AUXILIARY_LABELS: Record<string, string> = {
  words: "WORDS.TOK",
  inventory: "OBJECT",
  bindings: "Bindings",
  world: "World",
  tests: "Tests",
  references: "References",
};

/** What the explorer and tab call one document. */
export function documentLabel(key: string): string {
  const resource = RESOURCE_KEY.exec(key);
  if (resource)
    return `${RESOURCE_LABELS[resource[1] as keyof typeof RESOURCE_LABELS]} ${resource[2]}`;
  return AUXILIARY_LABELS[key] ?? key;
}

/**
 * A derived reading of retained LOGIC bytes for orientation only: the
 * disassembly is a preview the host marks as derived; it is never installed
 * as the document's authored source.
 */
export function derivedLogicSource(
  payload: Uint8Array,
  profileId: ProfileId,
  words: readonly (readonly [string, number])[],
): { readonly source: string } {
  try {
    return {
      source: disassembleLogic(payload, {
        profile: PROFILES[profileId],
        dictionary: new Map(words),
      }),
    };
  } catch (error) {
    return {
      source: `// The logic does not disassemble: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
