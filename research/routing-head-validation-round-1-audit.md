# Routing head validation round 1: independent evidence audit

The first preserved production classification campaign completed its full frozen
schedule, but it did not qualify the routing head. All 180 attempts selected
strong, all 180 production completeness checks remained unverified, and the
runtime submitted zero feature requests. This establishes a completed campaign
of the actual production fallback path. It does not establish head quality,
useful easy-task routing, neural inference latency, or downstream correctness.

The recorded result is `productionQualified: false` and
`qualificationCandidate: false`. No promotion follows from this evidence. The
full routing goal in [GOAL_ACCEPTANCE.md](GOAL_ACCEPTANCE.md) remains open.

## Scope and exact evidence

This bounded independent audit read the three preserved evidence files below
and the specifically authorized frozen `headEvaluationContext` and
`workflowConversation` functions. It performed CPU-only hash, serialization,
schedule, population, aggregate, and attempt consistency checks. It did not
invoke the worker, tokenizer, model, GPU, network, or validation harness, and
did not change source, configuration, credentials, or evidence files. The only
written file is this audit.

The recomputation selected host case metadata, prompts and prior-exchange
fields, plus aggregate and attempt classification evidence. Expected answers
were not interpreted or used to judge correctness. No expected answers or
prompt bodies are reproduced here.

| Preserved file | Bytes | SHA-256 |
| --- | ---: | --- |
| [result.json](routing-head-validation-round-1/result.json) | 650,734 | `e888ebf8ae9a94398cf313c805a66248ff3772647a2e6de760357200e28a25d8` |
| [protocol.json](routing-head-validation-round-1/protocol.json) | 32,528 | `bfd39d11ae7472b28080245f42258700ec82031a758c7bbe73da346d8983f6ad` |
| [source-manifest.json](routing-head-validation-round-1/source-manifest.json) | 3,714 | `4a7fbd892c655c5c2adcbf88eb1f7cd1059ba4ee97c2288b9a4b0f5a9c028d10` |

The result binds the exact protocol file hash. The source manifest has 17 unique
named entries, and its ordered name-to-SHA map exactly equals
`protocol.sourceSha256`. Sixteen entries are archived; the Python executable
entry is recorded without an archive copy. ROOT separately verified all 17
physical source/executable references and the archived source snapshots. This
audit independently checked their manifest/protocol bindings, rather than
repeating that broader physical source audit.

The principal recorded artifact identities are:

| Identity | SHA-256 |
| --- | --- |
| Frozen head | `6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e` |
| Training plan | `9a9faabd4e550f8db17fe4cec3fb45479fb04b1d1c19e2f5130ded45a24f763e` |
| Classifier wrapper | `f2cc4741d7ed6615fc9337f57aa5b2cdc646c29a25a860ec9bae71ec1818a958` |
| Worker source | `f3519bc5f33f86ffed0caf994549ad8b578db77fb84964e6f5906212522c5ead` |
| Qualification policy | `9728b875d55808835bf9b298e5505f54ef3652969fbb9c6f513335e05b5a5368` |
| Code-bundle source identity | `f3fbdf93320d71f4053434468a272fcca35010d0a02310ce354dcf6e53f7c21f` |

The code-bundle source identity recomputes exactly as SHA-256 of
`JSON.stringify(protocol.sourceSha256)`. The qualification policy identity
recomputes exactly as SHA-256 of its two-space JSON serialization with a final
newline. Every attempt's wrapper, head, worker, and qualification policy pins
match the protocol/source map.

## Complete schedule and preserved negatives

The protocol declares 60 distinct cases and 60 distinct context hashes: 20 easy,
20 hard, and 20 unknown, spanning 12 declared families. Each case has a distinct
declared group and `metadata.independent: true`. The schedule runs the complete
population once in the named cold pass and twice in the named warm passes.
The actual schedule and ordered attempt identities exactly match all 180
protocol entries; every scheduled entry records completion.

| Pass | Phase | Scheduled / attempted / completed | Easy | Hard | Unknown | Easy fast | Unsafe fast | Completeness verified | Raw head scores available |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | cold | 60 / 60 / 60 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |
| 1 | warm | 60 / 60 / 60 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |
| 2 | warm | 60 / 60 / 60 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |

There are zero recorded errors and zero unrun attempts. All 40 strong-required
cases select strong in each pass, retaining the full 120 repeated hard/unknown
attempts. All 20 easy cases also select strong in each pass. Consequently easy
fast coverage is zero, each pass is all-strong, and each pass's ordinary and
qualification gates both record `passed: false`.

The reports' `incomplete: 0` means there are no missing execution records. It
does not mean completeness was verified: all 180 classifications explicitly
record `complete: false` and each pass reports `completenessVerified: 0`.

The declared independence has specific limits. The protocol says validation
was machine-authored and frozen before fitting, with the same author as TRAIN,
possible conceptual family overlap, and no exact prompt/prior-pair overlap.
These are preserved protocol attestations; this bounded audit did not inspect
other corpora to independently prove separation. The repetitions contribute
three measurements per case, not 180 independent scenarios. The sensitivity
summaries contain 60 one-case groups per pass and empty `byFormat` and `byOrder`
objects. Their `matchedVariantsInvariant: true` does not demonstrate paired
format or option-order robustness.

## Exact contexts and input identities

