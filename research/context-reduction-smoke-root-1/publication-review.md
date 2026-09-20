# Independent bounded publication review

Verdict: **PASS for the declared prompt-reduction smoke measurement and its
publication structure.** No blocker was found in the permitted archive,
accounting, recorded-proof or privacy scope. This does not approve answer
quality or qualify production improvement. ROOT reports actual execution exit
0; this review checks the published completed evidence, not a private process
log or replay.

Only this research folder was read. The only written file is this review.
Archive members were hashed in memory, and limited public producer functions
were inspected without extraction or execution. No `.build` capture, original
SF source, private history/configuration/credential file, model, network, GPU,
Git operation or other campaign lane was accessed or changed.

## Exact attribution and source archive

| Published artifact          |   Bytes | Verified SHA-256                                                   |
| --------------------------- | ------: | ------------------------------------------------------------------ |
| `protocol.json`             |  15,329 | `aa9eb72467e4bb90965eb3afe6b7c5d2b4966b4a1527add004b768681e0b4906` |
| `result-projection.json`    |  45,808 | `eb3d2e88b7aa63426448ac518bd896c25a3fbd131b4b7d063a4a64e9d78ca0ee` |
| `source-manifest.json`      |   8,049 | `10413feaa29662413dd53942d61f6493647581fd81cd351d01f33309cbe453a4` |
| `source-evidence.tar.gz`    | 180,100 | `5ff5013b9e99e14ef7a3c866f02cd52657503030f2a19fc569168d4b0300394b` |
| `publication-manifest.json` |     358 | `ad80804b140f8d11a2c46c87e4b5932558c58d5587df164884e1108822e90183` |
| `measurement.json`          |     353 | `e313bea1a4425f34da015c78bea2a68123fb6864f7bf8b5345766d37a50882e9` |
| `run-claim.json`            |     134 | `cd2637035e0d77af812672def77956ea78fb044ceea4ec784bddecaf9ac8cad3` |
| `local-validation.json`     |     500 | `45450bc07106e9e4f9b1ed1fc820d80d4c2cadc68268c8ff3a06a1159e26716e` |

Publication-manifest protocol/result/archive hashes and compressed archive size
match exact current bytes. Result, source manifest and run claim bind to the
same protocol SHA. All 25 archive entries are unique regular files at relative
`source/` paths: no absolute/traversal paths, links, special files, unexpected
members or missing members. Each entry's byte count and exact SHA match its
source-manifest record. The exact original-path/SHA set matches all 25 protocol
source pins. Originals outside this folder were not reopened.

Protocol, source manifest and local-validation receipt consistently declare
source commit `2860d17b005f3c0d6cca9a25a9e0b0d118113665`; Git was not inspected.
The protocol has 24 SF pins comprising package metadata and 23 factory
entrypoints. Every saved workflow records 23 controlled factories. No original
SF source is archived; source-manifest flags for SF source and raw provider
bodies are false. The supplied controlled factory setup does not establish
equivalence to normal installed SF defaults.

## Full physical population and recorded proofs

Three declared cases and two repetitions produce six raw and six compressed
workflows. All 12 unique saved IDs/case/arm bindings match the protocol schedule
exactly. Each case/arm has two saved repetitions, and the published schedule
matches the protocol plus the completed statuses. All 12 workflows are
completed: zero errors, zero unrun, full coverage and execution verified.

There are 26 physical task requests: 12 raw and 14 compressed. Ten workflows
have two requests and two have three, retaining the additional recovery work.
All records have distinct physical indices, are bound to scheduled workflow
IDs, and record physical/completed true, HTTP 200, completed body cleanup and
completed status. No HTTP 429 is present. There are 20 distinct request digests;
identical request bytes across attempts/repetitions are not deduplicated from
the 26 physical records. There are zero compressor/summary requests.

All 12 recorded canonical proofs match the corresponding protocol case's
original tool-text SHA and byte count, with originalExact true and isError
false. All wire-proof request hashes bind to physical requests of the same
workflow, and their original hashes match the declared case source. Raw
workflows retain a literal wire result matching the canonical ID hash,
source-text hash and size. Each compressed workflow has at least one paired
wire result with projected true, different text SHA and smaller byte count.
There are 16 wire rows, including eight projected rows and recovery evidence.

