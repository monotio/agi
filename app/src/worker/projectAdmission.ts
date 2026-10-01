/** Complete project admission with explicit run authority, independent of debugger loading. */
import { compileWorkingProjectImage } from "../project/projectWorkingImage.ts";
import {
  readProjectHistory,
  type PortableProjectHistory,
} from "../../../src/authoring/projectHistoryCodec.ts";
import { bytesToBase64 } from "../project/bytes.ts";
import { captureProjectBuild } from "../../../src/authoring/projectBuild.ts";
import { inspectProjectReferences } from "../../../src/authoring/projectReferences.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import type { DebugBindings } from "../../../src/runtime/debugExpression.ts";
import {
  canonicalizeCandidateFiles,
  openStagedContainer,
  type PreviewUpdatePlan,
} from "../../../src/runtime/previewAdmission.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { Inbound, WorkerContext } from "./context.ts";
import type { ProjectAdmissionState } from "./projectAdmissionState.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
  type PortableProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import { projectDocumentId } from "../../../src/authoring/projectContent.ts";
import {
  compileProjectDocuments,
  readProjectDocuments,
  readBindingsDocument,
} from "../../../src/authoring/projectDocuments.ts";
import type { captureProjectBuild as CaptureProjectBuild } from "../../../src/authoring/projectBuild.ts";
import type {
  PreviewLaneIdentity,
  PreviewUpdateOutcome,
  SourceBindingKind,
} from "./workerProtocol.ts";

/** Terminal outcomes retained per run for the dedupe/reconciliation contract. */
const RESULT_LEDGER_LIMIT = 64;

const BINDING_KINDS = new Set<SourceBindingKind>([
  "logic",
  "picture",
  "view",
  "sound",
  "flag",
  "variable",
  "string",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The live image exactly as the capture contract assembles it. */
function liveImageFiles(ctx: WorkerContext): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of ctx.engine!.containerFiles) files[name] = bytes;
  if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords;
  return files;
}

/**
 * The lane's current published identity: its own epoch/build/serial plus
 * the native revision recomputed over the actually installed files — the
 * ground truth a request's `expected` must equal. Null when the run the
 * lane was minted for is gone (or no lane exists at all).
 */
export function projectAdmissionIdentity(
  ctx: WorkerContext,
  lane: ProjectAdmissionState | null,
): PreviewLaneIdentity | null {
  const engine = ctx.engine;
  if (lane === null || engine === null || lane.engine !== engine) return null;
  return {
    epoch: lane.epoch,
    buildId: lane.buildId,
    revision: computeResourceRevision(liveImageFiles(ctx)),
    updateSerial: lane.updateSerial,
    ...(lane.documentId !== undefined ? { documentId: lane.documentId } : {}),
  };
}

function sameIdentity(a: PreviewLaneIdentity, b: PreviewLaneIdentity): boolean {
  return (
    a.epoch === b.epoch &&
    a.buildId === b.buildId &&
    a.revision === b.revision &&
    a.updateSerial === b.updateSerial &&
    a.documentId === b.documentId
  );
}

/** Wire-shape check for a lane identity field; null when it cannot be read. */
function readIdentity(value: unknown): PreviewLaneIdentity | null {
  if (!isRecord(value)) return null;
  const documentId = value["documentId"];
  if (
    documentId !== undefined &&
    (typeof documentId !== "string" || !/^[a-f0-9]{64}$/.test(documentId))
  )
    return null;
  const epoch = value["epoch"];
  const buildId = value["buildId"];
  const revision = value["revision"];
  const updateSerial = value["updateSerial"];
  if (
    !Number.isSafeInteger(epoch) ||
    typeof buildId !== "string" ||
    typeof revision !== "string" ||
    !Number.isSafeInteger(updateSerial)
  )
    return null;
  return {
    epoch: epoch as number,
    buildId,
    revision,
    updateSerial: updateSerial as number,
    ...(typeof documentId === "string" ? { documentId } : {}),
  };
}

