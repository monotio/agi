/** Detached native inspection; this surface issues no edit or admission authority. */
import { createAgentSessionState } from "./agentState.ts";
import { ASK_TOOLS, executeAgentToolAsync, type AgentToolDeps } from "./tools.ts";
import { openContainer } from "../container/container.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import { readBindingsDocument } from "../authoring/projectDocuments.ts";
import { validateAuthoringState } from "../authoring/authoringState.ts";
import { computeResourceRevision } from "../authoring/resourceRevision.ts";
import { parseWordsTok } from "../logic/words.ts";
import type { ProjectContent } from "../authoring/projectContent.ts";
import type { AgentCandidateDiagnostic } from "../authoring/projectAgentCandidate.ts";

export function createProjectInspection(input: {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  /** Metadata belonging to this native image, independently of the current draft. */
  readonly documents: Readonly<Record<string, ProjectContent>>;
  readonly origin?: "admitted" | "live";
}) {
  const profile = PROFILES[input.profileId];
  if (!profile) throw new Error(`Unknown AGI profile: ${input.profileId}`);
  const files = Object.fromEntries(
    Object.entries(input.files).map(([key, bytes]) => [key, new Uint8Array(bytes)]),
  );
  const container = openContainer(new Map(Object.entries(files)), { profile });
  // Decode optional vocabulary independently. A damaged dictionary
  // must not prevent another resource from being inspected.
  const dictionary = container.files.get("WORDS.TOK");
  const revision = computeResourceRevision(files);
  const diagnostics: AgentCandidateDiagnostic[] = [];
  let dictionaryError: string | undefined;
  const words = new Map<string, number>();
  if (dictionary) {
    try {
      for (const { word, id } of parseWordsTok(dictionary)) words.set(word, id);
    } catch (cause) {
      dictionaryError = `WORDS.TOK: ${cause instanceof Error ? cause.message : String(cause)}`;
      diagnostics.push({ key: "words", severity: "warning", message: dictionaryError });
    }
  }
  const state = createAgentSessionState(container, profile, words);
  state.genesisComplete = true;
  const bindings = input.documents["bindings"];
  const tests = input.documents["tests"];
  const testsFromDocuments = tests !== undefined;
  if (testsFromDocuments)
    state.testsPayload =
      typeof tests === "string" ? new TextEncoder().encode(tests) : new Uint8Array(tests);
  try {
    state.authoring = validateAuthoringState({
      version: 1,
      bindings: readBindingsDocument(typeof bindings === "string" ? bindings : "{}"),
      world: state.authoring.world,
    });
  } catch (cause) {
    diagnostics.push({ key: null, severity: "warning", message: String(cause) });
  }
  return {
    diagnostics,
    async execute(name: string, args: Record<string, unknown>, deps: AgentToolDeps) {
      if (!ASK_TOOLS.includes(name))
        return { success: false, error: "This tool is unavailable during inspection." };
      if (name === "read_words" && dictionaryError)
        return { success: false, error: dictionaryError };
      try {
        const result = await executeAgentToolAsync(state, name, args, { ...deps, readOnly: true });
        const origin = result.details?.["origin"] as Record<string, unknown> | undefined;
        if (!origin) return result;
        return {
          ...result,
          details: {
            ...result.details,
            ...(testsFromDocuments && (name === "read_game_tests" || name === "run_game_tests")
              ? { testDefinitionsOrigin: "admitted" }
              : {}),
            ...(dictionaryError ? { dictionaryError } : {}),
            origin: {
              ...origin,
              kind:
                origin["kind"] === "staged"
                  ? testsFromDocuments && name === "read_game_tests"
                    ? "admitted"
                    : (input.origin ?? "admitted")
                  : origin["kind"],
              resourceRevision: revision,
              profileId: profile.id,
            },
          },
        };
      } catch (cause) {
        return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}
