import type { ReportedSpend } from "../../agent/reportedSpend.ts";
import { imageReportedSpend } from "./imageSpend.ts";
/**
 * The optional image-generation controller: review -> one explicit submit ->
 * detached offer -> explicit Use. It sits on the accepted OpenAI adapter and
 * touches nothing on its own: every project fact (context tokens, materials,
 * rasters) and every write (staging) arrives through the injected host, and
 * the paid boundary is the adapter's prepared handle plus detached summary.
 *
 * Context discipline: the host's context snapshot is captured with the
 * review and re-read at every async boundary (submit, result, decode,
 * stage). A moved workspace lifetime drops the result entirely; a moved
 * base, draft or consulted source keeps a same-lifetime result as a
 * labelled comparison that cannot stage. Cancellation, unmount and
 * supersession abort nonsettling requests; there is no automatic retry,
 * and an explicit retry means a fresh review plus one fresh request.
 *
 * Ownership: async work is stamped at admission. The latest admitted
 * preparation owns the panel — an older one that resolves late is
 * dropped silently — and dispose/discard invalidate pending work so a
 * closed panel never publishes a late review or notice. The paid
 * boundary re-reads the full context after the last consulted material
 * read, synchronously before `provider.submit`. A successful stage is
 * the admitted write: the host validates the pinned context before it
 * changes anything, so its own workspaceVersion advance is consumed,
 * and a real close or workspace move during that await still consumes
 * the offer — nothing may land twice.
 */
import {
  sameVersionRef,
  versionRefKey,
  type CreativeBoardEntry,
  type CreativeSource,
  type Rect,
  type VersionRef,
} from "../../../../src/creative/catalog.ts";
import { sha256Hex } from "../../../../src/crypto.ts";
import {
  inspectCreativeImageHeader,
  orientedImageDimensions,
} from "../../../../src/creative/imageHeader.ts";
import type { CreativeImageIntake } from "../../references/creativeImageDecode.ts";
import { intakeGeneratedImage } from "./generatedImageIntake.ts";
import {
  buildSelectionMaskPng,
  compositeSelection,
  normalizeSelection,
  CreativeSelectionError,
  type SelectionComposite,
} from "./creativeSelectionComposite.ts";
import {
  OpenAiImageError,
  type OpenAiImageBackground,
  type OpenAiImageFailure,
  type OpenAiImageKind,
  type OpenAiImageOffer,
  type OpenAiImageProvider,
  type OpenAiImageQuality,
  type OpenAiImageRole,
  type OpenAiImageSummary,
  type PreparedOpenAiImage,
} from "./openaiImageProvider.ts";
import type { AiSettings } from "../../settings/aiSettings.ts";

/**
 * The saved OpenAI profile's key, whatever text provider is selected.
 * Mounts pass `() => aiSettings.value` so an image request reads only
 * `profiles.openai` — an Anthropic or stub profile key never leaves.
 * A null read (no settings mounted) reads as "no key".
 */
export function savedOpenAiCredential(
  read: () => Pick<AiSettings, "profiles"> | null,
): () => string | null {
  return () => {
    const key = read()?.profiles.openai.apiKey.trim();
    return key === undefined || key === "" ? null : key;
  };
}

/** Everything a review consulted, as comparable tokens the host computes. */
export interface CreativeGenerationContext {
  /** The open workspace incarnation; a moved or reopened workspace changes it. */
  readonly workspaceId: string;
  readonly closed: boolean;
  /** A project write is busy; reviews wait it out. */
  readonly busy: boolean;
  /** The project's durable history lifetime. */
  readonly lifetime: string;
  /** Storage generation of the kept body. */
  readonly generation: number;
  /** Resource revision of the kept body. */
  readonly revision: string;
  /** Authoring fingerprint of the kept body. */
  readonly authoring: string;
  /** The complete draft's monotone revision. */
  readonly draftRevision: number;
  /** The workspace's own change counter: pending sources, jobs, board. */
  readonly workspaceVersion: number;
}

/** @public A source the asset picker may offer. */
export interface CreativeGenerationSourceOption {
  readonly identity: VersionRef;
  readonly key: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** The source sits on the approved board. */
  readonly onBoard: boolean;
}

/** @public An approved board entry the reference picker may offer. */
export interface CreativeGenerationReferenceOption {
  /** The board entry's own identity; this is what a request names. */
  readonly identity: VersionRef;
  readonly key: string;
  /** The kept source the entry points at. */
  readonly source: VersionRef;
  readonly title: string;
  readonly roles: readonly string[];
}

