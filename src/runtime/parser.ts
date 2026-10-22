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
  stopAtTenthWord = true,
  defaultLoneAAndI = true,
  stripPunctuation = true,
) {
  // Spec "Parser normalization"; retain the interpreter's ASCII-only A-Z
  // folding and per-profile punctuation handling (docs/fidelity.md "Parser
  // verdicts, second pass", F-Parser-10).
  const folded = line.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
  const normalized = stripPunctuation
    ? folded
        .replace(/['`\-"]/g, "")
        .replace(/[ ,.?!();:[\]{}]+/g, " ")
        .replace(/ $/, "")
    : folded.replace(/ +/g, " ").replace(/^ | $/g, "");
  const words: number[] = [];
  const texts: string[] = [];
  const tokens: SentenceToken[] = [];
  let unknownPosition = 0;
  const input = normalized.split(" ").filter((token) => token.length > 0);
  for (let index = 0; index < input.length;) {
    if (!dictionary || unknownPosition) {
      tokens.push({ text: input[index++]!, id: undefined, status: "unread" });
      continue;
    }
    // The word loop tests i >= 10 BEFORE each Match call and exits silently
    // across all 20 shipped PC, Amiga and IIgs profiles: tokens past the tenth
    // retained word are never examined, so an unknown word there is not
    // reported and no eleventh text is kept (docs/fidelity.md "Parser
    // verdicts").
    if (stopAtTenthWord && words.length >= 10) {
      tokens.push({ text: input[index++]!, id: undefined, status: "unread" });
      continue;
    }
    const { text, id, length } = matchDictionaryPhrase(input, index, dictionary, defaultLoneAAndI);
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
