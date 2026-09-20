# Raw-head VAL2: independent audit of actual laboratory inference

The raw-head laboratory campaign exercised the actual pinned feature/head path
for all 180 scheduled calls, completing without recorded errors or unrun rows.
Unlike the preserved production completeness campaigns, this run obtained real
recorded model scores. Its descriptive routing result fails the declared safety
gate: each pass sends 35 of 40 strong-required controls to raw fast. Combined
warm operational p95 is 260.819042 ms, above the 100 ms target.

The run explicitly forces essential-facts availability to true to reach the
encoder. It provides no production completeness proof, classifier qualification,
Pi dispatcher execution, downstream generation or promotion. All qualification
and promotion flags remain false. The previously consumed VAL2 population is
descriptive evidence, and the post-run cutoff calculation does not authorize
threshold tuning or repair the full goal in
[GOAL_ACCEPTANCE.md](GOAL_ACCEPTANCE.md).

## Scope and evidence identities

This bounded independent audit read the raw result, frozen plan and sidecar,
claims, source and archive manifests, archived source/evidence bytes, and the
threshold-overlap diagnostic. It also hashed the pinned head, fixture and
external Python launcher. Payload reconstruction selected only fixture IDs,
host labels, prompts and previous user/assistant exchanges; expected answers
were not dereferenced or analyzed. No raw prompts, tool bodies or gold answers
are reproduced here.

The audit used CPU hashing, archive inspection, serialization and arithmetic.
It did not execute the diagnostic, worker, tokenizer, model, GPU or Python
launcher, access the network or read credentials. The only written file is this
audit. ROOT separately reported actual terminal session 75883 completed with
exit code 0; this audit checks the preserved evidence rather than rerunning that
process or independently observing its historical device state.

| Preserved file                                                                                        |   Bytes | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------------- | ------: | ------------------------------------------------------------------ |
| [result.json](routing-head-raw-validation-v2/result.json)                                             | 573,385 | `b2a5eab21f0e1a9e383e27d2f3b32899b7794b875978baaeb0362d0908899947` |
| [plan.json](routing-head-raw-validation-v2/plan.json)                                                 | 149,967 | `38817154ca09999a76a4f99f3a35f82caa0b39a5857f5d8d6e0ff461f507a8d6` |
| [plan.sha256](routing-head-raw-validation-v2/plan.sha256)                                             |      65 | `c1b91e0905943e71e821bc7ab36c85d621d2a497707785b7648ec4bf02287d2f` |
| [run-claim.json](routing-head-raw-validation-v2/run-claim.json)                                       |     130 | `8ecf8434680e3c940aab98425ab1782ce5f09c8f30350e8665514fe23432ef35` |
| [prepare-claim.json](routing-head-raw-validation-v2/prepare-claim.json)                               |      46 | `c7a8b57e8333a67946f1ba9915f35595c591359bfbd9cf969fe2117daeaa0345` |
| [source-manifest.json](routing-head-raw-validation-v2/source-manifest.json)                           |   1,514 | `a8d8241a6161d033fee9c726a9bc317d3bc2a4475965fa9995e5335b384c7bad` |
| [archive-manifest.json](routing-head-raw-validation-v2/archive-manifest.json)                         |     513 | `edaf91f4edee2a9f4479791341add4b2d0acaecd82408b927c69bbd8112a3f89` |
| [evidence.tar.gz](routing-head-raw-validation-v2/evidence.tar.gz)                                     | 115,104 | `3150cde5ba3d57b9a042657d7a7cd463e19b4044131c1d4575a397c35ff91725` |
| [threshold-overlap-diagnostic.json](routing-head-raw-validation-v2/threshold-overlap-diagnostic.json) |     761 | `75869934f6297438cac94e25f091a1a00a29a418ae2d4ef3a714f63a246acc95` |

The plan sidecar exactly contains the plan file hash plus newline. The result
and run claim bind the same plan hash. Preparation is recorded at
2026-09-20T17:59:23.376Z and the run claim at
2026-09-20T18:00:18.775Z, in that order.

The archive's compressed hash and size match its manifest. It has exactly 13
regular members: six evidence files (plan, sidecar, preparation claim, run claim,
result and source manifest) and seven source files under `source-snapshot/`.
The complete member set matches this declared population, with safe relative
paths, no duplicate members and no link entries. Every evidence member equals
its preserved file, and every archived source member's size and SHA match the
manifest and frozen plan. The separately hashed archive manifest and subsequent
threshold diagnostic remain outside this evidence archive.

The plan and source manifest agree on all eight source entries: diagnostic
script, feature worker, TypeScript and built JavaScript runtime, TypeScript and
built JavaScript head, package lock, and the external Python launcher. Seven are
archived. The external `.build/rfdt-venv/bin/python` is 52,448 bytes and matches
SHA-256 `2e0ccaeff53d8335112e0654cca683b6e4acbaa3bdba86fa86660cd07f9e0b20`;
it was hashed without execution. The diagnostic source snapshot is pinned by
SHA-256 `d5c805216395dddde68fc75e21409390919839bbaa4100df1d15d721eb3bfe1c`.

