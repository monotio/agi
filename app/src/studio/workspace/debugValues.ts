import { scanLogicTokens, type Token } from "../../../../src/logic/syntax.ts";
import { ACTION_BY_NAME, CONDITION_BY_NAME } from "../../../../src/logic/opcodes.ts";

export interface LogicValue {
  kind: "variable" | "flag";
  slot: number;
  names: string;
}

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
