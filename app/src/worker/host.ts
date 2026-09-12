/**
 * The EngineHost the interpreter sees. Every callback reads the context
 * directly or reaches another module through ctx.fns.
 */
import { openContainer } from "../../../src/container/container.ts";
import { HostWait, type EngineHost } from "../../../src/runtime/engine.ts";
import { bytesToBase64 } from "../bytes.ts";
import type { WorkerContext } from "./context.ts";

export function createEngineHost(ctx: WorkerContext): EngineHost {
  return {
    randomWord() {
      let value: number;
      if (!ctx.replay.replay) value = Math.floor(Math.random() * 65536);
      else {
        ctx.replay.replay.random =
          (Math.imul(ctx.replay.replay.random, 1664525) + 1013904223) >>> 0;
        value = ctx.replay.replay.random >>> 16;
      }
      ctx.recording.recording?.tape.host(["random", value]);
      return value;
    },
    print(text) {
      if (ctx.recording.recording && ctx.recording.recording.printed.length < 16)
        ctx.recording.recording.printed.push(text.slice(0, 400));
      ctx.ports.presentation({ type: "print", text });
    },
    /**
     * The text surface is composited into every posted frame, so per-call
     * display/clear/text-mode mirrors are not shipped — they would only
     * duplicate bytes the next frame already carries.
     */
    displayAt() {},
    /**
     * Key wait for have.key busy loops, selectors and confirmations. Queued
     * keys answer synchronously; otherwise the engine suspends on the thrown
     * HostWait and the next key message delivers the answer — the worker keeps
     * serving application messages meanwhile.
     */
    waitKey() {
      const buffered = ctx.input.keyQueue.shift();
      if (buffered !== undefined) {
        ctx.recording.recording?.tape.host(["waitKey", buffered]);
        return buffered;
      }
      ctx.fns.setKeyWaiting(true);
      if (ctx.replay.replay) ctx.fns.postReplay("waitkey");
      throw new HostWait();
    },
    statusLine(text) {
      ctx.ports.presentation({ type: "status", text });
    },
    takeInputLine() {
      const line = ctx.input.inputBuffer.shift() ?? null;
      ctx.recording.recording?.tape.host(["line", line]);
      return line;
    },
    takeKeys() {
      const keys = ctx.input.keyQueue.splice(0);
      ctx.recording.recording?.tape.host(["keys", keys.slice()]);
      return keys;
    },
    prepareRoom(room, from) {
      if (!ctx.boot.authorRooms || !ctx.engine) return true;
      const container = openContainer(ctx.engine.containerFiles);
      if (container.getResource("logic", room)) return true;
      // The agent's answer lands in deliverHostResponse, which applies the
      // patch and delivers true/false to the suspended new.room.
      return ctx.fns.postHostRequest("room", {
        room,
        from,
        edge: ctx.engine.vars[2],
        state: ctx.engine.readState(),
        objects: ctx.engine.readObjects(),
      });
    },
    /** 0x6e shake.screen: cosmetic jitter on the main thread. */
    shakeScreen(count) {
      ctx.ports.presentation({ type: "shake", count });
    },
    /** 0x81/0xa2 show.obj: modal view popup (engine pauses on the open modal). */
    showObj(viewNum) {
      ctx.ports.presentation({ type: "showObj", viewNum });
    },
    // show.pri.screen and status (inventory) report through frame.modal; the
    // exploded view needs show.obj's view number, so that notice stays.
    /** 0x76 get.num: a host-request prompt; the engine suspends until answered. */
    promptNumber(prompt, row, col) {
      return ctx.fns.postHostRequest("getnum", { prompt, row, col });
    },
    /** 0x73 get.string: a host-request prompt; the engine suspends until answered. */
    promptString(prompt, maxLen, row, col) {
      return ctx.fns.postHostRequest("getstring", { prompt, maxLen, row, col });
    },
    /**
     * 0x7d save.game: the selector's directory listing is a host request; the
     * response's base64 images decode on delivery.
     */
    listSaveGames() {
      return ctx.fns.postHostRequest("saveList", {});
    },
    get promptSaveDescription() {
      // Replays drive the save dialog with recorded key presses, so the engine's
      // own in-dialog editor must run: a DOM prompt can never be answered by a
      // recorded key, only by an explicit answer action.
      if (ctx.replay.replay) return undefined;
      return (initial: string, maxLen: number, row: number, col: number) =>
        ctx.fns.postHostRequest("saveDescription", { initial, maxLen, row, col });
    },
    saveGame(bytes, slot = 1) {
      // The main thread owns localStorage; the image travels as base64.
      return ctx.fns.postHostRequest("saveWrite", { slot, image: bytesToBase64(bytes) });
    },
    /** 0x7e restore.game: the save lookup is a host request; null = cancelled. */
    restoreGame(slot = 1) {
      return ctx.fns.postHostRequest("restore", { slot });
    },
    /** 0x90 log / 0x85 obj.status.v / 0x87 show.mem: debug log stream. */
    logText(text) {
      ctx.ports.presentation({ type: "log", text });
    },
    /** 0x8d version: stored into a string slot by the engine. */
    versionString() {
      const value = ctx.engine ? `AGI ${ctx.engine.profile.id}` : "AGI IS HERE";
      ctx.recording.recording?.tape.host(["version", value]);
      return value;
    },
    quit() {
      ctx.fns.stopTimers();
      ctx.ports.presentation({ type: "quit" });
    },
    /** Playback state only; the engine emits scheduled audio commands separately. */
    playSound(soundNum) {
      ctx.ports.presentation({ type: "sound", soundNum });
    },
    soundDevice() {
      ctx.recording.recording?.tape.host(["soundDevice", ctx.boot.selectedSoundDevice]);
      return ctx.boot.selectedSoundDevice;
    },
    soundOutput(output) {
      ctx.ports.presentation({ type: "soundOutput", output });
    },
    /** 0x64 stop.sound: silence playback on the main thread. */
    stopSound() {
      ctx.ports.presentation({ type: "stopSound" });
    },
  };
}
