/**
 * The real mount seam between CreativeGenerate and a CreativeMaterialWorkspace.
 * It hands the generation controller live authority: context tokens pinned
 * from the workspace and its EditableProject, pending plus kept sources for
 * the pickers, exact encoded material and canonical rasters for review, the
 * saved OpenAI profile key through savedOpenAiCredential, and staging through
 * the workspace's material authority — an opaque capture issued at review
 * plus stageMaterialUse for the admitted write.
 *
 * Writes stay inside the workspace's authority: the capture freezes the
 * consulted records and every pin the review relied on, and the workspace's
 * serialized admission callback rechecks them inside the staging
 * transaction. A Generate stages its decoded original; an Edit stages its
 * provider original plus the locally composited result as a strict
 * two-parent selection-composite derivation — recomputed byte-exact at
 * admission.
 */
import {
  CREATIVE_SOURCE_FORMAT,
  RASTER_FORMAT,
  SELECTION_COMPOSITE_ALGORITHM,
  versionRefKey,
  type CreativeSource,
  type VersionRef,
} from "../../../../src/creative/catalog.ts";
import { encodePngRgba } from "../../../../src/creative/composite.ts";
import { sha256Hex } from "../../../../src/crypto.ts";
import { loadCreativeCatalog, readCreativeBlob } from "../../project/creativeStore.ts";
import { CREATIVE_RASTER_MIME } from "../../references/creativeImageDecode.ts";
import type { AiSettings } from "../../settings/aiSettings.ts";
import {
  createCreativeGeneration,
  GenerationRefusal,
  savedOpenAiCredential,
  sameGenerationContext,
  type CreativeGenerationCompositeUse,
  type CreativeGenerationContext,
  type CreativeGenerationController,
  type CreativeGenerationFailure,
  type CreativeGenerationHost,
  type CreativeGenerationUse,
} from "./creativeGeneration.ts";
import { createOpenAiImageProvider, type OpenAiImageProvider } from "./openaiImageProvider.ts";
import type {
  CreativeMaterialCapture,
  CreativeMaterialUseResult,
  CreativeMaterialWorkspace,
} from "./creativeWorkspace.ts";

/** What a mounted generation dock owns; dispose ends both the lease on reads and the controller. */
export interface CreativeGenerationMount {
  readonly controller: CreativeGenerationController;
  /** The adapter instance the controller reviews against. */
  readonly provider: OpenAiImageProvider;
  /** The workspace-backed host, exposed so mounts and tests can read it. */
  readonly host: CreativeGenerationHost;
  dispose(): void;
}

export interface CreativeGenerationMountOptions {
  /** The workspace this mount stages into. */
  readonly workspace: CreativeMaterialWorkspace;
  /**
   * The saved settings snapshot; null or absent reads as "no key". Only
   * `profiles.openai.apiKey` is ever read — the selected text provider's
   * key is not touched.
   */
  readonly settings?: (() => Pick<AiSettings, "profiles"> | null) | undefined;
  /** Open the existing AI settings dialog for the missing-key action. */
  readonly openSettings?: (() => void) | undefined;
  /** Provider override for tests; the real adapter is the default. */
  readonly provider?: OpenAiImageProvider | undefined;
  /**
   * Offer decode override for tests; absent, offers take the shared
   * decodeCreativeImage intake an upload does.
   */
  readonly intakeOffer?: CreativeGenerationHost["intakeOffer"];
}

const KIND_TITLE: Record<string, string> = {
  generate: "generation",
  variation: "variation",
  edit: "edit",
};

/** Workspace material refusals map onto the controller's own failure set. */
const MATERIAL_FAILURE: Record<string, CreativeGenerationFailure> = {
  superseded: "superseded",
  closed: "closed",
  unavailable: "unavailable",
  authority: "authority",
  conflict: "conflict",
  cancelled: "cancelled",
};

function materialReason(result: CreativeMaterialUseResult): never {
  const refusal = (result as { refusal: string }).refusal;
  throw new GenerationRefusal(
    MATERIAL_FAILURE[refusal] ?? "unavailable",
    `The material workspace refused the stage (${refusal}).`,
  );
}

