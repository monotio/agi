/** Per-part working copies, with a synchronous journal until IndexedDB acknowledges them. */
import type { ProjectChange, ProjectContent } from "../../../src/authoring/projectContent.ts";
import { checkProjectDocumentKey } from "../../../src/authoring/projectDocumentKey.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import { historyLifetimeGuard, readBodyRecords, updateBodyRecords } from "./gameBodyStorage.ts";
import { claimProjectSaveJournal } from "./projectSaveJournal.ts";
import { rebaseWorldDraft } from "./projectWorld.ts";

type Journal = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
const liveJournals = new Set<string>();
interface PartDraft {
  readonly projectId: string;
  readonly format: "monotio.agi.part-draft";
  readonly version: 1;
  readonly key: string;
  readonly lifetime: string;
  readonly receipt: string;
  readonly parent: string | null;
  readonly content: ProjectContent | null;
  readonly baseImage?: string | undefined;
}
function readKeys(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  const row = raw as { format?: unknown; version?: unknown; keys?: unknown };
  if (
    row.format !== "monotio.agi.part-drafts" ||
    row.version !== 1 ||
    !Array.isArray(row.keys) ||
    row.keys.some((key: unknown) => typeof key !== "string")
  )
    throw new Error("This draft version needs a newer app. Reopen after updating.");
  for (const key of row.keys) checkProjectDocumentKey(key);
  return row.keys;
}
function readDraft(raw: unknown): PartDraft | undefined {
  if (raw === undefined) return undefined;
  const draft = raw as PartDraft;
  if (draft.format !== "monotio.agi.part-draft" || draft.version !== 1)
    throw new Error("This draft version needs a newer app. Reopen after updating.");
  checkProjectDocumentKey(draft.key);
  if (
    draft.content !== null &&
    typeof draft.content !== "string" &&
    !(draft.content instanceof Uint8Array)
  )
    throw new Error("This draft is damaged. Download your unsaved edits.");
  return draft;
}
export function openProjectDrafts(input: {
  projectId: string;
  lifetime: string;
  journal?: Journal;
  changed?(): void;
  delay?: number;
  currentImage?(): string;
  canWrite?(): boolean;
  read?(key: string): ProjectContent | undefined;
}) {
  const storage = input.journal ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const manifest = `part-drafts/${input.projectId}`;
  const prefix = `monotio_agi.${manifest}/`;
  const client = crypto.randomUUID();
  const clientKey = `${prefix}${client}`;
  const ownership = claimProjectSaveJournal(clientKey);
  liveJournals.add(clientKey);
  const drafts: Record<string, PartDraft> = {};
  const receipts: Record<string, string> = {};
  const recoveredJournals: Record<string, string[]> = {};
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve();
  let disposed = false;
  let error = "";
  let busy = false;
  let blocked = false;
  const past: { before: ProjectChange[]; after: ProjectChange[] }[] = [];
  const future: { before: ProjectChange[]; after: ProjectChange[] }[] = [];
  const observers = new Set<() => void>();
  const notify = () => {
    input.changed?.();
    for (const observer of observers) observer();
  };
  const journalKey = (key: string) => `${prefix}${client}/${key}`;
  function encode(draft: PartDraft): string {
    return JSON.stringify({
      ...draft,
      content:
        draft.content === null ? null : writeProjectWorkspace({ [draft.key]: draft.content }),
    });
  }
  function decode(text: string): PartDraft {
    const raw = JSON.parse(text) as PartDraft;
    const content = raw.content === null ? null : readProjectWorkspace(raw.content)[raw.key]!;
    return readDraft({ ...raw, content })!;
  }
  function checkWriter(): void {
    if (disposed) throw new Error("Open this project again to save changes.");
    if (input.canWrite?.() === false)
      throw new Error("The game changed in another tab. Download your unsaved edits, then reopen.");
  }
  const ready = readBodyRecords(manifest, (raw) =>
    readKeys(raw).map((key) => `${manifest}/${key}`),
  ).then(async (snapshot) => {
    await ownership.ready;
    function inspectBase(draft: PartDraft): void {
      if (
        draft.baseImage !== undefined &&
        input.currentImage &&
        draft.baseImage !== input.currentImage()
      ) {
        blocked = true;
        error = "The game changed in another tab. Download your unsaved edits, then reopen.";
      }
    }
    for (const raw of snapshot.records.values()) {
      const draft = readDraft(raw);
      if (draft === undefined || draft.lifetime !== input.lifetime) continue;
      receipts[draft.key] = draft.receipt;
      const local = drafts[draft.key];
      drafts[draft.key] = local ? { ...local, parent: draft.receipt } : draft;
      if (local) {
        try {
          storage?.setItem(journalKey(draft.key), encode(drafts[draft.key]!));
        } catch {
          error = "Browser storage could not keep a recovery copy. Retry saving before closing.";
        }
      }
    }
    // A terminated page may have journaled a part before opening its IDB transaction.
    const journalKeys = Array.from({ length: storage?.length ?? 0 }, (_, index) =>
      storage!.key(index),
    ).filter((key): key is string => key?.startsWith(prefix) === true);
    for (const key of journalKeys) {
      const owner = key.slice(0, key.lastIndexOf("/"));
      if (liveJournals.has(owner)) continue;
      const recover = () => {
        const source = storage!.getItem(key);
        if (source === null) return;
        const recovered = decode(source);
        if (recovered.lifetime !== input.lifetime) return;
        const current = drafts[recovered.key];
        if (current?.receipt === recovered.receipt) storage!.removeItem(key);
        else if ((current?.receipt ?? null) === recovered.parent) {
          drafts[recovered.key] = recovered;
          pending.add(recovered.key);
          try {
            storage!.setItem(journalKey(recovered.key), encode(recovered));
            storage!.removeItem(key);
          } catch {
            (recoveredJournals[recovered.key] ??= []).push(key);
            error = "Browser storage could not keep a recovery copy. Retry saving before closing.";
          }
        } else {
          blocked = true;
          error = "A draft changed in another tab. Download your unsaved edits, then reopen.";
        }
      };
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (locks)
        await locks.request(owner, { ifAvailable: true }, (lock) => {
          if (lock) recover();
        });
      else recover();
    }
    // A newer recovery journal may carry this page's accepted room image.
    // Check the final recovered draft, after its receipt supersedes storage.
    for (const draft of Object.values(drafts)) inspectBase(draft);
    notify();
    if (pending.size && !blocked && !disposed)
      timer = setTimeout(() => {
        void flush().catch(() => {});
      }, input.delay ?? 250);
  });
  async function persist(key: string): Promise<void> {
    checkWriter();
    const draft = drafts[key]!;
    const receipt = receipts[key] ?? null;
    await updateBodyRecords(
      manifest,
      (raw) => ({
        reads: [`${manifest}/${key}`],
        complete(records) {
          checkWriter();
          const previous = readDraft(records.get(`${manifest}/${key}`));
          if ((previous?.receipt ?? null) !== receipt)
            throw new Error(
              "This part changed in another tab. Download your unsaved edits, then reopen.",
            );
          const keys = [...new Set([...readKeys(raw), key])].sort();
          return {
            result: undefined,
            puts: [
              { projectId: manifest, format: "monotio.agi.part-drafts", version: 1, keys },
              { ...draft, projectId: `${manifest}/${key}` },
            ],
          };
        },
      }),
      historyLifetimeGuard(input.projectId as never, input.lifetime),
    );
    receipts[key] = draft.receipt;
    for (const old of recoveredJournals[key] ?? []) storage?.removeItem(old);
    delete recoveredJournals[key];
    if (drafts[key] === draft) {
      pending.delete(key);
      storage?.removeItem(journalKey(key));
    } else {
      // Rebase a newer local edit on the acknowledged receipt before crash recovery.
      drafts[key] = { ...drafts[key]!, parent: draft.receipt };
      storage?.setItem(journalKey(key), encode(drafts[key]!));
    }
  }
  function flush(): Promise<void> {
    clearTimeout(timer);
    const result = tail.then(async () => {
      await ready;
      busy = true;
      notify();
      try {
        if (blocked) throw new Error(error);
        while (pending.size) await persist([...pending][0]!);
        error = "";
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      } finally {
        busy = false;
        notify();
      }
    });
    tail = result.catch(() => {});
    return result;
  }
  function stage(changes: readonly ProjectChange[]): void {
    checkWriter();
    for (const { key } of changes) checkProjectDocumentKey(key);
    for (const { key, content } of changes) {
      const draft: PartDraft = {
        projectId: `${manifest}/${key}`,
        format: "monotio.agi.part-draft",
        version: 1,
        key,
        lifetime: input.lifetime,
        receipt: crypto.randomUUID(),
        parent: receipts[key] ?? null,
        baseImage: input.currentImage?.(),
        content: content instanceof Uint8Array ? content.slice() : content,
      };
      drafts[key] = draft;
      pending.add(key);
      try {
        storage?.setItem(journalKey(key), encode(draft));
      } catch {
        error = "Browser storage could not keep a recovery copy. Retry saving before closing.";
      }
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, input.delay ?? 250);
  }
  return {
    ready,
    subscribe(observer: () => void) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    stage(changes: readonly ProjectChange[]) {
      stage(changes);
      past.length = 0;
      future.length = 0;
      notify();
    },
    stageTransaction(changes: readonly ProjectChange[]) {
      if (changes.length === 0) return;
      const before = changes.map(({ key }) => ({
        key,
        content: Object.hasOwn(drafts, key) ? drafts[key]!.content : (input.read?.(key) ?? null),
      }));
      stage(changes);
      past.push({
        before,
        after: changes.map(({ key }) => ({ key, content: drafts[key]!.content })),
      });
      future.length = 0;
      notify();
    },
    undo(): boolean {
      const edit = past.at(-1);
      if (!edit) return false;
      stage(edit.before);
      past.pop();
      future.push(edit);
      notify();
      return true;
    },
    redo(): boolean {
      const edit = future.at(-1);
      if (!edit) return false;
      stage(edit.after);
      future.pop();
      past.push(edit);
      notify();
      return true;
    },
    changes(): readonly ProjectChange[] {
      return Object.values(drafts).map(({ key, content }) => ({ key, content }));
    },
    rebase(
      before: { documentId: string; world: ProjectContent | undefined },
      after: { documentId: string; world: ProjectContent | undefined },
    ) {
      if (
        before.documentId === after.documentId ||
        blocked ||
        Object.values(drafts).some(
          (draft) => draft.baseImage !== undefined && draft.baseImage !== before.documentId,
        )
      )
        return;
      const changes = Object.values(drafts).map((draft) => ({
        key: draft.key,
        content:
          draft.key === "world"
            ? rebaseWorldDraft(before.world, after.world, draft.content)
            : draft.content,
      }));
      if (!changes.length) return;
      stage(changes);
      for (const transaction of [...past, ...future])
        for (const change of [...transaction.before, ...transaction.after])
          if (change.key === "world")
            Object.assign(change, {
              content: rebaseWorldDraft(before.world, after.world, change.content),
            });
      notify();
    },
    status() {
      return {
        busy,
        pending: pending.size > 0,
        error,
        canUndo: past.length > 0,
        canRedo: future.length > 0,
      };
    },
    flush,
    async clear() {
      clearTimeout(timer);
      await ready;
      await tail;
      await updateBodyRecords(manifest, (raw) => ({
        reads: Object.keys(drafts).map((key) => `${manifest}/${key}`),
        complete(records) {
          for (const key of Object.keys(drafts))
            if (readDraft(records.get(`${manifest}/${key}`))?.receipt !== receipts[key])
              throw new Error("A draft changed in another tab. Reopen before discarding.");
          const remaining = readKeys(raw).filter((key) => !Object.hasOwn(drafts, key));
          return {
            result: undefined,
            deletes: Object.keys(drafts).map((key) => `${manifest}/${key}`),
            puts: [
              {
                projectId: manifest,
                format: "monotio.agi.part-drafts",
                version: 1,
                keys: remaining,
              },
            ],
          };
        },
      }));
      for (const key of Object.keys(drafts)) {
        delete drafts[key];
        delete receipts[key];
        storage?.removeItem(journalKey(key));
        for (const old of recoveredJournals[key] ?? []) storage?.removeItem(old);
        delete recoveredJournals[key];
      }
      pending.clear();
      past.length = 0;
      future.length = 0;
      error = "";
      blocked = false;
      notify();
    },
    dispose() {
      disposed = true;
      liveJournals.delete(clientKey);
      ownership.release();
      clearTimeout(timer);
    },
  };
}
