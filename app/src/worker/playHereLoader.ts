import type { Inbound, WorkerContext } from "./context.ts";
import type { createPlayHere } from "./playHere.ts";

/** The room-jump tools load only when the player asks to move the live game. */
export function createPlayHereLoader(ctx: WorkerContext) {
  let handler: ReturnType<typeof createPlayHere> | null = null;
  let loading: Promise<void> | null = null;

  function onPlayHere(msg: Inbound<"playHere">): void {
    if (handler !== null) return handler.onPlayHere(msg);
    const generation = ctx.run.generation;
    const previewSerial = ctx.previewVisitSerial;
    loading ??= import("./playHere.ts").then((module) => {
      handler = module.createPlayHere(ctx);
    });
    void loading
      .then(() => {
        if (
          ctx.run.generation === generation &&
          (!(msg.visit || msg.launch) || ctx.previewVisitSerial === previewSerial)
        )
          handler!.onPlayHere(msg);
        else
          ctx.ports.control({
            type: "playedHere",
            id: msg.id,
            ok: false,
            room: ctx.run.engine?.vars[0] ?? 0,
            x: ctx.run.engine?.screenObjects[0]?.x ?? 0,
            y: ctx.run.engine?.screenObjects[0]?.y ?? 0,
            reason:
              ctx.run.generation === generation
                ? "Play started while the room visit loaded. Choose Create and open the room again."
                : "The game changed while Play here loaded. Try again.",
          });
      })
      .catch((error: unknown) => {
        ctx.ports.control({
          type: "playedHere",
          id: msg.id,
          ok: false,
          room: ctx.run.engine?.vars[0] ?? 0,
          x: ctx.run.engine?.screenObjects[0]?.x ?? 0,
          y: ctx.run.engine?.screenObjects[0]?.y ?? 0,
          reason: `Play here could not load: ${String(error)}`,
        });
      });
  }

  return { onPlayHere };
}
