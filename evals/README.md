# Authoring evaluations

Measure whether the authoring agent produces usable AGI resources and whether
the tools give it enough feedback to correct mistakes.

| Evaluation        | Run                                  | Measures                                                                       |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| Stored bad cases  | `npm run eval:replay`                | Exact outcomes for known tool and transport failures                           |
| Genesis           | `npm run eval:genesis`               | An adventure brief becoming playable resources, with tool failures and usage   |
| Picture fidelity  | `npm run eval:picture`               | Render structure, pixel metrics and visual quality across authoring rounds     |
| Remix benchmark   | `npm run eval:remix`                 | Ask/Remix cases on a real engine: requests, cost, latency and cache per run    |
| Production effort | `npm --prefix evals run eval:effort` | Complete app Genesis runs, startup payloads, cost, repairs and playable output |

## Offline verification

`npm run check` includes stored bad cases and provider transport tests. These
checks use deterministic inputs and mocked providers, so they incur no API charges.
All evaluation configs, providers, prompts, assertions and tests are TypeScript;
`tsconfig.json` checks them under the same strict rules as the main project.
A standalone genesis smoke run is also available:

```bash
npm run eval:genesis -- --template knights-trial --provider stub
```

Bad cases in `fixtures/bad-cases/` declare a tool call and its acceptable result.
Add one for a recurring failure, replay it through the real toolchain in
`tests/replay.test.ts`, and observe failure before the fix and success afterward.
Image transport cases check that rendered previews reach the provider as image
content and that binary buffers do not expand into JSON properties.

## Live model evaluations

Choose a provider and model explicitly and set its API key in the environment.
Live runs are billed to that provider account. The runner headers document their
options: [genesis](../scripts/eval-genesis.ts) and
[picture fidelity](../scripts/eval-picture.ts).

Genesis records model calls, compiler feedback, token usage and playtest results.
Picture evaluation reads a local reference, asks for an art-direction brief,
recreates the scene through the picture tool, and compares the results. The edit
lane measures a requested change against the original scene. `--provider fake`
exercises the picture pipeline offline when local reference data is available.

Local manifests, rendered references, transcripts and result bundles stay in the
ignored `fixtures/pictures/` and `results/` directories. Use original or suitably
licensed assets when sharing an evaluation.

The optional Promptfoo configurations in `configs/` compare repeated runs. Install
those tools with `npm --prefix evals install`, then use the matching configuration:

```bash
npm --prefix evals exec -- promptfoo eval -c evals/configs/genesis.ts
npm --prefix evals exec -- promptfoo eval -c evals/configs/picture.ts
```

The production effort lane uses the app's `AgentSession`, provider adapters and
tools. It saves the exact first request body (system, Genesis brief and tool
schemas), provider-reported token usage, generated resources, transcript, events
and opening frame under ignored `results/effort/`. Request headers and API keys
are excluded. Per-section token counts are labeled estimates; the first response
supplies the exact total input count.

For a bounded comparison of one model at medium and low effort:

```bash
EVAL_EFFORT_LANES=openai-gpt-5.6-sol-lean-medium,openai-gpt-5.6-sol-lean-low \
EVAL_EFFORT_STAGES=lean-medium,lean-low \
npm --prefix evals run eval:effort -- --no-cache
```

Each run starts with a $1.25 estimated allowance and stops at a budget pause or
timeout. `EVAL_EFFORT_RUN_BUDGET_USD`, `EVAL_EFFORT_CASES`,
`EVAL_EFFORT_REPEATS` and `EVAL_EFFORT_RUN_ID` control the comparison. Preserve a
first-request artifact before editing prompts; select `baseline-default` and set
`EVAL_EFFORT_BASELINE_REQUEST` to replay its system, Genesis instructions and
tool descriptions. Baseline artifacts are local, not required by offline tests.
Use `baseline-low,lean-low` for prompt comparisons at a fixed effort, including
Opus and Fable. The `default` stages use the current app recommendation, which
can change; reports record the actual requested effort and payload hashes.

Claude requests enable automatic conversation caching in addition to the static
tool and system prefixes. Compare prompt variants with the same caching policy;
cache reads, writes and uncached input all contribute to the reported cost.
See [Claude's caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Reading the results

Keep structural correctness and creative quality separate. A compiled resource
can still have poor composition, awkward animation or an unsolvable puzzle.
Inspect renders and play the game alongside numerical scores.

These Genesis costs cover the playable opening and its boot validation. Later
room authoring and a complete adventure playthrough are outside this lane.

Optimize total cost per usable result, including repairs. Fewer startup tokens or
a successful boot alone do not establish better value. Compare effort levels on
the same briefs and tool implementation, review their frames and interaction
assertions, and count incomplete runs separately. Preserve important constraints
while removing repeated instructions, following the current
[GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)
and [Claude effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort).

For comparisons, record the model, prompt and tool versions, input assets,
settings, repeat count, usage and elapsed time. Compare those same conditions
across runs. Offline checks establish harness behavior; live evaluations establish
what a particular model produces with it.