## Head, fixture and exact encoder payloads

The physical frozen head is 119,474 bytes and matches the plan SHA
`6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e`.
Its settings match the plan: version 1, dimension 1152, strong-score threshold
0.1, minimum margin 0.02 and uncalibrated scores. The physical VAL2 fixture is
133,720 bytes and matches SHA
`e60a1b49b2f73d104a8a9c6221b5fda335b326b5f1bfdbb49ef8328da8b3752d`.
Neither artifact was modified for this audit.

All 60 plan rows match the fixture's ordered IDs and host labels. Independent
reconstruction of the frozen `diagnosticText` function matches every payload
and every payload SHA. With no prior exchange, the encoder text is exactly the
prompt. With a completed prior exchange, it is exactly:

```text
Previous exchange:
User: <prior user>
Assistant: <prior assistant>

Current request:
<prompt>
```

Both completed prior exchanges in VAL2 are retained. Host labels, expected
answers, group/family metadata and essential-facts flags are not serialized into
the encoder text. Payloads satisfy the frozen 32 KiB text and 64 KiB JSONL input
limits. The frozen call site passes only `text: row.text` and
`essentialFactsAvailable: true` to the runtime. That true value is an explicit
laboratory override, not an observation that facts are available.

The result marks `forcedEncoderCall: true`,
`essentialFactsAvailableIsForced: true`, `completenessProof: false`,
`featureCacheUsed: false`, and `qualificationSha256IsAttributionOnly: true`.
The plan uses the real frozen head and fixture with `testOnlyInputs: false`,
while retaining the explicit LAB purpose. Its attribution SHA recomputes from
the fixed string `raw-head LAB diagnostic; not qualification; productionQualified:false`
as `14379ccfe6818879c32010d3c000210552d961797384865ed6c75607d540234c`.
That attribution string does not supply a production qualification artifact.

## Full schedule and score consistency

The frozen schedule is exactly three ordered passes over the same 60 cases:
`cold`, `warm-1`, and `warm-2`. All 180 result identities (phase, index, ID and
payload SHA) match the complete frozen schedule. Every record is completed;
the error list is empty; each phase summary reports zero errors and zero unrun.
Host labels retain 20 easy, 20 hard and 20 unknown in every pass.

| Phase  | Completed / scheduled | Raw fast / strong / uncertain | Easy fast | Hard fast | Unknown fast | Strong-required raw fast |
| ------ | --------------------- | ----------------------------- | --------- | --------- | ------------ | ------------------------ |
| cold   | 60 / 60               | 54 / 6 / 0                    | 19 / 20   | 17 / 20   | 18 / 20      | 35 / 40                  |
| warm-1 | 60 / 60               | 54 / 6 / 0                    | 19 / 20   | 17 / 20   | 18 / 20      | 35 / 40                  |
| warm-2 | 60 / 60               | 54 / 6 / 0                    | 19 / 20   | 17 / 20   | 18 / 20      | 35 / 40                  |

The 60 case decisions and both recorded scores repeat exactly across all three
passes. These are repeated measurements over 60 consumed scenarios, not 180
independent cases. All negative controls remain in the population; across the
three passes there are 105 policy-unsafe raw fast routes among 120 repeated
strong-required calls. These are descriptive violations of the declared raw
route policy. The diagnostic performs no fast-model dispatch or task generation.

All 180 fast/strong scores and confidence values are finite and in [0, 1].
Fast and strong scores sum to one within 1e-12. Every recorded decision matches
the frozen rule: equality of scores or strong-score distance within half the
margin abstains; otherwise strong scores above threshold select strong and
those below select fast. Recorded confidence matches the frozen runtime's
selected-route score, with the maximum score used only for uncertain. It is not
necessarily the larger score for strong routes when threshold is below 0.5.
Confidence remains explicitly uncalibrated.

All input-token counts are integers within the pinned 2048-token maximum;
observed counts range from 72 to 1413. All feature, operational and diagnostic
elapsed values are finite and nonnegative, with feature time no greater than
operational time and operational time no greater than diagnostic time.

## Recorded model provenance and limits of independent recomputation

Every one of the 180 provenance objects exactly matches the fixed worker/runtime
policy and artifact pins:

- Model and modelId `google/gemma-3-1b-it`, revision
  `dcc83ea841ab6100d6b47a070329e1ba4cf78752`, with model weight SHA
  `3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6`.
- Worker source SHA
  `f3519bc5f33f86ffed0caf994549ad8b578db77fb84964e6f5906212522c5ead`
  and the exact eight pinned model/tokenizer file hashes.
- Official raw-text tokenizer preprocessing with special tokens and BOS, no
  chat template or truncation; 1152 final RMS-normalized decoder last-token
  features; no adapter, LM head or trainable model parameters applied.
