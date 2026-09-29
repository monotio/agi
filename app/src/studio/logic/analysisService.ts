import { createProjectLogicLanguageSnapshot } from "../../../../src/authoring/projectLanguage.ts";
import { PROFILES } from "../../../../src/runtime/profile.ts";
import type { LogicAnalysisReply, LogicAnalysisRequest } from "./analysisProtocol.ts";

/** Private worker cache. Draft authority and cancellation belong to the caller. */
export function createLogicAnalysisService() {
  const snapshots = new Map<string, ReturnType<typeof createProjectLogicLanguageSnapshot>>();
  let epoch = -1;
  return (request: LogicAnalysisRequest): LogicAnalysisReply => {
    const identity = {
      id: request.id,
      epoch: request.epoch,
      revision: request.revision,
      key: request.key,
      version: request.version,
    };
    try {
      if (request.epoch !== epoch) {
        snapshots.clear();
        epoch = request.epoch;
      }
      const cacheKey = `${request.revision}:${request.key}:${request.version}`;
      let language = snapshots.get(cacheKey);
      if (!language) {
        language = createProjectLogicLanguageSnapshot({
          source: request.source,
          profile: PROFILES[request.profileId],
          dictionary: new Map(request.words),
          bindings: request.bindings,
        });
      }
      snapshots.delete(cacheKey);
      snapshots.set(cacheKey, language);
      if (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value!);
      const query = request.query;
      const result =
        query.method === "diagnostics"
          ? {
              diagnostics: language.diagnostics,
              generatedDiagnostics: language.generatedDiagnostics,
            }
          : query.method === "renameAt"
            ? language.renameAt(query.offset, query.name)
            : language[query.method](query.offset);
      return { ...identity, ok: true, method: query.method, result };
    } catch (error) {
      return {
        ...identity,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
