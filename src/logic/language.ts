/**
 * Owned, protocol-independent language snapshot for one exact compiler input.
 * Hosts provide project-expanded source and map generated binding origins back
 * to their documents. Browser workers and local protocol adapters share this
 * service; it never writes documents, saves a project or changes a running game.
 */
import { assembleLogic, AssemblerError } from "./assembler.ts";
import { commandReference } from "./commandReference.ts";
import { quoteLogicString } from "./disassembler.ts";
import { analyzeLogicSyntax, scanLogicTokens, type Token } from "./syntax.ts";
import type { AgiProfile } from "../runtime/profile.ts";

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function createLogicLanguageSnapshot(input: {
  readonly source: string;
  readonly profile: AgiProfile;
  readonly dictionary: ReadonlyMap<string, number>;
}) {
  const source = input.source;
  const profile = { ...input.profile };
  const dictionary = new Map(input.dictionary);
  const syntax = analyzeLogicSyntax(source);
  const commands = commandReference(profile);
  const byName = new Map(commands.map((command) => [command.name, command]));
  const diagnostics = syntax.diagnostics.map((entry) => ({
    ...entry,
    severity: "error" as "error" | "warning",
  }));
  let payload: Uint8Array | undefined;
  if (!diagnostics.length) {
    try {
      const compiled = assembleLogic(source, { profile, dictionary });
      payload = compiled.payload;
      diagnostics.push(
        ...compiled.diagnostics.map((entry) => ({ ...entry, severity: "warning" as const })),
      );
    } catch (error) {
      if (!(error instanceof AssemblerError)) throw error;
      const token = syntax.tokens.find(
        (entry) => entry.line === error.line && entry.col === error.col,
      );
      let start = token?.start;
      if (start === undefined) {
        start = 0;
        for (let line = 1; line < error.line; line++) start = source.indexOf("\n", start) + 1;
        start = Math.min(source.length, start + error.col - 1);
      }
      diagnostics.push({
        message: error.message,
        line: error.line,
        col: error.col,
        start,
        end: token?.end ?? Math.min(source.length, start + 1),
        severity: "error",
      });
    }
  }

  function checkOffset(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
      throw new RangeError("Cursor offset must be within the source in UTF-16 code units.");
  }

  function tokenAt(offset: number): Token | undefined {
    return syntax.tokens.find((token) => token.start <= offset && token.end > offset);
  }

  function contextAt(offset: number) {
    const frames: { name: string; parameter: number }[] = [];
    let previous: Token | undefined;
    for (const token of syntax.tokens) {
      if (token.start >= offset) break;
      if (token.type === "punct" && token.text === "(")
        frames.push({ name: previous?.type === "ident" ? previous.text : "", parameter: 0 });
      else if (token.type === "punct" && token.text === ")") frames.pop();
      else if (token.type === "punct" && token.text === "," && frames.length)
        frames[frames.length - 1]!.parameter++;
      previous = token;
    }
    return { frames, call: [...frames].reverse().find((frame) => byName.has(frame.name)) };
  }

  function completeAt(offset: number) {
    checkOffset(offset);
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    const linePrefix = source.slice(lineStart, offset).trimStart();
    if (linePrefix.startsWith("#") && !/\s/.test(linePrefix))
      return ["#define", "#message"]
        .filter((name) => name.startsWith(linePrefix))
        .map((name) => ({
          label: name,
          detail: name === "#define" ? "Define a numeric name" : "Declare a message",
          start: offset - linePrefix.length,
          end: offset,
          text: name,
        }));
    const at =
      tokenAt(offset) ??
      syntax.tokens.find(
        (token) =>
          token.end === offset &&
          (token.type === "ident" ||
            token.type === "string" ||
            (token.type === "invalid" && source[token.start] === '"')),
      );
    const previous = syntax.tokens
      .filter((token) => token.end <= offset && token.type !== "eof")
      .at(-1);
    const gap = source.slice(Math.max(previous?.end ?? 0, lineStart), offset);
    if ((!at || at.type === "eof") && (gap.includes("//") || gap.trimStart().startsWith("#")))
      return [];
    const context = contextAt(offset);
    if (context.call?.name === "said") {
      if (at && !["string", "invalid", "ident", "eof"].includes(at.type)) return [];
      const start = at && at.type !== "eof" ? at.start : offset;
      const end = at && at.type !== "eof" ? at.end : offset;
      const fragment = source.slice(start, offset);
      let prefix = fragment;
      if (fragment.startsWith('"')) {
        try {
          prefix = scanLogicTokens(fragment + '"')[0]?.text ?? "";
        } catch {
          return [];
        }
      }
      return [...dictionary.keys()]
        .filter((word) => word.startsWith(prefix.toLowerCase()))
        .sort()
        .map((word) => ({
          label: word,
          detail: `Word group ${dictionary.get(word)}`,
          start,
          end,
          text: quoteLogicString(word),
        }));
    }
    if (at?.type === "string" || at?.type === "invalid") return [];
    const start = at?.type === "ident" ? at.start : offset;
    const end = at?.type === "ident" ? at.end : offset;
    const prefix = source.slice(start, offset);
    if (context.call) {
      return syntax.definitions
        .filter(
          (entry) =>
            entry.kind === "define" && entry.start < offset && entry.name.startsWith(prefix),
        )
        .map((entry) => ({
          label: entry.name,
          detail: "Local definition",
          start,
          end,
          text: entry.name,
        }));
    }
    const kind = context.frames.some((frame) => frame.name === "if") ? "condition" : "action";
    const control: Record<string, string> = {
      if: "Conditional block",
      goto: "Jump to a label",
      return: "Return from this logic",
    };
    const keywords =
      kind === "action"
        ? Object.entries(control)
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, detail]) => ({ label: name, detail, start, end, text: name }))
        : [];
    return [
      ...keywords,
      ...commands
        .filter((command) => command.kind === kind && command.name.startsWith(prefix))
        .map((command) => ({
          label: command.name,
          detail: command.signature,
          start,
          end,
          text: command.name,
        })),
    ];
  }

  function signatureAt(offset: number) {
    checkOffset(offset);
    const call = contextAt(offset).call;
    if (!call) return null;
    const command = byName.get(call.name)!;
    return {
      label: command.signature,
      activeParameter: call.parameter,
      documentation: command.help ?? "",
    };
  }

  function hoverAt(offset: number) {
    checkOffset(offset);
    const token = tokenAt(offset);
    if (token?.type !== "ident") return null;
    const definition = definitionAt(offset);
    if (definition) {
      const value = syntax.tokens.find((entry) => entry.start >= definition.end)?.text ?? "";
      return {
        start: token.start,
        end: token.end,
        text:
          definition.kind === "label"
            ? `Label ${definition.name}`
            : `#define ${definition.name} ${value}`,
      };
    }
    const command = byName.get(token.text);
    return command
      ? {
          start: token.start,
          end: token.end,
          text: `${command.signature}\n\n${command.help ?? ""}`,
        }
      : null;
  }

  function definitionAt(offset: number) {
    checkOffset(offset);
    const declaration = syntax.definitions.find(
      (entry) => entry.start <= offset && entry.end > offset,
    );
    if (declaration) return { ...declaration };
    const reference = syntax.references.find(
      (entry) => entry.start <= offset && entry.end > offset,
    );
    const definition =
      reference?.definitionStart === undefined
        ? undefined
        : syntax.definitions.find((entry) => entry.start === reference.definitionStart);
    return definition ? { ...definition } : null;
  }

  function referencesAt(offset: number) {
    const definition = definitionAt(offset);
    if (!definition) return [];
    return [
      { start: definition.start, end: definition.end },
      ...syntax.references
        .filter((entry) => entry.definitionStart === definition.start)
        .map(({ start, end }) => ({ start, end })),
    ].sort((left, right) => left.start - right.start);
  }

  function renameAt(offset: number, name: string): readonly TextEdit[] {
    const definition = definitionAt(offset);
    if (!definition) throw new Error("Rename needs a resolved local definition.");
    if (!payload)
      throw new Error(
        "Rename requires a valid compiled source; fix incomplete or invalid code first.",
      );
    let tokens: Token[];
    try {
      tokens = scanLogicTokens(name);
    } catch (error) {
      if (!(error instanceof AssemblerError)) throw error;
      throw new Error("The new name is not a safe source identifier.", { cause: error });
    }
    if (
      tokens.length !== 2 ||
      tokens[0]!.type !== "ident" ||
      tokens[0]!.start !== 0 ||
      tokens[0]!.end !== name.length ||
      (definition.kind === "define" && /^[vfoms]\d{1,3}$/.test(name))
    )
      throw new Error("The new name is not a safe source identifier.");
    if (
      syntax.definitions.some(
        (entry) =>
          entry.kind === definition.kind && entry.name === name && entry.start !== definition.start,
      )
    )
      throw new Error(`The name '${name}' already has a definition.`);
    const edits = referencesAt(offset).map((range) => ({ ...range, text: name }));
    let changed = source;
    for (const edit of [...edits].reverse())
      changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
    const renamed = assembleLogic(changed, { profile, dictionary }).payload;
    if (renamed.length !== payload.length || renamed.some((byte, index) => byte !== payload[index]))
      throw new Error("Rename would change compiled game behavior.");
    return edits;
  }

  return {
    source,
    diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze(entry))),
    completeAt,
    signatureAt,
    hoverAt,
    definitionAt,
    referencesAt,
    renameAt,
  };
}
