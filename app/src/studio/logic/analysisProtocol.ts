import type { createProjectLogicLanguageSnapshot } from "../../../../src/authoring/projectLanguage.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";

type Language = ReturnType<typeof createProjectLogicLanguageSnapshot>;
export interface LogicAnalysisOperations {
  diagnostics: {
    diagnostics: Language["diagnostics"];
    generatedDiagnostics: Language["generatedDiagnostics"];
  };
  completeAt: ReturnType<Language["completeAt"]>;
  signatureAt: ReturnType<Language["signatureAt"]>;
  hoverAt: ReturnType<Language["hoverAt"]>;
  definitionAt: ReturnType<Language["definitionAt"]>;
  referencesAt: ReturnType<Language["referencesAt"]>;
  renameAt: ReturnType<Language["renameAt"]>;
}
export type LogicAnalysisQuery =
  | { method: "diagnostics" }
  | {
      method: "completeAt" | "signatureAt" | "hoverAt" | "definitionAt" | "referencesAt";
      offset: number;
    }
  | { method: "renameAt"; offset: number; name: string };

/** A complete consulted workspace revision; the host supplies authored LOGIC documents. */
export interface LogicAnalysisProject {
  readonly revision: number;
  readonly profileId: ProfileId;
  readonly words: readonly (readonly [string, number])[];
  readonly bindings: Readonly<Record<string, { readonly num: number }>>;
  readonly documents: Readonly<
    Record<string, { readonly version: number; readonly source: string }>
  >;
}
export interface LogicAnalysisRequest {
  readonly id: number;
  readonly epoch: number;
  readonly revision: number;
  readonly key: string;
  readonly version: number;
  readonly source: string;
  readonly profileId: ProfileId;
  readonly words: LogicAnalysisProject["words"];
  readonly bindings: LogicAnalysisProject["bindings"];
  readonly query: LogicAnalysisQuery;
}
type ReplyIdentity = Pick<LogicAnalysisRequest, "id" | "epoch" | "revision" | "key" | "version">;
export type LogicAnalysisReply = ReplyIdentity &
  (
    | {
        readonly ok: true;
        readonly method: keyof LogicAnalysisOperations;
        readonly result: LogicAnalysisOperations[keyof LogicAnalysisOperations];
      }
    | { readonly ok: false; readonly error: string }
  );
