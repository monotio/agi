import { AGI_SYSTEM_PROMPT, createGenesisPrompt } from "../../src/agent/prompt.ts";

export default function ({ vars }) {
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
