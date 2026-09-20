# Routing head VAL2: independent audit of the negative native campaign

The native VAL2 campaign completed all 180 scheduled production classification
attempts without errors, but again provided no useful routing coverage. Every
attempt selected strong and recorded production completeness false. The runtime
submitted zero feature requests, produced no raw head scores, and never became
model ready. Qualification remains false. This is evidence of the executed
production completeness/fallback path, with no observed head accuracy or neural
latency from which to draw a quality or performance conclusion.

The fresh source-blind fixture is now consumed validation evidence. Its stronger
authorship separation does not turn this all-strong outcome into successful
routing. Successful head fitting and export do not repair a production guard
that accepts no requests for feature/head execution. The full routing acceptance
work in [GOAL_ACCEPTANCE.md](GOAL_ACCEPTANCE.md) remains unfinished.

## Bounded scope and exact files

The independent audit checked the native result, protocol and permanent run
claim; their archived copies; the source and archive manifests; the evidence
archive; the 16 archived source snapshots and pinned external Python launcher;
and the exact frozen head, fixture, fixture protocol, wrapper and qualification
policy bytes. It reconstructed contexts and classifier inputs using only host
case metadata, prompts and prior-exchange fields, plus aggregate and attempt
classification evidence. Expected answers were not dereferenced or analyzed.
No prompt bodies or gold answers are reproduced here.

These checks used ordinary CPU file hashing, JSON serialization and archive
reading. They did not invoke the harness, worker, tokenizer, model, GPU, network,
or Python launcher, and did not read credentials. The only written file is this
audit; all historical evidence and source files remain unchanged.

The native files under `.build/routing-experiments/head-validation-v2-root-1`
are byte-identical to the corresponding preserved files below.

| Preserved file | Bytes | SHA-256 |
| --- | ---: | --- |
| [result.json](routing-head-validation-v2/result.json) | 936,897 | `eb547be14edff18a5ef44163a2bfe57e51f65419b501208d0d52a00ae2354fa3` |
| [protocol.json](routing-head-validation-v2/protocol.json) | 37,889 | `35ca3dde29a1620847ff9563d708ae1490f110635f0b0ca3b0591e63756bfad0` |
| [run-claim.json](routing-head-validation-v2/run-claim.json) | 176 | `6b805c496ff8aad711e5730d7361f7a3bf1d714eb28ddc0b30977ba6518b163c` |
| [source-manifest.json](routing-head-validation-v2/source-manifest.json) | 3,714 | `46bbffab22fbdebf6122c5454dd5c8dfbdeb6c2a9da78dd236d68efb0a766f3c` |
| [archive-manifest.json](routing-head-validation-v2/archive-manifest.json) | 423 | `b0f8088a17275ebc41f7d1218d25aca49334ff179682e169657fa8a0d6e10721` |
| [evidence.tar.gz](routing-head-validation-v2/evidence.tar.gz) | 192,632 | `5fb8728725d5f64f7b7ad50f5de0b01bd3f787cd31a847aac5432251736a3e08` |

The result and permanent claim both bind the exact protocol file SHA. The claim
records owner PID 46827, claimed at 2026-09-20T17:43:14.914Z, immediately before
the recorded start. This is a preserved claim and chronology check, not a new
observation of that historical process.

The compressed archive hash and byte count match its manifest. Its 20 regular
members consist of the result, protocol, run claim, source manifest and all 16
archived source snapshots. Member paths are relative and safe, with no duplicate
members or link entries. Every member is byte-identical to its preserved
snapshot. All 16 source member sizes and hashes independently match the source
manifest and protocol pins. The seventeenth pin is the external Python launcher
at `.build/rfdt-venv/bin/python`; its 52,448 bytes independently match SHA-256
`2e0ccaeff53d8335112e0654cca683b6e4acbaa3bdba86fa86660cd07f9e0b20`.
The launcher was hashed, not executed, and is intentionally not in the archive.

## Artifact, fixture and source bindings