export function createCreativeGenerationMount(
  options: CreativeGenerationMountOptions,
): CreativeGenerationMount {
  const workspace = options.workspace;
  const readKey = savedOpenAiCredential(() => options.settings?.() ?? null);
  const provider = options.provider ?? createOpenAiImageProvider({ credentials: readKey });

  /**
   * Kept sources are read lazily and cached: the pickers are synchronous,
   * and the catalog only moves when the workspace version does, so one read
   * per change is enough. A failed read keeps the last-known list rather
   * than emptying the picker mid-flight.
   */
  let keptSources: readonly CreativeSource[] = [];
  let keptStale = true;
  let keptRead: Promise<void> | null = null;
  const refreshKept = (): void => {
    if (!keptStale || keptRead !== null || workspace.closed) return;
    keptStale = false;
    keptRead = (async () => {
      try {
        const { catalog } = await loadCreativeCatalog(workspace.projectId);
        keptSources = catalog === null ? [] : catalog.sources;
      } catch {
        // Keep the last-known list; a corrupt store already fails loudly
        // through the workspace's own reads.
      } finally {
        keptRead = null;
      }
    })();
  };
  const unsubscribe = workspace.subscribe(() => {
    keptStale = true;
  });
  void workspace.ready.then(() => {
    keptStale = true;
    refreshKept();
  });

  const contextSnapshot = (): CreativeGenerationContext => {
    const saved = workspace.project.savedIdentity();
    return {
      workspaceId: workspace.leaseId,
      closed: workspace.closed,
      busy: workspace.busy,
      lifetime: saved.lifetime,
      generation: saved.generation,
      revision: saved.revision,
      authoring: saved.authoring,
      draftRevision: workspace.project.draft.capture().revision,
      workspaceVersion: workspace.version,
    };
  };

  const generatedTitle = (use: CreativeGenerationUse): string => {
    const model = use.review.summary.model;
    const label = provider.models[model]?.label ?? model;
    return `${label} ${KIND_TITLE[use.review.summary.kind] ?? use.review.summary.kind}`;
  };

  /** A fresh generated-origin source record over one decoded intake. */
  const generatedRecord = (
    intake: CreativeGenerationUse["intake"],
    title: string,
  ): CreativeSource => ({
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: {
      id: `source-${crypto.randomUUID()}`,
      incarnation: crypto.randomUUID(),
      revision: 0,
    },
    encoded: { ...intake.encoded },
    availability: "original",
    normalized: { ...intake.normalized, blob: { ...intake.normalized.blob } },
    origin: { kind: "generated", title },
  });

  const host: CreativeGenerationHost = {
    context: async () => contextSnapshot(),
    sources: () => {
      refreshKept();
      const pendingKeys = new Set(
        workspace.sources.map((entry) => versionRefKey(entry.record.identity)),
      );
      return [
        ...workspace.sources.map((entry) => entry.record),
        ...keptSources.filter((record) => !pendingKeys.has(versionRefKey(record.identity))),
      ];
    },
    board: () => workspace.board,
    material: async (identity: VersionRef) => {
      const key = versionRefKey(identity);
      const pending = workspace.sources.find(
        (entry) => versionRefKey(entry.record.identity) === key,
      );
      if (pending !== undefined) return { record: pending.record, encoded: pending.encoded };
      const { catalog } = await loadCreativeCatalog(workspace.projectId);
      const record = catalog?.sources.find((entry) => versionRefKey(entry.identity) === key);
      if (record === undefined) return null;
      try {
        const blob = await readCreativeBlob(workspace.projectId, record.encoded.hash);
        return { record, encoded: blob.bytes };
      } catch {
        // A missing or tampered blob reads as "moved": the review refuses
        // rather than send unverifiable bytes.
        return null;
      }
    },
    raster: (identity: VersionRef) => workspace.sourceRaster(identity),
    ...(options.intakeOffer !== undefined ? { intakeOffer: options.intakeOffer } : {}),
    hasCredential: () => readKey() !== null,
    openSettings: () => options.openSettings?.(),
    issueCapture: (input) => workspace.issueMaterialCapture(input),
    stageGenerated: async (use: CreativeGenerationUse) => {
      if (use.capture === undefined) {
        // A mount without the material seam keeps the plain intake path:
        // the frozen pins are rechecked against the live workspace first.
        const now = contextSnapshot();
        const pinned = use.review.context;
        if (now.closed || now.workspaceId !== pinned.workspaceId)
          throw new GenerationRefusal(
            "closed",
            "The workspace changed; the staged image was refused.",
          );
        if (!sameGenerationContext(now, pinned))
          throw new GenerationRefusal(
            "superseded",
            "The work changed since the review; the staged image was refused.",
          );
        return workspace.importIntake(use.intake, {
          kind: "generated",
          title: generatedTitle(use),
        });
      }
      const record = generatedRecord(use.intake, generatedTitle(use));
      const staged = await workspace.stageMaterialUse(use.capture as CreativeMaterialCapture, {
        sources: [{ record, pixels: use.intake.pixels, encoded: use.intake.encodedBytes }],
        ...(use.signal !== undefined ? { signal: use.signal } : {}),
      });
      if ("refusal" in staged) materialReason(staged);
      return record;
    },
    stageComposite: async (use: CreativeGenerationCompositeUse) => {
      if (use.capture === undefined)
        throw new GenerationRefusal(
          "unavailable",
          "Selection edits are unavailable in this workspace. Choose Generate or Variation.",
        );
      const title = generatedTitle(use);
      const providerRecord = generatedRecord(use.intake, `${title} source`);
      const png = encodePngRgba(use.composite.width, use.composite.height, use.composite.pixels);
      const compositeRecord: CreativeSource = {
        format: CREATIVE_SOURCE_FORMAT,
        version: 1,
        identity: {
          id: `source-${crypto.randomUUID()}`,
          incarnation: crypto.randomUUID(),
          revision: 0,
        },
        encoded: {
          hash: sha256Hex(png),
          byteLength: png.length,
          mime: "image/png",
        },
        availability: "original",
        normalized: {
          blob: {
            hash: sha256Hex(use.composite.pixels),
            byteLength: use.composite.pixels.length,
            mime: CREATIVE_RASTER_MIME,
          },
          format: RASTER_FORMAT,
          width: use.composite.width,
          height: use.composite.height,
        },
        origin: { kind: "composite", title: `${title} composite` },
        derivation: {
          kind: "selection-composite",
          version: 1,
          base: { ...use.base },
          provider: { ...providerRecord.identity },
          selection: { ...use.selection },
          algorithm: SELECTION_COMPOSITE_ALGORITHM,
        },
      };
      const staged = await workspace.stageMaterialUse(use.capture as CreativeMaterialCapture, {
        sources: [
          { record: providerRecord, pixels: use.intake.pixels, encoded: use.intake.encodedBytes },
          { record: compositeRecord, pixels: use.composite.pixels, encoded: png },
        ],
        ...(use.signal !== undefined ? { signal: use.signal } : {}),
      });
      if ("refusal" in staged) materialReason(staged);
      return compositeRecord;
    },
  };

  const controller = createCreativeGeneration({ provider, host });
  return {
    controller,
    provider,
    host,
    dispose(): void {
      unsubscribe();
      controller.dispose();
    },
  };
}
