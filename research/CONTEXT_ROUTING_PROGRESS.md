# Context and routing implementation progress

The new context codec, actual Pi context hooks, current-request routing dispatcher,
operational frozen-Gemma feature driver, classifier adapter and session-only
Manager controls are implemented. Real TRAIN extraction, public Pi/Grok smokes,
a rate-limited public validation and a completed 192-session SF comparison are
recorded below. The SF campaign resolved the harness lifecycle and rate-capacity
failures, but its repetition codec reduced prompt tokens only 0.298% and did not
qualify. The new bounded excerpt/retrieval benchmark measured 61.67% fewer
whole-workflow prompt tokens, meeting the current 50% reduction target on its
long synthetic outputs. The optional caveman comparison measured only 14.88%
reduction and failed that target; answer effectiveness remains deferred. Native routing
validation exercised only the strong fallback; the
subsequent direct head diagnostic failed safety and latency. Production quality,
speed and billing gains remain unproved. No rejected RFDT model has been promoted.

## Keep harness and model evidence separate

The task-model control is the user's existing `llmgw/grok-4.6` registration at
their configured gateway. The paired workflow uses the same task model in both
arms. That holds the task model fixed while testing context delivery, accounting,
dispatch and orchestration. A Grok context judge supplements independently
checked literal expected answers; it cannot override a failed answer check.

The new router uses Google's pinned, unchanged Gemma 3 1B decoder to extract
1,152-dimensional features and fits a small binary logistic head in TypeScript.
This is separate from full RFDT adapter training. Only Google Gemma, the user's
xAI Grok selection, and the user-attested OpenAI mapping are allowed model
lineages. Qwen and Chinese-lineage models are excluded.

## New routing-head TRAIN result

The first feature/head campaign completed all 240 TRAIN rows: 120 fast and 120
strong, with zero errors and zero unrun rows. Extraction used 240 real feature
calls; cached CPU fitting used zero additional feature calls. The fit took
146.821708 ms and reached its declared full-gradient stationarity tolerance.

An independent audit performed 1,249 checks, including all examples and both
classes, file/source bindings and independent recomputation of the standardized
objective and every gradient component. It found no integrity, coverage or
arithmetic issue. The maximum gradient difference was 2.1142e-18.

The approximately 32.02 ms warm p95 is TRAIN extraction timing. It excludes ready
startup, persistence, fitting, completeness guards, routing dispatch and task
generation. It is not a full router or developer-workflow speed claim.

The complete TRAIN plan, features, head and journal are preserved in
[routing-head-round-1](routing-head-round-1/evidence-manifest.json). The exact raw
head SHA-256 is
`6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e`.
The [independent audit](routing-head-round-1-audit.md) records arithmetic and
timing limits. The [prospective qualification policy](routing-head-round-1/qualification-policy.json)
was frozen before fresh inference and explicitly does not approve the artifact.

TRAIN and the first 60-case validation set have zero exact
prompt/previous-exchange overlap. Both are machine-authored, and the same author
produced both sets; conceptual family overlap remains possible. That validation
is not a human-reviewed production test.

## Native routing validation has no useful coverage

The [first native validation](routing-head-validation-round-1/result.json) and
[source-blind second validation](routing-head-validation-v2/result.json) each
completed all 180 scheduled attempts: 60 cases over one cold and two warm passes,
with zero errors and zero unrun attempts. Every request selected strong. In each
campaign the actual-source completeness verifier accepted zero requests, raw
head scores were available for zero requests and there were zero encoder feature
calls. Both campaigns failed useful easy coverage and the requirement to avoid
an all-strong router. Neither qualified the artifact.

This is evidence that the production completeness checker has no useful
coverage on these workloads. The reported router p95 measures the CPU fallback
path; it does not measure Gemma inference or establish head accuracy. Zero
unsafe fast decisions while selecting strong for every request provides no
evidence that the head can safely select fast. The
[second campaign archive](routing-head-validation-v2/archive-manifest.json)
preserves its executed sources and full scheduled population.