| Frozen artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| [head.json](routing-head-round-1/head.json) | 119,474 | `6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e` |
| [routing-validation-v2.json](../fixtures/routing-validation-v2.json) | 133,720 | `e60a1b49b2f73d104a8a9c6221b5fda335b326b5f1bfdbb49ef8328da8b3752d` |
| [routing-validation-v2-protocol.md](routing-validation-v2-protocol.md) | 17,266 | `3d9d50a4e9329414795f996008a8965ea1af37e03e135a362c00ffb1379eddcd` |
| [workflow-artifact.json](routing-head-validation-v2-policy/workflow-artifact.json) | 124,699 | `df9098b0138b8f02fb89110032a8c2b47a3a85ab4cc0db5a99517ab2639f4638` |
| [qualification-policy.json](routing-head-validation-v2-policy/qualification-policy.json) | 1,378 | `0fcb231e5d1871f453db1ae25eae34dd3daa51a91c120a7a208b95b29cc7e10d` |

All five physical file hashes match the campaign protocol. The qualification
policy contents exactly match the embedded policy, and its hash also recomputes
from two-space JSON with a final newline. All 17 named source pins are valid
SHA-256 values, physically match their frozen snapshot or external launcher,
and match the protocol map. The bundle identity recomputes as SHA-256 of
`JSON.stringify(protocol.sourceSha256)`:
`4b96a02e176757591a215a64a6ccd9c65b0665a8e6b3168122a77f82c6abc76e`.
Every attempt's wrapper, head, worker and policy identities match their intended
protocol/source pins. The head remains the same frozen round-1 head.

The protocol declares a fresh fork whose fixture author had no repository,
model, head, TRAIN, VAL1 or prediction exposure. It also declares disclosure of
the old harness's aggregate rejection outcome, 60 machine-authored literal
tasks and independently checked gold, with no human-reviewed production or
final unseen-test claim. This audit preserves those authorship attestations;
hash and schedule checks do not independently reconstruct the author's exposure
history or regrade the protected answers. After this run the fixture is a
consumed validation corpus. ROOT retained the negative without label tuning.

## Full schedule, contexts and classifier inputs

The protocol has 60 distinct cases and 60 distinct context SHA values, covering
12 declared families. Host case labels are exactly 20 easy, 20 hard and 20
unknown. Each pass contains 60 distinct declared groups with independence true.
The ordered actual schedule and ordered attempts exactly match the entire
180-entry protocol schedule; every scheduled entry has completed status.

| Pass | Phase | Scheduled / attempted / completed | Easy | Hard | Unknown | Easy fast | Unsafe fast | Completeness verified | Raw scores available |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | cold | 60 / 60 / 60 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |
| 1 | warm | 60 / 60 / 60 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |
| 2 | warm | 60 / 60 / 60 | 20 | 20 | 20 | 0 | 0 | 0 | 0 |

There are zero errors and zero unrun attempts. Every pass retains all 40
hard/unknown strong-required cases, yielding 120 repeated negative-control
attempts across the campaign. Every easy case also selects strong. Each pass
records all-strong, zero easy-fast coverage and failed ordinary and qualification
gates. Report `incomplete: 0` describes complete execution records; it does not
mean semantic completeness was verified. Each classification explicitly records
`complete: false`.

Independent reconstruction matches all 60 `contextSha256` values using the
frozen `headEvaluationContext` and `workflowConversation` functions. It retains
the exact role/message envelope, timestamp zero and completed assistant
representation where present. There are 58 cases without prior exchanges and
two with prior user/assistant objects. Both completed prior exchanges survive
the reconstructed context and actual classifier input.

Independent reconstruction also matches all 180 per-request
`classification.sourceSha256` values from this exact input insertion order:

```js
{
  prompt: actual.latestUserText,
  ...(previousExchange
    ? { previousExchange: { user: priorActualUser, assistant: completedActualAssistant } }
    : {}),
  toolResults: []
}
```

Host labels, expected answers, family/group metadata and essential-facts flags
are outside the reconstructed message contexts and request objects. Forty
host cases have `essentialFactsAvailable: true`; those annotations are not
passed as production completeness proof. The code-bundle identity and the
per-request source identity hash distinct intended objects, and both match
their own bindings.

