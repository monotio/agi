/**
 * Pending text for the preparation fields.
 *
 * A plain `:value` binding re-asserts the model on every re-render, so an
 * unrelated workspace update — a completed background preparation, a board
 * pin — would erase text the author is still typing before its ordinary
 * change/blur commit. Each field instead keeps its raw text in a draft here
 * until it commits. The draft is captured against the identity of what it
 * edits (job incarnation + frame/field + the entity content at first
 * keystroke), so an update that left that owner untouched keeps the draft
 * and one that removed or replaced it can never be handed stale typing.
 */
export interface FieldDraft {
  /** Entity content captured when typing started. */
  stamp: string;
  /** The author's raw text — never clamped or erased mid-edit. */
  text: string;
}

export class FieldDrafts {
  private readonly drafts = new Map<string, FieldDraft>();
  /**
   * Keys whose draft a replaced or removed owner dropped. A commit arriving
   * after that still carries the stale text — it is refused, not applied
   * onto whatever now holds the slot. Fresh keystrokes clear the mark.
   */
  private readonly orphaned = new Set<string>();

  /**
   * The text a field shows: the live draft while its captured stamp still
   * matches the current owner, else the model value. A draft whose owner
   * was replaced or changed underneath it is dropped — stale typing is
   * never displayed over a different entity.
   */
  show(key: string, stamp: string, model: string | number): string | number {
    const draft = this.drafts.get(key);
    if (draft === undefined) return model;
    if (draft.stamp !== stamp) {
      this.drafts.delete(key);
      this.orphaned.add(key);
      return model;
    }
    return draft.text;
  }

  /**
   * Record a keystroke (`@input`). The first keystroke captures the owner's
   * stamp; later ones only extend the text, so an unrelated model update in
   * between never rewrites the edit in progress. A keystroke landing on a
   * newer owner than the draft's starts a fresh capture against it — typing
   * seen by the field always belongs to what the field renders.
   */
  edit(key: string, stamp: string, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    const draft = this.drafts.get(key);
    if (draft === undefined || draft.stamp !== stamp) {
      this.drafts.set(key, { stamp, text });
      this.orphaned.delete(key);
    } else {
      draft.text = text;
    }
  }

  /**
   * An ordinary commit (`@change` — blur or Enter). When a draft exists the
   * owner must still carry the stamp it was typed against; a removed or
   * replaced owner — or text that outlived a dropped draft — refuses the
   * commit instead of applying stale typing to whatever now holds the slot.
   * Invalid text (empty or unparseable for the field) keeps the draft so
   * the unfinished edit is never silently erased; valid text applies once
   * and clears it. A bare change with no draft behaves exactly as before.
   */
  commit(
    key: string,
    stamp: string,
    event: Event,
    valid: (text: string) => boolean,
    apply: (text: string) => void,
  ): void {
    const text = (event.target as HTMLInputElement).value;
    const draft = this.drafts.get(key);
    if (this.orphaned.delete(key) || (draft !== undefined && draft.stamp !== stamp)) {
      this.drafts.delete(key);
      return;
    }
    if (draft === undefined) {
      if (valid(text)) apply(text);
      return;
    }
    if (!valid(text)) return;
    this.drafts.delete(key);
    apply(text);
  }

  /** Escape or a gone owner abandons the draft without applying it. */
  discard(key: string): void {
    this.drafts.delete(key);
    this.orphaned.delete(key);
  }

  /**
   * After an own commit rebuilt the entities the drafts point at — a frame
   * patch the component itself emitted, an underlay patch — re-stamp every
   * surviving draft under `prefix` from the new content so the author's own
   * commits compose, and drop drafts whose owner is gone.
   */
  rebase(prefix: string, stampFor: (key: string) => string | null): void {
    for (const [key, draft] of this.drafts) {
      if (!key.startsWith(prefix)) continue;
      const stamp = stampFor(key);
      if (stamp === null) {
        this.drafts.delete(key);
        this.orphaned.add(key);
      } else {
        draft.stamp = stamp;
      }
    }
  }
}

/** Non-empty text that parses as a finite number — the numeric fields' gate. */
export function numericText(text: string): boolean {
  return text !== "" && Number.isFinite(Number(text));
}
