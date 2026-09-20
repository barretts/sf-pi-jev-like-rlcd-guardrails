# Controlled 23-SF context workflow: independent preflight audit

The frozen protocol and source snapshot pass this bounded preflight attribution
and schedule audit. The protocol declares 24 cases, four repetitions and two
arms: 96 matched pairs and 192 workflow cells, followed by 24 optional judges.
Each case is baseline-first twice and compact-first twice. The source implements
shared request pacing, visible rate-limit failures, host-only gold grading and
affirmative cleanup requirements.

This is a preflight source/protocol finding. It makes no claim that the running
campaign has completed, passed, preserved semantics, reduced usable prompts,
improved latency, qualified the full goal or saved money. No current result,
provider context, session prompt or system body was inspected.

## Scope and exact attribution

The audit read only `protocol.json`, `source-manifest.json` and the authorized
frozen `source-snapshot`. It used CPU file hashing, JSON metadata checks and
static source inspection. It did not read live results, raw provider contexts,
session prompts, system bodies, fixture tool bodies or gold answers; contact the
network; invoke models/GPU; read credentials; inspect or control campaign
processes; or run Git commands. Its only output is this `.build` audit. No
tracked, source or research file was edited.

| Frozen file | Bytes | SHA-256 |
| --- | ---: | --- |
| `protocol.json` | 69,612 | `9c53002a2db917a7e690e43f18e8a9f4867db007fd5b07eb228546b0678c3d18` |
| `source-manifest.json` | 5,203 | `c17b6f3a3f8979e496199651d60788d9e27730f4c3adb26be49dfd1c0b689b93` |

The source manifest binds the exact protocol SHA and records Git HEAD
`160cc9da3e78350a4f7e909918ebf777f6da9a31`. That is the frozen recorded identity;
this audit did not independently query current Git or remote state.

All 16 source snapshot byte counts and SHA values independently match the
manifest and the protocol's original-path source pins. Source archive paths are
safe and relative, and source identities and archive paths are unique. These
entries include the workflow harness, compression/extension/gateway source and
built modules, package metadata/lock and the pinned Pi SDK execution path.

The protocol contains 23 unique SF source paths with valid SHA-256 pins. The
manifest explicitly states that SF source and captured system context are not
copied into the publication archive. Within the authorized scope, the audit
verified their declared cardinality, uniqueness and digest form and inspected
the frozen enforcement code. It did not independently hash the original SF
files. `verifyFreeze` hashes all 16 ordinary and all 23 SF original sources
before execution, along with the fixture and runtime identity; `runSession`
checks that every declared SF path appears in the loaded extension paths.
These source checks support a controlled supplied 23-factory configuration.
They do not establish equivalence to the installed normal default configuration.

The frozen registration SHA is
`5c51b133f8ef98d9021980ec78753eb8a25af8199f0946eef1d5ecc919f9ca43`
and independently recomputes from compact JSON serialization of the protocol
registration. The fixture is pinned by
`910f57ee3be2b3c2ee4ceb4c8149355d632ff9d65544a860f0b00190db1edd5b`.
This audit did not open that fixture. Source freeze code checks its bytes, each
case's original tool-text SHA, host expected-object SHA and task-prompt SHA and
reconstructs the exact schedule before running. Recorded host runtime is Node
v26.5.1, darwin, arm64; the source verifies the same runtime identity.

## Population and counterbalance

| Declared dimension | Verified count |
| --- | ---: |
| Unique cases | 24 |
| Families | 14 |
| Repetitions per case | 4, numbered 1 through 4 |
| Unique matched pair IDs | 96 |
| Unique workflow cell IDs | 192 |
| Baseline workflow cells | 96 |
| Compact workflow cells | 96 |
| Baseline-first pairs | 48 |
| Compact-first pairs | 48 |
| Baseline-first / compact-first per case | 2 / 2 |
| Planned optional judges | 24, one per case |
| Maximum parallel pair workers | 4 |

Every schedule pair references a declared case and its matching family and has
one baseline and one compact arm. Every case has repetitions exactly 1–4, with
both arm orders balanced locally as well as globally. The frozen schedule code
alternates order by case index plus zero-based repetition, while recording
one-based repetition numbers. Each worker executes a pair's arms sequentially;
up to four pairs can run concurrently. Completed output is sorted back into
frozen workflow-cell order.

