# Independent audit of routing head round 1 TRAIN evidence

Read-only audit on 2026-09-20 of
`.build/routing-experiments/frozen-head-round-1`. The audit read the TRAIN-only
fixture, frozen plan, feature cache, head, completion journal, and their seven
source/binary references. It used independent Python standard-library hashing
and arithmetic. It did not execute the feature worker, fit another head, load a
model/tokenizer, run GPU inference, use network or credentials, inspect model
configuration, or read validation labels/predictions. The only written file is
this report.

**Result:** all 1,249 consistency, population, provenance, chronology, numerical,
and objective/gradient checks passed. No attributable integrity, coverage, or
arithmetic finding was identified. This result establishes a complete,
attributable TRAIN extraction and an internally consistent stationary cached
head fit. It does not qualify the router, establish downstream correctness, or
approve/promote a model.

## Exact evidence identities

These are hashes of the original bytes, independent of any later archive path.
Archive membership and archive hashes are outside this audit.

| File under the original evidence directory | Bytes | SHA-256 |
| --- | ---: | --- |
| `plan.json` | 94,614 | `9a9faabd4e550f8db17fe4cec3fb45479fb04b1d1c19e2f5130ded45a24f763e` |
| `plan.sha256` | 65 | `9c37cfc93a67abd3fd6354d12566bbd4fff0b26b7dda2f62360a46e4091ea571` |
| `features.json` | 5,230,455 | `6354b9c0c832bb8933bc14f24ce3e8dccde6573b8daaa5621462f0047e378cac` |
| `head.json` | 119,474 | `6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e` |
| `journal.json` | 36,885 | `3d939dd3dc546fa71830261e5e213e478f044b3df3d3028834970d0a10cc1808` |
| `prepare-claim.json` | 41 | `fcb4ec6c2cd5c83eea0235159fa5003894242d37414689243f5045178eb3c439` |

`plan.sha256` contains the exact `plan.json` SHA-256 followed by a newline.
Both the feature cache and completion journal bind to that plan hash. The
journal binds to the exact saved head hash and reproduces its training
diagnostics exactly.

The full TRAIN fixture is `fixtures/routing-train.json`, SHA-256
`4c444028cff3c3bff3df7fb73966e300c56c77a7be9f43308578a05482569c20`.
Its 240 ordered case objects equal the plan's 240 ordered rows exactly.

All seven frozen references still match their recorded size and SHA-256:

| Repository-relative reference | Bytes | SHA-256 |
| --- | ---: | --- |
| `scripts/routing-head-train.mjs` | 18,008 | `01cc4504810f72b9ffa787389b823e66fffa96698ca1d8e1068ce90e8e458b3d` |
| `routing/feature_worker.py` | 18,384 | `f3519bc5f33f86ffed0caf994549ad8b578db77fb84964e6f5906212522c5ead` |
| `src/routing-head.ts` | 19,022 | `81e332082fabd45bac9aa6d7c831e3e5386cc0fc63682aafbc1e89a586a8b9b9` |
| `dist/routing-head.js` | 17,155 | `09e0eaa13b07452eac0f0cf851630f0c88aa53c540afb49948481dc888a5d3ba` |
| `src/routing-runtime.ts` | 22,505 | `92cc5a850089ff3566a4b65ebf62cbb6b871ebbefdb8a1a4fbf98fa46cc239ee` |
| `dist/routing-runtime.js` | 22,191 | `60012ebc3f636c73649ad67ee01600c9064ff82a4babbbbd0e999477744c6514` |
| `.build/rfdt-venv/bin/python` | 52,448 | `2e0ccaeff53d8335112e0654cca683b6e4acbaa3bdba86fa86660cd07f9e0b20` |

## Full TRAIN population and provenance

The plan, fixture, and feature cache retain every one of the 240 scheduled rows:
120 `fast` and 120 `strong`, including the complete negative population. IDs are
unique and ordered identically. Every cached row retains the original family
and label and has the correct UTF-8 text SHA-256. All 240 input text hashes are
distinct. Every row has exactly 1,152 finite features: 276,480 feature cells in
total. Recorded input lengths are 30–94 tokens, totaling 13,831 tokens.

Journal scheduled/completed/feature-call counts are all 240. Errors and unrun
counts are zero; cached CPU fitting reports zero additional feature calls.
The plan declares TRAIN-only scope, no heldout read, and no network. This audit
does not infer independence or generalization from the machine-authored TRAIN
population or treat its labels as independently verified quality gold.

Feature-cache and journal provenance agree exactly. Their official base binding
is `google/gemma-3-1b-it`, revision
`dcc83ea841ab6100d6b47a070329e1ba4cf78752`, with recorded full-weight SHA-256
`3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6`.
The worker source hash agrees with the frozen source reference. The eight
recorded file pins agree with the worker's literal frozen `FILE_SHA256` map.
This audit did not independently rehash the physical base weights or recompute
features through the model.