/** What one explicit Use hands to the host's authoritative staging. */
interface CreativeGenerationUse {
  readonly offer: OpenAiImageOffer;
  readonly intake: CreativeImageIntake;
  readonly review: CreativeGenerationReview;
  /**
   * The opaque material capture the host issued at review, when the
   * mounted workspace supports it. Opaque to the controller: only the
   * host's workspace can read or honour it.
   */
  readonly capture?: unknown;
  /** Aborts the stage: cancel and dispose both revoke it. */
  readonly signal?: AbortSignal;
}

/** Edit Use adds the locally composited result and its provenance. */
interface CreativeGenerationCompositeUse extends CreativeGenerationUse {
  readonly composite: SelectionComposite;
  /** The captured base source the composite derives from. */
  readonly base: VersionRef;
  /** The authorized base-space selection. */
  readonly selection: Rect;
}

export interface CreativeGenerationHost {
  /** Current consulted-version tokens; compared at every async boundary. */
  context(): Promise<CreativeGenerationContext>;
  /** Sources the asset picker may offer (pending and adoptable kept). */
  sources(): readonly CreativeSource[];
  /** Board entries; only approved ones may leave the browser. */
  board(): readonly CreativeBoardEntry[];
  /** One source's record plus its exact encoded original; null when moved. */
  material(
    identity: VersionRef,
  ): Promise<{ readonly record: CreativeSource; readonly encoded: Uint8Array } | null>;
  /** One source's canonical RGBA raster for an edit selection; null when moved. */
  raster(
    identity: VersionRef,
  ): Promise<{ readonly record: CreativeSource; readonly pixels: Uint8Array } | null>;
  /** The saved OpenAI profile holds a key. Called for UI hints and submit. */
  hasCredential(): boolean;
  /** Open the existing AI settings so the user can save a key. */
  openSettings(): void;
  /** Reserve the shared provider allowance at the paid boundary. */
  reserveRequest?(
    summary: OpenAiImageSummary,
    approved: boolean,
  ): (offer: OpenAiImageOffer | null) => ReportedSpend | void;
  /** Decode an offer through the shared intake; defaults to the upload path. */
  intakeOffer?: (offer: OpenAiImageOffer, signal?: AbortSignal) => Promise<CreativeImageIntake>;
  /**
   * Issue the workspace's opaque material capture over the consulted
   * source keys at review time. Absent on hosts without the material
   * staging seam — the controller then carries no capture and stage
   * callbacks that need one refuse `unavailable`.
   */
  issueCapture?(input: { readonly keys: readonly string[] }): unknown;
  /**
   * Stage one reviewed generated original: the mount wires the shared
   * decodeCreativeImage/importIntake path and keeps authoritative review.
   */
  stageGenerated(use: CreativeGenerationUse): Promise<CreativeSource>;
  /**
   * Stage one reviewed edit composite and its provider original with their
   * parent/derivative provenance. Absent while the material API has no
   * derivative seam: edit Use then refuses with `unavailable`.
   */
  stageComposite?(use: CreativeGenerationCompositeUse): Promise<CreativeSource>;
}

/** The form's request, copied at review; the caller may mutate it after. */
export interface CreativeGenerationInput {
  readonly kind: OpenAiImageKind;
  readonly role: OpenAiImageRole;
  readonly model: string;
  readonly prompt: string;
  readonly title?: string;
  readonly size: string;
  readonly quality: OpenAiImageQuality;
  readonly background: OpenAiImageBackground;
  readonly inputFidelity?: "low" | "high";
  /** The asset a variation or edit departs from: a source identity. */
  readonly asset?: VersionRef;
  /** Approved board entry identities to send as references. */
  readonly references?: readonly VersionRef[];
  /** Edit kind only: the authorized rectangle in canonical raster pixels. */
  readonly selection?: Rect;
}

