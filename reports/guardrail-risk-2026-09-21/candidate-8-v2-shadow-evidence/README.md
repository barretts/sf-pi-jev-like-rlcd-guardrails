# C8 VALID v2 host shadow replay

`fake-shadow-report.json` is the complete 96-case VALID-only replay through
sf-pi's v2 shadow bridge with a deliberately always-confirm fake provider.
It was produced from evaluator commit `b688b49` and the independently authored
VALID-only corpus and model-free receipt. `SHA256SUMS` verifies the raw report.

| Bound component               | Identity                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| VALID corpus                  | `a95f61b055d4e214d1e0245b1b87f417a06ddbd1fb10a6f1c3e003ea2d1dbad8` |
| Model-free preflight          | `e0418dee9dff8ce13506219f70b0a99470c9ba8421f7635b873e541aa1537acc` |
| sf-pi v2 host                 | `d86cdcfcfa02e419a4255291d16e56c48a5f2ade`                         |
| sf-pi baseline                | `927c25ebee99f59ea349bcd6d5da06c9a999255e4e99d7658ee0f113da96e4f2` |
| Jev prompt protocol           | `d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530` |
| Jev v2 base decision protocol | `f4f00541c9ce815ca17d19400488f5e4e999c87e9712b7c0ec17419068e85f9b` |

All 58 prepared fake-provider calls answered, with zero attempted-call
fallbacks or replay errors. Six inputs had explicit pre-model fallback, and
three exact hard blocks remained code-owned. The current engine matched
83/96 authored labels, including 11 unsafe automatic allows and two benign
interruptions. The fake always-confirm decisions matched 57/96 labels; those
figures and the fake warm timings are **not a C8 model score**. No external
operation was executed, and no held-out TEST data was opened.

This receipt is historical: the final enforce-capable v2 host and a frozen
model-specific TRAIN-CAL scoring protocol will require a fresh, separately
sealed model-free preflight before real VALID scoring. The evaluator rejects
real scoring until those identities are in place.

`fake-shadow-calibrated-loader.json` is a second fake-only replay from evaluator
commit `109049005326033a9b703302bd0a4ace3b2c2ce3` after aligning its dormant
real path to the C8 TRAIN-CAL cutoff receipt. Its SHA-256 is
`98535e87f88866cf84d3bfe85751514b54925ce2ed8a4b9ecd21e1e7e8d887b0`.
It used an isolated detached checkout of the historical `d86cdcfc` host and
again recorded 58/58 eligible fake-provider calls, zero attempted fallbacks,
zero replay errors, and unchanged exact blocks. This checks the evaluator's
source and call-accounting path; it is not a local-model effectiveness or
latency measurement.