/**
 * The request content digest the dedupe ledger pins: the run token, the
 * expected identity and the whole candidate — every file byte included, so
 * an id reused under any different content is refused rather than replayed.
 */
function requestDigest(msg: Inbound<"previewUpdate">): string {
  try {
    const candidate: Record<string, unknown> = isRecord(msg?.candidate) ? msg.candidate : {};
    const files = isRecord(candidate["files"]) ? candidate["files"] : {};
    const names = Object.keys(files).sort();
    let size = 0;
    const parts = names.map((name) => {
      const bytes = files[name];
      const packed = bytes instanceof Uint8Array ? bytes : new Uint8Array(String(bytes).length);
      if (!(bytes instanceof Uint8Array)) {
        for (let i = 0; i < packed.length; i++) packed[i] = String(bytes).charCodeAt(i) & 0xff;
      }
      size += 8 + name.length + packed.length;
      return { name, packed };
    });
    const image = new Uint8Array(size);
    const view = new DataView(image.buffer);
    let offset = 0;
    for (const { name, packed } of parts) {
      view.setUint32(offset, name.length);
      view.setUint32(offset + 4, packed.length);
      offset += 8;
      for (let i = 0; i < name.length; i++) image[offset + i] = name.charCodeAt(i) & 0xff;
      offset += name.length;
      image.set(packed, offset);
      offset += packed.length;
    }
    const manifest = JSON.stringify({
      runToken: msg?.runToken,
      expected: msg?.expected,
      candidate: { ...candidate, files: sha256Hex(image) },
    });
    return sha256Hex(new TextEncoder().encode(manifest)) + ":" + sha256Hex(image);
  } catch {
    return "";
  }
}

/** The expression-evaluator subview of a complete authored binding map. */
function expressionBindings(
  sourceBindings: Record<string, { kind: SourceBindingKind; num: number }>,
): DebugBindings {
  const bindings: DebugBindings = {};
  for (const [name, binding] of Object.entries(sourceBindings)) {
    if (binding.kind === "variable" || binding.kind === "flag" || binding.kind === "string")
      bindings[name] = { kind: binding.kind, num: binding.num };
  }
  return bindings;
}

/**
 * Complete typed binding-map equality. The captured build identity hashes
 * bindings projected to bare numbers, so a kind-only change — variable to
 * flag at the same num — keeps an identical buildId while the expression
 * subview the plans resolve under genuinely differs. The lane compares the
 * full typed map so such drift still installs fresh source authority. A
 * lane with no map reads as empty.
 */
function sameSourceBindings(
  installed: Record<string, { kind: SourceBindingKind; num: number }> | null,
  candidate: Record<string, { kind: SourceBindingKind; num: number }>,
): boolean {
  const before = installed ?? {};
  const names = Object.keys(before);
  if (names.length !== Object.keys(candidate).length) return false;
  return names.every((name) => {
    const next = candidate[name];
    return next !== undefined && before[name]!.kind === next.kind && before[name]!.num === next.num;
  });
}

interface ValidatedCandidate {
  readonly files: Map<string, Uint8Array>;
  readonly record: Record<string, Uint8Array>;
  readonly profile: ProfileId | undefined;
  readonly sources: Record<string, string>;
  readonly sourceBindings: Record<string, { kind: SourceBindingKind; num: number }>;
  readonly bindings: DebugBindings;
  readonly buildId: string;
  readonly revision: string;
}

/**
 * The wire-level candidate contract, checked before any deeper work: a
 * complete files record of real bytes, the declared profile equal to the
 * running one, string sources, a well-formed complete binding map, claimed
 * identities and document-origin versions. Returns the refusal reason or
 * the detached, byte-copied candidate.
 */
