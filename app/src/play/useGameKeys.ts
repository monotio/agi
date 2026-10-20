/**
 * The game's whole-page keyboard, routed in one place: the shell's own keys
 * first, then the Agent bubble, page controls, walkthrough and history
 * playback, and finally the game's prompts, modals, keys and input line.
 * App.vue listens on window; the play area supplies the input line and the
 * key actions it owns.
 */
import type { EngineApi } from "../engine/engineContext.ts";
import type { ModalKind } from "../engine/useEngine.ts";
import { translatePlatformKey, type JoystickSample } from "../../../src/runtime/keys.ts";
import { FUNCTION_KEYS } from "./gameControls.ts";

/** Minimal subset of the W3C Gamepad object used by the platform joystick poller. */
export interface GamepadInputLike {
  readonly connected?: boolean;
  readonly axes?: readonly number[];
  readonly buttons?: readonly { readonly pressed: boolean }[];
}

/** Convert the browser's stick/D-pad snapshot without inventing native key events. */
export function gamepadSample(pad: GamepadInputLike | null | undefined): JoystickSample | null {
  if (!pad || pad.connected === false) return null;
  const axis = (index: number): number => {
    const value = pad.axes?.[index] ?? 0;
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  };
  const up = Boolean(pad.buttons?.[12]?.pressed),
    down = Boolean(pad.buttons?.[13]?.pressed);
  const left = Boolean(pad.buttons?.[14]?.pressed),
    right = Boolean(pad.buttons?.[15]?.pressed);
  return {
    x: left || right ? Number(right) - Number(left) : axis(0),
    y: up || down ? Number(down) - Number(up) : axis(1),
    button1: Boolean(pad.buttons?.[0]?.pressed),
    button2: Boolean(pad.buttons?.[1]?.pressed),
  };
}

/** Sample the first connected controller for boot and the mounted play surface. */
export function connectedGamepad(): JoystickSample | null {
  const pads = typeof navigator === "undefined" ? undefined : navigator.getGamepads?.();
  return gamepadSample(pads ? Array.from(pads).find((p) => p && p.connected !== false) : null);
}

/**
 * The controller's 60 Hz poll, sharing the keyboard's ownership rule: only
 * while the game owns the page do its samples and fire buttons reach it.
 * While a page control, sheet or dialog holds the keyboard the poll posts a
 * neutral sample instead, so nothing held crosses the handoff and no stale
 * press can fire late when the game takes the page back.
 */
export function createGamepadPoll(deps: {
  /** The whole ownership gate: engine phase, readiness and who owns the page. */
  gameOwnsPad(): boolean;
  /** The live pad snapshot, or null when none answers. */
  sample(): JoystickSample | null;
  /** Post a pad sample (or neutral) to the game; the caller dedupes. */
  send(sample: JoystickSample | null): void;
  /** A blocking get.string/get.num prompt turns fire-button edges into words. */
  prompt(): boolean;
  /** Deliver a fire word (0x0101/0x0201) into the open prompt. */
  promptKey(code: number): void;
  /** "amiga" has one fire button; "iigs" fires on press, the rest on release. */
  presentation(): string;
}): () => void {
  let buttons = [false, false];
  // A button that crossed the handoff still held is stale until a poll sees
  // it released: its press edge happened under the host control, so neither
  // convention may fire it — not on return (IIgs) and not on its late release.
  let stale = [false, false];
  return () => {
    if (!deps.gameOwnsPad()) {
      buttons = [false, false];
      stale = [true, true];
      deps.send(null);
      return;
    }
    const sample = deps.sample();
    const next = [Boolean(sample?.button1), Boolean(sample?.button2)];
    // A button held across the handoff stays stale until an owned poll sees
    // it up — prompt or no prompt — and that release is not a fire edge.
    const wasStale = [stale[0], stale[1]];
    for (let i = 0; i < 2; i++) if (!next[i]) stale[i] = false;
    if (deps.prompt()) {
      deps.send(null);
      // The Amiga gameport has one fire button (F-IN-17).
      for (let i = 0; i < (deps.presentation() === "amiga" ? 1 : 2); i++) {
        if (wasStale[i]!) continue;
        const pressed = next[i]!;
        const wasPressed = buttons[i]!;
        if (deps.presentation() === "iigs" ? pressed && !wasPressed : wasPressed && !pressed)
          deps.promptKey(i === 0 ? 0x0101 : 0x0201);
      }
    } else deps.send(sample);
    buttons = next;
  };
}