/** One input row of the detached review, title joined to the summary data. */
interface CreativeGenerationImageReview {
  readonly title: string;
  readonly identity: VersionRef;
  readonly roles: readonly string[];
  readonly hash: string;
  readonly byteLength: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

/** @public The frozen review: what leaves, whom it names and the context it pinned. */
export interface CreativeGenerationReview {
  readonly summary: OpenAiImageSummary;
  readonly title?: string;
  readonly images: readonly CreativeGenerationImageReview[];
  readonly context: CreativeGenerationContext;
  readonly selection:
    | {
        readonly rect: Rect;
        readonly mask: {
          readonly hash: string;
          readonly byteLength: number;
          readonly width: number;
          readonly height: number;
        };
      }
    | undefined;
}

/** @public Workflow phases. */
export type CreativeGenerationPhase =
  "compose" | "preparing" | "review" | "submitting" | "offer" | "using";

/** Provider reasons plus the controller's own local refusals. */
export type CreativeGenerationFailure =
  | OpenAiImageFailure
  /** The consulted work moved; the reviewed decision is revoked. */
  | "superseded"
  /** The workspace ended; nothing else may land. */
  | "closed"
  /** A required seam is absent (for example derivative staging). */
  | "unavailable"
  /** The issued capture was foreign, forged or revoked. */
  | "authority"
  /** Durable admission refused the write; the work may be retried. */
  | "conflict"
  | "budget";

/** @public Failure info. */
export interface CreativeGenerationFailureInfo {
  readonly reason: CreativeGenerationFailure;
  readonly message: string;
}

interface ConsultedMaterial {
  readonly identity: VersionRef;
  readonly encodedHash: string;
}

interface ReviewState {
  readonly record: CreativeGenerationReview;
  readonly prepared: PreparedOpenAiImage;
  readonly consulted: readonly ConsultedMaterial[];
  /** The opaque material capture issued at review; undefined without the seam. */
  readonly capture: unknown;
  readonly selection:
    | {
        readonly rect: Rect;
        readonly base: {
          readonly pixels: Uint8Array;
          readonly width: number;
          readonly height: number;
        };
        readonly baseIdentity: VersionRef;
      }
    | undefined;
}

interface OfferState {
  readonly offer: OpenAiImageOffer;
  stale: boolean;
  intake?: CreativeImageIntake;
}

/**
 * Carries a refusal reason through the controller's own throws. Hosts raise
 * it from their stage callbacks on pinned-context drift: "superseded" keeps
 * a same-lifetime offer comparison-only, "closed" drops it — a plain error
 * would read as a transport failure and leave a stale offer usable.
 */
export class GenerationRefusal extends Error {
  readonly reason: CreativeGenerationFailure;
  constructor(reason: CreativeGenerationFailure, message: string) {
    super(message);
    this.name = "GenerationRefusal";
    this.reason = reason;
  }
}

export interface CreativeGenerationController {
  /** The adapter's capability table; the form filters options by model. */
  readonly provider: OpenAiImageProvider;
  readonly phase: CreativeGenerationPhase;
  readonly notice: string;
  readonly failure: CreativeGenerationFailureInfo | null;
  readonly review: CreativeGenerationReview | null;
  readonly offer: OpenAiImageOffer | null;
  readonly partialImage: Uint8Array | null;
  readonly spend: ReportedSpend | null;
  /** The offer arrived after the work moved: a comparison, it cannot stage. */
  readonly offerStale: boolean;
  readonly disposed: boolean;
  readonly version: number;
  subscribe(listener: () => void): () => void;
  /** The saved OpenAI profile can sign a request. */
  credentialReady(): boolean;
  /** Open the existing AI settings. */
  openSettings(): void;
  /** Asset pick-list entries for the form. */
  sourceOptions(): readonly CreativeGenerationSourceOption[];
  /** Approved board entries for the reference pick-list. */
  referenceOptions(): readonly CreativeGenerationReferenceOption[];
  /** A source's canonical raster, for the edit-selection preview. */
  assetRaster(identity: VersionRef): Promise<{
    readonly pixels: Uint8Array;
    readonly width: number;
    readonly height: number;
  } | null>;
  /** Freeze inputs, resolve materials and build the detached review. */
  prepareReview(input: CreativeGenerationInput): Promise<void>;
  /** Send the reviewed request once. The provider charges it. */
  submit(approved?: boolean): Promise<void>;
  /** Leave the held or pending review without sending; the next send reviews again. */
  discardReview(): void;
  /** Abort the in-flight request locally; a late answer is dropped. */
  cancel(): void;
  /** Drop the held offer and return to composing. */
  dismissOffer(): void;
  /** The deterministic edit composite of the held offer, when decoded. */
  editComposite(): SelectionComposite | null;
  /** Explicit Use: stage the offer through the host's authoritative path. */
  useImage(): Promise<void>;
  /** Abort nonsettling work and refuse further calls. */
  dispose(): void;
}

export interface CreativeGenerationOptions {
  readonly provider: OpenAiImageProvider;
  readonly host: CreativeGenerationHost;
}

/**
 * Two context snapshots stand for the same pinned work. The host's stage
 * check uses this too, so the review's frozen tokens mean the same thing at
 * the write boundary as they did at every read boundary.
 */
function sameGenerationContext(
  a: CreativeGenerationContext,
  b: CreativeGenerationContext,
): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.closed === b.closed &&
    a.busy === b.busy &&
    a.lifetime === b.lifetime &&
    a.generation === b.generation &&
    a.revision === b.revision &&
    a.authoring === b.authoring &&
    a.draftRevision === b.draftRevision &&
    a.workspaceVersion === b.workspaceVersion
  );
}