The source-pinned producer explicitly compares canonical builtin-read content
with the original source and pairs it to wire evidence by tool-call/source
hash. This review checks those public proof fields and producer logic. It does
not independently replay captured bodies or assert literal reconstruction of
the lossy excerpt representation, preservation of every relevant fact, or
correctness of the final answer. Final assistant content is published only as
a SHA, never as answer text.

Every workflow records affirmative cleanup and completed abort, shutdown and
disposal. Top-level runtime cleanup is completed and setupError is false.
These are checks of the published cleanup ledger, not live-process or
credential-state inspection.

## Recomputed measurements and limits

All 26 requests have nonnegative integer prompt/completion/total counts with
total equal to prompt plus completion. Core usage is complete with zero
unknown-usage requests. Per-arm sums and known-usage lower bounds match the
published summary.

| All physical workflow observation |           Raw |    Compressed |
| --------------------------------- | ------------: | ------------: |
| Physical task requests            |            12 |            14 |
| Prompt tokens                     |       140,766 |        53,955 |
| Completion tokens                 |         1,348 |         4,091 |
| Total tokens                      |       142,114 |        58,046 |
| Summed workflow elapsed, ms       | 60,761.197751 | 85,339.984875 |
| Known / unknown cache records     |         9 / 3 |        11 / 3 |

Recomputation gives:

- Prompt reduction: `1 - 53955 / 140766 = 0.6167043178040152`, or
  **61.6704317804%**, including all physical requests and recovery work.
- Total-token reduction: `1 - 58046 / 142114 = 0.591553260058826`, or
  **59.1553260059%**.
- Output-token ratio: `4091 / 1348 = 3.03486646884273`; output increased.
- Summed workflow elapsed ratio:
  `85339.984875 / 60761.197751 = 1.4045145262725751`; elapsed increased.

Every recomputed value matches `measurement.json`. The protocol's declared
strategy is `excerpts`, and actual summary-model calls are zero. The result's
`measuredAtLeast50Percent:true` follows from this smoke measurement; it is not
answer-quality acceptance. Latency is explicitly not this smoke's acceptance
gate, and the observed elapsed increase is retained rather than presented as
speed improvement.

Cache accounting is incomplete in both arms. Six requests have unknown cache
counts in total; complete cached/uncached aggregate totals remain null.
Known-cache lower bounds do not establish a complete cache-hit ratio or paid
token total. No zero-cost, cache-adjusted billing or dollar-saving claim follows.

## Closed publication structure

All seven JSON files pass duplicate-key and nonfinite-constant parsing checks.
The actual result passes an independent exact recursive grammar derived from
the archived public producer: zero extra or missing fields in its declared
result/run/request/schedule/proof/cleanup/summary layouts. Values are bounded
workflow/case/arm/status enums, nonnegative finite counts/timings, booleans,
SHA-only strings, and explicitly permitted null usage/error slots. Boolean
values are not accepted as numeric counts.

The producer reconstructs publication workflow, physical request and proof
records from explicit field lists, sanitizes IDs/hashes/statuses/counts, and
uses a fixed failure code. The upstream schedule constructor has a fixed
scalar field set, which matches the actual published schedule. No captured
system or request body, message array, answer text, actual tool arguments,
response prose, raw error or private SF context is present in the projection.
Public SDK source code is source evidence, not a private runtime capture.

This review is bounded to publication structure and recorded evidence. Private
capture comparison, exact credential-byte matching, original SF-source checks,
independent upstream model attestation and model execution were not performed.
The local-validation receipt is preserved as recorded; its tests were not
rerun here. It also explicitly records answerQualityTested false.

`answerQualityTested:false`, `productionImprovementQualified:false`,
`qualityDeferred:true`, `latencyNotAcceptanceGate:true` and
`billingNotMeasured:true` remain intact. This closes the first smoke publication
review without adding a quality gate or making a claim about another lane.
