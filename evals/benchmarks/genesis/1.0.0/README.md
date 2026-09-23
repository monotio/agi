# Genesis benchmark, app 1.0.0

Five models built the same adventure openings, from the same two briefs,
through the app's production authoring session: the real `AgentSession`,
provider adapters, tools, and boot validation. Every run completed and passed
its playtest. The results make a baseline for tracking the harness, its
instructions, and newer models over time.

- [`matrix/matrix.md`](matrix/matrix.md) compares cost, content, picture depth
  and control lines, and brief coverage, with hand-written readings per brief.
  [`matrix/metrics.json`](matrix/metrics.json) holds every measurement.
- [`runs/`](runs/) holds each run: the report, the conversation, session
  events, the opening frame, and the generated game in `<run>.resources/`.

## Settings

| Setting | Value                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Briefs  | [`knights-trial`](../../../../games/knights-trial/SKILL.md), [`badge-of-millhaven`](../../../../games/badge-of-millhaven/SKILL.md) |
| Lanes   | Claude Opus 5.5 at `high` and `medium`; GPT-6 Astra, Sol and Luna at `medium`                                                      |
| Prompt  | the `lean` variant, the app's current system prompt and tools                                                                      |
| Runs    | one per lane and brief; an allowance of up to $10 each, which no run reached                                                       |
| Prices  | list prices in [`src/agent/modelEffort.ts`](../../../../src/agent/modelEffort.ts); the ten runs cost $15.26 together               |

One run per lane and brief gives no variance. Read differences of a few
percent as noise, and weigh the pictures and the games alongside the numbers.

## Playing a run

Each `runs/<run>.resources/` folder is a complete game. In the app, choose
**Add game**, then that folder.

## Reproducing and extending

A new snapshot repeats these steps for a new app version, prompt or model;
compare its matrix with this one.

```bash
EVAL_EFFORT_LANES=anthropic-claude-opus-5-5-lean-high,anthropic-claude-opus-5-5-lean-medium,openai-gpt-6-astra-lean-medium,openai-gpt-6-sol-lean-medium,openai-gpt-6-luna-lean-medium \
EVAL_EFFORT_STAGES=lean-high,lean-medium \
EVAL_EFFORT_CASES=knights-trial,badge-of-millhaven \
EVAL_EFFORT_RUN_BUDGET_USD=10 \
EVAL_EFFORT_RUN_ID=<run-id> \
npm --prefix evals run eval:effort -- --no-cache

npm run eval:snapshot -- evals/results/effort/<run-id> evals/benchmarks/genesis/<version>
npm run eval:matrix -- evals/benchmarks/genesis/<version>/runs evals/benchmarks/genesis/<version>/matrix
```

The snapshot step drops what a reader cannot use or should not publish:
embedded images, encrypted reasoning, the debug log stream, and absolute paths.
Hand-written `reading-<brief>.md` files in `matrix/` are folded into
`matrix.md` when it is regenerated. `evals/tests/genesis-matrix.test.ts` checks
that every committed snapshot still reproduces its `metrics.json`.
