/**
 * The game's whole-page keyboard (App.vue listens on window). Split from the
 * shell root so the routing reads in one place; the play area supplies the
 * input line and the key actions it owns.
 */
import type { EngineApi } from "./engineContext.ts";
import type { ModalKind } from "./useEngine.ts";
import { FUNCTION_KEYS, registeredKey, pcKey } from "./gameControls.ts";

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

export function useGameKeys(deps: {
  engine: EngineApi;
  playArea: () => KeyTarget | null | undefined;
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
    historyView,
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
    // The bubble owns the keyboard while it is open: the world is frozen and
    // nothing typed here may reach the interpreter's input line.
    if (state.powerUp.open) {
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
      (target instanceof Element &&
        target !== area()?.inputEl &&
        target.closest(
          "button, input, textarea, select, a, audio, summary, dialog, [data-shell-keys]",
        )) ||
      (ev.key === "Tab" && ev.shiftKey)
    ) {
      return;
    }
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
        historyView.transportToggle();
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        historyView.exitHistory();
        return;
      }
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        void historyView.stepMark(ev.key === "ArrowRight" ? 1 : -1);
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
        historyView.resumeLive();
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
      const key = pcKey(ev);
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

    const shortcut = registeredKey(ev, state.controls);
    if (shortcut !== undefined) {
      ev.preventDefault();
      area()?.triggerKey(shortcut);
      return;
    }

    if (!state.inputEnabled) {
      const code = pcKey(ev);
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