function validateCandidate(
  value: unknown,
  engineProfileId: ProfileId,
): { candidate: ValidatedCandidate } | { error: string } {
  if (!isRecord(value)) return { error: "preview candidate must be an object" };
  const filesValue = value["files"];
  if (!isRecord(filesValue) || Object.keys(filesValue).length === 0)
    return { error: "preview candidate carries no file image" };
  for (const [name, bytes] of Object.entries(filesValue)) {
    if (!(bytes instanceof Uint8Array))
      return { error: `preview candidate file '${name}' is not bytes` };
  }
  let canonical: Map<string, Uint8Array>;
  try {
    // The engine's own canonicalizer: every payload detached, every name
    // canonical, duplicates refused — the staged image never aliases a
    // caller-owned buffer.
    canonical = canonicalizeCandidateFiles(filesValue as Record<string, Uint8Array>);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const profile = value["profile"];
  if (profile !== undefined && profile !== engineProfileId)
    return { error: "preview candidate declares a different profile" };
  const sourcesValue = value["sources"];
  if (!isRecord(sourcesValue) || Object.values(sourcesValue).some((s) => typeof s !== "string"))
    return { error: "preview candidate sources must map logic numbers to source text" };
  const sourceBindingsValue = value["sourceBindings"];
  if (!isRecord(sourceBindingsValue))
    return { error: "preview candidate sourceBindings must be a name map" };
  const sourceBindings: Record<string, { kind: SourceBindingKind; num: number }> = {};
  for (const [name, binding] of Object.entries(sourceBindingsValue)) {
    const kind = isRecord(binding) ? binding["kind"] : undefined;
    const num = isRecord(binding) ? binding["num"] : undefined;
    if (
      !BINDING_KINDS.has(kind as SourceBindingKind) ||
      !Number.isInteger(num) ||
      (num as number) < 0 ||
      (num as number) > 255
    )
      return {
        error: `preview candidate binding '${name}' needs { kind: logic|picture|view|sound|flag|variable|string, num: 0..255 }`,
      };
    sourceBindings[name] = { kind: kind as SourceBindingKind, num: num as number };
  }
  const buildId = value["buildId"];
  if (typeof buildId !== "string" || buildId === "")
    return { error: "preview candidate carries no claimed build identity" };
  const revision = value["revision"];
  if (typeof revision !== "string" || revision === "")
    return { error: "preview candidate carries no claimed resource revision" };
  const origins = value["origins"];
  if (
    !Array.isArray(origins) ||
    origins.some(
      (origin) =>
        !isRecord(origin) ||
        typeof origin["key"] !== "string" ||
        !Number.isSafeInteger(origin["version"]) ||
        (origin["version"] as number) < 0,
    )
  )
    return { error: "preview candidate origins must be a list of { key, version }" };
  const record: Record<string, Uint8Array> = {};
  for (const [name, bytes] of canonical) record[name] = bytes;
  return {
    candidate: {
      files: canonical,
      record,
      // Any supplied value already equals the running profile — keep the
      // wire value's own identity rather than re-deriving it.
      profile: profile === undefined ? undefined : engineProfileId,
      sources: { ...(sourcesValue as Record<string, string>) },
      sourceBindings,
      bindings: expressionBindings(sourceBindings),
      buildId,
      revision,
    },
  };
}

/** Establish the boot image from verified source or exact native documents. */
export function initializeProjectAdmission(
  ctx: WorkerContext,
  lane: ProjectAdmissionState,
  workspace: unknown,
  history: PortableProjectHistory | undefined,
): void {
  const files = liveImageFiles(ctx);
  const profileId = ctx.engine!.profile.id;
  const claims = workspace === undefined ? undefined : readProjectWorkspace(workspace);
  let nativeBindings = {};
  try {
    if (typeof claims?.["bindings"] === "string")
      nativeBindings = readBindingsDocument(claims["bindings"]);
  } catch {
    /* Native documents retain their authority. */
  }
  const native = readProjectDocuments({
    files,
    profileId,
    bindings: nativeBindings,
    sources: Object.fromEntries(
      Object.entries(claims ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  });
  const compiled = compileWorkingProjectImage({
    files,
    profileId,
    documents: claims ?? native.documents,
    fallback: native.documents,
    ...(history !== undefined ? { history: readProjectHistory(history, sha256Hex) } : {}),
  });
  const documents = compiled.documents();
  lane.buildId = compiled.build.identity.buildId;
  lane.documentId = projectDocumentId(documents, sha256Hex);
  lane.sources = Object.fromEntries(
    Object.entries(documents)
      .filter(([key, content]) => key.startsWith("logic:") && typeof content === "string")
      .map(([key, content]) => [key.slice(6), content as string]),
  );
  const bindings = documents["bindings"];
  lane.sourceBindings =
    typeof bindings === "string"
      ? (JSON.parse(bindings) as ProjectAdmissionState["sourceBindings"])
      : {};
  lane.bindings = expressionBindings(lane.sourceBindings ?? {});
  ctx.boot.project = { documents: writeProjectWorkspace(documents), documentId: lane.documentId };
}

export interface ProjectAdmissionOptions {
  /** The host grants authority explicitly for this physical run; null denies it. */
  readonly lane: () => ProjectAdmissionState | null;
  /** Legacy isolated previews carry LOGIC source rather than a complete document image. */
  readonly legacyPreview?: boolean;
  /** Prepare any attached debugger plans before mutation; return bounded installation. */
  readonly prepareSession?: (candidate: {
    build: ReturnType<typeof CaptureProjectBuild>;
    sources: Record<string, string>;
    sourceBindings: Record<string, { kind: SourceBindingKind; num: number }>;
    bindings: DebugBindings;
  }) => (() => number) | null;
}

export function createProjectAdmission(ctx: WorkerContext, options: ProjectAdmissionOptions) {
  const control = ctx.ports.control;

  function liveLane(): ProjectAdmissionState | null {
    const lane = options.lane();
    const engine = ctx.engine;
    return lane !== null && engine !== null && lane.engine === engine ? lane : null;
  }

  function onPreviewUpdate(msg: Inbound<"previewUpdate">): void {
    const engine = ctx.engine;
    const id = isRecord(msg) && Number.isSafeInteger(msg.id) ? msg.id : 0;
    const runToken = isRecord(msg) && typeof msg.runToken === "string" ? msg.runToken : "";
    const expected = isRecord(msg) ? readIdentity(msg.expected) : null;
    const post = (outcome: PreviewUpdateOutcome): void =>
      control({ type: "previewUpdateResult", id, runToken, ...outcome });
    const refuse = (reason: string): void =>
      post({
        status: "refused",
        expected,
        current: projectAdmissionIdentity(ctx, liveLane()),
        patchGeneration: engine?.patchGeneration ?? 0,
        reason,
      });

    const lane = liveLane();
    if (lane === null || engine === null) {
      refuse("this run has no play-preview lane");
      return;
    }
    if (runToken !== lane.runToken) {
      refuse("run token does not match the play-preview lane");
      return;
    }
    // A request without a readable transaction id cannot enter the ledger:
    // it is refused without admission so a malformed id can never squat on
    // the serial a real first request would carry.
    if (!isRecord(msg) || !Number.isSafeInteger(msg.id) || msg.id < 0) {
      refuse("preview request carries no valid transaction id");
      return;
    }

    // Dedupe by run-local transaction id + exact request digest: an exact
    // retransmission replays its settled result verbatim; the same id under
    // any other content is refused; an evicted id can never run again.
    const retained = lane.results.get(id);
    const digest = requestDigest(msg);
    if (retained !== undefined) {
      if (digest === retained.digest) {
        post({ ...retained.outcome });
      } else {
        refuse(`preview transaction ${id} was already settled under different content`);
      }
      return;
    }
    if (id <= lane.highWater) {
      refuse(`preview transaction ${id} is at or below the lane's admission mark`);
      return;
    }
    lane.highWater = id;

    const settle = (outcome: PreviewUpdateOutcome): void => {
      lane.results.set(id, { digest, outcome: Object.freeze(outcome) });
      while (lane.results.size > RESULT_LEDGER_LIMIT) {
        lane.results.delete(lane.results.keys().next().value!);
      }
      post(outcome);
    };
    const settleRefused = (reason: string): void =>
      settle({
        status: "refused",
        expected,
        current: projectAdmissionIdentity(ctx, liveLane()),
        patchGeneration: engine.patchGeneration,
        reason,
      });

    // The expected identity must equal the live lane identity exactly — a
    // stale epoch, build, revision or update serial refuses before any work.
    const prior = projectAdmissionIdentity(ctx, liveLane())!;
    if (expected === null) {
      settleRefused("preview request carries no readable expected identity");
      return;
    }
    if (!sameIdentity(expected, prior)) {
      settleRefused("expected identity is stale: the lane has moved past it");
      return;
    }

    // The complete candidate contract — shape first, then the detached
    // capture: sources must reproduce their LOGIC payloads under the
    // shipped bindings, and the captured identity must equal the claimed
    // one. Caller assertion alone admits nothing.
    const validated = validateCandidate(msg.candidate, engine.profile.id);
    if ("error" in validated) {
      settleRefused(validated.error);
      return;
    }
    const candidate = validated.candidate;
    let captured: ReturnType<typeof CaptureProjectBuild>;
    let documentId: string | undefined;
    let admittedDocuments: PortableProjectWorkspace | undefined;
    try {
      captured = captureProjectBuild({
        files: candidate.record,
        profileId: engine.profile.id,
        sources: candidate.sources,
        bindings: Object.fromEntries(
          Object.entries(candidate.sourceBindings).map(([name, b]) => [name, { num: b.num }]),
        ),
      });
      if (
        !options.legacyPreview ||
        msg.candidate.documents !== undefined ||
        msg.candidate.documentId !== undefined
      ) {
        const documents = readProjectWorkspace(msg.candidate.documents);
        admittedDocuments = writeProjectWorkspace(documents);
        documentId = projectDocumentId(documents, sha256Hex);
        if (documentId !== msg.candidate.documentId)
          throw new Error("claimed project document identity differs from its documents");
        const compiled = compileProjectDocuments({
          files: candidate.record,
          profileId: engine.profile.id,
          documents,
        });
        if (
          compiled.build.identity.revision !== candidate.revision ||
          compiled.build.identity.buildId !== candidate.buildId ||
          projectDocumentId(compiled.documents(), sha256Hex) !== documentId
        )
          throw new Error("project documents do not reproduce the candidate image");
        const bindings = compiled.documents()["bindings"];
        if (bindings !== undefined && typeof bindings === "string") {
          const complete = JSON.parse(bindings) as Record<
            string,
            { kind: SourceBindingKind; num: number }
          >;
          if (!sameSourceBindings(complete, candidate.sourceBindings))
            throw new Error("project bindings differ from candidate bindings");
        } else if (Object.keys(candidate.sourceBindings).length > 0)
          throw new Error("candidate bindings lack project documents");
      }
    } catch (error) {
      settleRefused(
        `candidate build capture failed: ${String(error instanceof Error ? error.message : error)}`,
      );
      return;
    }
    if (captured.identity.buildId !== candidate.buildId) {
      settleRefused("claimed build identity does not match the verified capture");
      return;
    }
    if (captured.identity.revision !== candidate.revision) {
      settleRefused("claimed resource revision does not match the verified capture");
      return;
    }

    // Source-authority drift the native verdict cannot see: the captured
    // build identity covers source text and bytes but projects bindings to
    // bare numbers, so a kind-only change is a real authority change hiding
    // behind an identical buildId. Computed before commit so the engine's
    // unchanged verdict still inherits the strict idle boundary.
    const sourceAuthorityChanged =
      documentId !== lane.documentId ||
      captured.identity.buildId !== lane.buildId ||
      !sameSourceBindings(lane.sourceBindings, candidate.sourceBindings);

    // The complete candidate's cross-resource truth, checked detached
    // before any commit: literal resource, word and item references
    // resolved on the candidate's own container under the selected profile
    // and the full binding map. Capture verifies identities, not
    // references — an error-severity diagnostic (a dangling literal target,
    // an undecodable instruction stream, an unreadable document) refuses
    // the whole candidate while variable-indirect targets stay warnings
    // under the existing policy. Missing-room generation is an explicit
    // host policy and is never inferred from the candidate here.
    let inspection: ReturnType<typeof inspectProjectReferences>;
    try {
      inspection = inspectProjectReferences({
        container: openStagedContainer(candidate.files, engine.profile),
        profile: engine.profile,
        bindings: candidate.sourceBindings,
        allowMissingRooms: ctx.projectAdmission === lane && ctx.boot.authorRooms,
      });
    } catch (error) {
      settleRefused(
        `candidate image cannot be inspected: ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
      return;
    }
    const existing: Record<string, number> = Object.create(null);
    const marker = (finding: (typeof inspection.diagnostics)[number]) =>
      JSON.stringify([finding.document, finding.code, finding.command, finding.message]);
    if (ctx.projectAdmission === lane) {
      const baseline = inspectProjectReferences({
        container: openStagedContainer(
          new Map(Object.entries(liveImageFiles(ctx))),
          engine.profile,
        ),
        profile: engine.profile,
        bindings: lane.sourceBindings ?? {},
        allowMissingRooms: ctx.boot.authorRooms,
      });
      for (const finding of baseline.diagnostics)
        if (finding.severity === "error") {
          const key = marker(finding);
          existing[key] = (existing[key] ?? 0) + 1;
        }
    }
    const violations = inspection.diagnostics.filter((finding) => {
      if (finding.severity !== "error") return false;
      const key = marker(finding);
      if ((existing[key] ?? 0) > 0) {
        existing[key]!--;
        return false;
      }
      return true;
    });
    if (violations.length > 0) {
      const first = violations[0]!;
      settleRefused(
        `candidate fails detached project validation: ${first.document}: ${first.message}` +
          (violations.length > 1 ? ` (+${violations.length - 1} more)` : ""),
      );
      return;
    }

    let installSession: (() => number) | null;
    try {
      installSession =
        options.prepareSession?.({
          build: captured,
          sources: candidate.sources,
          sourceBindings: candidate.sourceBindings,
          bindings: candidate.bindings,
        }) ?? null;
    } catch (error) {
      settleRefused(
        `preview session plans cannot carry over: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // The committed WORDS dictionary is parsed detached now — nothing that
    // can throw may run after the Engine's first live write.
    const wordsFile = candidate.files.get("WORDS.TOK");
    let committedDictionary: { word: string; id: number }[] | null = null;
    if (wordsFile !== undefined) {
      try {
        committedDictionary = parseWordsTok(wordsFile);
      } catch (error) {
        settleRefused(
          `candidate WORDS.TOK is not a valid dictionary: ${String(
            error instanceof Error ? error.message : error,
          )}`,
        );
        return;
      }
    }

    // Stage the whole native image detached through the Engine. Terminal
    // verdicts — malformed resources, layout/profile drift, removals —
    // are recorded on the issued plan and surface at commit; the worker
    // never interprets raw container bytes itself. The call is contractually
    // non-throwing; the guard keeps the one-result invariant if it ever
    // broke.
    let plan: PreviewUpdatePlan;
    try {
      plan = engine.preparePreviewUpdate(
        candidate.profile === undefined
          ? { files: candidate.files }
          : { files: candidate.files, profile: candidate.profile },
      );
    } catch (error) {
      settleRefused(
        `preview staging failed: ${String(error instanceof Error ? error.message : error)}`,
      );
      return;
    }

    // The synchronous recheck the contract demands: the lane's identity and
    // the engine's generation must still be what the candidate was staged
    // against — anything moved means the request settles refused, unstaged.
    const again = projectAdmissionIdentity(ctx, liveLane());
    if (again === null || !sameIdentity(again, prior)) {
      settleRefused("the lane's identity moved while the candidate was staged");
      return;
    }
    const result = engine.commitPreviewUpdate(plan, { sourceAuthorityChanged });

    if (result.status === "deferred") {
      // A busy boundary is a terminal, honest answer: nothing is queued,
      // nothing was written; the host retries at a natural boundary with a
      // fresh transaction id.
      settle({
        status: "deferred",
        expected,
        current: projectAdmissionIdentity(ctx, liveLane()),
        patchGeneration: engine.patchGeneration,
      });
      return;
    }
    if (result.status === "restartRequired" || result.status === "refused") {
      settle({
        status: result.status,
        expected,
        current: projectAdmissionIdentity(ctx, liveLane()),
        patchGeneration: result.patchGeneration,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      });
      return;
    }

    // Engine verdict "unchanged" names a byte-identical native image — but
    // source authority may still differ. An exact no-change (same build
    // identity and same typed bindings) reports unchanged; any
    // source/binding drift commits the verified authority with the native
    // revision untouched.
    const installed = result.status === "committed" || sourceAuthorityChanged;
    if (installed) {
      if (ctx.projectAdmission === lane)
        ctx.boot.project = { documents: admittedDocuments!, documentId: documentId! };
      if (ctx.projectAdmission === lane)
        ctx.fns.historyRecord({
          kind: "projectImage",
          files: Object.fromEntries(
            [...candidate.files].map(([name, bytes]) => [name, bytesToBase64(bytes)]),
          ),
          documents: admittedDocuments!,
          documentId: documentId!,
          nativeChanged: result.status === "committed",
        });
      lane.sources = candidate.sources;
      lane.sourceBindings = candidate.sourceBindings;
      lane.bindings = candidate.bindings;
      lane.buildId = captured.identity.buildId;
      lane.documentId = documentId;
      lane.updateSerial += 1;
      lane.epoch = installSession === null ? lane.epoch + 1 : installSession();
      // Every external image consumer re-points at the admitted bytes: the
      // engine's own staged container is the truth these mirrors follow.
      ctx.boot.currentBootFiles = new Map(engine.containerFiles);
      if (committedDictionary !== null && wordsFile !== undefined) {
        // The commit rebinds the engine's parser dictionary to the staged
        // map — liveDictionary keeps the boot-time content mirror (and
        // currentDictionary its alias) rather than staying a stale alias
        // of the parser's old map.
        ctx.boot.liveDictionary.clear();
        for (const { word, id: wordId } of committedDictionary)
          ctx.boot.liveDictionary.set(word, wordId);
        ctx.boot.currentDictionary = ctx.boot.liveDictionary;
        ctx.boot.authoredWords = wordsFile.slice();
      }
    }
    settle({
      status: installed ? "committed" : "unchanged",
      expected,
      current: projectAdmissionIdentity(ctx, liveLane()),
      patchGeneration: engine.patchGeneration,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
  }

  /**
   * The read-only reconciliation a lost ack is recovered through: the
   * lane's live identity, plus the retained correlated result for a named
   * transaction — "unavailable" for an id at or below the admission mark
   * with no retained result, "unknown" for an id above the mark this run
   * never admitted. The bounded ledger cannot separate an evicted outcome
   * from a skipped lower id; "unavailable" asserts neither execution nor
   * commit, and the host must never infer rollback or replay a lower id.
   */
  function onPreviewStatus(msg: Inbound<"previewUpdateStatus">): void {
    const id = isRecord(msg) && Number.isSafeInteger(msg.id) ? msg.id : 0;
    const lane = liveLane();
    const transactionId = isRecord(msg) ? msg.transactionId : undefined;
    let transaction:
      { id: number; outcome: PreviewUpdateOutcome } | "unavailable" | "unknown" | null = null;
    if (transactionId !== undefined) {
      const tid = Number.isSafeInteger(transactionId) ? transactionId : -1;
      const retained = lane === null || tid < 0 ? undefined : lane.results.get(tid);
      if (retained !== undefined) {
        transaction = { id: tid, outcome: retained.outcome };
      } else if (lane !== null && tid >= 0 && tid <= lane.highWater) {
        transaction = "unavailable";
      } else {
        transaction = "unknown";
      }
    }
    control({
      type: "previewUpdateStatus",
      id,
      runToken: lane === null ? null : lane.runToken,
      current: projectAdmissionIdentity(ctx, liveLane()),
      transaction,
    });
  }

  return { onPreviewUpdate, onPreviewStatus };
}
