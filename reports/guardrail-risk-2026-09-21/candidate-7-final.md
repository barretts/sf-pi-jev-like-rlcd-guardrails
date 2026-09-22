# Candidate 7 delivery report (2026-09-22)

**Outcome: both Candidate 7 models failed prospective VALID selection.** Both
real local models avoided unsafe automatic allows and completed every prepared
model call within the 750 ms hard deadline. They still interrupted many more
safe requests than the existing engine. The existing sf-guardrail engine remains
active, Jev defaults to `off`, and the held-out TEST corpus was not opened or
scored. Neither model has an enforcement qualification.

## Measured result

The 128- and 256-update models were each scored against the same sealed 65-case,
22-group VALID set through the pinned sf-pi risk bridge in shadow mode. The
fixed cutoff was `0.99`; no decision criterion was adjusted after either score.

| VALID measure                                         | Existing engine |  128 updates |  256 updates |
| ----------------------------------------------------- | --------------: | -----------: | -----------: |
| Expected actions matched, of 65                       |              60 |           37 |           41 |
| Unsafe automatic allows, of 29 risky cases            |               3 |            0 |            0 |
| Safety regressions / exact hard-block demotions       |               — |        0 / 0 |        0 / 0 |
| Unnecessary confirmations or blocks, of 36 safe cases |               2 |           28 |           24 |
| Corrected baseline risks / fewer benign interruptions |               — |        3 / 0 |        3 / 0 |
| Prepared semantic model calls answered                |               — |      36 / 36 |      36 / 36 |
| Model fallbacks / replay errors                       |               — |        0 / 0 |        0 / 0 |
| Warm risk-check p95 / maximum                         |               — | 556 / 591 ms | 485 / 521 ms |
| Calls beyond 750 ms hard deadline                     |               — |            0 |            0 |
| Cold provider initialization, separate                |               — |       3.19 s |       3.12 s |
| Candidate eligible for held-out TEST                  |               — |           no |           no |

The [128-update per-case receipt](./candidate-7-evidence/valid/model-128.json)
has SHA-256 `a2016f0ca1ac2e66df8721ebe2f15c3094b73e1e05254829306411f05bc2aefa`.
It confirmed all 36 prepared requests, including 28 whose authored outcome was
`allow`. Its warm p95 of 556.24 ms met the 750 ms requirement but missed the
sub-500 ms ideal. The [256-update per-case receipt](./candidate-7-evidence/valid/model-256.json)
has SHA-256 `b5defa240353408c50304623cf7ce424681ae98b03c6fb68b1c33fe189466599`.
It allowed four prepared safe requests and confirmed the other 32. Its warm
p95 was 485.32 ms, below the ideal, and maximum was 521.28 ms. Both reports
record `benignInterruptionsAtOrBelowBaseline: false`,
`candidateSelectionEligible: false`, and `qualification: false`; all other
predeclared VALID gates passed. A finite zero-unsafe result does not imply 100%
safety beyond this corpus, and the corrected baseline risks do not offset the
failed usability gate.

A **VALID-only score diagnostic** also shows why a post-hoc global cutoff
change cannot rescue the 256-update model on these same records. The highest
`allowScore` for a risky prepared request with a raw `allow` token is
`0.8541790372294901`, so zero unsafe allows would require a cutoff strictly
above it. Five safe prepared requests score at or below that value, and four
other safe requests chose the raw `confirm` token. At least nine unnecessary
interruptions would remain, versus two for the existing engine. This is not
a changed cutoff, rerun, qualification result, or estimate beyond VALID.

The baseline numbers come from the frozen fake-provider **host preflight**, not
from either C7 model. They reflect the final code-owned preview-send floor:
60/65 expected actions, three unsafe automatic allows and two benign
interruptions. Of 65 requests, 36 reached the semantic model lane (28
rubric-safe, eight approval-required); 21 hit exact/code-owned policy floors,
five were ineligible and three used pre-model fallback. The 29 risky cases
include 21 outside the model lane. Apex, AgentScript, SOQL, Canvas, and browser
risks were among the code-owned or ineligible lanes; their correct final
outcomes do not demonstrate learned model detection there. Model effectiveness
claims must identify the eight prepared risky cases separately from code-owned
protection. The historical strict mixed-risk-per-family diagnostic remains
false and is explicitly not the lane-aware C7 selection gate.

## Frozen training and source

The C7 admission contains 227 TRAIN rows in 77 complete operation groups:
175 inherited admitted C6 rows plus 52 new contrast rows in 18 groups (26
allow/26 confirm). The admitted TRAIN JSONL SHA-256 is
`745004e919d7c8cd6d3a1bb0078f741a9fa6134443ea195b618cf6a39aed53e7`.
Neither RFDT run prepared internal VALID or TEST rows. Both use the original
Google `google/gemma-3-1b-it` base revision
`dcc83ea841ab6100d6b47a070329e1ba4cf78752` and the fixed v2 scoring
protocol SHA-256
`d67044fb1a5d2a519f12e8e7ed743f42753f726812b0bd99ea6ab530`.
The TRAIN source commit is `845b67913f099897241b88451bf463d1d98c6312`;
the two training plans were fixed before C7 VALID model scoring.

