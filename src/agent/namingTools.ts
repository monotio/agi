/** Evidence-backed names share the LOGIC editor's binding ownership model. */
import type { ToolDefinition } from "./tools.ts";
import type { AuthoringState, BindingKind } from "./authoringState.ts";
import { readBindingsDocument } from "../authoring/projectDocuments.ts";
import { createProjectLogicLanguageSnapshot } from "../authoring/projectLanguage.ts";
import { compileProjectLogic } from "../authoring/projectLogic.ts";
import { projectBindingInfos } from "../logic/projectNames.ts";
import { inspectProjectSourceDependencies } from "../authoring/projectSourceDependencies.ts";
import { expandProjectLogic } from "../authoring/projectLogic.ts";
import { offsetAt } from "../logic/lspTypes.ts";
import { analyzeLogicSyntax, type Stmt } from "../logic/syntax.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { parseWordsTok } from "../logic/words.ts";
import { readInventoryObjects } from "./inventory.ts";
import type { ProjectChange, ProjectContent } from "../authoring/projectContent.ts";
import type { AgiProfile } from "../runtime/profile.ts";

const KINDS = [
  "logic",
  "picture",
  "view",
  "sound",
  "flag",
  "variable",
  "object",
  "inventory",
  "message",
];
export const NAMING_TOOL: ToolDefinition = {
  name: "propose_names",
  description:
    "Propose a batch of names or renames for flags, variables, objects (oN), inventory items (iN), resources and messages (mN). Read LOGIC first. Each name needs exact evidence with LOGIC, line, role and nearby messages. Thin evidence means leave it unnamed. Message names also identify their LOGIC. Explicit rename is the old binding name. The batch joins project review and one Undo; compiled bytes stay identical.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      names: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            kind: { type: "string", enum: KINDS },
            id: { type: "integer", minimum: 0, maximum: 255 },
            logic: { type: ["integer", "null"], minimum: 0, maximum: 255 },
            rename: { type: ["string", "null"] },
            evidence: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  logic: { type: "integer", minimum: 0, maximum: 255 },
                  line: { type: "integer", minimum: 1 },
                  role: { type: "string", enum: ["Set", "Checked", "Used"] },
                  text: { type: "string", minLength: 1 },
                  nearbyMessages: { type: "array", items: { type: "string", minLength: 1 } },
                },
                required: ["logic", "line", "role", "text", "nearbyMessages"],
              },
            },
          },
          required: ["name", "kind", "id", "logic", "rename", "evidence"],
        },
      },
    },
    required: ["names"],
  },
};
interface NameProposal {
  name: string;
  kind: BindingKind;
  id: number;
  logic: number | null;
  rename: string | null;
  evidence: { logic: number; line: number; role: string; text: string; nearbyMessages: string[] }[];
}

/** A PICTURE selector is evidence only when every local write is the same literal. */
function literalPictureReference(
  source: string,
  profile: AgiProfile,
  bindings: AuthoringState["bindings"],
  id: number,
  line: number,
  dictionary: ReadonlyMap<string, number>,
): boolean {
  const dependencies = inspectProjectSourceDependencies({ source, profile, bindings });
  const expansion = expandProjectLogic(source, bindings);
  const assignments: Extract<Stmt, { type: "action" }>[] = [];
  function visit(statements: readonly Stmt[]) {
    for (const statement of statements) {
      if (statement.type === "action" && statement.name === "assignn") assignments.push(statement);
      if (statement.type === "if") {
        visit(statement.then);
        if (statement.else_) visit(statement.else_);
      }
    }
  }
  visit(analyzeLogicSyntax(expansion.prelude + source).program);
  return dependencies.unresolved.some((reference) => {
    if (
      reference.kind !== "picture" ||
      reference.variable === undefined ||
      source.slice(0, reference.start).split(/\r?\n/).length !== line
    )
      return false;
    const variable = reference.variable;
    const infos = projectBindingInfos({
      profileId: profile.id,
      words: [...dictionary],
      bindings: { ...bindings, picture_selector_proof: { kind: "variable", num: variable } },
      documents: { "logic:0": { source } },
    });
    const writes = infos
      .filter((info) => info.kind === "variable" && info.num === variable)
      .flatMap((info) => info.uses)
      .filter((use) => use.role === "Set");
    return (
      writes.length > 0 &&
      writes.every((use) => {
        const offset = offsetAt(source, use.range.start) + expansion.authoredStart;
        return assignments.some((statement) => {
          const [target, value] = statement.args;
          return (
            target?.kind === "v" &&
            target.index === variable &&
            value?.kind === "num" &&
            value.value === id &&
            statement.tok.start <= offset &&
            statement.end > offset
          );
        });
      })
    );
  });
}