The first validation was consumed for development before the checker gained
strict support for harmless output-format contracts and declared request
wrappers. The second campaign remained source-blind during authoring, but still
produced no head scores. The subsequent raw-head LAB diagnostic explicitly
forced encoder evaluation to inspect the head separately. It did not bypass
production completeness requirements or qualify production routing.

## Direct routing-head result fails safety and latency

The [forced-encoder laboratory campaign](routing-head-raw-validation-v2/archive-manifest.json)
completed all 180 real feature calls on the unchanged head: one initial 60-case
pass and two complete warm passes, with zero errors or unrun rows. Each pass
selected fast for 19/20 easy cases, 17/20 hard cases and 18/20 unknown cases.
That is 35/40 fast decisions contrary to the declared strong-required policy.
No downstream answer generation occurred, so this is routing safety evidence,
not a claim that 35 task answers were incorrect.

The first startup-inclusive request took 4,566.38 ms. Across the 120 warm calls,
operational p95 was 260.82 ms, exceeding the 100 ms target. The approximately
32 ms TRAIN feature p95 did not predict this fresh workload's routing time.
All three passes had the same decisions. Actual runtime cleanup completed with
disposed state, zero active or queued requests, 180 submitted/completed model
requests and zero completeness fallbacks.

The [score-overlap diagnostic](routing-head-raw-validation-v2/threshold-overlap-diagnostic.json)
finds that even an optimistic common cutoff excluding every strong-required
case would retain only 2/20 easy cases. This ignores additional uncertainty
and confidence requirements and is not a selected threshold. No artifact,
threshold or production setting was changed. Better feature representation
and training coverage need a new prospective experiment; threshold tuning on
this consumed corpus cannot qualify the current head.

## Previous full RFDT training

R7 completed 512 steps, adapter reload, export and all 194 scheduled native
validation checks. Its training loss fell, but the formal answer-quality gates
failed. In particular, fresh developer truth accuracy was 8/20 and developer
choice accuracy was 22/26. Execution success and decreasing TRAIN loss do not
justify model promotion. R7 remains rejected and unapproved; the new feature-head
fit does not change that decision.

## Gateway compatibility diagnosis

The first new SF/Pi smoke scheduled four sessions with all 23 controlled SF
factories. All four requests failed with HTTP 400 before any tool execution.
Usage remains unknown. The separate context judge completed successfully. The
[full-population safe projection](context-workflow-smoke-root-1/result-projection.json)
preserves the failure, source identities and unknown accounting; captured prompt
bodies remain local.

Automatic approval review initially rejected reposting that captured request
for diagnosis because it contained project/system context. The rejected command
did not run. A subsequent fresh diagnostic used only a literal synthetic prompt
and synthetic tool schema, with no captured Pi/SF request or project context.
The user later explicitly approved the bounded Pi request containing all 23 SF
factories, their system/schema context and generated traces. That approval covers
the later SF smoke described below; SF transmission is no longer pending.

The [public synthetic probe](grok-public-compatibility-probe-root-1/results.json)
observed streaming HTTP 200 both without tools and with tools. Adding only
`store:false` caused HTTP 400. A separate `strict:false` request returned HTTP 200
but reached the 128-token completion limit. It establishes transport acceptance
of that field, not a complete task response.

The evaluator now uses in-memory `supportsStore:false` and
`supportsStrictMode:false` compatibility overrides. The second omission is a
conservative experiment setting, not a claim that strict mode is unsupported.
The user's saved model configuration is unchanged. CPU tests through the actual
installed SDK confirm that the two optional fields disappear while tools,
streamed-usage requests and output limits remain intact.

## Public Pi/Grok smoke history

The next live smoke used the actual Pi SDK, public SDK instructions and an
invented literal trace. It loaded no SF factories or context files. It scheduled
four sessions in counterbalanced order, two per arm. All four completed, all four
literal answers passed, and the one Grok context judge passed. Eligible compressed
tool text and the authenticated manifest reached the provider; canonical saved
tool results retained their exact originals.

The [complete result](context-workflow-public-smoke-root-2/result.json) and
[source archive](context-workflow-public-smoke-root-2/archive-manifest.json)
retain the exact 16 executed source files and all scheduled sessions. Prompt
tokens fell from 5,262 to 5,146, approximately 2.20%. Completion tokens increased
from 231 to 342. Aggregate workflow elapsed increased from approximately 5.57 to
12.96 seconds. One compact session requested an additional file read. This is
functional evidence on one small integration case, with a negative latency
result; it does not establish general quality, speed or billing savings.