The independent VALID evaluator commit is
`d064f7402d9e8eebf0cc9bdb811dee7a59210976`, and its corrected blind
manifest SHA-256 is
`868dac2146b72e732b07017c451f88f1066c2faea3c46300f5fba75545e76200`.
Its held-out TEST manifest is an opaque seal here. It is not a scored set.
The authored VALID rubric is independent of the current engine's baseline;
disagreement with the engine does not automatically count as model error.

Both fixed RFDT runs completed their planned steps, changed the adapter,
verified checkpoint reload, and exported distinct F16 GGUF files. Training
loss fell from 7.39 to 0.443 at 128 updates and to 0.132 at 256 updates;
these TRAIN observations establish that optimization ran, not that either
model meets the VALID acceptance bar. Each GGUF is 2,006,573,408 bytes and
remains local outside Git.

| Fixed run                                                    | Model identity                       | Training plan SHA-256                                              | GGUF SHA-256                                                       |
| ------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [128 updates](./candidate-7-evidence/runs/128/manifest.json) | `jev/gemma-3-1b-guardrail-c7-128-v1` | `75f49e15a3ac4386bb824ffbf984b1328bb6033ff8bc4f6be677bbec9faada07` | `ce635434131c6585935625d1c070e5795c5a72f2ef2375980fcdcaa380944128` |
| [256 updates](./candidate-7-evidence/runs/256/manifest.json) | `jev/gemma-3-1b-guardrail-c7-256-v1` | `e68b2c5c4f1cd50644d4e577ed6bc1bfa24f968cd7876bdb87dc1ed091e4eb9e` | `9d1bffc4ed982dea529841d20ac4a56cd0f5086107f2aa6da0c1ea17ae148006` |

The weights are at
`/private/tmp/simple-jev-ts-guardrail-c7-unified-20260922/.build/guardrail/candidate-7-rfdt-128step-finalhost-v2/gemma-3-1b-rfdt-f16.gguf`
and
`/private/tmp/simple-jev-ts-guardrail-c7-unified-20260922/.build/guardrail/candidate-7-rfdt-256step-finalhost-v1/gemma-3-1b-rfdt-f16.gguf`.
The two exported artifact descriptors and registries are retained in the
evidence bundle. The [37-file SHA-256 inventory](./candidate-7-evidence/SHA256SUMS)
has SHA-256 `f94223a62e6d39c2d88ceee42fcb833d2d0c320d322698436aeaa5d9ee7f3cd9`;
every listed file verified after packaging. The
[bundle manifest](./candidate-7-evidence/manifest.json) has SHA-256
`5a159cfd21206391fdd4f6ac3993d87749f64a0b4481071a2052322e3a4ded8f`.
It retains the original admission, 52-row host-projection receipts, both
training plans/manifests/attempts, the fake host preflight, and both complete
65-case real VALID reports. No held-out TEST payload is in the bundle.

## Integration and proof limits

The [baseline-bound C7 sf-pi patch](../../integrations/sf-pi-guardrail/candidate7-sf-pi-from-4f901db9.patch)
reproduces evaluation host commit `bc7862b078997d2c60aa908979b5cbf59f83db80`
and tree `77baa1b435e07da31675a26ead942d36f0a1bdbe` from baseline
`4f901db9c3f5076ea0305dea33ad6e8856e467da`. Its SHA-256 is
`b1a6e9cbaa436b803fe43b88cc4472f08e1df4261b5ce22001486ca8caeb4bae`.
The evaluation-host runtime SHA-256 is
`6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e`.
The patch was checked with a disposable Git index, leaving sf-pi's working
files and index unchanged. The 52 newly authored TRAIN requests generated
byte-identical model inputs on the prior training host and this evaluation
host; the 175 inherited C6 TRAIN inputs were not reprojected.

The comparison uses stubbed tool execution and authored org/browser facts.
The scorer observes the actual code-owned risk floors before model comparison,
but the VALID replay is a bridge-shadow test, not a live external workflow or
full Pi approval/audit lifecycle. Browser evidence describes the observed
request context, not a future live click effect. Latency is measured on a
serial isolated replay; cold initialization is separate. Model scores are
uncalibrated. A finite zero-unsafe result would not prove 100% population
accuracy, and no model may be enabled without the frozen held-out gate.

The first sandboxed TRAIN-only native smoke could verify the C7-128 artifact
but could not create a Metal command queue (`default device: (null)`). The
same pinned artifact and runtime succeeded when executed with Metal access:
one admitted TRAIN read request returned a valid uncalibrated response in
260 ms after 29.6 s cold loading. This was an infrastructure diagnostic, not
a VALID score. Both real VALID replays used that same runtime profile. Their
serial warm timings include host configuration, baseline classification,
bridge preparation, queue wait and local inference; they do not establish
latency under concurrent load or a matched user workflow.

The evaluator replayed the final host's Safety Kernel, code-owned preview
floors and Jev bridge with stubbed execution in shadow mode. It did not invoke
the full Pi `tool_call` handler's approval, session or audit lifecycle, and
neither Salesforce nor any other external operation executed. Separate hook
tests establish integration behavior, not learned model effectiveness. The
model input was checked against the complete original operation and
independently resolved facts, and its per-case hash had to match the fake-host
preflight. Since both prospective VALID candidates failed the usability gate,
there is no selected model to freeze, no held-out TEST score, and no basis to
enable enforcement. Future work needs a new prospective campaign rather than
post-hoc adjustment of these candidates' cutoff or criteria.
