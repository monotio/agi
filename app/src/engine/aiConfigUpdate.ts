import type { LlmConfig } from "../agent/llmClient.ts";
import type { useAuthoringController } from "../authoring/useAuthoringController.ts";
import type { BootedGame } from "../project/gameTypes.ts";
import type { ProjectSession } from "../project/projectSession.ts";

type AiConfigController = Pick<ReturnType<typeof useAuthoringController>, "updateAiConfig">;

export interface AiConfigUpdateOwner {
  readonly game: BootedGame | null;
  readonly worker: Worker | null;
  readonly mode: "play" | "create";
  readonly modeGeneration: number;
  readonly project: ProjectSession | null;
  readonly sessionId: number;
}

interface AiConfigUpdateDeps {
  readonly getController: () => AiConfigController | null;
  readonly getLoading: () => Promise<AiConfigController> | undefined;
  readonly getOwner: () => AiConfigUpdateOwner;
  readonly publish: (config: LlmConfig, commit?: () => void) => void;
}

/** Shared settings settle an already requested authoring controller before publishing. */
export function createAiConfigUpdater(deps: AiConfigUpdateDeps) {
  return async function updateAiConfig(config: LlmConfig, commit?: () => void): Promise<void> {
    let controller = deps.getController();
    const loading = controller ? undefined : deps.getLoading();
    if (loading) {
      const owner = deps.getOwner();
      controller = await loading;
      const current = deps.getOwner();
      if (
        current.game !== owner.game ||
        current.worker !== owner.worker ||
        current.mode !== owner.mode ||
        current.modeGeneration !== owner.modeGeneration ||
        current.project !== owner.project ||
        current.sessionId !== owner.sessionId
      )
        throw new Error("The game changed while applying AI settings. Try again.");
    }
    // The loaded controller owns its opening, catalog fork and settings transaction.
    // Home keeps the direct path until an authoring controller has been requested.
    if (controller) await controller.updateAiConfig(config, () => deps.publish(config, commit));
    else deps.publish(config, commit);
  };
}
