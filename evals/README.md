# Authoring evaluations

Measure whether the authoring agent produces usable AGI resources and whether
the tools give it enough feedback to correct mistakes.

| Evaluation        | Run                                  | Measures                                                                                    |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Stored bad cases  | `npm run eval:replay`                | Exact outcomes for known tool and transport failures                                        |
| Genesis           | `npm run eval:genesis`               | An adventure brief becoming playable resources, with tool failures and usage                |
| Picture fidelity  | `npm run eval:picture`               | Render structure, pixel metrics and visual quality across authoring rounds                  |
| Remix benchmark   | `npm run eval:remix`                 | Play hints and resource changes on a real engine: requests, cost, latency and cache per run |
| Editor assistance | `npm run eval:studio`                | Selection-scoped editor edits: candidates, refusals, rounds, tokens and cost                |
| Reference art     | `npm run eval:references`            | Full images against handles: tokens, cost, read_reference_image calls and match             |
| Prompt cache      | `npm run eval:cache`                 | Prefix stability of consecutive requests offline; cache reads and writes live               |
| Production effort | `npm --prefix evals run eval:effort` | Complete app Genesis runs, startup payloads, cost, repairs and playable output              |
| Genesis matrix    | `npm run eval:matrix`                | Cost, content, picture depth and control lines, and brief coverage per run                  |

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
content and that binary buffers do not expand into JSON properties. A case with a
`studio` focus (a picture's annotated `source`, `targetIds` and `lens`, or
a view's `payload` and `targetCels`) replays a Editor assistance tool call against that
selection. A case with `references` (solid-colour art under manifest fields) replays a
read_reference_image call against that art; a `referenceTurn` (attached ids, a tool log and
the final reply) is graded by the under-fetch rule against `expectedUnviewed`.

## Live model evaluations

Choose a provider and model explicitly and set its API key in the environment.
Live runs are billed to that provider account. A paid run takes consent on the
command line: every runner calls a provider only with both `--live` and
`--budget-usd <cap>` (`evals/lib/live-guard.ts`), and
the promptfoo comparisons need `EVAL_LIVE=1` with `EVAL_RUN_BUDGET_USD` (the effort
comparison: `EVAL_EFFORT_RUN_BUDGET_USD`). Without them a runner says what it would
have run and exits non-zero; `tests/live-guard.test.ts` spawns each one with keys
set and a local server in the provider's place to prove nothing is sent. The cap
is charged from provider usage at the model's list price and stops the run once
spent. The runner headers document their options: [genesis](genesis-cli.ts) and
[picture fidelity](picture-fidelity.ts).

The editor assistance benchmark (`evals/studio-assist-benchmark.ts`) enforces its cap from
provider usage across all its runs and has a `--dry-run` that drives the same
session loop with the offline stub.

The reference art benchmark (`evals/reference-benchmark.ts`) runs each case twice: with
the full images in the request, the way references travelled before handles, and
with handles (a manifest line and a thumbnail per image, plus read_reference_image). Its
reference images are drawn by the script. It scores the output against them
(palette overlap, layout agreement, silhouette IoU) and records tokens, cost and
read_reference_image calls per run. Budget and dry run work as in the editor assistance benchmark.

The prompt-cache benchmark (`evals/cache-probe.ts`) measures what the providers'
prefix caches can reuse. `--dry-run` plays four multi-turn tasks (a Remix with
reference art, a room build, an editor task with a refused proposal, a Play hint
conversation) through the production `AgentSession` and the real Anthropic and
OpenAI clients with a scripted model behind a mocked `fetch`, then compares each
request with the one before it: the byte-identical prefix, where they diverge and
why (tools, system text, a rewritten message), and the share
of the request a warm cache could serve. `tests/cache-prefix.test.ts` runs the
same probe under `npm run eval:replay` and fails when a task's prefix stability
drops below 100% or its cacheable share below the recorded floor. A live run
(`--provider anthropic|openai --budget-usd N`, budget and pauses as in the editor
assistance benchmark) plays the short tasks with a real model and reports the provider's
cache reads, writes and hit rate per request beside the client-side analysis of
the bodies it sent; `--diagnostics` asks the provider to name the divergence.

The transcript is append-only, and the probe measures it: a viewed reference
image stays in the conversation because dropping it later rewrites every
message after it. At Opus 5.5 rates a 350-token view costs 35
token-equivalents per request while cached; rewriting the 5,000 tokens that
followed it costs about 6,000 once, so the drop pays for itself only after
some 180 requests; on Claude Fable 5.1 (cache reads at 2.5%) the view stays cheaper for good. Claude
requests keep the static prefix (tool catalog and system prompt) as a 1-hour
cache entry and the conversation tail as the default 5-minute one; OpenAI
requests carry an explicit breakpoint at every turn's end under one routing
key per session.

Genesis records model calls, compiler feedback, token usage and playtest results.
Genesis and picture fidelity send provider turns through the app's conversation
clients, including caching, thinking, compaction and model token limits. Their
`--effort` option overrides the production model default. Genesis traces carry
normalized usage, request telemetry and the added provider transcript items.
`tests/runner-clients.test.ts` checks their request settings, conversation prefixes
and per-request budget charging with mocked providers.
Picture evaluation reads a local reference, asks for an art-direction brief,
recreates the scene through the picture tool, and compares the results. The edit
benchmark measures a requested change against the original scene. `--provider fake`
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

The production effort comparison uses the app's `AgentSession`, provider adapters and
tools. It saves the exact first request body (system, Genesis brief and tool
schemas), provider-reported token usage, generated resources, transcript, events
and opening frame under ignored `results/effort/`. Request headers and API keys
are excluded. Per-section token counts are labeled estimates; the first response
supplies the exact total input count.

For a bounded comparison of one model at medium and low effort:

```bash
EVAL_LIVE=1 EVAL_EFFORT_RUN_BUDGET_USD=5 \
EVAL_EFFORT_LANES=openai-gpt-6-sol-lean-medium,openai-gpt-6-sol-lean-low \
EVAL_EFFORT_STAGES=lean-medium,lean-low \
npm --prefix evals run eval:effort -- --no-cache
```

Each run gets `EVAL_EFFORT_RUN_BUDGET_USD` as its task budget and ends at a budget
pause, another pause, or a 40-minute timeout that guards against a hung run.
`EVAL_EFFORT_TIMEOUT_MS`, `EVAL_EFFORT_CASES`,
`EVAL_EFFORT_REPEATS` and `EVAL_EFFORT_RUN_ID` control the comparison. Compare
prompt changes at a fixed effort, such as `lean-low` or `lean-medium`. The
`default` stage uses the current app recommendation, which can change; reports
record the actual requested effort and payload hashes.

Claude requests enable automatic conversation caching in addition to the static
tool and system prefixes. Compare prompt variants with the same caching policy;
cache reads, writes and uncached input all contribute to the reported cost.
See [Claude's caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Benchmark snapshots

`evals/benchmarks/genesis/<version>/` freezes a set of production effort runs
so later prompts, tools and models are measured against the same briefs.
`npm run eval:snapshot` copies completed runs out of `results/`, dropping
embedded images, encrypted reasoning, the debug log and absolute paths.
`npm run eval:matrix` then analyses the runs with the engine's own code into
`matrix/metrics.json` and `matrix/matrix.md`, folding in any hand-written
`reading-<brief>.md`. `tests/genesis-matrix.test.ts` checks that every snapshot
still reproduces its committed metrics. The
[1.0.0 snapshot](benchmarks/genesis/1.0.0/README.md) lists the exact commands.

## Reading the results

Keep structural correctness and creative quality separate. A compiled resource
can still have poor composition, awkward animation or an unsolvable puzzle.
Inspect renders and play the game alongside numerical scores.

These Genesis costs cover the playable opening and its boot validation. Later
room authoring and a complete adventure playthrough are outside this benchmark.

Optimize total cost per usable result, including repairs. Fewer startup tokens or
a successful boot alone do not establish better value. Compare effort levels on
the same briefs and tool implementation, review their frames and interaction
assertions, and count incomplete runs separately. Preserve important constraints
while removing repeated instructions, following the current
[GPT-6 guidance](https://developers.openai.com/api/docs/guides/prompt-guidance)
and [Claude effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort).

For comparisons, record the model, prompt and tool versions, input assets,
settings, repeat count, usage and elapsed time. Compare those same conditions
across runs. Offline checks establish harness behavior; live evaluations establish
what a particular model produces with it.
