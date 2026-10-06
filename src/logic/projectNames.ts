/** Named resources and game state share authored uses with the LOGIC language server. */
import { createProjectLogicLanguageSnapshot } from "../authoring/projectLanguage.ts";
import { PROFILES } from "../runtime/profile.ts";
import { commandReference } from "./commandReference.ts";
import { analyzeLogicSyntax } from "./syntax.ts";
import { rangeAt, type Range } from "./lspTypes.ts";
import type { LogicLanguageProject } from "./lspServer.ts";
import { BINDING_KINDS } from "./languageOperands.ts";
import { systemBindingInfos } from "./systemNames.ts";

export interface BindingInfo {
  readonly name: string;
  readonly kind: string;
  readonly num: number;
  readonly logic?: number;
  /** Supplied by a template or ready part, not named by the creator. */
  readonly builtin?: boolean;
  readonly uses: readonly {
    key: string;
    uri: string;
    range: Range;
    role: "Set" | "Checked" | "Used";
    text: string;
    operation?: "Reset" | "View" | "Positioned" | "Drawn";
  }[];
}
// Destination operands of AGI actions; sound/cycle callbacks set flags later.
const WRITES: Record<string, readonly number[]> = {
  set: [0],
  reset: [0],
  toggle: [0],
  assignn: [0],
  assignv: [0],
  increment: [0],
  decrement: [0],
  addn: [0],
  addv: [0],
  subn: [0],
  subv: [0],
  muln: [0],
  mulv: [0],
  divn: [0],
  divv: [0],
  rindirect: [0],
  "get.posn": [1, 2],
  "get.priority": [1],
  "get.dir": [1],
  "get.cel": [1],
  "get.loop": [1],
  "get.view": [1],
  "last.cel": [1],
  "number.of.loops": [1],
  distance: [2],
  "get.room.v": [1],
  "get.num": [1],
  random: [2],
  sound: [1],
  "end.of.loop": [1],
  "reverse.loop": [1],
  "move.obj": [4],
  "move.obj.v": [4],
  "follow.ego": [2],
};

export function projectOperandInfos(project: LogicLanguageProject): BindingInfo[] {
  const infos = Object.entries(project.bindings)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, binding]) => ({
      name,
      kind: binding.kind ?? "resource",
      num: binding.num,
      ...(binding.logic === undefined ? {} : { logic: binding.logic }),
      uses: [] as BindingInfo["uses"][number][],
    }));
  for (const info of systemBindingInfos()) {
    if (
      !infos.some(
        (entry) => entry.name === info.name || (entry.kind === info.kind && entry.num === info.num),
      )
    )
      infos.push({ ...info, uses: [] });
  }
  const commands = Object.fromEntries(
    commandReference(PROFILES[project.profileId]).map((command) => [command.name, command]),
  );
  for (const [key, document] of Object.entries(project.documents)) {
    const { source } = document;
    const syntax = analyzeLogicSyntax(source);
    const snapshot = createProjectLogicLanguageSnapshot({
      source,
      profile: PROFILES[project.profileId],
      dictionary: new Map(project.words),
      bindings: project.bindings,
    });
    const frames: { name: string; parameter: number }[] = [];
    for (const [index, token] of syntax.tokens.entries()) {
      if (token.text === "(")
        frames.push({ name: syntax.tokens[index - 1]?.text ?? "", parameter: 0 });
      else if (token.text === ")") frames.pop();
      else if (token.text === "," && frames.length) frames.at(-1)!.parameter++;
      else if ([";", "{", "}", "#define", "#message"].includes(token.text)) frames.length = 0;
      if (token.type !== "ident" && token.type !== "number") continue;
      const operand = snapshot.operandAt(token.start);
      const name = snapshot.definitionAt(token.start);
      if (operand && !operand.declaration) {
        const kind = BINDING_KINDS[operand.kind];
        const logic = operand.kind === "m" ? Number(key.slice(6)) : undefined;
        if (
          !infos.some(
            (info) =>
              !info.name && info.kind === kind && info.num === operand.num && info.logic === logic,
          )
        )
          infos.push({
            name: "",
            kind,
            num: operand.num,
            ...(logic === undefined ? {} : { logic }),
            uses: [],
          });
      }
      const matches = infos.filter(
        (info) =>
          (info.logic === undefined || key === `logic:${info.logic}`) &&
          ((name?.kind === "binding" && name.name === info.name) ||
            (operand &&
              !operand.declaration &&
              (!operand.name || !info.name) &&
              operand.num === info.num &&
              BINDING_KINDS[operand.kind] === info.kind)),
      );
      const call = frames.at(-1);
      const role =
        syntax.tokens[index + 1]?.text === "=" ||
        (call && Object.hasOwn(WRITES, call.name) && WRITES[call.name]!.includes(call.parameter))
          ? "Set"
          : (call && commands[call.name]?.kind === "condition") ||
              [syntax.tokens[index - 1]?.text, syntax.tokens[index + 1]?.text].some((text) =>
                ["==", "!=", "<", ">", "<=", ">="].includes(text ?? ""),
              )
            ? "Checked"
            : "Used";
      for (const info of matches)
        info.uses.push({
          key,
          uri: document.uri ?? `agi-project:///logic.${key.slice(6)}.lgc`,
          range: rangeAt(source, token.start, token.end),
          role,
          text: source.split(/\r?\n/)[token.line - 1]?.trim() ?? "",
          ...(call?.name === "reset" && operand?.kind === "f"
            ? { operation: "Reset" as const }
            : operand?.kind === "o" &&
                call?.parameter === 0 &&
                ["set.view", "set.view.v"].includes(call.name)
              ? { operation: "View" as const }
              : operand?.kind === "o" &&
                  call?.parameter === 0 &&
                  ["position", "position.v", "reposition.to", "reposition.to.v"].includes(call.name)
                ? { operation: "Positioned" as const }
                : operand?.kind === "o" && call?.name === "draw"
                  ? { operation: "Drawn" as const }
                  : {}),
        });
    }
  }
  return infos;
}

/** Agent naming evidence and editor evidence are the same authored operand inventory. */
export function projectBindingInfos(project: LogicLanguageProject): BindingInfo[] {
  return projectOperandInfos(project).filter((info) => info.name);
}
