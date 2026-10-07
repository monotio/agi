/** Lightweight bindings codec shared by readers, labels and project compilation. */
import { validateAuthoringState, type AuthoringState } from "./authoringState.ts";

export function readBindingsDocument(text: string): AuthoringState["bindings"] {
  try {
    return validateAuthoringState({
      version: 1,
      bindings: JSON.parse(text) as unknown,
      world: { rooms: {}, facts: {}, quests: {} },
    }).bindings;
  } catch (error) {
    throw new Error(
      `Invalid project document bindings: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
