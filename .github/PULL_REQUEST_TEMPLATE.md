## What

<!-- One paragraph. Link the issue if there is one. -->

## Verification (use the items relevant to this change)

- [ ] **Every new test/eval was seen failing once** before it passed (broke the code or fed the bad case). Say how below.
- [ ] **Assertions are exact** where possible (bytes, pixels, bytecode, schema) — model judges only for ambiguity.
- [ ] **Browser behavior is proven in the real app** with scenario, request or download assertions; screenshots for visual changes.
- [ ] **A recurring failure became a rule**: stored bad case under `evals/`, permanent test, or eslint/ast-grep rule.
- [ ] **Public documentation updated** for changed behavior.
- [ ] **Format or version changes follow the [release contract](../AGENTS.md#release-contract)**: optional extensions retain their version; breaking changes include migrations and released fixtures.
- [ ] **Docs and media reflect the shipped UI**: update captures and alt text for visible changes.
- [ ] **Contribution provenance checked**: no commercial game assets or copied interpreter code; original AGI resources are allowed.
- [ ] `npm run check` passes locally.

## How the new checks were seen failing

<!-- e.g. "commented out the priority merge → view.test.ts:42 failed with expected 0x0f got 0x00" -->