/**
 * The native key word for a physical key, or undefined when the browser keeps
 * it. The Command key belongs to the browser (copy, paste, reload) unless the
 * game binds the word it makes: no shipped game binds an Amiga-qualified word
 * (docs/fidelity.md "Original input, menu and modal handling", F-IN-16).
 */
export function nativeGameKey(
  ev: KeyboardEvent,
  profile: string | null,
  controls: readonly { readonly key: number }[],
): number | undefined {
  const key = translatePlatformKey(ev, profile);
  if (key === undefined || !ev.metaKey) return key;
  return controls.some((binding) => binding.key === key) ? key : undefined;
}

/** What the keyboard routing needs from PlayArea's exposed API. */
export interface KeyTarget {
  readonly inputEl: HTMLInputElement | null;
  submit(): void;
  onPromptKey(ev: KeyboardEvent): void;
  onModalKey(ev: KeyboardEvent): void;
  triggerKey(code: number): void;
  movementKeyDown(ev: KeyboardEvent): boolean;
  movementKeyUp(ev: KeyboardEvent): void;
  mirrorPrintableChar(char: string): void;
  focusInput(): void;
}

/**
 * Page controls keep every key: nothing typed on the timeline, a menu, a
 * button or the shell's own regions reaches the game. Only the game's input,
 * or in Play the page itself, passes keys to the interpreter.
 */
export const PAGE_CONTROLS =
  "button, input, textarea, select, a, audio, summary, dialog, [data-shell-keys]";