function fail(reason: CreativeGenerationFailure, message: string): GenerationRefusal {
  return new GenerationRefusal(reason, message);
}

class CreativeGenerationControllerImpl implements CreativeGenerationController {
  readonly provider: OpenAiImageProvider;
  private readonly host: CreativeGenerationHost;
  private readonly decodeOffer: (
    offer: OpenAiImageOffer,
    signal?: AbortSignal,
  ) => Promise<CreativeImageIntake>;
  private readonly listeners = new Set<() => void>();
  private phaseState: CreativeGenerationPhase = "compose";
  private noticeText = "";
  private failureInfo: CreativeGenerationFailureInfo | null = null;
  private reviewState: ReviewState | null = null;
  private offerState: OfferState | null = null;
  private partialBytes: Uint8Array | null = null;
  private spendState: ReportedSpend | null = null;
  private job: { readonly controller: AbortController; cancelled: boolean } | null = null;
  private isDisposed = false;
  private versionCount = 0;
  /**
   * Async-operation ownership: the latest admitted preparation carries the
   * newest stamp. discardReview and dispose invalidate a pending one, so a
   * job that resolves late publishes nothing — no review, phase or notice.
   */
  private operationStamp = 0;

  constructor(options: CreativeGenerationOptions) {
    this.provider = options.provider;
    this.host = options.host;
    this.decodeOffer =
      options.host.intakeOffer ?? ((offer, signal) => intakeGeneratedImage(offer, signal));
  }

  get phase(): CreativeGenerationPhase {
    return this.phaseState;
  }
  get notice(): string {
    return this.noticeText;
  }
  get failure(): CreativeGenerationFailureInfo | null {
    return this.failureInfo;
  }
  get review(): CreativeGenerationReview | null {
    return this.reviewState?.record ?? null;
  }
  get offer(): OpenAiImageOffer | null {
    return this.offerState?.offer ?? null;
  }
  get spend(): ReportedSpend | null {
    return this.spendState ? { ...this.spendState } : null;
  }
  get partialImage(): Uint8Array | null {
    return this.partialBytes;
  }
  get offerStale(): boolean {
    return this.offerState?.stale ?? false;
  }
  get disposed(): boolean {
    return this.isDisposed;
  }
  get version(): number {
    return this.versionCount;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.versionCount++;
    for (const listener of this.listeners) listener();
  }

  private refuse(reason: CreativeGenerationFailure, message: string): void {
    this.failureInfo = { reason, message };
    this.noticeText = message;
    this.changed();
  }

  private checkAlive(): void {
    if (this.isDisposed) throw fail("closed", "This generation panel is closed.");
  }

  /** A job is abandoned when the panel closed or a newer operation took over. */
  private abandoned(stamp: number): boolean {
    return this.isDisposed || stamp !== this.operationStamp;
  }

  /**
   * Boundary check against the pinned review context: a closed or moved
   * workspace refuses `closed`, any other drift refuses `superseded`.
   */
  private async checkContext(
    pinned: CreativeGenerationContext,
  ): Promise<CreativeGenerationContext> {
    const fresh = await this.host.context();
    if (fresh.closed || fresh.workspaceId !== pinned.workspaceId)
      throw fail("closed", "The workspace changed; the reviewed request was dropped.");
    if (!sameGenerationContext(fresh, pinned))
      throw fail("superseded", "The work changed since the review; review the request again.");
    return fresh;
  }

  /**
   * Every image input the review froze must still resolve to the same
   * encoded bytes; a moved or edited source revokes the decision.
   */
  private async checkConsulted(consulted: readonly ConsultedMaterial[]): Promise<void> {
    for (const entry of consulted) {
      const resolved = await this.host.material(entry.identity);
      if (resolved === null || resolved.record.encoded.hash !== entry.encodedHash)
        throw fail("superseded", "A consulted source changed; review the request again.");
    }
  }

  credentialReady(): boolean {
    return this.host.hasCredential();
  }

  openSettings(): void {
    this.host.openSettings();
  }

  sourceOptions(): readonly CreativeGenerationSourceOption[] {
    const approved = new Set(
      this.host
        .board()
        .filter((entry) => entry.approval === "approved")
        .map((entry) => versionRefKey(entry.source)),
    );
    return this.host.sources().map((record) => ({
      identity: record.identity,
      key: versionRefKey(record.identity),
      title: record.origin.title,
      width: record.normalized.width,
      height: record.normalized.height,
      onBoard: approved.has(versionRefKey(record.identity)),
    }));
  }

