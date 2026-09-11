import { AGI_SYSTEM_PROMPT, createGenesisPrompt } from "../../src/agent/prompt.ts";

interface PromptMessage {
  role: "system" | "user";
  content: string;
}

/** Promptfoo prompt context; `vars` carries the test case's variables. */
export interface PromptVars {
  vars: { templateText?: string };
}

export default function ({ vars }: PromptVars): PromptMessage[] {
  const templateText = vars.templateText || "";
  return [
    {
      role: "system",
      content: AGI_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: createGenesisPrompt(templateText),
    },
  ];
}