export function useGameKeys(deps: {
  engine: EngineApi;
  playArea: () => KeyTarget | null | undefined;
  creating: () => boolean;
  /** Shell keys taken before the game: true when the event was consumed. */
  intercept: (ev: KeyboardEvent) => boolean;
}) {
  const {
    state,
    resumeAudio,
    closePowerUp,
    toggleWalkthroughPause,
    resumeWalkthrough,
    advanceDialog,
    sendKey,
  } = deps.engine;
  const area = deps.playArea;

  /**
   * Whole-page keyboard trapping: the browser chrome should disappear. Arrows
   * always steer ego (even while the input line is focused — the classic AGI
   * feel); any printable keystroke jumps into the input line; Enter dismisses
   * the print modal first, then submits.
   */
  function onKeydown(ev: KeyboardEvent): void {
    resumeAudio();
    // The shell's own keys (Create's dock keys, Studio over the paused
    // game) are taken before the game sees anything.
    if (deps.intercept(ev)) return;
    const isInputReady =
      state.walkthrough.active || state.historyView.active ? true : state.inputReady;
    if (state.phase !== "running" || !isInputReady) return;
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.target instanceof Element && ev.target.closest("dialog[open]")) return;
    // Play hints own the keyboard; Create routes each key by its focused zone.
    if (state.powerUp.open && !deps.creating()) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closePowerUp();
        if (!state.powerUp.open) area()?.focusInput();
      }
      return;
    }
    // Page controls keep native keyboard behavior. The invisible input owns
    // game keys; Shift+Tab lets a player leave it even during a game modal.
    // These guards run before the walkthrough shortcuts too, so a map dialog's
    // note field keeps its Space and Enter.
    // Shell chrome (the bars, docks and drawer) keeps its keys too: nothing
    // typed there may reach the game's parser.
    const target = ev.target;
    if (
      (target instanceof Element && target !== area()?.inputEl && target.closest(PAGE_CONTROLS)) ||
      (ev.key === "Tab" && ev.shiftKey)
    ) {
      return;
    }
    // Tab belongs to the game while it has the keyboard (Sierra games open the
    // inventory with it); Shift+Tab, above, is the documented way out.
    if (ev.key === "Tab" && target === area()?.inputEl) ev.preventDefault();
    if (
      state.walkthrough.active &&
      (state.walkthrough.status === "playing" ||
        state.walkthrough.status === "paused" ||
        state.walkthrough.status === "completed")
    ) {
      // The walkthrough drives the game; human keys own playback shortcuts only.
      if (ev.key === " ") {
        ev.preventDefault();
        toggleWalkthroughPause();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (state.walkthrough.status === "paused") {
          resumeWalkthrough();
          return;
        }
        if (advanceDialog()) return;
      }
      return;
    }
    if (state.historyView.active) {
      // The tape owns the keyboard: playback shortcuts only — the parked
      // engine gets nothing while the recording is under view.
      if (ev.key === " ") {
        ev.preventDefault();
        deps.engine.historyView.transportToggle();
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        deps.engine.historyView.exitHistory();
        return;
      }
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        void deps.engine.historyView.stepMark(ev.key === "ArrowRight" ? 1 : -1);
        return;
      }
      return;
    }
    if (state.historyView.parked) {
      // The transport holds a live pause: Space/Escape resume where the game
      // froze; every other key queues into the paused engine exactly as it
      // does under a map or bubble pause.
      if (ev.key === " " || ev.key === "Escape") {
        ev.preventDefault();
        deps.engine.historyView.resumeLive();
        return;
      }
    }
    if (ev.key === "ScrollLock") {
      ev.preventDefault();
      sendKey(0x4600);
      return;
    }
    if (state.prompt) {
      area()?.onPromptKey(ev);
      return;
    }
    const activeModal =
      state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
        ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
        : state.modal;
    if (activeModal !== null) {
      area()?.onModalKey(ev);
      return;
    }

    // Text screens can ask a specific question: preserve the actual key.
    if (
      state.textMode ||
      state.waitingForKey ||
      (state.walkthrough.active && window.__AGI_REPLAY__?.latest?.blocked === "waitkey")
    ) {
      const key = nativeGameKey(ev, state.profile, state.controls);
      if (key !== undefined) {
        ev.preventDefault();
        sendKey(key);
      }
      return;
    }

    // Intercept Function Keys F1..F10 (prevent browser reload, help, devtools)
    if (ev.key in FUNCTION_KEYS && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault();
      area()?.triggerKey(FUNCTION_KEYS[ev.key]!);
      return;
    }

    if (area()?.movementKeyDown(ev)) return;

    // Bound keys, Keypad 5 (stop) and the native sound switch reach the game.
    // Unbound keys keep their browser meaning (editing the command draft):
    // the original's input phase ignores them (F-Parser-12).
    const nativeKey = nativeGameKey(ev, state.profile, state.controls);
    if (
      nativeKey !== undefined &&
      (nativeKey === 0xf500 ||
        nativeKey === 0xff00 ||
        state.controls.some((b) => b.key === nativeKey))
    ) {
      ev.preventDefault();
      area()?.triggerKey(nativeKey);
      return;
    }

    if (!state.inputEnabled) {
      const code = nativeGameKey(ev, state.profile, state.controls);
      if (code !== undefined) {
        ev.preventDefault();
        sendKey(code);
      }
      return;
    }

    if (ev.key === "Escape") {
      ev.preventDefault();
      sendKey(0x001b);
      return;
    }

    const input = area()?.inputEl;
    // When input field is NOT focused:
    if (!input || ev.target !== input) {
      // If Enter or Space pressed while not typing, forward raw key event to wake have.key() (e.g. title screens)
      if (ev.key === "Enter" || ev.key === " ") {
        sendKey(ev.key === "Enter" ? 0x000d : 0x0020);
        ev.preventDefault();
        return;
      }
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        area()?.mirrorPrintableChar(ev.key);
        ev.preventDefault();
      }
      return;
    }

    // When input field IS focused:
    if (ev.key === "Enter") {
      ev.preventDefault();
      area()?.submit();
    }
  }

  function onKeyup(ev: KeyboardEvent): void {
    area()?.movementKeyUp(ev);
  }

  return { onKeydown, onKeyup };
}
