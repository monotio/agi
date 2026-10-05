/** Inline text and classic message slots remain ordinary AGI source. */
import { quoteLogicString } from "./disassembler.ts";
import { analyzeLogicSyntax } from "./syntax.ts";
import { rangeAt, positionAt, type Range } from "./lspTypes.ts";

function printArguments(source: string) {
  const syntax = analyzeLogicSyntax(source);
  const messages = new Map<string, string | undefined>();
  for (const [index, token] of syntax.tokens.entries()) {
    const key = syntax.tokens[index + 1]?.text;
    if (
      token.text === "#message" &&
      key &&
      /^\d+$/.test(key) &&
      Number(key) >= 1 &&
      Number(key) <= 255
    )
      messages.set(
        String(Number(key)),
        syntax.tokens[index + 2]?.type === "string" ? syntax.tokens[index + 2]!.text : undefined,
      );
  }
  const arguments_ = syntax.tokens.flatMap((token, index) => {
    if (
      token.text !== "print" ||
      syntax.tokens[index + 1]?.text !== "(" ||
      syntax.tokens[index + 3]?.text !== ")"
    )
      return [];
    const argument = syntax.tokens[index + 2]!;
    const number = /^m?(\d+)$/.exec(argument.text)?.[1];
    return [
      {
        token: argument,
        text:
          argument.type === "string"
            ? argument.text
            : number
              ? messages.get(String(Number(number)))
              : undefined,
      },
    ];
  });
  return { messages, arguments_ };
}
export function messageInlayHints(source: string, range?: Range) {
  return printArguments(source).arguments_.flatMap(({ token, text }) => {
    if (token.type === "string" || text === undefined) return [];
    const position = positionAt(source, token.end);
    if (range && (position.line < range.start.line || position.line > range.end.line)) return [];
    return [{ position, label: ` ${quoteLogicString(text)}`, paddingLeft: true }];
  });
}
export function messageCodeActions(
  source: string,
  uri: string,
  version: number | null,
  start: number,
  end: number,
) {
  const { messages, arguments_ } = printArguments(source);
  return arguments_.flatMap(({ token, text }) => {
    if (text === undefined || token.start > end || token.end < start) return [];
    const inline = token.type === "string";
    const num = Math.max(0, ...[...messages.keys()].map(Number)) + 1;
    if (inline && num > 255) return [];
    return [
      {
        title: inline ? "Move text to #message" : "Put text inline",
        kind: "refactor.rewrite" as const,
        diagnostics: [],
        edit: {
          documentChanges: [
            {
              textDocument: { uri, version },
              edits: [
                {
                  range: rangeAt(source, token.start, token.end),
                  newText: inline ? `m${num}` : quoteLogicString(text),
                },
                ...(inline
                  ? [
                      {
                        range: rangeAt(source, 0, 0),
                        newText: `#message ${num} ${quoteLogicString(text)}\n`,
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      },
    ];
  });
}
