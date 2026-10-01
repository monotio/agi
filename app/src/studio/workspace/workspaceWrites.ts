import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";

/** Completed gestures serialize; a typing burst submits its latest complete source. */
export function createWorkspaceWrites(input: {
  write(key: string, content: ProjectContent): Promise<void>;
  changed(drafts: Readonly<Record<string, ProjectContent>>, busy: boolean): void;
  error(cause: unknown): void;
  delay?: number;
  maximum?: number;
}) {
  let drafts: Record<string, ProjectContent> = {};
  const pending: Record<string, ProjectContent> = {};
  let tail = Promise.resolve();
  let active = 0;
  let disposed = false;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let maximum: ReturnType<typeof setTimeout> | undefined;
  function notify(): void {
    input.changed({ ...drafts }, active > 0 || Object.keys(pending).length > 0);
  }
  function submit(key: string, content: ProjectContent): void {
    active++;
    let succeeded = false;
    tail = tail
      .then(async () => {
        if (!disposed) {
          await input.write(key, content);
          succeeded = true;
        }
      })
      .catch(input.error)
      .finally(() => {
        active--;
        if (succeeded && drafts[key] === content) delete drafts[key];
        notify();
      });
  }
  function drain(): void {
    clearTimeout(delay);
    clearTimeout(maximum);
    delay = maximum = undefined;
    for (const [key, content] of Object.entries(pending)) {
      delete pending[key];
      submit(key, content);
    }
    notify();
  }
  return {
    edit(key: string, content: ProjectContent): void {
      if (disposed) return;
      drafts[key] = content;
      if (key.startsWith("logic:")) {
        pending[key] = content;
        clearTimeout(delay);
        delay = setTimeout(drain, input.delay ?? 250);
        maximum ??= setTimeout(drain, input.maximum ?? 1000);
      } else submit(key, content);
      notify();
    },
    flush(): Promise<void> {
      drain();
      return tail;
    },
    async retry(): Promise<void> {
      await tail;
      for (const [key, content] of Object.entries(drafts)) pending[key] = content;
      drain();
      await tail;
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
