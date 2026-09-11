import type { LogAgentFn } from "./useInputController.ts";

/**
 * Blocking get.num / get.string prompt awaiting player input. The engine has
 * drawn the prompt at (row, col); the host echoes the live edit after it.
 */
export interface PromptState {
  kind: "getnum" | "getstring" | "saveDescription";
  prompt: string;
  maxLen: number;
  row: number;
  col: number;
}

export interface PromptControllerOptions {
  readonly state: {
    prompt: PromptState | null;
    walkthrough: { seeking: boolean };
  };
  readonly logAgent: LogAgentFn;
}

export interface PromptController {
  readonly submitPrompt: (value: string, cancelled?: boolean) => void;
  readonly handlePromptRequest: (
    kind: "getnum" | "getstring" | "saveDescription",
    context: Record<string, unknown>,
  ) => Promise<string>;
  readonly cancelPrompt: () => void;
  readonly isPromptPending: () => boolean;
}

/**
 * Manages blocking get.num / get.string / saveDescription prompt requests
 * across the SAB bridge and user submission from the DOM or replay runner.
 */
export function usePromptController(options: PromptControllerOptions): PromptController {
  let promptResolver: ((value: string) => void) | null = null;

  function submitPrompt(value: string, cancelled = false): void {
    if (!promptResolver) return;
    if (!cancelled && !options.state.walkthrough.seeking && value.trim().length > 0) {
      options.logAgent("input", value.trim());
    }
    const resolve = promptResolver;
    const response =
      options.state.prompt?.kind === "saveDescription"
        ? JSON.stringify({ value: cancelled ? null : value })
        : value;
    promptResolver = null;
    options.state.prompt = null;
    resolve(response);
  }

  function handlePromptRequest(
    kind: "getnum" | "getstring" | "saveDescription",
    context: Record<string, unknown>,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      promptResolver = resolve;
      options.state.prompt = {
        kind,
        prompt: String(context["prompt"] ?? ""),
        maxLen: Number(context["maxLen"] ?? (kind === "getnum" ? 4 : 40)),
        row: Number(context["row"] ?? 22),
        col: Number(context["col"] ?? 0),
      };
    });
  }

  function cancelPrompt(): void {
    if (promptResolver) {
      promptResolver("");
      promptResolver = null;
    }
    options.state.prompt = null;
  }

  function isPromptPending(): boolean {
    return promptResolver !== null;
  }

  return {
    submitPrompt,
    handlePromptRequest,
    cancelPrompt,
    isPromptPending,
  };
}
