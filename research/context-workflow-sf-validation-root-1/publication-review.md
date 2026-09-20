# Independent bounded publication review

Verdict: **no publication blocker found in the permitted archive, projection,
aggregate and privacy-structure scope.** This is a review of the newly preserved
negative checkpoint. It does not qualify compression, production improvement,
model quality or speed.

Read scope was only this research folder: the closed result projection, its
schema, protocol and manifests, the source archive, generated diagnostics and
published audits/design. The only written file is this review. No `.build`
capture, raw result, original SF source, private provider/session history,
configuration, credential file, model, network, GPU or Git operation was read,
executed or changed. Archive members were hashed in memory without extraction
or execution. Checks used only CPU standard-library JSON/hash/tar processing.

## Frozen attribution and archive

| Published file | Bytes | Verified SHA-256 |
| --- | ---: | --- |
| `protocol.json` | 69,612 | `9c53002a2db917a7e690e43f18e8a9f4867db007fd5b07eb228546b0678c3d18` |
| `source-manifest.json` | 5,203 | `c17b6f3a3f8979e496199651d60788d9e27730f4c3adb26be49dfd1c0b689b93` |
| `projection-schema.json` | 9,477 | `21ced76636326b94d3e8946b45eee9ab44d543254d32699306154e22fbdfb283` |
| `result-projection.json` | 1,043,743 | `04531bce4f5f66cd8f28c45671abd69a8ddc4c100d08362bd2e37fed7c7df485` |
| `publication-manifest.json` | 230 | `864d86f8c0e5b6fde8875d741003eeaf4e9a968537fa0f4691654d57ffef5115` |
| `source-evidence.tar.gz` | 144,403 | `d608fc3faaae2a94b0e661a93630ed490e2c8293438db975c8f0d0c3d6d8e391` |

The archive SHA and compressed byte count match `publication-manifest.json`.
All 16 entries are unique regular files at relative `source/` paths, with no
absolute/traversal paths, links, special entries, unexpected members or missing
members. Every member's uncompressed size and exact-byte SHA match the source
manifest. The exact set of 16 original source paths and hashes also matches
`protocol.sources`. Protocol source pins do not contain byte sizes; sizes are
independently checked against the manifest and archive. No original outside
this publication folder was reopened for comparison.

Source manifest and result projection both bind to the exact protocol SHA
above. The manifest records Git head
`160cc9da3e78350a4f7e909918ebf777f6da9a31`; this review did not inspect Git.
The protocol contains 23 unique SF source-path/SHA pins. No SF source is an
archive member: the archive exactly contains the 16 permitted TS/JS/package
and public SDK source entries. Publication flags `sfSourcesArchived` and
`rawProviderBodiesArchived` are both false, consistent with that membership.

## Full saved population and negative outcome

The protocol has 24 distinct cases, four repetitions, 96 scheduled pairs and
192 scheduled session IDs. The result's 192 unique run IDs and case/family/arm
bindings match that schedule exactly. Every case/arm has four saved runs.
There are 96 saved runs per arm and zero unrun sessions. Arm order is
counterbalanced: 48 baseline/compact and 48 compact/baseline pairs.

| Recomputed observation | Baseline | Compact |
| --- | ---: | ---: |
| Scheduled / saved | 96 / 96 | 96 / 96 |
| Completed sessions | 96 | 95 |
| Error sessions / error count | 0 / 0 | 1 / 1 |
| Accepted answers / passed sessions | 88 / 88 | 89 / 89 |
| Correct final-answer observations | 88 | 89 |
| Correct answers in failed workflows | 0 | 0 |
| Usage-complete sessions | 96 | 96 |
| Observed / fully measured task requests | 192 / 192 | 193 / 193 |
| Extension failures | 0 | 0 |
| Affirmative shutdown and disposal | 96 | 96 |

All counts above recompute from saved rows and agree with the summary. The
sole error is retained as `v2-18-repeated-chunk-row-count__r3__compact`, with
false acceptance and its usage/cleanup retained. It omits the optional
`liveCompression` object; this does not remove it from any scheduled population.
The published strict grades were not changed or independently regraded here.

All 96 pairs are observed; 95 are complete and 87 have both arms accepted.
The paired acceptance cells are 87 both accepted, six neither accepted, one
baseline-only accepted and two compact-only accepted. Thus a higher compact
accepted count does not establish absence of paired task regression. The
recorded `fullCoverage` flag remains false with the errored session.

