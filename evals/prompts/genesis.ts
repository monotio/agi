import { AGI_SYSTEM_PROMPT, createGenesisPrompt } from "../../src/agent/prompt.ts";

interface PromptMessage {
  role: "system" | "user";
  content: string;
}

/** Promptfoo prompt context; `vars` carries the test case's variables. */
export interface PromptVars {
  vars: { cartridgeText?: string };
}

export default function ({ vars }: PromptVars): PromptMessage[] {
  const cartridgeText = vars.cartridgeText || "";
  return [
    {
      role: "system",
      content: AGI_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: createGenesisPrompt(cartridgeText),
    },
  ];
}