The later [public smoke](context-workflow-public-smoke-root-3/result.json), using
shorter boundary instructions, also completed four sessions over two pairs. All
four literal answers passed and its one context judge passed. Baseline prompt
tokens were 5,262 versus 3,646 with compaction, a 30.71% reduction. Total tokens
fell from 5,502 to 4,129, while completion tokens rose from 240 to 483. Aggregate
workflow elapsed fell from 13.6855 to 12.0309 seconds. The result passed its
small smoke gates and verified the live compressed representation at the
provider, but explicitly did not qualify production improvement. Two pairs do
not establish general answer quality, speed or billing savings.

## Larger public validation was rate-limited

The [full public validation](context-workflow-public-validation-root-1/result.json)
scheduled and attempted 192 sessions across the 24-case protected context
workload. Only 23 workflows completed, all with correct literal answers; 169
failed with HTTP 429 responses. Six of 24 scheduled context judges completed and
passed, with 18 judge errors. Full-population usage and comparison ratios remain
null, and functional, live-compression and production qualification are false.
The successful subset cannot replace the scheduled denominator or support a
token, latency or billing improvement claim. This campaign was limited by
gateway rate capacity; it is neither a demonstrated feature failure nor evidence
that the user's monetary budget was exhausted.

The shared request pacer now spaces physical requests by at least five seconds,
uses a 60-second rate-limit cooldown capped at 120 seconds, and opens its circuit
after three consecutive HTTP 429 responses. It does not retry failed requests.
This is a capacity control, not evidence that a full validation will complete.

## Approved SF smoke and lifecycle correction history

The [second SF smoke safe projection](context-workflow-sf-smoke-root-2/result-projection.json)
records four scheduled sessions with all 23 controlled SF factories under the
user's bounded approval. All four returned the correct literal answer, but two
workflows had an unknown-SF-extension error. Only two workflows completed
successfully. Its nine recorded physical requests returned HTTP 200, with no
HTTP 429 responses; the compressed representation passed its provider-wire
check. The single context judge passed. These transport and answer observations
do not qualify functional or performance acceptance: both paired comparisons
contain an errored workflow, and production qualification remains false.

The historical report's `acceptedAnswers` counts include answers from errored
workflows. That accounting bug was fixed; the safe projection explicitly
preserves the discrepancy and the as-executed result. Its apparent 4/4 answer
acceptance must not be reported as 4/4 successful workflows or a qualified SF
integration.

The [next approved SF smoke](context-workflow-sf-smoke-root-3/result-projection.json)
again returned four correct answers without HTTP 429, but correctly counted
only 2/4 accepted workflows and kept full comparisons null. Safe callback
coordinates identified both failures as `sf-slack` `session_start`. The
[lifecycle review](sf-context-session-cleanup-review.md) found that our harness
disposed sessions without emitting `session_shutdown`, leaving Slack's listener
attached to an invalid context. Bounded shutdown before disposal was added
with actual SDK lifecycle regressions. All 23 factories remain loaded.

The [corrected real SF smoke](context-workflow-sf-smoke-root-4/result-projection.json)
then completed all four workflows correctly and passed its Grok context judge.
All shutdowns completed; there were zero extension errors and zero HTTP 429
responses. Live compression and original-history checks passed. Prompt tokens
fell from 9,738 to 8,512 (12.59%), while workflow elapsed increased from 16.70 to
29.23 seconds (1.75 times baseline). This confirms the lifecycle correction and
functional integration. The small performance result fails the declared gates;
it cannot establish general capacity, speed or billing improvements.

## Full SF comparison completed but repetition compression is insufficient

The [subsequent bounded SF campaign](context-workflow-sf-validation-root-1/result-projection.json)
saved all 192 scheduled sessions: 96 baseline and 96 compact, with zero unrun
slots. Baseline completed all 96 workflows and
returned 88 correct answers. Compaction completed 95 workflows and returned 89
correct answers; its remaining workflow hit the completion-length limit. There
were zero extension failures, every shutdown was safe and there were zero HTTP
429 responses. The campaign made 409 physical requests, including 24 context
judges; all 24 judges passed preservation checks. A passing preservation judge
does not override an incorrect answer or incomplete workflow.

