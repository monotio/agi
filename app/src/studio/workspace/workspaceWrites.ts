import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";

/** Completed gestures serialize; a typing burst submits its latest complete source. */
export function createWorkspaceWrites(input: {
  write(key: string, content: ProjectContent): Promise<void>;
  durable?(): Promise<void>;
  changed(drafts: Readonly<Record<string, ProjectContent>>, busy: boolean): void;
  error(cause: unknown): void;
  delay?: number;
  maximum?: number;
}) {
  let drafts: Record<string, ProjectContent> = {};
  const pending: Record<string, ProjectContent> = {};
  const identities: Record<string, number> = {};
  let serial = 0;
  const failures: Record<string, unknown> = {};
  let tail = Promise.resolve();
  let active = 0;
  let disposed = false;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let maximum: ReturnType<typeof setTimeout> | undefined;
  function notify(): void {
    const busy = active > 0 || Object.keys(pending).length > 0;
    const key = Object.keys(drafts).find((key) => Object.hasOwn(failures, key));
    if (!busy && key !== undefined) input.error(saveError(key));
    input.changed({ ...drafts }, busy);
  }
  function saveError(key: string): Error {
    const cause = failures[key];
    const message = (cause instanceof Error ? cause.message : String(cause)).replace(/[.]+$/, "");
    return new Error(`Could not save ${key}: ${message}. Retry the save.`);
  }
  function submit(key: string, content: ProjectContent, identity: number): void {
    active++;
    let succeeded = false;
    tail = tail
      .then(async () => {
        if (!disposed) {
          await input.write(key, content);
          succeeded = true;
          delete failures[key];
        }
      })
      .catch((cause: unknown) => {
        failures[key] = cause;
        input.error(cause);
      })
      .finally(() => {
        active--;
        if (succeeded && drafts[key] === content && identities[key] === identity) {
          delete drafts[key];
          delete identities[key];
        }
        notify();
      });
  }
  function drain(): void {
    clearTimeout(delay);
    clearTimeout(maximum);
    delay = maximum = undefined;
    for (const [key, content] of Object.entries(pending)) {
      delete pending[key];
      submit(key, content, identities[key]!);
    }
    notify();
  }
  async function flush(): Promise<void> {
    let captured: Promise<void>;
    do {
      drain();
      captured = tail;
      await captured;
      if (captured !== tail || Object.keys(pending).length > 0) continue;
      const key = Object.keys(drafts)[0];
      if (key !== undefined) {
        throw saveError(key);
      }

      await input.durable?.();
    } while (captured !== tail || Object.keys(pending).length > 0);
  }
  return {
    edit(key: string, content: ProjectContent): void {
      if (disposed) return;
      drafts[key] = content;
      identities[key] = ++serial;
      if (key.startsWith("logic:")) {
        pending[key] = content;
        clearTimeout(delay);
        delay = setTimeout(drain, input.delay ?? 250);
        maximum ??= setTimeout(drain, input.maximum ?? 1000);
      } else submit(key, content, identities[key]!);
      notify();
    },
    flush,
    async retry(): Promise<void> {
      await tail;
      for (const [key, content] of Object.entries(drafts)) pending[key] = content;
      drain();
      await flush();
    },
    dispose(): void {
      disposed = true;
      clearTimeout(delay);
      clearTimeout(maximum);
      for (const key of Object.keys(pending)) delete pending[key];
      drafts = {};
    },
  };
}