The 14 declared families include regression, unknown outcome, multiplicity,
quoted untrusted data, artifact attribution, timestamps, unique-line controls,
repeated chunks, missing evidence and diff arithmetic. These are machine-authored
controlled validation cases. Four repetitions give repeated observations of 24
scenarios, not 96 or 192 independent scenarios.

Protocol preflight compression metadata records an applied transform for 19
cases and identity for five, with exact reconstruction recorded for all 24.
This audit checked that metadata and did not decompress protected fixture bodies.
Those five identity controls remain part of the full denominator. Actual live
hook application, usable complete-prompt reduction and downstream behavior must
be established from completed campaign evidence.

## Pacing and retained failure behavior

Frozen parameters are concurrency four, maximum 4096 output tokens, maximum four
turns, 180,000 ms workflow timeout, 8 MiB response limit and optional judges
enabled. The pacing configuration declares a 5000 ms minimum request interval,
60,000 ms rate-limit fallback cooldown, 120,000 ms maximum cooldown and a circuit
after three consecutive observed HTTP 429 responses.

The source constructs one shared paced transport and passes it to both workflow
provider adapters and the judges. The pacer's serialized reservation queue
advances the next dispatch time by the minimum interval, so concurrent pair
workers do not each receive an independent pacing budget. The actual transport
reserves before dispatch and records dispatch index, time and queued rate wait.
It checks the approved gateway route/method, rejects URL credentials, query and
fragment, and prevents redirects. Unapproved startup/extension/telemetry fetches
are blocked by the surrounding fetch replacement.

HTTP 429 responses extend the shared next-dispatch time using bounded cooldown
handling. Consecutive 429 observations can open the circuit; waiting callers are
notified and reserve again or reject. The source does not silently retry physical
requests. SDK retries are explicitly disabled. Physical and not-dispatched rows,
HTTP status, pacing error codes and rate-limit outcomes remain observable. Pair
workers stop taking cells after the circuit opens, leaving the frozen denominator
to expose unrun cells. Judges also use this shared transport and retain their own
error/unrun denominator.

This is code/configuration assurance, not a measurement of actual dispatch
spacing. The eventual audit must check recorded physical start intervals and
every HTTP 429, cooldown, circuit and unrun event. Workflow elapsed includes
shared pacing and contention waits. Such paced timing does not establish
intrinsic provider speed.

## Gold exclusion and actual SDK path

Static source dataflow keeps expected objects outside provider construction.
`taskPrompt` references the case question, with no expected-object reference.
The read-tool fixture file is written from original tool text, and the tool
returns that source text rather than a host expected object. The only
`record.expected` reference inside `runSession` is post-response host grading
at frozen line 1667, after the model prompt at lines 1611–1613. It compares the
strictly parsed final answer with the expected object. Neither task construction
nor read-tool construction uses that expected object.

The judge function references case ID, question and original tool text, plus the
encoded candidate context, and contains no expected-object reference. Judges
test contextual preservation rather than receive the deterministic host answer.
The protocol's host-only gold policy matches this source path. Because no actual
provider/system/session body was inspected, these findings are source preflight
assurance rather than an independent wire-content audit.

The harness uses the official Pi SDK session and actual
`registerContextCompression` hook, with compression disabled for baseline and
enabled for compact. Selected-model tool choices remain autonomous. Controlled
resource loading disables unrelated skills, themes, prompt templates and context
files while supplying the declared SF extension paths. Source runtime checks
cover model identity, loaded extension paths, real provider requests and live
compression evidence. These checks require future observed evidence before
acceptance; the protocol alone cannot demonstrate that they passed.

## Cleanup code and acceptance boundaries

`cleanupOwnedSession` attempts bounded session abort and public
`session_shutdown` emission while extension contexts remain active, measures
shutdown extension errors, and calls session disposal in a `finally` block.
Affirmative session cleanup requires successful abort, shutdown and disposal;
shutdown extension errors make it nonaffirmative. Cleanup failure clears passed
and accepted-answer state and leaves accepted-answer time null.