The representation is raw official-tokenizer text with BOS, special tokens
enabled, no chat template, and no truncation. Features are the final
RMS-normalized decoder state at the last token, dimension 1,152. Provenance
retains no adapter, LM-head, or trainable path, requires Metal, and labels its
8 GiB MLX memory guideline as a guideline rather than a hard peak-memory cap.
Recorded runtime attribution is Python 3.13.11, MLX 0.32.2, mlx-lm 0.32.0,
transformers 5.11.0, huggingface-hub 1.32.0, and mlx-lm revision
`9d1e356e7cc6549e7d1697adabe2ea01ff8e062c`. These are the captured worker
attributions; dependency execution and hardware were not independently rerun.

## Independently reproduced cached-head arithmetic

The head is dimension 1,152 and uncalibrated. Its options match the frozen plan:
L2 `0.001`, at most 300 iterations, stationarity tolerance `1e-7`, feature
standardization enabled, strong-score threshold `0.1`, and margin `0.02`.
Neither that threshold nor the logistic score establishes calibrated confidence
or a useful/safe route.

The audit sorted cached rows by ID as the frozen fitter does, independently
recomputed TRAIN feature centers and population standard deviations, then
recomputed the mean logistic objective plus L2 weight regularization. It
recomputed every weight-gradient component and the unregularized bias component
from the stored features and TRAIN labels. No optimizer was run and no route
accuracy was calculated.

| Arithmetic result | Value |
| --- | ---: |
| Recorded optimizer iterations | 75 |
| Initial objective | 0.6931471805599442 |
| Recomputed final objective | 0.0033907996664633653 |
| Recomputed data loss | 0.0008584393628041488 |
| Recomputed regularization loss | 0.0025323603036592167 |
| Maximum center difference | 3.552713678800501e-14 |
| Maximum scale difference | 1.7763568394002505e-15 |
| Maximum full-gradient component difference | 2.1141942363467336e-18 |
| Objective difference | 0 |
| Recomputed full-gradient infinity norm | 9.373681228258803e-8 |
| Recomputed full-gradient Euclidean norm | 7.607997340840574e-7 |

The infinity norm, including bias, is below the declared `1e-7` tolerance and
supports the recorded `stationary: true` / `termination: stationary` state.
The Euclidean norm is a separately reported diagnostic; the declared stopping
criterion is the infinity norm. Head loss components, gradient norms, population
counts, and all journal diagnostics agree. CPU fit time recorded by the runner
is 146.822 ms. This establishes numerical consistency of the TRAIN fit rather
than classifier acceptance.

## Timings with their actual scope

All 240 rows and the first cold model-loading row remain included below. p95 is
the nearest-rank 95th percentile. Warm summaries exclude only the first row and
are reported alongside the complete population.

| Recorded measurement | First row | All rows: n / total / median / p95 / max | Warm rows: n / total / median / p95 / max |
| --- | ---: | --- | --- |
| Worker feature elapsed | 341.169 ms | 240 / 6,286.177 ms / 22.571 ms / 31.043 ms / 341.169 ms | 239 / 5,945.008 ms / 22.564 ms / 31.043 ms / 31.984 ms |
| Training-driver request elapsed | 342.330 ms | 240 / 6,485.942 ms / 23.419 ms / 32.017 ms / 342.330 ms | 239 / 6,143.612 ms / 23.411 ms / 32.017 ms / 32.841 ms |

The worker's elapsed includes lazy decoder loading/materialization and the first
forward on the first request. The training driver's `operationalElapsedMs`
starts after the worker ready record, immediately before writing that row's
request, and ends after response validation. It therefore excludes source/base
hashing, tokenizer/ready startup, per-row feature-cache/journal persistence,
cached head fitting, routing guards, dispatcher work, and downstream provider
execution. Its approximately 32 ms warm p95 is feature-extraction transport
timing, not complete operational router p95. This run uses the training driver's
worker transport, rather than exercising actual Pi dispatch.

Journal wall time is 13,917 ms from `2026-09-20T17:05:45.302Z` to
`2026-09-20T17:05:59.219Z`. Preparation starts at `17:05:45.164Z`; plan creation
is `17:05:45.168Z`. The recorded chronology is ordered. Wall time and summed
row timings measure different work and are not substituted for one another.
No baseline ratio, routing speed acceptance, cache saving, billing, energy,
complete-workflow latency, or downstream quality is established here.

## Completion and cleanup evidence

The terminal journal records worker PID/process group 20636, normal exit code
0, no terminating signal, both streams closed, wait completed, and process group
absent. The frozen driver sets these fields from its child close/stream events
and an absence check, and refuses completed status on incomplete cleanup,
remaining protocol data, interruption, or other terminal contradictions. The
journal's terminal state is `completed_training_only`; approval and promotion
are both false. Stderr records zero bytes and the empty-content SHA-256, with no
body retained.

This is source-bound recorded cleanup evidence. The audit did not independently
observe the historical process exit, enumerate live processes, recover the
original command's terminal status, or replay worker responses. Those limits
remain explicit instead of converting the journal into an independent model
parity or production acceptance proof.

The next evidence lane is fresh, full native routing validation against the
predeclared denominator, followed by actual same-prompt Pi dispatch and complete
paired accepted-task confirmation under
[GOAL_ACCEPTANCE.md](GOAL_ACCEPTANCE.md). A successful TRAIN fit cannot clear
those gates, and this audit makes no qualification or promotion recommendation.
