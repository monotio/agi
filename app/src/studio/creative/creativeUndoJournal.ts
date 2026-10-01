/**
 * The session cursor over a project's retained creative snapshots.
 *
 * The durable lane — append-only snapshot rows under
 * `creative/<projectId>/undo/<id>` — is owned by `creativeUndo.ts`; this
 * journal only decides WHICH retained row an undo, redo or jump should land
 * on, and which row's content currently equals the live preparation.
 *
 * Model: `past` holds the durable snapshots below the live state in logical
 * (capture) order, `future` the snapshots an undo displaced (nearest on
 * top), and `live` the retained snapshot whose content equals the live
 * preparation — set right after a restore commits, cleared by the next
 * edit. A mutation that starts a new gesture captures its pre-state when
 * live is not already retained; mutations inside one gesture coalesce, so a
 * pointer drag is one step whose snapshot is the drag's starting state, not
 * one row per pointermove.
 *
 * Captures are minted with a sequence before their durable write runs;
 * `persisted` inserts the finished step at its sequence slot, so a retried
 * capture rejoins the chain where it was taken even after newer steps land.
 * Branching after an undo clears `future` but never touches the retained
 * rows: displaced snapshots stay listed for review and discard.
 */
export type UndoStep =
  | {
      /** A new snapshot must be captured and persisted for this step. */
      readonly kind: "capture";
      /** Stable position of the step in the chain, for retry insertion. */
      readonly seq: number;
    }
  | {
      /** The pre-state is already retained; no capture is needed. */
      readonly kind: "retained";
      readonly snapshotId: string;
    }
  | {
      /** Same gesture continuing: the open step's pre-state still holds. */
      readonly kind: "coalesced";
    };

export class CreativeUndoJournal {
  private past: { seq: number; id: string }[] = [];
  private future: string[] = [];
  private live: string | null = null;
  private pending: number[] = [];
  private gesture: { key: string; at: number } | null = null;
  private seq = 0;

  /** The retained snapshots the cursor can step back to, oldest first. */
  get pastIds(): readonly string[] {
    return this.past.map((entry) => entry.id);
  }
  /** The displaced snapshots a redo would step forward to, nearest last. */
  get futureIds(): readonly string[] {
    return [...this.future];
  }
  /** The retained snapshot equal to the live preparation, if known. */
  get liveId(): string | null {
    return this.live;
  }
  /** Captures minted but not yet proven durable. */
  get pendingCaptures(): number {
    return this.pending.length;
  }

  /**
   * A destructive mutation is about to land. Same-key edits inside
   * `window` ms continue the open gesture; a retained live state pushes to
   * `past` as this step's pre-state; otherwise the caller must capture and
   * persist a new snapshot for the returned `seq` before relying on it.
   * Starting a new step ends the redo branch — the rows stay retained.
   */
  step(key: string | null, at: number, window: number): UndoStep {
    if (
      key !== null &&
      this.gesture !== null &&
      this.gesture.key === key &&
      at - this.gesture.at <= window
    ) {
      this.gesture.at = at;
      return { kind: "coalesced" };
    }
    this.gesture = key === null ? null : { key, at };
    this.future = [];
    if (this.live !== null) {
      const id = this.live;
      this.live = null;
      this.pushPast(id);
      return { kind: "retained", snapshotId: id };
    }
    const seq = ++this.seq;
    this.pending.push(seq);
    return { kind: "capture", seq };
  }

  /**
   * A capture slot for the live state a restore is about to displace. The
   * caller writes the row and the matching `note*` call routes its id to
   * `past` or `future`; the slot itself has no stack effect.
   */
  mint(): number {
    const seq = ++this.seq;
    this.pending.push(seq);
    return seq;
  }

  /** The captured step proved durable: it joins the chain at its slot. */
  persisted(seq: number, snapshotId: string): void {
    this.pending = this.pending.filter((entry) => entry !== seq);
    this.past.push({ seq, id: snapshotId });
    this.past.sort((a, b) => a.seq - b.seq);
  }

  /** A displaced-state capture proved durable; the note calls place its id. */
  settled(seq: number): void {
    this.pending = this.pending.filter((entry) => entry !== seq);
  }

  /** The captured step's write refused; it stays out of the chain until retried. */
  failed(seq: number): void {
    this.pending = this.pending.filter((entry) => entry !== seq);
  }

  /** The snapshot an undo would land on; null when nothing is below live. */
  undoTarget(): string | null {
    return this.past.length === 0 ? null : this.past[this.past.length - 1]!.id;
  }

  /** The snapshot a redo would land on; null when nothing was displaced. */
  redoTarget(): string | null {
    return this.future.length === 0 ? null : this.future[this.future.length - 1]!;
  }

  /**
   * An undo committed: `restored` is the snapshot live state now equals,
   * `displaced` the durable identity of the state it replaced. Any history
   * movement ends the open gesture — the next edit, even on the same field,
   * starts a new step whose pre-state is the restored state.
   */
  noteUndo(restored: string, displaced: string): void {
    this.remove(restored);
    this.future.push(displaced);
    this.live = restored;
    this.gesture = null;
  }

  /**
   * A redo committed: `restored` leaves `future` and `displaced` — the
   * vacated live identity — moves back to `past` so a following undo
   * returns to the pre-redo state.
   */
  noteRedo(restored: string, displaced: string): void {
    this.remove(restored);
    this.pushPast(displaced);
    this.live = restored;
    this.gesture = null;
  }

  /**
   * An explicit jump committed: the displaced identity goes to `past` so a
   * following undo returns to the pre-jump state.
   */
  noteRestore(restored: string, displaced: string): void {
    this.remove(restored);
    this.pushPast(displaced);
    this.live = restored;
    this.gesture = null;
  }

  /** A retained row was discarded: the cursor forgets every mention. */
  drop(snapshotId: string): void {
    this.past = this.past.filter((entry) => entry.id !== snapshotId);
    this.future = this.future.filter((id) => id !== snapshotId);
    if (this.live === snapshotId) this.live = null;
  }

  /**
   * Reopen: seed the chain from the retained index order. The cursor sits at
   * live; undo lands on the newest retained snapshot. Classification is the
   * caller's — a stale top row simply refuses at use time.
   */
  hydrate(snapshotIds: readonly string[]): void {
    this.past = snapshotIds.map((id) => ({ seq: ++this.seq, id }));
    this.future = [];
    this.pending = [];
    this.live = null;
    this.gesture = null;
  }

  private pushPast(id: string): void {
    if (this.past[this.past.length - 1]?.id === id) return;
    this.past.push({ seq: ++this.seq, id });
  }

  private remove(id: string): void {
    this.past = this.past.filter((entry) => entry.id !== id);
    this.future = this.future.filter((entry) => entry !== id);
  }
}
