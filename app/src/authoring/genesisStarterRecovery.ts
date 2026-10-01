/**
 * Genesis starter recovery. A fresh Create run that asks a provider to write
 * a new adventure keeps a complete canonical Starter prepared beside it: the
 * same seed manual Create publishes, committed under its own fresh project id
 * and carrying the title the player typed. When the run ends before handover
 * (provider refusal, disconnect, cancel), Home's error surface offers "Open
 * starter". One explicit click commits the prepared project through the
 * ordinary local-project contract and opens it as a manual game: editable
 * source, vocabulary, bindings, menus, death handling and sound, no AI key
 * and no second provider request.
 *
 * The offer is ephemeral and owned by the exact run that armed it. A newer
 * creation, load, import or eject retires it, so a stale click or a delayed
 * failure can neither publish the seed nor boot over the game that took the
 * slot. A failed commit keeps the same prepared candidate: a retry repeats
 * the identical transaction instead of minting a second project.
 */
import type { ProjectId } from "../../../src/gameIdentity.ts";
import type { prepareLocalProject } from "../project/localProject.ts";

/** A compiled, committable starter handle as prepared by the local-project contract. */
type PreparedStarter = Awaited<ReturnType<typeof prepareLocalProject>>;

/** Injected in tests; production stays on the lazy local-project facade below. */
export type PrepareStarter = (title: string) => Promise<PreparedStarter>;

/**
 * The seed compiler stays a lazy import: cold Home then Play never pulls the
 * local-project toolchain in for a boot that may never need recovery.
 */
const prepareCanonicalStarter: PrepareStarter = async (title) =>
  (await import("../project/localProject.ts")).prepareLocalProject({ title, kind: "starter" });

/** What Home's error surface shows while a failed run's starter is on offer. */
export interface GenesisStarterOffer {
  /** The title the failed creation asked for; the project the click opens. */
  readonly title: string;
  /** A click is in flight; a second one settles alongside it. */
  opening: boolean;
}

/** One armed run: its epoch, its prepared candidate and the exposed offer. */
interface ArmedRun {
  readonly run: number;
  readonly candidate: PreparedStarter;
  readonly offer: GenesisStarterOffer;
  offered: boolean;
}

export interface GenesisStarterRecovery {
  /**
   * Arm a fresh provider-dependent Create run: retire any offer a previous
   * run left, then prepare the canonical Starter beside it under the
   * recovery project's own fresh id (the run's requested or overwrite id is
   * never reused). Returns the run's epoch for handedOver and fail.
   */
  begin(title: string): Promise<number>;
  /** A boot, eject or shutdown outside the armed run retires its offer. */
  retire(): void;
  /** The run reached handover: its seed booted as the generated game. */
  handedOver(run: number): void;
  /**
   * The run ended before handover: its starter goes on offer. Null when a
   * newer run owns the slot or the run already handed over.
   */
  fail(run: number): GenesisStarterOffer | null;
  /**
   * A newer begin or a retire moved the epoch past this run: its late result
   * or failure belongs to no screen and must not boot, save or overwrite
   * what took the slot. A run that handed over keeps its epoch, so a
   * post-handover boot error still surfaces.
   */
  superseded(run: number): boolean;
  /** The offer currently exposed, or null while no failed run owns it. */
  pending(): GenesisStarterOffer | null;
  /**
   * The explicit recovery click: commit the prepared project through the
   * local-project contract and return its id for the ordinary saved-game
   * boot. Null when the passed offer was superseded. A thrown storage error
   * keeps the offer and the same candidate, so a retry repeats the exact
   * commit rather than minting a duplicate.
   */
  open(offer: GenesisStarterOffer): Promise<ProjectId | null>;
}

export function createGenesisStarterRecovery(deps?: {
  prepare?: PrepareStarter;
}): GenesisStarterRecovery {
  const prepare = deps?.prepare ?? prepareCanonicalStarter;
  let epoch = 0;
  let armed: ArmedRun | null = null;
  const current = (run: number): ArmedRun | null => (armed?.run === run ? armed : null);
  return {
    async begin(title) {
      const run = ++epoch;
      armed = null;
      const candidate = await prepare(title);
      if (run === epoch)
        armed = { run, candidate, offer: { title, opening: false }, offered: false };
      return run;
    },
    retire() {
      epoch++;
      armed = null;
    },
    handedOver(run) {
      if (current(run) !== null) armed = null;
    },
    fail(run) {
      const target = current(run);
      if (target === null) return null;
      target.offered = true;
      return target.offer;
    },
    superseded(run) {
      return run !== epoch;
    },
    pending() {
      return armed !== null && armed.offered ? armed.offer : null;
    },
    async open(offer) {
      const target = armed;
      if (target === null || !target.offered || target.offer !== offer) return null;
      await target.candidate.save();
      return target.candidate.projectId;
    },
  };
}
