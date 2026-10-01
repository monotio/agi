import { scanLogicTokens, type Token } from "../../../../src/logic/syntax.ts";
import { ACTION_BY_NAME, CONDITION_BY_NAME } from "../../../../src/logic/opcodes.ts";

export interface LogicValue {
  kind: "variable" | "flag";
  slot: number;
  names: string;
}

// Reserved roles: AGI specifications, sections 3.3 and 3.4.
// https://www.agidev.com/articles/agispec/agispecs-3.html
// Cycle, edge and room roles also follow agi-re's runtime and object chapters.
export const reservedValues: Readonly<
  Record<LogicValue["kind"], Readonly<Record<number, string>>>
> = {
  variable: {
    0: "Room",
    1: "Previous room",
    2: "Hero edge",
    3: "Score",
    4: "Object touching edge",
    5: "Object edge",
    6: "Hero direction",
    7: "Maximum score",
    8: "Free memory",
    9: "Unknown word",
    10: "Cycle delay",
    11: "Clock seconds",
    12: "Clock minutes",
    13: "Clock hours",
    14: "Clock days",
    15: "Joystick sensitivity",
    16: "Hero view",
    17: "Error code",
    18: "Error detail",
    19: "Key pressed",
    20: "Computer type",
    21: "Window timeout",
    22: "Sound type",
    23: "Sound volume",
    24: "Input limit",
    25: "Selected item",
    26: "Monitor type",
  },
  flag: {
    0: "Hero on water",
    1: "Hero hidden",
    2: "Command entered",
    3: "Hero on trigger",
    4: "Command accepted",
    5: "New room",
    6: "Game restarted",
    7: "Script recording blocked",
    8: "Joystick sensitivity enabled",
    9: "Sound enabled",
    10: "Trace enabled",
    11: "First LOGIC 0 cycle",
    12: "Game restored",
    13: "Inventory selection enabled",
    14: "Menu enabled",
    15: "Window stays open",
  },
};

/** Inspect operand positions in the captured source, including local and global defines. */
export function logicValues(
  source: string,
  bindings: Readonly<Record<string, { readonly num: number; readonly kind?: string }>>,
): LogicValue[] {
  const tokens = scanLogicTokens(source);
  const defines: Record<string, number> = Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [name, binding.num]),
  );
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.text === "#define") {
      const name = tokens[i + 1];
      const value = tokens[i + 2];
      if (name?.type === "ident" && value?.type === "number")
        defines[name.text] = Number(value.text);
    }
  }
  const rows: Record<string, LogicValue> = {};
  function add(kind: LogicValue["kind"], token: Token | undefined): void {
    if (!token || token.type === "string") return;
    const raw = /^[vf](\d+)$/.exec(token.text);
    const slot = raw
      ? Number(raw[1])
      : token.type === "number"
        ? Number(token.text)
        : defines[token.text];
    if (slot === undefined || slot < 0 || slot > 255) return;
    const key = `${kind}:${slot}`;
    const row = (rows[key] ??= { kind, slot, names: "" });
    if (token.type === "ident" && !raw) {
      const names = row.names ? row.names.split(", ") : [];
      if (!names.includes(token.text)) row.names = [...names, token.text].join(", ");
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== "ident") continue;
    if (tokens[i + 1]?.text === "=") {
      add("variable", token);
      const right = tokens[i + 2];
      if (right?.type === "ident" && /^v\d+$/.test(right.text)) add("variable", right);
    }
    const spec = ACTION_BY_NAME[token.text] ?? CONDITION_BY_NAME[token.text];
    if (!spec || tokens[i + 1]?.text !== "(") continue;
    spec.operands.forEach((kind, index) => {
      if (kind === "var" || kind === "flag")
        add(kind === "var" ? "variable" : "flag", tokens[i + 2 + index * 2]);
    });
  }
  return Object.values(rows).sort((a, b) =>
    a.kind === b.kind ? a.slot - b.slot : a.kind === "variable" ? -1 : 1,
  );
}