- Metal required; official base dtype unchanged before float32 features;
  2048-token maximum; 268,435,456-byte MLX free-cache limit and 8,589,934,592-byte
  memory guideline explicitly marked as not a hard peak cap.
- Dependency pins Python 3.13.11, MLX 0.32.2, mlx-lm 0.32.0, Transformers
  5.11.0, huggingface-hub 1.32.0 and mlx_lm revision
  `9d1e356e7cc6549e7d1697adabe2ea01ff8e062c`.

These checks verify recorded provenance against the frozen source policy. They
do not constitute a new rehash of the large model snapshot or independent
historical GPU observation.

No feature vectors are persisted in the plan, result or archive. Consequently
this auditor cannot independently recompute the normalization, weight dot
product, logits or resulting probabilities from the frozen head. The audit
independently verifies payload bindings, numerical validity, recorded provenance,
route/confidence semantics, repeat consistency and aggregates. It does not claim
an independent end-to-end score recomputation. The result also contains no
downstream generated answer or accepted-correctness comparison.

## Operational timing and recorded cleanup

All nearest-rank p50/p95 summaries and maxima independently reproduce from the
recorded operational samples, including the one cold startup call, 59 subsequent
initial-pass calls and 120 warm calls.

| Population                 | Samples | Operational p50 (ms) | Operational p95 (ms) | Maximum (ms) |
| -------------------------- | ------: | -------------------: | -------------------: | -----------: |
| Cold pass                  |      60 |            67.204125 |           262.300750 |  4566.376959 |
| First cold startup call    |       1 |          4566.376959 |          4566.376959 |  4566.376959 |
| Initial pass after startup |      59 |            67.204125 |           262.300750 |   284.374959 |
| Warm pass 1                |      60 |            66.093333 |           260.576916 |   285.319625 |
| Warm pass 2                |      60 |            65.198625 |           260.819042 |   283.246750 |
| Combined warm passes       |     120 |            66.093333 |           260.819042 |   285.319625 |

The recorded campaign elapsed time is 21,924.514083 ms. Unlike the production
fallback campaign timings, these operational samples include actual feature
requests and cached-head scoring. The runtime's timing starts before queueing,
source verification and cold worker startup. The first call is the only record
marked cold start. The combined warm p95 is 2.608 times the 100 ms target and
therefore fails that timing gate in this descriptive LAB lane. These values
exclude production completeness, dispatcher and downstream generation and do
not establish full accepted-task latency or cost savings.

Cleanup is recorded as awaited and confirmed. Final runtime state is disposed,
modelReady true, with 180 submitted and 180 completed requests, zero fallbacks,
zero active requests and zero queued requests. Its head, worker and laboratory
attribution pins match the plan and records. ModelReady true records that this
runtime reached model-ready state before disposal; the disposed state and
confirmed cleanup do not indicate a worker intentionally left running. This is
internally consistent recorded cleanup evidence, without a new historical
process observation by this auditor.

## Consumed-validation threshold overlap

The separately preserved threshold diagnostic binds the exact result file SHA
and uses only the cold pass's full 60-case population. Its score ranges and
counts independently reproduce:

| Host control population            | Minimum recorded strong score | Maximum recorded strong score |
| ---------------------------------- | ----------------------------: | ----------------------------: |
| Easy                               |         8.764534313133887e-11 |           0.11231130249288027 |
| Strong required (hard and unknown) |         1.3952709634968598e-8 |            0.9826824388025571 |

For a strict scalar fast cutoff to preserve zero policy-unsafe fast routes on
these controls, its optimistic upper limit is the minimum strong-required score,
1.3952709634968598e-8. Only **2 of 20 easy scores** fall strictly below that
limit. This is below the declared **12 of 20** easy-fast target, even before
additional uncertainty-margin or confidence requirements. Thus a scalar cutoff
over these fixed scores cannot simultaneously produce zero unsafe fast routes
and the easy-fast target on this population.

This calculation is a post-run optimistic separation bound on consumed VAL2,
not a prospective threshold or independently qualified policy. It ignores
additional abstention/confidence requirements, applies no runtime change, and
explicitly records `appliedToRuntime: false` and `productionQualified: false`.
It does not prove that different learned features or a different head could
never improve; those would require their own frozen training and fresh
validation evidence.

## Acceptance boundary

The raw-head lane now supplies actual recorded inference evidence, while
rejecting this frozen head's descriptive safety and timing gates on VAL2. It
does not repair the production completeness failures, establish safe useful
Pi routing, execute the same-prompt lifecycle or demonstrate accepted downstream
correctness against the strong baseline. No production qualification or
promotion is justified.

No attributable archive, plan, source, head, fixture, payload, schedule,
provenance, numeric route, timing or diagnostic-integrity discrepancy was found
within this bounded audit. All negative routing and timing results are retained,
along with the explicit lack of persisted features and independent score
recomputation.