The two repetitions provide repeated measurements over 60 scenarios, not 180
independent scenarios. Every pass's format and order sensitivity summaries are
empty objects. The true matched-variant gate therefore does not establish
paired format or option-order invariance.

## What failed and what was never tested

Every attempt records strong route, completeness false, confidence zero,
zero input tokens, zero feature elapsed time and null model provenance. All
raw-head records are unavailable, with null fast/strong scores and reason
`production-completeness-rejected-or-no-encoder-score`. Every eligibility reason
is now explicitly `completeness-unverified`.

| Actual production completeness reason | Attempts |
| --- | ---: |
| `unsupported-or-unverified-routine` | 51 |
| `unverified-request-wrapper` | 45 |
| `unverified-referenced-source` | 21 |
| `routing-instruction-in-input` | 3 |
| `explicit-missing-facts` | 60 |
| **Total** | **180** |

The attributable outcome is production completeness rejection and fallback.
There are no actual head scores or predictions with which to assess head
accuracy, calibration, quality rejection, or generalization. Zero unsafe-fast
decisions in this all-strong run retains safety fallback evidence but supplies
no useful easy-fast coverage. Changing or successfully fitting the head alone
cannot establish the missing verified completeness and useful routing behavior.

The result has `realExecution: true` because actual production context
extraction, completeness, runtime fallback, binding and eligibility ran. The
protocol preserves one serial classification at a time, no cache replay, no
raw-head bypass, no training during evaluation, no network and
`fullPiWorkflow: false`. No neural forward occurred. This is not evidence of
the full Pi dispatcher, downstream task lifecycle or cancellation behavior.

Each pass records 60 scheduled answer checks, zero checked, 60 unavailable and
`allPassed: false`. There is no accepted downstream correctness result or
paired comparison against the strong baseline in this campaign.

## Operational timings and recorded cleanup

Nearest-rank p95 over each pass's 60 attempt router elapsed samples independently
matches the report, and each observed maximum matches the attempt maximum.

| Pass | Named phase | Router p95 (ms) | Router maximum (ms) | Actual model/feature calls |
| ---: | --- | ---: | ---: | ---: |
| 0 | cold | 0.634291 | 4.462458 | 0 |
| 1 | warm | 0.483875 | 0.623625 | 0 |
| 2 | warm | 0.439792 | 0.604875 | 0 |

The recorded start is 2026-09-20T17:43:14.915Z and completion is
2026-09-20T17:43:15.057Z, a 142 ms wall span. These timings cover the executed
CPU fallback path. The intended protocol includes worker startup and actual
inference when present; neither happened. The named cold and warm passes do
not supply cold model startup, warm neural inference, or successful full-router
operational timing. The model was never warmed. There are no available
feature-cache timing samples.

Cleanup records completion with null error. The final runtime state is disposed
and modelReady false, with zero active, queued, submitted and completed worker
requests, and 180 fallback requests. Its head, worker and policy pins match the
campaign. This is consistent recorded cleanup with zero actual worker/model
calls, not a new retrospective process or GPU observation by the auditor.

## Qualification and remaining acceptance work

The laboratory assumption treats matching artifact pins as qualified only
inside the evaluation to ask the production eligibility guard. It explicitly
supplies no quality evidence, completeness proof or production qualification
manifest. The policy remains productionQualified false; every pass is
qualification-ineligible with failed gates; the result and summary both record
productionQualified false and qualificationCandidate false. No promotion is
justified.

The remaining work must establish production context completeness and actual
fresh feature/head execution, useful correct easy-fast coverage alongside all
strong-required controls, family and option-order controls, and the complete
same-prompt Pi lifecycle with safety and cancellation. Operational timing must
include the inference path, and downstream accepted correctness must be checked
against the strong baseline. Any subsequent tuning must preserve VAL2 as
consumed negative evidence and use an appropriate fresh validation population.
The frozen fit and this complete all-strong campaign do not meet those gates.

No attributable archive, source, artifact, context, request, schedule or aggregate
integrity discrepancy was found within this bounded audit. All historical
negative evidence remains preserved without reinterpretation as head-quality
failure or successful goal acceptance.