The 24 distinct judge IDs exactly match the 24 protocol case IDs. All 24 judges
are completed and passed, with all five preserved-evidence decision booleans
true, zero errors, zero unrun and zero issues. Judge qualification is true for
that assessment lane only. It does not override failed task acceptance or
qualify the compression intervention.

## Usage, physical requests, pacing and cleanup

| Recomputed task usage | Baseline | Compact |
| --- | ---: | ---: |
| Prompt tokens | 554,728 | 553,075 |
| Completion tokens | 11,232 | 30,184 |
| Total tokens | 565,960 | 583,259 |
| Cached prompt tokens | 46,080 | 60,672 |
| Uncached prompt tokens | 508,648 | 492,403 |

The per-run usage and completed-usage lower bounds sum exactly to these
published aggregates. All 385 task-request usage records contain nonnegative
integer prompt/completion/total/cache/uncached counts with consistent sums.
The separate 24 judge records contain consistent nonnegative integer
prompt/completion/total/cache counts; their uncached field is not recorded.
Judge totals are 71,779 prompt, 133,035 completion, 204,814 total and 11,392
cached prompt tokens. These are consumption observations, not benefit or
billing qualification.

The 192 baseline plus 193 compact task requests and 24 judges bind by exact
request-SHA multiset to all 409 distinct physical ledger records. All are
physical, dispatched, HTTP 200 and `response_received`, with zero HTTP 429,
zero undispatched records and null physical error/rate-limit fields. Transport
completion does not make an errored or incorrectly answered workflow accepted.
Task finish reasons remain 193 `tool_calls`, 191 `stop` and one `length`.
Recorded response model IDs match the selected protocol registration; no
independent upstream lineage assertion follows from that agreement.

Saved dispatches obey the frozen 5,000 ms minimum interval; the smallest sorted
gap is approximately 5,000.001583 ms. The circuit remains closed. These are
paced campaign observations, not provider inference-speed measurements.

Every one of the 192 saved sessions has shutdown attempted, shutdown completed,
disposal completed and affirmative cleanup, with zero shutdown-extension
errors. Every run records 23 controlled SF factories. Top-level session and
runtime-credential cleanup are recorded affirmative/completed. This checks the
published cleanup ledger, not an independent live-process or credential-state
inspection.

Provider-position, request-overhead and interim consumption diagnostic counts
and usage reconcile with the saved result. They retain `qualifiedBenefit:false`.
The interim diagnostic's `judgesUnreported:true` describes its earlier recording;
the final projection separately preserves all 24 completed judge assessments.

## Recursive projection and publication privacy structure

All 11 JSON files parse without duplicate keys or nonfinite JSON constants.
The result conforms recursively to the closed schema: zero unexpected fields
at any depth, only the declared object/array layouts, exact boolean/string
types and finite numeric leaves. The sample-derived `int` and `float` labels
are treated as numeric slots accepting finite integers/floats and null; bool
is not accepted as a number. Current nulls occur only in numeric or explicitly
null schema slots. Missing optional whitelist fields do not authorize extras.

The result has no captured system prompt/body, message array, provider request
or response body, headers, actual tool arguments, assistant answer, free-form
error text or judge issue prose. Physical error/rate-limit slots remain null;
failures are represented by status, counts and booleans. Published string
families consist of fixed interpretation text, IDs/families/order/status,
timestamps, model IDs, bounded tool-call IDs, nonces and hashes. Captured
system/request/answer/tool text is not introduced through an unexpected nested
field. Public synthetic gold-audit quotations are authored fixture material,
not private provider or SF context capture.

This is a structural publication audit. Raw-body replay, a byte comparison with
private captures/raw results, original SF-source verification and exact
credential-byte matching were explicitly not performed. The recorded
`rawResultSha256` is an opaque retained identity here, not independently checked
against the private result. ROOT owns the separate credential-byte check.

## Interpretation retained

`liveCompressionQualified`, `passed`, `productionImprovementQualified` and
`functionalAndJudgeAcceptance` remain false. All primary benefit fractions and
paired/aggregate improvement metrics remain null; every capacity/latency gate
is false. Eligibility usage remains incomplete with null qualified prompt
totals. Complete observed usage is not silently converted into qualified
benefit after a failed workflow.

The timestamp, row-count and diff-control audits remain consumed-case
diagnostics. The diff ambiguity and malformed hunk are preserved without
regrading or assigning them as the cause of an actual mismatch. The successor
design is explicitly unimplemented and unevaluated. The published concurrent
CPU observer and paced controlled-SF scope limit wall-clock interpretation.
Nothing in this checkpoint establishes a token-capacity, speed, cost,
production-equivalence or model-quality improvement.
