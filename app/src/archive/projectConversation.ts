import type { CachedGameData } from "../project/gameTypes.ts";

import { validateTranscript } from "../../../src/agent/transcript.ts";
export { validateTranscript } from "../../../src/agent/transcript.ts";

/** Provider changes retain a readable archive without replaying incompatible protocol items. */
export function continuationTranscript(
  data: Pick<CachedGameData, "provider" | "model" | "transcript">,
  provider: string,
  model?: string,
): unknown[] | undefined {
  if (!data.transcript?.length) return undefined;
  if (data.provider === provider && (!model || data.model === model))
    return validateTranscript(data.transcript, provider);
  const text = `Previous authoring conversation (reference material from an earlier model session; game resources are authoritative):\n${JSON.stringify(data.transcript, (key, value) => (key === "encrypted_content" || key === "signature" || key === "image_url" || key === "data" ? undefined : value))}`;
  return [{ role: "user", content: text }];
}
