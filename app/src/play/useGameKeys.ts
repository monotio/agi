/**
 * The game's whole-page keyboard, routed in one place: the shell's own keys
 * first, then the Ask bubble, page controls, walkthrough and history
 * playback, and finally the game's prompts, modals, keys and input line.
 * App.vue listens on window; the play area supplies the input line and the
 * key actions it owns.
 */
import type { EngineApi } from "../engine/engineContext.ts";
import type { ModalKind } from "../engine/useEngine.ts";
import { AGI_KEY, translatePlatformKey } from "../../../src/runtime/keys.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { FUNCTION_KEYS, registeredKey, pcKey } from "./gameControls.ts";

/** Minimal subset of the W3C Gamepad object used by the platform joystick poller. */
export interface GamepadInputLike {
  readonly connected?: boolean;
  readonly axes?: readonly number[];
  readonly buttons?: readonly { readonly pressed: boolean }[];
}

export interface GamepadPollState {
  prevDir: number;
  prevBtn0: boolean;
  prevBtn1: boolean;
  btn0ReleaseAt: number;
  btn1ReleaseAt: number;
}

export function createGamepadPollState(): GamepadPollState {
  return {
    prevDir: 0,
    prevBtn0: false,
    prevBtn1: false,
    btn0ReleaseAt: -1000,
    btn1ReleaseAt: -1000,
  };
}

/**
 * Sample one browser Gamepad snapshot into the active profile's original
 * joystick semantics: 8-way direction edge transitions (`JoyDir`) and
 * primary/secondary button edge releases (`WaitJoyButton` / `JoyButton`
 * single/double-click words `0x0101..0x0401` on PC and Amiga, and `0x0101`/`0x0201`
 * or modal `0x0d` on Apple IIgs).
 */
export function stepGamepadPoll(
  pad: GamepadInputLike | null | undefined,
  pollState: GamepadPollState,
  nowMs: number,
  options: {
    readonly profileId: string | null;
    readonly modal: ModalKind | null;
    readonly holdToMove: boolean;
    readonly sendDirection: (dir: number) => void;
    readonly sendKey: (code: number) => void;
  },
): void {
  if (!pad || pad.connected === false) {
    if (pollState.prevDir !== 0) {
      pollState.prevDir = 0;
      if (options.modal === null) {
        if (options.holdToMove) options.sendDirection(0);
        else options.sendKey(0xf500);
      }
    }
    pollState.prevBtn0 = false;
    pollState.prevBtn1 = false;
    return;
  }

  const up = Boolean(pad.buttons?.[12]?.pressed);
  const down = Boolean(pad.buttons?.[13]?.pressed);
  const left = Boolean(pad.buttons?.[14]?.pressed);
  const right = Boolean(pad.buttons?.[15]?.pressed);
  const ax = pad.axes?.[0] ?? 0;
  const ay = pad.axes?.[1] ?? 0;
  const dx = right || ax >= 0.5 ? 1 : left || ax <= -0.5 ? -1 : 0;
  const dy = down || ay >= 0.5 ? 1 : up || ay <= -0.5 ? -1 : 0;
  const dir =
    dx === 0 && dy < 0
      ? 1
      : dx > 0 && dy < 0
        ? 2
        : dx > 0 && dy === 0
          ? 3
          : dx > 0 && dy > 0
            ? 4
            : dx === 0 && dy > 0
              ? 5
              : dx < 0 && dy > 0
                ? 6
                : dx < 0 && dy === 0
                  ? 7
                  : dx < 0 && dy < 0
                    ? 8
                    : 0;

  if (dir !== pollState.prevDir) {
    pollState.prevDir = dir;
    if (dir !== 0) {
      options.sendDirection(dir);
    } else if (options.modal === null) {
      if (options.holdToMove) options.sendDirection(0);
      else options.sendKey(0xf500);
    }
  }

  const btn0 = Boolean(pad.buttons?.[0]?.pressed);
  const btn1 = Boolean(pad.buttons?.[1]?.pressed);
  const presentation =
    options.profileId !== null && Object.hasOwn(PROFILES, options.profileId)
      ? PROFILES[options.profileId as ProfileId].presentation
      : "pc";

  if (pollState.prevBtn0 && !btn0) {
    if (presentation === "iigs") {
      options.sendKey(options.modal !== null ? AGI_KEY.ENTER : 0x0101);
    } else if (nowMs - pollState.btn0ReleaseAt <= 350) {
      pollState.btn0ReleaseAt = -1000;
      options.sendKey(0x0301);
    } else {
      pollState.btn0ReleaseAt = nowMs;
      options.sendKey(0x0101);
    }
  }
  if (pollState.prevBtn1 && !btn1) {
    if (presentation === "iigs") {
      options.sendKey(options.modal !== null ? AGI_KEY.ENTER : 0x0201);
    } else if (nowMs - pollState.btn1ReleaseAt <= 350) {
      pollState.btn1ReleaseAt = -1000;
      options.sendKey(0x0401);
    } else {
      pollState.btn1ReleaseAt = nowMs;
      options.sendKey(0x0201);
    }
  }
  pollState.prevBtn0 = btn0;
  pollState.prevBtn1 = btn1;
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
      const key = translatePlatformKey(ev, state.profile) ?? pcKey(ev);
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

    const nativeKey = translatePlatformKey(ev, state.profile);
    if (
      nativeKey !== undefined &&
      (nativeKey === 0xf500 ||
        nativeKey === 0xff00 ||
        ((nativeKey & 0xff) === 0 && nativeKey >= 0x3b00 && nativeKey <= 0x4400) ||
        state.controls.some((b) => b.key === nativeKey))
    ) {
      ev.preventDefault();
      area()?.triggerKey(nativeKey);
      return;
    }

    const shortcut = registeredKey(ev, state.controls);
    if (shortcut !== undefined) {
      ev.preventDefault();
      area()?.triggerKey(shortcut);
      return;
    }

    if (!state.inputEnabled) {
      const code = translatePlatformKey(ev, state.profile) ?? pcKey(ev);
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
