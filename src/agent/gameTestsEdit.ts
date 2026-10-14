/** Test documents validate structure; game references are checked only when run. */
import type { AgiProfile } from "../runtime/profile.ts";
import {
  parseGameTests,
  serializeGameTests,
  validateGameTest,
  type GameTest,
} from "./gameTestFormat.ts";

export type GameTestsEditOperation =
  | { readonly kind: "merge" | "replace"; readonly tests: unknown; readonly order?: "append" }
  | { readonly kind: "update"; readonly name: string; readonly test: unknown }
  | { readonly kind: "remove"; readonly names: readonly string[] }
  | { readonly kind: "rename"; readonly name: string; readonly to: string }
  | { readonly kind: "reorder"; readonly names: readonly string[] }
  | { readonly kind: "text"; readonly text: string };

export class GameTestsEditError extends Error {
  readonly kind: "document" | "validation" | "missing" | "duplicate";
  constructor(kind: GameTestsEditError["kind"], message: string) {
    super(message);
    this.name = "GameTestsEditError";
    this.kind = kind;
  }
}

export function editGameTests(
  input: {
    readonly document: string | Uint8Array | undefined;
    readonly profile: AgiProfile;
    readonly words: Uint8Array | undefined;
  },
  op: GameTestsEditOperation,
): {
  readonly tests: readonly GameTest[];
  readonly written: readonly GameTest[];
  readonly payload: Uint8Array;
} {
  const parse = (document: typeof input.document, kind: GameTestsEditError["kind"]) => {
    try {
      return parseGameTests(
        typeof document === "string" ? new TextEncoder().encode(document) : document,
        input.profile,
      ).tests;
    } catch (error) {
      throw new GameTestsEditError(kind, error instanceof Error ? error.message : String(error));
    }
  };
  const stored =
    op.kind === "replace" || op.kind === "text" ? [] : parse(input.document, "document");
  const requireNames = (names: readonly string[]) => {
    const missing = names.filter((name) => !stored.some((test) => test.name === name));
    if (missing.length)
      throw new GameTestsEditError(
        "missing",
        `No game test named ${missing.map((name) => JSON.stringify(name)).join(", ")}.`,
      );
  };
  let next: readonly GameTest[];
  let written: readonly GameTest[] = [];
  try {
    if (op.kind === "remove") {
      if (!op.names.length)
        throw new GameTestsEditError(
          "validation",
          "remove needs the names of the tests to delete.",
        );
      requireNames(op.names);
      next = stored.filter((test) => !op.names.includes(test.name));
    } else if (op.kind === "reorder") {
      requireNames(op.names);
      if (op.names.length !== stored.length || new Set(op.names).size !== stored.length)
        throw new GameTestsEditError("validation", "Include each test name once in the new order.");
      next = op.names.map((name) => stored.find((test) => test.name === name)!);
    } else if (op.kind === "rename") {
      requireNames([op.name]);
      const renamed = validateGameTest(
        { ...stored.find((test) => test.name === op.name)!, name: op.to },
        "test",
        input.profile,
      );
      if (stored.some((test) => test.name === renamed.name && test.name !== op.name))
        throw new GameTestsEditError(
          "duplicate",
          `Duplicate test name ${JSON.stringify(renamed.name)} in tests.`,
        );
      next = stored.map((test) => (test.name === op.name ? renamed : test));
    } else {
      if (op.kind === "text") written = parse(op.text, "validation");
      else {
        if (op.kind === "update") requireNames([op.name]);
        const tests = op.kind === "update" ? [op.test] : op.tests;
        if (!Array.isArray(tests) || !tests.length)
          throw new GameTestsEditError(
            "validation",
            `${op.kind} needs at least one test in tests.`,
          );
        written = tests.map((test, index) => {
          const validated = validateGameTest(test, `tests[${index}]`, input.profile);
          const previous = stored.find(
            (entry) => entry.name === (op.kind === "update" ? op.name : validated.name),
          );
          return {
            ...validated,
            ...((test as Record<string, unknown>)["rngVersion"] == null &&
            previous?.rngVersion === 1
              ? { rngVersion: 1 as const }
              : {}),
            ...(!validated.setup && previous?.setup ? { setup: previous.setup } : {}),
          };
        });
      }
      const seen = new Set<string>();
      for (const test of written) {
        if (seen.has(test.name))
          throw new GameTestsEditError(
            "duplicate",
            `Duplicate test name ${JSON.stringify(test.name)} in tests.`,
          );
        seen.add(test.name);
      }
      if (op.kind === "replace" || op.kind === "text") next = written;
      else if (op.kind === "update") {
        if (stored.some((test) => test.name !== op.name && seen.has(test.name)))
          throw new GameTestsEditError(
            "duplicate",
            `Duplicate test name ${JSON.stringify(written[0]!.name)} in tests.`,
          );
        next = stored.map((test) => (test.name === op.name ? written[0]! : test));
      } else if (op.order === "append")
        next = [...stored.filter((test) => !seen.has(test.name)), ...written];
      else
        next = [
          ...stored.map((test) => written.find((entry) => entry.name === test.name) ?? test),
          ...written.filter((test) => !stored.some((entry) => entry.name === test.name)),
        ];
    }
    return { tests: next, written, payload: serializeGameTests(next) };
  } catch (error) {
    if (error instanceof GameTestsEditError) throw error;
    throw new GameTestsEditError(
      "validation",
      error instanceof Error ? error.message : String(error),
    );
  }
}