  referenceOptions(): readonly CreativeGenerationReferenceOption[] {
    const titles = new Map(
      this.host
        .sources()
        .map((record) => [versionRefKey(record.identity), record.origin.title] as const),
    );
    return this.host
      .board()
      .filter((entry) => entry.approval === "approved")
      .map((entry) => ({
        identity: entry.identity,
        key: versionRefKey(entry.identity),
        source: entry.source,
        title:
          titles.get(versionRefKey(entry.source)) ??
          (entry.notes === "" ? "Board reference" : entry.notes),
        roles: entry.roles,
      }));
  }

  async assetRaster(identity: VersionRef): Promise<{
    readonly pixels: Uint8Array;
    readonly width: number;
    readonly height: number;
  } | null> {
    if (this.isDisposed) return null;
    const found = await this.host.raster(identity);
    if (found === null) return null;
    return {
      pixels: found.pixels,
      width: found.record.normalized.width,
      height: found.record.normalized.height,
    };
  }

  private async resolveMaterial(
    identity: VersionRef,
    label: string,
  ): Promise<{ record: CreativeSource; encoded: Uint8Array }> {
    const resolved = await this.host.material(identity);
    if (resolved === null) throw fail("invalid-request", `${label} is not available any more.`);
    return resolved;
  }

  async prepareReview(input: CreativeGenerationInput): Promise<void> {
    if (this.isDisposed) return this.refuse("closed", "This generation panel is closed.");
    if (this.phaseState === "submitting" || this.phaseState === "using")
      return this.refuse("busy", "A generation is running; wait for it or cancel it first.");
    if (this.phaseState === "offer")
      return this.refuse("invalid-request", "Settle the held offer before a new request.");
    const stamp = ++this.operationStamp;
    this.spendState = null;
    this.phaseState = "preparing";
    this.failureInfo = null;
    this.reviewState = null;
    this.changed();
    // Every offered field is read once here; the caller mutating the form
    // object afterwards cannot change what this review freezes.
    const kind = input.kind;
    const role = input.role;
    const model = input.model;
    const prompt = input.prompt;
    const size = input.size;
    const quality = input.quality;
    const background = input.background;
    const inputFidelity = input.inputFidelity;
    const assetRef = input.asset === undefined ? undefined : { ...input.asset };
    const referenceRefs = [...(input.references ?? [])].map((ref) => ({ ...ref }));
    const selection = input.selection === undefined ? undefined : { ...input.selection };
    try {
      // The host's snapshot is a token object: own a copy so a caller
      // mutating the shared record cannot move the pinned context.
      const before = { ...(await this.host.context()) };
      if (this.abandoned(stamp)) return;
      if (before.closed) throw fail("closed", "The workspace is closed.");
      if (before.busy)
        throw fail("busy", "A creative Save is in progress; try again once it finishes.");

      const titles: string[] = [];
      const consulted: ConsultedMaterial[] = [];
      const materials: {
        readonly identity: VersionRef;
        readonly roles: readonly string[];
        readonly bytes: Uint8Array;
      }[] = [];

      let selectionState: ReviewState["selection"];
      let maskBytes: Uint8Array | undefined;
      let maskSummary: NonNullable<CreativeGenerationReview["selection"]>["mask"] | undefined;
      let rect: Rect | undefined;
      if (kind === "variation" || kind === "edit") {
        if (assetRef === undefined)
          throw fail("invalid-request", `A ${kind} needs the asset it departs from.`);
        const asset = await this.resolveMaterial(assetRef, "The asset");
        if (this.abandoned(stamp)) return;
        const header = inspectCreativeImageHeader(asset.encoded);
        if (!header.ok)
          throw fail("invalid-request", `The asset could not be read: ${header.message}`);
        materials.push({
          identity: { ...assetRef },
          roles: ["exact-source"],
          bytes: asset.encoded,
        });
        titles.push(asset.record.origin.title);
        consulted.push({ identity: { ...assetRef }, encodedHash: asset.record.encoded.hash });
        if (kind === "edit") {
          if (selection === undefined)
            throw fail("invalid-request", "An edit needs the authorized selection.");
          if (header.header.orientation !== 1)
            throw fail(
              "invalid-request",
              "Edit selection works on upright sources; this image carries a stored rotation.",
            );
          const raster = await this.host.raster(assetRef);
          if (this.abandoned(stamp)) return;
          if (raster === null)
            throw fail("invalid-request", "The asset's pixels are not available any more.");
          const oriented = orientedImageDimensions(header.header);
          if (
            oriented.width !== raster.record.normalized.width ||
            oriented.height !== raster.record.normalized.height ||
            header.header.width !== raster.record.normalized.width ||
            header.header.height !== raster.record.normalized.height
          )
            throw fail(
              "invalid-request",
              "The asset's stored and decoded dimensions disagree; it cannot drive an edit selection.",
            );
          rect = normalizeSelection(
            selection,
            raster.record.normalized.width,
            raster.record.normalized.height,
          );
          maskBytes = buildSelectionMaskPng(header.header.width, header.header.height, rect);
          maskSummary = {
            hash: sha256Hex(maskBytes),
            byteLength: maskBytes.length,
            width: header.header.width,
            height: header.header.height,
          };
          // The exact base the composite will protect, frozen now.
          selectionState = {
            rect: { ...rect },
            base: {
              pixels: raster.pixels.slice(),
              width: raster.record.normalized.width,
              height: raster.record.normalized.height,
            },
            baseIdentity: { ...assetRef },
          };
        }
      }

      const approved = this.host.board().filter((entry) => entry.approval === "approved");
      const seen = new Set<string>();
      for (const ref of referenceRefs) {
        const key = versionRefKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = approved.find((candidate) => sameVersionRef(candidate.identity, ref));
        if (entry === undefined)
          throw fail("invalid-request", "Only approved board references can leave the browser.");
        const material = await this.resolveMaterial(entry.source, "A reference");
        if (this.abandoned(stamp)) return;
        materials.push({
          identity: { ...entry.source },
          roles: entry.roles.map(String),
          bytes: material.encoded,
        });
        titles.push(material.record.origin.title);
        consulted.push({
          identity: { ...entry.source },
          encodedHash: material.record.encoded.hash,
        });
      }

      const prepared = this.provider.prepare({
        kind,
        role,
        model,
        prompt,
        size,
        quality,
        background,
        ...(inputFidelity !== undefined ? { inputFidelity } : {}),
        ...(materials.length > 0 && (kind === "edit" || kind === "variation")
          ? { asset: materials[0] }
          : {}),
        references: kind === "generate" ? materials : materials.slice(1),
        ...(maskBytes !== undefined ? { mask: { bytes: maskBytes } } : {}),
      });

      const pinned = await this.checkContext(before);
      if (this.abandoned(stamp)) return;
      // The material capture is issued against the same pinned instant:
      // it freezes the consulted records and authority axes the Use stage
      // will recheck inside the workspace's serialized admission.
      const capture = this.host.issueCapture?.({
        keys: consulted.map((entry) => versionRefKey(entry.identity)),
      });
      if (this.abandoned(stamp)) return;
      // The published review is detached and frozen: host token objects,
      // form state and board arrays mutate on their own clock, and the
      // reviewed decision must stay the one the user saw.
      const record: CreativeGenerationReview = Object.freeze({
        summary: Object.freeze(prepared.summary),
        ...(input.title !== undefined ? { title: input.title } : {}),
        images: Object.freeze(
          prepared.summary.images.map((image, index) =>
            Object.freeze({
              title: titles[index] ?? image.identity.id,
              identity: Object.freeze({ ...image.identity }),
              roles: Object.freeze([...image.roles]),
              hash: image.hash,
              byteLength: image.byteLength,
              mime: image.mime,
              width: image.width,
              height: image.height,
            }),
          ),
        ),
        context: Object.freeze({ ...pinned }),
        selection:
          rect !== undefined && maskSummary !== undefined
            ? Object.freeze({
                rect: Object.freeze({ ...rect }),
                mask: Object.freeze({ ...maskSummary }),
              })
            : undefined,
      });
      this.reviewState = { record, prepared, consulted, capture, selection: selectionState };
      this.offerState = null;
      this.phaseState = "review";
      this.noticeText = "";
      this.failureInfo = null;
      this.changed();
    } catch (error) {
      if (this.abandoned(stamp)) return;
      const reason =
        error instanceof GenerationRefusal
          ? error.reason
          : error instanceof OpenAiImageError
            ? error.reason
            : error instanceof CreativeSelectionError
              ? "invalid-request"
              : "invalid-request";
      this.phaseState = "compose";
      this.refuse(reason, error instanceof Error ? error.message : String(error));
    }
  }

