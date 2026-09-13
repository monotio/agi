import type {
  GameInspection,
  PreviewWorkerInbound,
  PreviewWorkerOutbound,
} from "./gameInspection.ts";

/** The wall-clock deadline also bounds pathological binary decoders, outside bytecode budgets. */
export async function previewGame(game: {
  files: Record<string, Uint8Array>;
  words: [string, number][];
}): Promise<Omit<GameInspection, "rgba" | "rows"> & { preview: string }> {
  const worker = new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" });
  const result = await new Promise<GameInspection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(
        new Error(
          "The opening took too long to check. The game may need an unsupported interpreter extension. Try another release.",
        ),
      );
    }, 12_000);
    const finish = (): void => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<PreviewWorkerOutbound>) => {
      finish();
      if ("result" in event.data) resolve(event.data.result);
      else
        reject(
          new Error(
            `We could not start this game: ${event.data.error}. Check that the folder contains all its AGI files, or try another release.`,
          ),
        );
    };
    worker.onerror = () => {
      finish();
      reject(new Error("The preview could not run. Reload the app and try again."));
    };
    // The worker inspects resources only; an imported project's transcript and
    // authoring state must not be cloned into it.
    worker.postMessage({ files: game.files, words: game.words } satisfies PreviewWorkerInbound);
  });
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not create a game preview.");
  context.putImageData(new ImageData(result.rgba, 320, 200), 0, 0);
  return {
    status: result.status,
    message: result.message,
    profile: result.profile,
    preview: canvas.toDataURL("image/png"),
  };
}