The outer workflow removes the runtime API key with bounded cleanup and requires
affirmative runtime credential and session cleanup for
`functionalAndJudgeAcceptance`. That acceptance also requires the full workflow
summary, qualified judge denominator and zero pair-worker failures. A final
cleanup path attempts key removal if not already started, drops the in-memory
credential reference and restores the original fetch.

This audit verified those static requirements. It has not observed successful
cleanup, process termination, a completed judge population or any final
acceptance result. Eventual publication must retain each cleanup component and
failure and distinguish recorded cleanup from independent historical process
observation.

## Publication-safe projection checklist for eventual results

Use an explicit field allowlist to produce a separate publication artifact while
preserving original private evidence unchanged. Do not publish a recursively
redacted copy of full live session/provider evidence.

1. **Bind the completed evidence.** Include exact protocol/result/source-manifest
   and relevant archive hashes, the recorded commit, registration SHA, relative
   source names and pins, runtime version and controlled 23-factory scope.
   State that SF source bytes are not archived and that installed-default
   equivalence is unclaimed. Remove absolute personal paths and gateway URLs.
2. **Retain every scheduled cell.** Publish case ID, family, repetition, pair ID,
   arm/order, execution status, bounded error code and explicit scheduled,
   attempted, completed, failed and unrun counts. Keep all 24 scenarios, all 192
   workflow cells, five identity controls and 24 planned judges visible. Do not
   turn repetitions into independent-case counts or omit failed pairs.
3. **Project acceptance as typed metadata.** Retain correctness, accepted/passed,
   live-compression verification and cleanup booleans/status codes, worker
   failures and final gate decisions. Preserve false, null, unavailable and
   unknown distinctions. Publish answer hashes rather than final answer text or
   parsed answer objects. Judge booleans and pass/error counts may be included;
   exclude free-text judge issues and explanations.
4. **Account for full elapsed work.** Retain complete workflow elapsed,
   accepted-answer time only when accepted, provider-attempt durations, physical
   dispatch index/time and queued rate wait. Report paired distributions and
   case/arm denominators with the full failure population. Include concurrency,
   5000 ms pacing, cooldown and contention in interpretation. Do not present
   wait-inclusive timing as provider speed.
5. **Retain token/cache uncertainty.** Keep provider prompt/output token counts,
   cache and uncached counters, request/turn/tool-call counts and usage-complete
   flags where available. HTTP 429 and missing usage remain unknown rather than
   zero. Measure the complete usable provider prompt including trusted decoder
   and transient-manifest overhead. Protocol text compression ratios alone are
   not observed prompt-token savings. Zero configured SDK prices supply no
   billed-cost or savings evidence.
6. **Retain rate limits and cleanup.** Keep physical-attempt/not-dispatched counts,
   HTTP status, bounded pacing/circuit codes, parsed cooldown duration and retry
   classification, with no raw headers. Retain abort, shutdown, extension-error,
   disposal and runtime-key cleanup outcomes separately. Failed, partial or
   unknown cleanup cannot be projected as clean or qualified.
7. **Exclude content and secrets by construction.** Omit raw provider contexts,
   request/response bodies, captured system/decoder bodies, task/session/judge prompts,
   tool bodies, persistent-session data, gold objects, credentials, authorization
   headers, raw errors and arbitrary nested controller/session objects. Hashes,
   byte counts and specifically allowed typed controller metrics can bind those
   lanes without publishing their contents. Scan the final allowlisted artifact
   for credential patterns and unexpected content before publication.
8. **Carry the evidence limits.** State synthetic machine authorship, uncontrolled
   remote cache, variable SDK system/nonce context, no retained raw response
   replay and the supplied 23-factory configuration. Functional/judge gates,
   measured complete-prompt reduction, latency and cache observations are
   separate evidence lanes. Publish future completion/performance claims only
   when the completed frozen result directly supports them.

No attributable preflight source-binding, schedule, counterbalance, pacing-code,
gold-dataflow or cleanup-code discrepancy was found within the authorized scope.
The declared SF pin bytes, protected contexts and running campaign outcomes
remain outside this independent inspection. Git state was not queried or changed
by this auditor, and the campaign's tracked/source/research freeze was respected.
