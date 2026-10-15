import { matchDictionaryPhrase } from "../logic/words.ts";

interface SentenceToken {
  readonly text: string;
  readonly id: number | undefined;
  readonly status: "known" | "skipped" | "new" | "unread";
}

/** The interpreter's parser calculation, with a reading trace for editor previews. */
export function parseSentence(
  line: string,
  dictionary?: ReadonlyMap<string, number>,
  stopAtTenthWord = false,
) {
  // Spec "Parser normalization"; retain the interpreter's normalization exactly.
  const normalized = line
    .toLowerCase()
    .replace(/['`\-"]/g, "")
    .replace(/[ ,.?!();:[\]{}]+/g, " ")
    .replace(/ $/, "");
  const words: number[] = [];
  const texts: string[] = [];
  const tokens: SentenceToken[] = [];
  let unknownPosition = 0;
  const input = normalized.split(" ").filter((token) => token.length > 0);
  for (let index = 0; index < input.length; ) {
    if (!dictionary || unknownPosition) {
      tokens.push({ text: input[index++]!, id: undefined, status: "unread" });
      continue;
    }
    // The word loop tests i >= 10 BEFORE each Match call and exits silently:
    // tokens past the tenth retained word are never examined, so an unknown
    // word there is not reported and no eleventh text is kept (kq1 2.917
    // Parse 0x18F4 / kq4 3.002.086 0x1BAD / gr1 3.002.149 0x1B7C). Unprobed
    // builds keep examining (and reporting) words past the cap.
    if (stopAtTenthWord && words.length >= 10) {
      tokens.push({ text: input[index++]!, id: undefined, status: "unread" });
      continue;
    }
    const { text, id, length } = matchDictionaryPhrase(input, index, dictionary);
    index += length;
    if (id === undefined) {
      // docs/fidelity.md, parser unknown-word audit: the unknown has a zero slot.
      texts.push(text);
      unknownPosition = words.length + 1;
      if (stopAtTenthWord || words.length < 10) words.push(0);
      tokens.push({ text, id, status: "new" });
    } else if (id === 0) tokens.push({ text, id, status: "skipped" });
    else if (stopAtTenthWord || words.length < 10) {
      words.push(id);
      texts.push(text);
      tokens.push({ text, id, status: "known" });
    } else tokens.push({ text, id, status: "unread" });
  }
  return { words, texts, count: unknownPosition || words.length, unknownPosition, tokens };
}
