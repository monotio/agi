## What

<!-- One paragraph. Link the issue if there is one. -->

## Verification (use the items relevant to this change)

- [ ] **Every new test/eval was seen failing once** before it passed (broke the code or fed the bad case). Say how below.
- [ ] **Assertions are exact** where possible (bytes, pixels, bytecode, schema) — model judges only for ambiguity.
- [ ] **Browser behavior is proven in the real app** with scenario, request or download assertions; screenshots for visual changes.
- [ ] **A recurring failure became a rule**: stored bad case under `evals/`, permanent test, or eslint/ast-grep rule.
- [ ] **Public documentation updated** for changed behavior.
- [ ] **Contribution provenance checked**: no commercial game assets or copied interpreter code; original AGI resources are allowed.
- [ ] `npm run check` passes locally.

## How the new checks were seen failing

<!-- e.g. "commented out the priority merge → view.test.ts:42 failed with expected 0x0f got 0x00" -->
