/** Event-driven waits used by fixtures evaluated inside the browser. */
export function waitForSignal(
  predicate: () => boolean,
  subscribe: (check: () => void) => () => void,
  timeoutMs = 5000,
): Promise<boolean> {
  // wall-clock: bounds a missing event; successful waits resolve on the event itself.
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Browser signal deadline exceeded"));
    }, timeoutMs);
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(true);
    };
    const unsubscribe = subscribe(check);
    check();
  });
}

export function audioState(
  context: AudioContext,
  state: AudioContextState,
  timeoutMs = 1200,
): Promise<boolean> {
  return waitForSignal(
    () => context.state === state,
    (check) => {
      context.addEventListener("statechange", check);
      return () => context.removeEventListener("statechange", check);
    },
    timeoutMs,
  );
}

/** A silent source reports elapsed audio time through the browser's ended event. */
export function audioElapsed(context: AudioContext, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    source.loop = true;
    source.connect(context.destination);
    source.onended = () => {
      source.disconnect();
      resolve();
    };
    source.start();
    source.stop(context.currentTime + seconds);
  });
}

/** An independent running context witnesses time while the tested context is frozen. */
export async function audioWitness(seconds: number): Promise<void> {
  const context = new AudioContext();
  try {
    await context.resume();
    await audioElapsed(context, seconds);
  } finally {
    await context.close();
  }
}
