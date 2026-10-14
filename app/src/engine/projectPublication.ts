/** Publish committed project documents while preserving the running game and its progress owner. */
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { bindProgressTarget, resolveProgressTarget } from "../project/progressBinding.ts";
import { writeResumePointer } from "../saves/resumePointer.ts";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { BootedGame } from "../project/gameTypes.ts";
import type { openProjectSession } from "../project/projectSession.ts";
import type { createProgressOwnership } from "../saves/progressOwnership.ts";
import type { AutosaveController } from "../saves/useAutosaveController.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";
import type { PreviewUpdateOutcome } from "../worker/workerProtocol.ts";

type SessionOptions = Parameters<typeof openProjectSession>[0];
interface PublicationPorts {
  readonly getGame: () => BootedGame;
  readonly setGame: (game: BootedGame) => void;
  readonly current: () => boolean;
  readonly state: Pick<
    EngineState,
    "copyCreated" | "patchTick" | "worldTick" | "profile" | "status"
  >;
  readonly progressOwnership: Pick<ReturnType<typeof createProgressOwnership>, "acquire" | "close">;
  readonly autosaveController: Pick<AutosaveController, "reset" | "flushAutosave">;
  readonly hook: Pick<TextHook, "autosave">;
  readonly publishHook: () => void;
  readonly useGameFiles: (files: Record<string, Uint8Array>) => void;
  readonly admitted: (outcome: PreviewUpdateOutcome) => void;
}

/** One callback owner follows native admissions and storage receipts throughout the session. */
export function createProjectPublication(
  ports: PublicationPorts,
): Required<Pick<SessionOptions, "forked" | "publish">> {
  const { state, current, progressOwnership, autosaveController, hook } = ports;
  let nativeRevision: ResourceRevision | undefined;
  return {
    async forked(data, lifetime) {
      if (!current()) return;
      let game = ports.getGame();
      state.copyCreated = { projectId: data.projectId, originalTitle: game.title };
      const retainRuntime = nativeRevision === undefined;
      if (retainRuntime)
        game.retainedProgressTarget ??= {
          target: resolveProgressTarget(game),
          lifetime: game.historyLifetime,
        };
      const forked = {
        ...game,
        installed: false,
        revision: nativeRevision ?? game.revision,
        files: game.files,
        projectId: data.projectId,
        title: data.title,
        authoredGame: {
          ...game.authoredGame!,
          projectId: data.projectId,
          title: data.title,
          imported: data.imported,
          library:
            data.library === undefined
              ? undefined
              : {
                  ...data.library,
                  revision: computeResourceRevision(game.authoredGame!.files),
                },
        },
        historyLifetime: lifetime,
      };
      game = retainRuntime ? Object.assign(game, forked) : forked;
      ports.setGame(game);
      if (!retainRuntime) {
        const target = bindProgressTarget(game);
        autosaveController.reset();
        hook.autosave = -1;
        if (target) {
          await progressOwnership.acquire(target);
          if (!current()) return;
          writeResumePointer(localStorage, target.locator);
        }
        void autosaveController.flushAutosave();
      }
      state.patchTick++;
      state.worldTick++;
    },
    publish(snapshot, data, outcome, nativeInstalled, documentOnly) {
      if (!current()) return;
      const game = ports.getGame();
      if (
        !documentOnly &&
        computeResourceRevision(game.authoredGame!.files) !==
          snapshot.lastAdmissibleBuild!.identity.revision
      ) {
        hook.autosave = -1;
        ports.publishHook();
      }
      const running =
        !documentOnly &&
        (nativeInstalled === true ||
          outcome?.status === "committed" ||
          outcome?.status === "unchanged");
      if (running) {
        nativeRevision = snapshot.lastAdmissibleBuild!.identity.revision;
        game.files = structuredClone(data.files);
        if (!game.installed) {
          game.revision = snapshot.lastAdmissibleBuild!.identity.revision;
          const retained = game.retainedProgressTarget;
          if (retained?.target === null) progressOwnership.close();
          const target = bindProgressTarget(game);
          if (retained && target)
            void progressOwnership
              .acquire(target)
              .then(() => {
                if (!current()) return;
                writeResumePointer(localStorage, target.locator);
                void autosaveController.flushAutosave();
              })
              .catch((error: unknown) => {
                if (current())
                  state.status = error instanceof Error ? error.message : String(error);
              });
        }
        if (outcome?.replacementRunToken !== undefined)
          state.profile = snapshot.lastAdmissibleBuild!.identity.profileId;
      }
      if (running)
        game.words =
          data.files["WORDS.TOK"] === undefined
            ? data.words
            : parseWordsTok(data.files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
      game.authoredGame = {
        ...data,
        projectId: game.projectId!,
        authoredAt: game.authoredGame!.authoredAt,
      };
      if (running) ports.useGameFiles(game.files);
      state.patchTick++;
      state.worldTick++;
      if (outcome?.status === "committed") ports.admitted(outcome);
    },
  };
}