  async submit(approved = false): Promise<void> {
    if (this.isDisposed) return this.refuse("closed", "This generation panel is closed.");
    if (this.phaseState === "submitting" || this.phaseState === "using")
      return this.refuse("busy", "A generation is already running; wait for it or cancel it.");
    const review = this.reviewState;
    if (this.phaseState !== "review" || review === null)
      return this.refuse("invalid-request", "Review the request before submitting.");
    // The phase moves synchronously: a second click sees `submitting` and
    // refuses instead of sending a duplicate paid request.
    this.phaseState = "submitting";
    this.partialBytes = null;
    this.failureInfo = null;
    const job = { controller: new AbortController(), cancelled: false };
    this.job = job;
    this.changed();
    let settle: ((offer: OpenAiImageOffer | null) => ReportedSpend | void) | undefined;
    let sent = false;
    try {
      await this.checkContext(review.record.context);
      await this.checkConsulted(review.consulted);
      // The paid boundary: the last awaited host read before the request is
      // the full context itself, so a move that lands while consulted
      // material reads run still refuses the send.
      await this.checkContext(review.record.context);
      if (!this.host.hasCredential())
        throw fail("no-key", "Generation needs a saved OpenAI API key.");
      if (job.cancelled) throw fail("cancelled", "The request was cancelled.");
      settle = this.host.reserveRequest?.(review.record.summary, approved);
      sent = true;
      const offer = await this.provider.submit(review.prepared, {
        signal: job.controller.signal,
        onPartial: (bytes) => {
          if (job.cancelled || this.isDisposed || this.job !== job) return;
          this.partialBytes = bytes;
          this.changed();
        },
      });
      const spend = settle?.(offer) ?? imageReportedSpend(offer.summary.model, offer.usage);
      if (this.job === job) this.spendState = spend;
      settle = undefined;
      this.partialBytes = null;
      // A transport that settles after cancel/dispose is consumed by nobody.
      if (job.cancelled || this.isDisposed) return;
      const fresh = await this.host.context();
      if (fresh.closed || fresh.workspaceId !== review.record.context.workspaceId) {
        this.reviewState = null;
        this.offerState = null;
        this.phaseState = "compose";
        this.refuse("closed", "The workspace changed; the arrived result was dropped.");
        return;
      }
      const state: OfferState = {
        offer,
        stale: !sameGenerationContext(fresh, review.record.context),
      };
      this.offerState = state;
      this.phaseState = "offer";
      this.noticeText = state.stale
        ? "The result arrived after the work changed; it stays a comparison."
        : "";
      this.changed();
      // An edit offer decodes eagerly so the composite preview is exact and
      // Use has the raster ready. A decode refusal keeps the detached offer.
      if (review.record.summary.kind === "edit" && !state.stale) {
        try {
          const intake = await this.decodeOffer(offer);
          if (this.isDisposed || job.cancelled) return;
          const after = await this.host.context();
          if (after.closed || after.workspaceId !== review.record.context.workspaceId) {
            this.reviewState = null;
            this.offerState = null;
            this.phaseState = "compose";
            this.refuse("closed", "The workspace changed; the arrived result was dropped.");
            return;
          }
          if (!sameGenerationContext(after, fresh)) {
            state.stale = true;
            this.noticeText = "The result arrived after the work changed; it stays a comparison.";
          } else {
            state.intake = intake;
          }
          this.changed();
        } catch (error) {
          if (this.isDisposed) return;
          this.noticeText =
            error instanceof Error ? error.message : "The result could not be decoded.";
          this.changed();
        }
      }
    } catch (error) {
      if (job.cancelled || this.isDisposed) return;
      const reason =
        error instanceof GenerationRefusal
          ? error.reason
          : error instanceof OpenAiImageError
            ? error.reason
            : "transport";
      // A missing key keeps the still-live reviewed request so the user can
      // save one and resubmit the identical summary; every other refusal
      // revokes the review and a new one is required.
      if (reason === "no-key" || reason === "budget") {
        this.phaseState = "review";
      } else {
        this.reviewState = null;
        this.offerState = null;
        this.phaseState = "compose";
      }
      this.refuse(reason, error instanceof Error ? error.message : String(error));
    } finally {
      const spend = settle?.(null);
      if (this.job === job) {
        if (sent && this.spendState === null)
          this.spendState = spend ?? imageReportedSpend(review.record.summary.model);
        this.partialBytes = null;
        this.job = null;
        if (!this.isDisposed) this.changed();
      }
    }
  }

