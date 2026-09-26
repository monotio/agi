/**
 * Bounded, memoised thumbnail rendering for the Home shelf. Each key renders
 * at most once per session (successes and failures are both remembered, so a
 * broken game is not re-run on every scroll), and no more than `limit`
 * renders run at the same time. Results live in memory only: thumbnails are
 * never written to storage.
 */
export interface ThumbnailQueue {
  /**
   * The render for `key`: the remembered result, the one already in flight,
   * or a new one started when a slot is free. A request aborted before its
   * render starts is dropped, so a later request for the key starts over.
   */
  request(key: string, render: () => Promise<string>, signal?: AbortSignal): Promise<string>;
  /** A finished render, synchronously, or undefined. */
  cached(key: string): string | undefined;
}

export function createThumbnailQueue(limit: number): ThumbnailQueue {
  const requests = new Map<string, Promise<string>>();
  const results = new Map<string, string>();
  const waiting: (() => void)[] = [];
  let active = 0;

  function drain(): void {
    while (active < limit && waiting.length > 0) waiting.shift()!();
  }

  function request(
    key: string,
    render: () => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const existing = requests.get(key);
    if (existing) return existing;
    const pending = new Promise<string>((resolve, reject) => {
      waiting.push(() => {
        if (signal?.aborted) {
          requests.delete(key);
          reject(new DOMException("The thumbnail is no longer needed.", "AbortError"));
          return;
        }
        active++;
        Promise.resolve()
          .then(render)
          .then((value) => {
            results.set(key, value);
            resolve(value);
          }, reject)
          .finally(() => {
            active--;
            drain();
          });
      });
    });
    requests.set(key, pending);
    drain();
    return pending;
  }

  return { request, cached: (key) => results.get(key) };
}
