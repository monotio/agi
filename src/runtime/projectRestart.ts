/** Prepare a complete cold boot without changing the previous Engine or running game LOGIC. */
import { Engine, type EngineHost } from "./engine.ts";
import { detectProfileDecision, type AgiProfile } from "./profile.ts";
import {
  canonicalizeCandidateFiles,
  openStagedContainer,
  stageDictionary,
  type PreviewUpdateCandidate,
} from "./previewAdmission.ts";
import { validateCompleteImage } from "./projectImageValidation.ts";

export function prepareProjectRestart(
  candidate: PreviewUpdateCandidate,
  host: EngineHost,
  fallbackProfile: AgiProfile,
): Engine {
  const files = canonicalizeCandidateFiles(candidate.files);
  const profile = detectProfileDecision(files, candidate.profile ?? fallbackProfile).profile;
  const container = openStagedContainer(files, profile);
  validateCompleteImage(container, profile, host.soundDevice?.() ?? 1);
  if (container.getResource("logic", 0) === null)
    throw new Error("The game needs LOGIC 0 to start.");
  const words = files.get("WORDS.TOK");
  return new Engine(container, host, words === undefined ? new Map() : stageDictionary(words), {
    profile,
  });
}