  discardReview(): void {
    if (this.isDisposed) return;
    if (this.phaseState !== "review" && this.phaseState !== "preparing") return;
    // A pending preparation is invalidated with the held one: whichever
    // resolves later stays silent instead of reviving the request.
    this.operationStamp++;
    this.reviewState = null;
    this.phaseState = "compose";
    this.failureInfo = null;
    this.noticeText = "";
    this.changed();
  }

  cancel(): void {
    const job = this.job;
    if (job === null) return;
    if (this.phaseState === "submitting") {
      job.cancelled = true;
      job.controller.abort();
      this.partialBytes = null;
      this.reviewState = null;
      this.phaseState = "compose";
      this.noticeText = "The request was cancelled.";
      this.changed();
      return;
    }
    // A use in flight keeps its held offer: aborting revokes the stage's
    // operation authority, and the offer returns to review for a retry.
    if (this.phaseState === "using") {
      job.cancelled = true;
      job.controller.abort();
      this.phaseState = "offer";
      this.noticeText = "The stage was cancelled.";
      this.changed();
    }
  }

  dismissOffer(): void {
    if (this.phaseState !== "offer") return;
    this.offerState = null;
    this.reviewState = null;
    this.phaseState = "compose";
    this.noticeText = "";
    this.changed();
  }