Full-population recorded consumption and elapsed sums were:

| Measure                     |      Baseline |       Compact |       Recorded change |
| --------------------------- | ------------: | ------------: | --------------------: |
| Prompt tokens               |       554,728 |       553,075 |             −0.29798% |
| Output tokens               |        11,232 |        30,184 | 2.6873 times baseline |
| Total tokens                |       565,960 |       583,259 |              +3.0566% |
| Summed workflow elapsed, ms | 3,821,496.076 | 4,050,171.627 |              +5.9839% |

These arithmetic changes describe the recorded population. All qualified
comparison ratios remain null, and functional and performance qualification are
false. The paced elapsed measurements include CPU observer work and uncontrolled
provider-cache effects. They do not isolate transform time or establish billing
cost. The full campaign shows that the v2 repetition codec is insufficient for
the user's current 50% reduction target; the earlier small smokes cannot replace
this result.

## Task-aware excerpts and retrieval are implemented

The replacement strategy selects exact source excerpts according to the current
task and retains original tool results for retrieval. Ordinary
`registerExtension` now defaults to `strategy: "excerpts"` when context reduction
is enabled. Reduction remains off by default and session-only. Standalone
`registerContextCompression` with no strategy preserves its lossless default for
compatibility; historical repetition-codec evidence still describes that path.

`jev_context_read` retrieves retained original text by host-issued `reference`,
not a filesystem path. Optional `offset` is a one-based line number and `limit`
defaults to 100 lines, capped at 200. Optional `byteOffset` is a zero-based UTF-8
boundary for long-line paging. Returned original text is bounded to 16 KiB per
page; JSON escaping and metadata add response overhead. Use `nextOffset` or
`nextByteOffset` for continuation.

`targetReduction` defaults to `0.5`. This is a requested 50% reduction target, not
a measured full-provider-prompt result. Status explicitly labels token counts as
estimates. The session controls are `/jev-context on`, `off`, `status`, `reset`,
`excerpts` and `caveman`. Selecting excerpts or caveman enables the selected mode.

Caveman mode accepts an optional injected
`ContextCompressionOptions.summarize` callback. Its
`TaskContextSummaryInput` is `{task, reference, excerpt, maxOutputBytes, signal?}`
and its `TaskContextSummaryResult` is `{text, complete}`. A host may supply the
Grok summary implementation; there is no automatic credential resolution or
additional model startup. With no callback, caveman mode falls back to excerpts.

The user's current acceptance target is a measured 50% reduction in
whole-workflow prompt tokens. Answer effectiveness is deferred and has not
passed a quality evaluation.

## First excerpt benchmark meets the bounded reduction target

The [first actual Pi/Grok excerpt benchmark](context-reduction-smoke-root-1/result-projection.json)
loaded all 23 controlled SF factories and used three invented 20–40 KiB tool
trace cases, two counterbalanced repetitions and six workflows per arm. Each
frozen trace was approximately 34 KiB and 325 lines. All 12 scheduled workflows
completed, with zero errors and zero unrun slots. Full canonical original text
remained exact and the request projection was verified at the provider wire.
Abort, shutdown, disposal and runtime-key cleanup completed safely.

The [measurement](context-reduction-smoke-root-1/measurement.json) includes all
26 physical requests, including recovery requests: 12 raw and 14 compressed.
There were zero summary-model calls and no unknown-usage requests.

| Measure                           |           Raw |      Excerpts |       Recorded change |
| --------------------------------- | ------------: | ------------: | --------------------: |
| Whole-workflow prompt tokens      |       140,766 |        53,955 |             −61.6704% |
| Output tokens                     |         1,348 |         4,091 | 3.0349 times baseline |
| Total tokens                      |       142,114 |        58,046 |             −59.1553% |
| Summed paced workflow elapsed, ms | 60,761.197751 | 85,339.984875 | 1.4045 times baseline |

