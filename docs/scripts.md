# CLI scripts

Run TypeScript scripts with Node.js 22.22 or newer and
`node --experimental-strip-types scripts/NAME.ts`. The complete
[npm command table](../CONTRIBUTING.md#commands) covers package entry points.

| Script or command                                                                                  | Inputs and output                                                                             |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npx --no-install agi-language-server --stdio [--project GAME] [--profile ID] [--words WORDS.TOK]` | LOGIC over stdio; [editor setup](editor-setup.md)                                             |
| `node --experimental-strip-types scripts/generate-logic-reference.ts [--check]`                    | Refresh or check the LOGIC command tables                                                     |
| `npm run conformance -- pictures GAME_DIR OUT [PROFILE] [SUITE]`                                   | Picture observations; [conformance guide](testing.md#comparing-with-reference-observations)   |
| `npm run conformance -- runtime GAME_DIR SCENARIO OUT`                                             | Runtime observations from a supplied game                                                     |
| `npm run conformance -- compare REF CAND`                                                          | Compare observation files                                                                     |
| `npm run prove:walkthrough -- ALIAS [OUT]`                                                         | Completion proof from a supplied fixture; [walkthroughs](testing.md#running-the-walkthroughs) |
| `npm run walkthrough:generate`                                                                     | Rewrite `app/public/walkthroughs/*.json` from supplied fixtures                               |
| `node --experimental-strip-types scripts/walkthrough-reference.ts prepare\|query\|render …`        | Inspect game LOGIC for route planning; [walkthrough tools](testing.md#walkthrough-tools)      |
| `npm run fixtures:audit -- LIBRARY_DIR OUTPUT_JSON`                                                | Content hashes and release identities                                                         |
| `npm run verify:deploy -- --url URL --commit SHA --artifact DIR [--attempts N --delay SECONDS]`    | Deployment identity and asset hashes; [hosting](hosting.md#production-releases)               |
| `node --experimental-strip-types scripts/serve-production.ts`                                      | Serve `app/dist` with production headers; port `AGI_E2E_PORT` (5299)                          |
| `npm run media:capture`                                                                            | Original browser and tool imagery; port `AGI_MEDIA_PORT` (5871)                               |
| `node --experimental-strip-types scripts/capture-feedback.ts [OUT]`                                | Agent feedback captures, default `.captures/feedback`                                         |
| `node --experimental-strip-types scripts/benchmark-media.ts [OUT]`                                 | Media from the committed Genesis benchmark                                                    |
| `node --experimental-strip-types scripts/descramble-agi.ts GAME_DIR OUT.bin [LOADER.COM]`          | Decode your own interpreter for [fidelity research](fidelity.md)                              |
| `node --experimental-strip-types scripts/interpreter-inventory.ts LIBRARY_DIR`                     | Local interpreter inventory JSON on stdout                                                    |

## Check tools

`lint-deps.mjs`, `dependency-report.mjs`, `check-ast-grep-suppressions.mjs` and
`check-design-tokens.mjs` run through the `lint:*` scripts. `lint-deps.mjs` also
checks Home's static import closure during `npm run check`, sharing source
boundaries with `check-bundle-budget.ts` through `deferred-modules.mjs`.
`check-bundle-budget.ts` verifies emitted chunks after `npm run build`.
Use `npm run lint:tokens -- --update`
to record a reviewed token cleanup. Mutation testing uses `mutation:test` as its
test command and writes its report under `reports/mutation/`.