All 60 protocol context SHA values match independent reconstruction from the
allowed result prompt/prior fields using the two frozen source functions. The
reconstruction preserves the actual role/message envelope, assistant text
representation and completion status where applicable, fixed timestamp zero,
and fixed conversation-evidence usage fields.

All 180 `classification.sourceSha256` values also match independent
reconstruction of the actual classifier input, with its original insertion
order:

```js
{
  prompt: actual.latestUserText,
  ...(previousExchange
    ? { previousExchange: { user: priorActualUser, assistant: completedActualAssistant } }
    : {}),
  toolResults: []
}
```

There are 56 cases without a prior exchange and four cases whose prior field
is a user string. The latter produce prior user messages in the context, but
do not provide a completed prior user/assistant exchange for the classifier
input. The independently reconstructed inputs therefore contain only
`prompt` and `toolResults` in this campaign. Their recorded hashes match that
actual extraction behavior.

Host `label`, `family`, `expected`, `metadata`, and
`essentialFactsAvailable` fields are outside the reconstructed message
contexts and classifier input objects. Forty cases carry a true host
essential-facts flag, but the actual production verifier does not treat that
host flag as completeness evidence. No host label or expected answer was added
to the reconstructed classifier request.

The protocol's code-bundle `sourceIdentity` and an attempt's per-request
`classification.sourceSha256` intentionally identify different objects. Their
different values are not an integrity discrepancy. Both identities match
their own intended serialization.

## What the production path actually exercised

Every classification records route strong, `complete: false`, confidence zero,
zero input tokens, zero feature time, and null model provenance. Every raw-head
record is unavailable, with null fast/strong scores and reason
`production-completeness-rejected-or-no-encoder-score`.

| Production completeness reason | Attempts |
| --- | ---: |
| `unsupported-or-unverified-routine` | 114 |
| `unverified-referenced-source` | 6 |
| `explicit-missing-facts` | 60 |
| **Total** | **180** |

All 180 eligibility records preserve the original campaign reason
`classification-binding-mismatch`. That frozen reason combines eligibility
conditions and includes rejection when `complete !== true`; it does not
establish a hash mismatch. The independent context, input, wrapper, head,
worker, policy, and bundle checks above found no such mismatch. Subsequent
source changes to reason wording do not rewrite this preserved campaign.

This result is attributable to the production completeness gate taking the
fallback path. It provides no observed head predictions from which to infer
poor head quality, a good head, neural accuracy, or a model confidence margin.
The head was not exercised. Zero unsafe-fast decisions in an all-strong run
does not establish useful routing coverage.

The result has `realExecution: true`: the actual production CPU context,
completeness, fallback runtime, binding and eligibility path ran. The protocol
also records no feature-cache replay, no raw-head diagnostic bypass, no
training during evaluation, no network, one classification at a time, and
`fullPiWorkflow: false`. This is not a full Pi dispatcher/downstream task
campaign.

Each pass schedules 60 answer checks but records zero checked and 60
unavailable, with `allPassed: false`. There is no accepted downstream answer or
paired strong-baseline correctness evidence in these files.

## Timings and recorded cleanup

The attempt-level router elapsed samples independently reproduce the reported
p95 values and observed maxima using the nearest-rank p95 over 60 samples per
pass.

| Pass | Recorded phase | Router p95 (ms) | Router maximum (ms) | Actual feature requests |
| ---: | --- | ---: | ---: | ---: |
| 0 | cold | 0.223291 | 3.416000 | 0 |
| 1 | warm | 0.114458 | 0.117833 | 0 |
| 2 | warm | 0.082125 | 0.088375 | 0 |

The campaign timestamps are 2026-09-20T17:26:07.521Z through
2026-09-20T17:26:07.645Z, a recorded wall span of 124 ms. The protocol's intended
timing boundary includes worker startup and inference when present. Neither
was present here. These small values measure the executed CPU fallback path;
they are not cold model startup, warm neural inference, or successful full
router latency evidence. The named warm repetitions never warmed the model.
No feature-cache latency samples are available.

Recorded cleanup is completed with null error. The final runtime status is
disposed, with `modelReady: false`, zero active and zero queued requests, zero
completed worker requests, zero submitted requests, and 180 fallback requests.
This is internally consistent with no worker invocation and no feature calls.
It is recorded campaign cleanup evidence, not a new historical process or GPU
observation by this auditor.

## Qualification boundary and remaining work

The outer laboratory assumption treats matching artifact pins as qualified
only inside this evaluation so that the production eligibility guard can be
asked. The protocol explicitly says this assumption supplies neither quality
evidence nor completeness proof and is not a production qualification
manifest. The policy itself remains `productionQualified: false`, every pass
is ineligible, and both the top-level result and summary reject qualification.
The policy's prospective 60% easy-fast minimum is not met by zero coverage.

The full goal still needs verified production context completeness, actual
fresh feature/head execution with full positive and negative denominators,
useful correct easy-fast coverage, controlled family and option-order evidence,
and the full same-prompt Pi lifecycle with cancellation, safety guards,
operational router timing and accepted downstream correctness against the
strong baseline. The preserved run cannot answer those questions and does not
authorize promotion or tuning after validation.

No attributable integrity discrepancy was found within this bounded evidence
audit. Its negative outcome is retained in full. Further source re-review or a
reinterpretation of this run cannot supply the missing inference and
qualification evidence.