The measured prompt reduction exceeds the user's 50% acceptance target for this
bounded long-output workload. Output and elapsed time increased. Effectiveness
was deliberately deferred: no judge or answer-quality acceptance gate ran, and
production improvement remains unqualified. Provider-cache accounting is
incomplete and billing was not measured. The controlled source-pinned setup is
not a claim about normal installed SF defaults, universal 50% reduction, short
context or the amount of protected content that must remain. This result does
not erase the full 192-session repetition-codec failure or routing-head failures.

The [protocol](context-reduction-smoke-root-1/protocol.json) binds source commit
`2860d17b005f3c0d6cca9a25a9e0b0d118113665`, exact executed source hashes, the SF
setup and frozen parameters. It uses zero retries, a 300-second workflow limit,
at most four task requests and four summary requests per workflow, and shared
five-second pacing. The
[local validation record](context-reduction-smoke-root-1/local-validation.json)
reports passing typecheck/build, 969 Vitest checks, 241 Node protocol checks,
formatting and fresh package-consumer checks; it explicitly did not test answer
quality. No new tests or provider requests were run to write this document.

The reproducible prepare/run commands are in the
[README](../README.md#bounded-context-reduction-benchmark).
Preparation uses `--prepare --strategy excerpts --with-sf-pi --sf-pi-path` and a
new output directory. Execution uses the same directory, strategy and SF path
with `--run --expected-protocol-sha` set to the returned SHA and an explicit
`--api-key-file` pointing to an existing local credential file.

## Optional caveman benchmark fails the reduction target

The [later caveman comparison](context-reduction-caveman-smoke-root-1/result-projection.json)
used the same frozen inputs and source, a fresh run directory and its own raw
comparison. All 12 scheduled workflows completed with zero workflow errors and
zero unrun slots. Canonical-original preservation, provider-wire projection and
cleanup checks passed. The 50% whole-workflow prompt objective nevertheless
failed, and the
[publication manifest](context-reduction-caveman-smoke-root-1/publication-manifest.json)
preserves harness exit code 1.

Its [measurement](context-reduction-caveman-smoke-root-1/measurement.json)
includes all 35 physical requests: 12 raw task requests, 15 compressed task
requests and eight summary requests. Summary input/output usage of 3,226/7,680
tokens is included in the compressed totals. Of the eight summary requests,
three completed and five were recorded as incomplete. Passing workflow
execution does not qualify summary generation or answer quality, and fallback
may occur. There were no unknown-usage requests.

| Measure                           |           Raw | Caveman, including summaries |       Recorded change |
| --------------------------------- | ------------: | ---------------------------: | --------------------: |
| Whole-workflow prompt tokens      |       141,186 |                      120,175 |             −14.8818% |
| Output tokens                     |         1,766 |                       12,724 | 7.2050 times baseline |
| Total tokens                      |       142,952 |                      132,899 |              −7.0324% |
| Summed paced workflow elapsed, ms | 61,574.647999 |               141,954.134416 | 2.3054 times baseline |

Task-only prompt reduction was 17.1667%, also below 50%; it cannot replace the
whole-workflow objective that includes summary requests. The
[caveman protocol](context-reduction-caveman-smoke-root-1/protocol.json) records
the separately frozen comparison. Effectiveness remains deferred, there was no
judge or answer-quality gate, and production improvement remains unqualified.
Excerpts remain the ordinary registration strategy and retain their bounded
61.67% passing result; optional caveman remains opt-in. These recorded runs do
not establish universal reduction, cost savings, speed improvements or causal
model/training benefits.

## Remaining work

Keep both completed benchmarks and every scheduled slot in the evidence record.
Answer effectiveness remains deferred. Keep the demonstrated bounded excerpt
prompt reduction and failed caveman objective separate from quality, latency and
billing claims.
For routing, retain the failed head and checker evidence and prepare a better
encoder/training hypothesis while addressing the production completeness
checker's zero coverage through actual supplied-source proof. Host labels and
expected answers remain outside classifier and task-model requests. Any later
qualification needs fresh prospective evidence after development changes, useful
fast coverage, safety gates and complete downstream workflow measurements. The
1,249-check TRAIN audit remains valid, and R7 remains rejected.