  editComposite(): SelectionComposite | null {
    const review = this.reviewState;
    const offer = this.offerState;
    if (review === null || offer === null || review.selection === undefined) return null;
    const intake = offer.intake;
    if (intake === undefined) return null;
    return compositeSelection(
      review.selection.base,
      {
        pixels: intake.pixels,
        width: intake.normalized.width,
        height: intake.normalized.height,
      },
      review.selection.rect,
    );
  }

  async useImage(): Promise<void> {
    if (this.isDisposed) return this.refuse("closed", "This generation panel is closed.");
    if (this.phaseState === "using")
      return this.refuse("busy", "The image is already being staged.");
    const offer = this.offerState;
    const review = this.reviewState;
    if (this.phaseState !== "offer" || offer === null || review === null)
      return this.refuse("invalid-request", "There is no result to use.");
    if (offer.stale)
      return this.refuse("superseded", "This result predates a change; it stays a comparison.");
    this.phaseState = "using";
    this.failureInfo = null;
    // A use carries its own abort authority: cancel revokes the stage
    // through this signal, dispose revokes it too.
    const job = { controller: new AbortController(), cancelled: false };
    this.job = job;
    this.changed();
    try {
      await this.checkContext(review.record.context);
      await this.checkConsulted(review.consulted);
      const intake = offer.intake ?? (await this.decodeOffer(offer.offer, job.controller.signal));
      this.checkAlive();
      if (job.cancelled) throw fail("cancelled", "The stage was cancelled.");
      await this.checkContext(review.record.context);
      if (review.record.summary.kind === "edit") {
        if (this.host.stageComposite === undefined)
          throw fail(
            "unavailable",
            "Selection edits are unavailable in this workspace. Choose Generate or Variation.",
          );
        const composite = compositeSelection(
          review.selection!.base,
          {
            pixels: intake.pixels,
            width: intake.normalized.width,
            height: intake.normalized.height,
          },
          review.selection!.rect,
        );
        await this.host.stageComposite({
          offer: offer.offer,
          intake,
          review: review.record,
          capture: review.capture,
          signal: job.controller.signal,
          composite,
          base: review.selection!.baseIdentity,
          selection: review.selection!.rect,
        });
      } else {
        await this.host.stageGenerated({
          offer: offer.offer,
          intake,
          review: review.record,
          capture: review.capture,
          signal: job.controller.signal,
        });
      }
      // A resolved stage is the admitted write's receipt: the host
      // validated the pinned context before mutating, so its own
      // workspaceVersion advance is consumed here — it is not foreign
      // supersession. Consume the offer and review synchronously, before
      // any fallible observation; a status read can never revoke the
      // write or leave the staged image usable a second time.
      this.offerState = null;
      this.reviewState = null;
      this.phaseState = "compose";
      this.failureInfo = null;
      if (this.isDisposed) return;
      // Advisory only: a real close or workspace move during the await is
      // reported, and a rejected read still leaves the consumed state.
      const after = await this.host.context().catch(() => null);
      if (this.isDisposed) return;
      if (
        after !== null &&
        (after.closed || after.workspaceId !== review.record.context.workspaceId)
      ) {
        this.refuse("closed", "The image was staged; the workspace moved as it landed.");
      } else {
        this.noticeText = "Image added to the workspace.";
        this.changed();
      }
    } catch (error) {
      if (this.isDisposed) return;
      const reason =
        error instanceof GenerationRefusal
          ? error.reason
          : error instanceof OpenAiImageError
            ? error.reason
            : "transport";
      if (reason === "superseded" || reason === "closed") {
        // The moved work wins: the offer becomes comparison-only when its
        // workspace still lives, or is dropped when the workspace ended.
        if (reason === "closed") {
          this.offerState = null;
          this.reviewState = null;
          this.phaseState = "compose";
        } else {
          offer.stale = true;
          this.phaseState = "offer";
        }
      } else {
        this.phaseState = "offer";
      }
      this.refuse(reason, error instanceof Error ? error.message : String(error));
    } finally {
      if (this.job === job) this.job = null;
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.operationStamp++;
    this.job?.controller.abort();
    this.job = null;
    this.reviewState = null;
    this.offerState = null;
    this.phaseState = "compose";
    this.changed();
  }
}

export function createCreativeGeneration(
  options: CreativeGenerationOptions,
): CreativeGenerationController {
  return new CreativeGenerationControllerImpl(options);
}
