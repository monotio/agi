# Authoring evaluations

Measure whether the authoring agent produces usable AGI resources and whether
the tools give it enough feedback to correct mistakes.

| Evaluation       | Run                    | Measures                                                                    |
| ---------------- | ---------------------- | --------------------------------------------------------------------------- |
| Stored bad cases | `npm run eval:replay`  | Exact outcomes for known tool and transport failures                        |
| Genesis          | `npm run eval:genesis` | A cartridge brief becoming playable resources, with tool failures and usage |
| Picture fidelity | `npm run eval:picture` | Render structure, pixel metrics and visual quality across authoring rounds  |

## Offline verification

`npm run check` includes stored bad cases and provider transport tests. These
checks use deterministic inputs and mocked providers, so they incur no API charges.
A standalone genesis smoke run is also available:

```bash
npm run eval:genesis -- --cartridge knights-trial --provider stub
```

Bad cases in `fixtures/bad-cases/` declare a tool call and its acceptable result.
Add one for a recurring failure, replay it through the real toolchain in
`tests/replay.test.mjs`, and observe failure before the fix and success afterward.
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
npm --prefix evals exec -- promptfoo eval -c evals/configs/genesis.mjs
npm --prefix evals exec -- promptfoo eval -c evals/configs/picture.mjs
```

## Reading the results

Keep structural correctness and creative quality separate. A compiled resource
can still have poor composition, awkward animation or an unsolvable puzzle.
Inspect renders and play the game alongside numerical scores.

For comparisons, record the model, prompt and tool versions, input assets,
settings, repeat count, usage and elapsed time. Compare those same conditions
across runs. Offline checks establish harness behavior; live evaluations establish
what a particular model produces with it.