export function proposeNames(input: {
  documents: Readonly<Record<string, ProjectContent>>;
  profile: AgiProfile;
  names: readonly NameProposal[];
}): readonly ProjectChange[] {
  const documents = input.documents;
  const original = readBindingsDocument(String(documents["bindings"] ?? "{}"));
  const bindings: AuthoringState["bindings"] = { ...original };
  const words = documents["words"];
  const dictionary = new Map<string, number>(
    typeof words === "string"
      ? JSON.parse(words)
      : words
        ? parseWordsTok(words).map(({ word, id }) => [word, id])
        : [],
  );
  const sources = Object.fromEntries(
    Object.entries(documents)
      .filter(([key]) => key.startsWith("logic:"))
      .map(([key, content]) => [
        key,
        typeof content === "string"
          ? content
          : disassembleLogic(content, { profile: input.profile, dictionary }),
      ]),
  );
  const changed = new Map<string, ProjectChange>();
  const seen = new Set<string>();
  for (const proposal of input.names) {
    if (
      seen.has(proposal.name) ||
      /^(?:[vfomsiwc]\d+|constructor|prototype|__proto__)$/.test(proposal.name)
    )
      throw new Error("Choose a unique source name.");
    seen.add(proposal.name);
    if (!proposal.evidence.length)
      throw new Error("Read the code and supply evidence for each name.");
    if (proposal.kind === "message" && proposal.logic === null)
      throw new Error("Message names need a LOGIC number.");
    const probe = {
      kind: proposal.kind,
      num: proposal.id,
      ...(proposal.kind === "message" ? { logic: proposal.logic! } : {}),
    };
    const infos = projectBindingInfos({
      profileId: input.profile.id,
      words: [...dictionary],
      bindings: { ...original, [proposal.name]: probe },
      documents: Object.fromEntries(
        Object.entries(sources).map(([key, source]) => [key, { source }]),
      ),
    });
    const uses = infos
      .filter((info) => info.kind === proposal.kind && info.num === proposal.id)
      .flatMap((info) => info.uses);
    if (
      ["flag", "variable"].includes(proposal.kind) &&
      !["Set", "Checked"].every((role) => proposal.evidence.some((e) => e.role === role))
    )
      throw new Error("State names need evidence of where they are set and checked.");
    if (!proposal.evidence.some((e) => e.nearbyMessages.length))
      throw new Error("Read nearby messages before proposing a name.");
    // An operand use, with the same binding resolution used by editor navigation,
    // connects the quoted line to the proposed identity.
    for (const evidence of proposal.evidence) {
      const source = sources[`logic:${evidence.logic}`];
      if (!source || source.split(/\r?\n/)[evidence.line - 1]?.trim() !== evidence.text.trim())
        throw new Error("Evidence must quote the current LOGIC line exactly.");
      if (proposal.kind === "message" && proposal.logic !== evidence.logic)
        throw new Error("Message evidence belongs to its LOGIC.");
      const snapshot = createProjectLogicLanguageSnapshot({
        source,
        profile: input.profile,
        dictionary,
        bindings: original,
      });
      const sigils: Record<string, string> = {
        flag: "f",
        variable: "v",
        object: "o",
        inventory: "i",
        message: "m",
      };
      if (!sigils[proposal.kind] && evidence.role !== "Used")
        throw new Error("Resource evidence identifies a Used operand.");
      const tokens = analyzeLogicSyntax(source).tokens.filter(
        (token) => token.line === evidence.line,
      );
      const identity =
        (proposal.kind === "picture" &&
          literalPictureReference(
            source,
            input.profile,
            original,
            proposal.id,
            evidence.line,
            dictionary,
          )) ||
        tokens.some((token) => {
          const operand = snapshot.operandAt(token.start);
          const definition = snapshot.definitionAt(token.start);
          const binding = definition?.kind === "binding" ? original[definition.name] : undefined;
          return (
            (operand?.num === proposal.id && operand.kind === sigils[proposal.kind]) ||
            (binding?.num === proposal.id && binding.kind === proposal.kind) ||
            (!sigils[proposal.kind] &&
              inspectProjectSourceDependencies({
                source,
                profile: input.profile,
                bindings: original,
              }).references.some(
                (reference) =>
                  reference.dependency === `${proposal.kind}:${proposal.id}` &&
                  source.slice(0, reference.start).split(/\r?\n/).length === evidence.line,
              ))
          );
        });
      if (!identity) throw new Error("Evidence must show a use of the named identity.");
      if (
        sigils[proposal.kind] &&
        !uses.some(
          (use) =>
            use.key === `logic:${evidence.logic}` &&
            use.range.start.line === evidence.line - 1 &&
            use.role === evidence.role,
        )
      )
        throw new Error("Evidence roles must match the code's Set, Checked or Used operand.");
      // Nearby messages must actually occur in this code; unsupported guesses are refused.
      for (const message of evidence.nearbyMessages)
        if (
          !compileProjectLogic(source, {
            profile: input.profile,
            dictionary,
            bindings: original,
          }).assembly.messages.includes(message)
        )
          throw new Error("Nearby messages must quote this LOGIC's messages.");
    }
    if (proposal.kind === "inventory") {
      const inventory = documents["inventory"];
      const items =
        typeof inventory === "string"
          ? (JSON.parse(inventory) as unknown[])
          : inventory
            ? readInventoryObjects(inventory, input.profile)
            : [];
      if (!items[proposal.id]) throw new Error("Choose an existing inventory item.");
    }
    if (proposal.rename !== null) {
      const old = original[proposal.rename];
      if (
        !old ||
        old.kind !== proposal.kind ||
        old.num !== proposal.id ||
        old.logic !== probe.logic
      )
        throw new Error("The old name must identify the same binding.");
      if (bindings[proposal.name] && proposal.name !== proposal.rename)
        throw new Error("The proposed name is already used.");
      delete bindings[proposal.rename];
    } else if (
      bindings[proposal.name] &&
      (bindings[proposal.name]!.kind !== proposal.kind ||
        bindings[proposal.name]!.num !== proposal.id ||
        bindings[proposal.name]!.logic !== probe.logic)
    )
      throw new Error("The proposed name is already used.");
    bindings[proposal.name] = { ...probe, evidence: structuredClone(proposal.evidence) };
  }
  for (const [key, source] of Object.entries(sources)) {
    const snapshot = createProjectLogicLanguageSnapshot({
      source,
      profile: input.profile,
      dictionary,
      bindings: original,
    });
    let after = source;
    for (const token of [...analyzeLogicSyntax(source).tokens].reverse()) {
      const definition = snapshot.definitionAt(token.start);
      const rename =
        definition?.kind === "binding"
          ? input.names.find((proposal) => proposal.rename === definition.name)
          : undefined;
      if (rename) after = after.slice(0, token.start) + rename.name + after.slice(token.end);
    }
    const beforeBytes = compileProjectLogic(source, {
      profile: input.profile,
      dictionary,
      bindings: original,
    }).assembly.payload;
    const afterBytes = compileProjectLogic(after, { profile: input.profile, dictionary, bindings })
      .assembly.payload;
    if (
      beforeBytes.length !== afterBytes.length ||
      beforeBytes.some((byte, index) => byte !== afterBytes[index])
    )
      throw new Error("Naming would change compiled game behavior.");
    if (after !== source) changed.set(key, { key, content: after });
  }
  const content =
    JSON.stringify(
      Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      null,
      2,
    ) + "\n";
  changed.set("bindings", { key: "bindings", content });
  return [...changed.values()];
}
