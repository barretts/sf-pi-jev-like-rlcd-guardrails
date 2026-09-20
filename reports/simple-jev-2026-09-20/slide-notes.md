# Simple Jev presentation — slide text

Evidence snapshot: `b5d796c0e7bee0532e2f6c07989fada2393d6342`.

This is a searchable companion to the PDF. Edit `build_report.py` to change the presentation and rebuild this file.

## 01. Simple Jev: from TypeScript rewrite to context reduction

*Project presentation*

SIMPLE JEV  /  PI + SF-PI

From TypeScript rewrite to useful context reduction

The implementation, model experiments, compactions, caveman summaries and exact-excerpt results.

20 SEPTEMBER 2026  •  PRIVATE PROJECT REPORT

Exact excerpts exceeded the reduction target. Quality and speed on real developer tasks still need validation.

60.8%

fewer input tokens

192

recorded Pi/sf-pi workflows

Latest bounded evaluation

Sources: [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 02. A working foundation and a measured compression win

*Where we stand*

WHERE WE STAND

A working foundation and a measured compression win

The engineering path works. The strongest measured result is reduced context work on frozen synthetic tasks.

DELIVERED

TypeScript + Pi

Classifier library, Pi tools, sf-pi Manager seam, HTTP/browser surfaces and a real training/export workflow.

MEASURED

60.76%

Fewer prompt tokens in the latest 192-workflow evaluation. Accepted workflows: 86/96 with excerpts, 84/96 with full context.

OPEN PROOF

1 regression

A multiline count/position answer regressed. Paced task-request time increased 18.67%; production effectiveness remains unqualified.

The current deliverable is an opt-in context feature, backed by retained positive and negative evidence.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 03. The project moved from integration to measured outcomes

*Journey • 19–20 September*

JOURNEY • 19–20 SEPTEMBER

The project moved from integration to measured outcomes

Milestones below follow the actual work sequence; model and harness evidence remain separate.

01

Independent TypeScript rewrite

Recreate the classifier contracts and fit the Pi extension model.

02

Local model selection + RFDT

Compare Gemma prompts and sizes; train, export and reject failed students.

03

Developer and routing controls

Measure complete decision work; reuse prior-thread dispatch lessons.

04

Fixed-Grok context compaction

Hold the task model fixed; repair lifecycle and rate-capacity handling.

05

First exact-excerpt success

Exceed the 50% reduction target on three long trace fixtures.

06

Caveman comparison + selection

Evaluate summary overhead; retain exact excerpts as the selected solution.

07

Answer-effectiveness evaluation

Record all 192 workflows, including the one paired answer regression.

Sources: [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 04. The acceptance target became concrete

*Goal and scope*

GOAL AND SCOPE

The acceptance target became concrete

The original aim was better developer work in Pi/sf-pi. The user later prioritized 50% reduction before judging effectiveness.

Platform and model constraints

TypeScript for Pi/sf-pi. Google Gemma locally; user-selected Grok for controls. Qwen and Chinese-lineage models excluded.

Original developer-improvement bar

Correct outcomes plus faster accepted work or less complete generative work. Standalone classifier speed could not prove that.

Immediate compression target

At least 50% fewer whole-workflow prompt tokens, including extra task, recovery and summary requests.

Subsequent effectiveness check

Strict frozen answers, full scheduled denominators, original preservation, wire delivery and lifecycle cleanup.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 05. The rewrite fits the normal Pi tool loop

*TypeScript implementation*

TYPESCRIPT IMPLEMENTATION

The rewrite fits the normal Pi tool loop

The classifier uses local llama.cpp selected-token logits and returns typed results with zero generated classifier tokens.

Pi prompt

User request

Validate

Typed arguments

Dispatch

jev_classify

Gemma

Local inference

Return

Tool result

Continue

Next assistant turn

Choice • truth • evidence score

Same library contracts across surfaces

TypeScript library

Typed requests and results

Pi extension + Manager

Commands, lifecycle and session status

HTTP + browser

Optional local API and inspection

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md).

## 06. Independent rewrite, explicit compatibility boundaries

*Rewrite method and contracts*

REWRITE METHOD AND CONTRACTS

Independent rewrite, explicit compatibility boundaries

Documentation and source inspection were permitted. This was not a source-separated legal clean-room process.

Contract

Resulting behavior

Evidence boundary

Choice

Select the strongest permitted candidate label.

Confidence is uncalibrated.

Evidence score

Expected zero-based rubric index.

An estimate, with exact provenance.

Noul / truth

Map nine rating bins into [0.01, 0.99].

Unknown handling is tested separately.

v1 compatibility

72 whole-Plan and 432 answer/usage comparisons.

Exact on the captured comparison set.

Original Python checkout preserved. First-party TypeScript is Apache 2.0; model terms remain separate.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md).

## 07. Integration progressed to real autonomous tool use

*Pi and sf-pi proof*

PI AND SF-PI PROOF

Integration progressed to real autonomous tool use

The initial harness proved dispatch. A separate real-provider run later proved automatic selection for controlled prompts.

INITIAL INTEGRATION

1 tool / 2 turns

All 23 sf-pi extensions loaded alongside Jev. Pi validated arguments, dispatched real Gemma inference and consumed all three result types. The harness authored the tool call.

SEPARATE AUTONOMOUS LANE

Gemma 4 selected Jev

The local Gemma 4 agent chose one jev_classify call from 33 tools. The Gemma 3 1B classifier used 683 input tokens and generated zero output tokens.

The warm classification workflow took 154.27 seconds. Two controlled prompts establish functionality; broad speed and selection quality remain open.

Sources: [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md).

## 08. First model selection exposed quality limits

*Gemma classifier selection*

GEMMA CLASSIFIER SELECTION

First model selection exposed quality limits

An explicit refund request initially scored ~0.01 under v1. v2 repaired that sample (~0.99), while the frozen 60-record validation gates still failed.

Candidate

Choice accuracy

Clear truth

Score MAE

Regressions

Gemma 3 1B • v1

50.0%

50.0%

0.25437

2 / 6

Gemma 3 1B • v2 C2

80.0%

50.0%

0.20082

4 / 6

Gemma 3 4B • v2 C7

85.0%

100.0%

0.07971

6 / 6

Formal gates: choice ≥90%, clear truth ≥95%, Brier ≤0.10, normalized score MAE ≤0.10, all regressions and zero execution errors.

The 4B candidate missed choice by one answer: 17/20 versus 18/20 required. Its unknown-truth MAE was also poor (~0.490).

Sources: [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S23 — Reviewed model registry](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/src/models.ts).

## 09. RFDT became a real training-to-native workflow

*Training and acceptance*

TRAINING AND ACCEPTANCE

RFDT became a real training-to-native workflow

Training execution, reload equivalence, exported artifact identity and answer quality were checked independently.

Pinned Gemma base

Validated TRAIN labels

Adapter optimization

Reload + fuse + GGUF

Native validation/test

Initial 64-step student

TRAIN loss fell 4.23194 → 0.11660; fresh reload delta was zero. Native validation passed, including 19/20 choice and 16/16 clear truth.

Held-out test rejected promotion

Score MAE was 0.113934 against a 0.10 maximum. The candidate stayed unapproved; the official base remained the default.

The teacher path also gained strict typed validation and cache checks after a real invalid-target failure. Supplied labels remain distinct from teacher estimates.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md).

## 10. More 1B training fit did not yield reliable developer truth

*Expanded developer corpus*

EXPANDED DEVELOPER CORPUS

More 1B training fit did not yield reliable developer truth

A cancelled 64.3 GiB physical-footprint attempt led to MLX cache clearing. Fresh R2 recorded a 5.05 GiB MLX peak; these are separate memory measures.

Gemma 3 1B round

Developer choice

Clear truth

Score MAE

Diagnosis

R2 • 570 rows / 64 steps

4 / 26

12 / 20

0.28322

Not run

R5 • 570 rows / 512 steps

24 / 26

12 / 20

0.12008

16 / 56

R6 • 730 rows / 512 steps

23 / 26

10 / 20

0.18656

44 / 56

R7 • 970 rows / 512 steps

22 / 26

8 / 20

0.15389

48 / 56

R7 TRAIN loss fell 6.70021 → 0.08457, and all 194 validation rows executed. Every suite still failed its unchanged quality gates.

Sources: [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md).

## 11. A larger Gemma control improved judgments

*Separate model research*

SEPARATE MODEL RESEARCH

A larger Gemma control improved judgments

The Gemma 4 successor passed the 194-record validation stage and completed a matched 312-attempt direct/generated comparison.

Matched developer comparison

Direct selected labels

Generated RFDT targets

Correct judgments

152 / 156  •  97.44%

146 / 156  •  93.59%

Correct individual scores

48 / 52  •  92.31%

42 / 52  •  80.77%

Elapsed per correct judgment

6.103 seconds

7.948 seconds

Generated output tokens

0

2,348

The observed elapsed-per-correct advantage was ~1.30×. The predeclared 2× timing requirement failed in both repetitions; natural Pi task improvement remains unproven.

The successor report was reconstructed from a complete retained audit after a serializer failure; inference was not replayed. The logical and physical changes were not isolated.

Sources: [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S04 — Prior-thread review](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/PRIOR_THREAD_REVIEW.md).

## 12. The prior thread supplied useful routing lessons

*Reuse and performance boundaries*

REUSE AND PERFORMANCE BOUNDARIES

The prior thread supplied useful routing lessons

The two projects had different tasks and timing scopes. No matched experiment ranks one project ahead of the other overall.

Reusable findings

Cache frozen features for fitting. Keep safety checks on every fast branch. Use adversarial missing-fact, quoted-instruction and label-order regressions.

Current-request dispatch

Pi captures its model before before_agent_start. A provider dispatcher is implemented to choose the executing target inside the current stream.

Prior specialized router

HTTP p95 9.22 ms; actual Pi routing p95 79.53 ms. Routed answers: 45/48; always-strong controls: 24/24. Its practical improvement gate failed.

MiniLM was not qualified for this project's allowlist.

Our frozen-Gemma head diagnostic

35/40 strong-required requests routed fast in each pass. Warm operational p95: 260.82 ms versus a 100 ms target. The head remains unapproved.

Sources: [S04 — Prior-thread review](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/PRIOR_THREAD_REVIEW.md); [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md).

## 13. The rewrite also built the developer-facing surfaces

*Product and hardening work*

PRODUCT AND HARDENING WORK

The rewrite also built the developer-facing surfaces

Source/distribution checks and controlled live checks establish different layers of evidence.

Pi and sf-pi Manager

External contribution seam, scoped preferences, lazy startup, explicit warmup, and opt-in advisory routing and answer-evaluation hooks.

HTTP and browser inspection

Real local classification, structured errors, exact response rendering and read-only RFDT inspection that displays failed gates.

Runtime recovery and concurrency

One active plus 16 pending requests; shared warmup, cancellation, deadlines, explicit native recovery and awaited process cleanup.

Pinned artifacts and packaging

Reviewed lineage, role, size and SHA-256; no weights in the package. Excerpt checkpoint 2860d17 passed 969 Vitest and 241 Node protocol checks.

Tool-schema optimization saved 589 prompt tokens (2.85%) across the full 33-tool catalog; validator parity passed 98 vectors. Complete-task gains remain unproven.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S12 — Excerpt source validation](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-smoke-root-1/local-validation.json).

## 14. Fixed Grok separated harness changes from model changes

*Context-compression pivot*

CONTEXT-COMPRESSION PIVOT

Fixed Grok separated harness changes from model changes

The user chose llmgw Grok 4.6 for task controls and context judgments; local model training remained a separate lane.

Same frozen task

Same tool trace Same expected answer Same task model

Full-context request

Projected request

Grok 4.6 in both arms

Provider usage and every physical request counted, including recovery and summaries.

Host-only literal gold

Deterministic strict scoring supplies the acceptance decision; the task model never receives expected answers.

Supplementary judge

Separate Grok preservation/support judgments add evidence. They cannot override failed answers or missing execution.

Sources: [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 15. The first lossless pilot showed savings and extra work

*Context pilot • outside the later Pi hook*

CONTEXT PILOT • OUTSIDE THE LATER PI HOOK

The first lossless pilot showed savings and extra work

Six fixed synthetic extraction tasks used repeated-line encoding; Grok 4.6 ran both task arms and preservation judgments.

CORRECTNESS

6 / 6 each

All literal task answers and all six preservation judges passed. Independent round trips reconstructed exact originals.

PROMPT TOKENS

59.90% less

13,858 → 5,557 prompt tokens. Generated output increased from 3,376 to 6,195 tokens.

TASK TIME

57.01% more

20.864 → 32.760 seconds. The compressed representation required more generated work despite less prompt context.

Observed prompt caching prevented a billing claim. Earlier temperature-rejected and length-limited judge runs remain retained failures.

Sources: [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S06 — Fixed-Grok pilot](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-compression-pilot.md).

## 16. Pi/sf-pi testing exposed harness and capacity failures

*Integration lessons*

INTEGRATION LESSONS

Pi/sf-pi testing exposed harness and capacity failures

These failures were preserved, diagnosed and followed by separately recorded runs.

Observed problem

What changed

Subsequent evidence

Gateway compatibility

Omit store:false; use explicit in-memory SDK compatibility settings.

Real streaming/tool requests reached Grok.

169 / 192 HTTP 429 failures

Shared pacing, cooldown and circuit breaker; no hidden retries.

Later bounded SF campaigns had zero HTTP 429.

SF extension lifecycle errors

Emit bounded session_shutdown before disposal.

SF smoke 4 passed 4/4 workflows and its judge.

That passing SF smoke reduced prompt tokens only 12.59% and took 1.75× baseline elapsed time. Functional recovery did not qualify the 50% reduction target.

Sources: [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md).

## 17. The full repetition campaign fell far short of 50%

*Full SF comparison • 192 scheduled workflows*

FULL SF COMPARISON • 192 SCHEDULED WORKFLOWS

The full repetition campaign fell far short of 50%

The reversible codec compressed eligible repeated lines, but the complete workflow showed almost no prompt reduction.

Whole-workflow prompt tokens

Full context

554,728

Codec

553,075

0.298%

reduction versus 50% target

Recorded outcome

Full context

Repetition codec

Change

Accepted workflows

88 / 96

89 / 96

1 output-limit error

Total tokens

565,960

583,259

+3.06%

Summed workflow time

3,821.50 s

4,050.17 s

+5.98%

First requests added 20,627 prompt tokens; after-read requests saved 25,319; one extra request added 3,039. Net saving: 1,653 tokens. Output also grew 2.69×.

Sources: [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md); [S07 — Full SF repetition comparison](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-workflow-sf-validation-root-1/result-projection.json); [S08 — Repetition overhead diagnostic](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-workflow-sf-validation-root-1/request-overhead-diagnostic.json).

## 18. Three compression approaches had different tradeoffs

*From repeated lines to selected evidence*

FROM REPEATED LINES TO SELECTED EVIDENCE

Three compression approaches had different tradeoffs

The key design choice was how much evidence to send immediately, and how to preserve access to everything else.

REPETITION CODEC

Encode repeats

Keep every distinct line and order in a reversible representation. Helps highly repetitive output; adds decoding instructions and cannot remove unique irrelevant content.

CAVEMAN SUMMARY

Rewrite briefly

A host-injected model writes a terse summary. Summary requests and incomplete responses add work; excerpt fallback remains possible.

EXACT EXCERPTS

Select verbatim

Deterministic task terms select original passages. Omission markers expose missing spans; scoped recovery can read retained originals. No summary-model call.

Verbatim excerpts preserve wording; omitted spans can contain facts needed for a correct answer.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S09 — Exact-excerpt implementation](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/src/context-projection.ts); [S14 — Caveman measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-caveman-smoke-root-1/measurement.json); [S21 — Projection API review](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-projection-api-review.md).

## 19. Caveman summaries did not reach the reduction target

*Optional summary comparison*

OPTIONAL SUMMARY COMPARISON

Caveman summaries did not reach the reduction target

This later comparison reused the three frozen long cases and source, with its own full-context arm and all summary requests counted.

WHOLE-WORKFLOW PROMPT REDUCTION

14.88%

141,186 → 120,175 prompt tokens. Task-only savings were 17.17%, also below target; summary work belongs in the total.

SUMMARY EXECUTION

3 / 8 complete

Five requests were recorded as incomplete. Summary usage: 3,226 input and 7,680 output tokens. Fallback could occur.

WORKFLOW ELAPSED

2.31× baseline

All 12 workflows completed, but elapsed increased. Total tokens fell only 7.03%; answer quality was deliberately not graded.

The CLI exited 1 for the missed 50% reduction objective. Exact excerpts remained the selected ordinary strategy.

Sources: [S13 — Caveman protocol](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-caveman-smoke-root-1/protocol.json); [S14 — Caveman measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-caveman-smoke-root-1/measurement.json); [S05 — Context and routing progress](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/CONTEXT_ROUTING_PROGRESS.md).

## 20. Exact excerpts change the request view and retain originals

*Selected solution*

SELECTED SOLUTION

Exact excerpts change the request view and retain originals

Lexical task terms and named symbols rank three-line windows; merged ranges retain source order and literal text.

Task: Why did build alpha fail?

001 build alpha started
002 compiler: missing symbol Render
003 build alpha failed
... 300 unrelated telemetry lines ...

reference: <host-issued handle>
[lines 1-3]
build alpha started
compiler: missing symbol Render
build alpha failed
[omitted lines 4-303]

Illustrative invented example; no captured provider text.

Canonical history stays exact

Only eligible completed text tool results are projected. Roles, IDs, images and errors are preserved; guards restore literal text when required.

Original recovery is explicit

jev_context_read pages exact text by scoped reference: 100 lines by default, 200 maximum, and 16 KiB of original text per page.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S09 — Exact-excerpt implementation](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/src/context-projection.ts); [S21 — Projection API review](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-projection-api-review.md); [S22 — Projection source review](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-projection-source-review.md).

## 21. The first exact-excerpt run exceeded 50% reduction

*First bounded compression success*

FIRST BOUNDED COMPRESSION SUCCESS

The first exact-excerpt run exceeded 50% reduction

Actual Pi/Grok execution, all 23 controlled SF factories, three invented 20–40 KiB traces and two counterbalanced repetitions.

Whole-workflow prompt tokens

Full context

140,766

Excerpts

53,955

61.67%

Target met on long outputs

Coverage

Physical requests

Extra work

Measured tradeoff

12 / 12 completed

12 raw / 14 excerpt

0 summary calls

40.45% more elapsed

Exact originals + wire

All usage known

Recovery included

59.16% fewer total tokens

This success proved the requested reduction on its frozen workload. Answer effectiveness was deferred, and generated output increased 3.03×. Billing was not measured.

Sources: [S10 — First excerpt protocol](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-smoke-root-1/protocol.json); [S11 — First excerpt measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-smoke-root-1/measurement.json); [S12 — Excerpt source validation](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-smoke-root-1/local-validation.json).

## 22. The next evaluation tested answers across a full schedule

*Exact-excerpt answer effectiveness*

EXACT-EXCERPT ANSWER EFFECTIVENESS

The next evaluation tested answers across a full schedule

The task model, source, gold and scoring contract were frozen; no training or case changes followed inference results.

24

native short cases

+ 24

scoped long variants

× 2

counterbalanced repeats

× 2

full / excerpt arms

= 192

recorded workflows

Fourteen authored task families

Counts, last writes, failures, arithmetic, diffs, timestamps, quoted instructions, exact multiline bodies, Unicode and lookup lookalikes.

Acceptance required all checks

Strict JSON keys, types and values plus exact canonical originals, provider-wire delivery and affirmative lifecycle cleanup.

The 48 cases are synthetic. Long variants use deterministic unrelated padding; repeated variants are correlated observations, not new independent scenarios.

Sources: [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S20 — Frozen synthetic fixture](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/fixtures/context-effectiveness/v1.json); [S24 — Answer-effectiveness protocol](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/protocol.json); [S25 — Independent CPU gold check](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/gold-check.json).

## 23. Observed answer acceptance was mostly retained

*Complete bounded quality result*

COMPLETE BOUNDED QUALITY RESULT

Observed answer acceptance was mostly retained

Wrong completed answers and execution failures remain in the scheduled denominators; the result is not a production qualification.

Outcome

Full context

Exact excerpts

Accepted workflows

84 / 96  •  87.50%

86 / 96  •  89.58%

Wrong completed answers

9

8

Execution errors

3

2

Native short accepted / compression applied

41 / 48  •  none

41 / 48  •  0

Scoped long accepted / compression applied

43 / 48  •  none

45 / 48  •  48

96 pairs: 83 both accepted • 3 favor excerpts • 1 favors full context • 9 neither accepted.

Sources: [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S17 — Answer-effectiveness records](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/result-projection.json); [S18 — Independent evaluation audit](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/independent-audit.json).

## 24. One exact-answer regression remains real evidence

*Discordant workflows*

DISCORDANT WORKFLOWS

One exact-answer regression remains real evidence

Recoverable originals do not guarantee that the assistant retrieves and uses every necessary fact.

Multiline count / position

quality-v3-22-long__r1

Full context answered correctly. The excerpt workflow returned valid JSON matching only 1 of 2 expected fields, despite a recovery turn. Its second repetition passed.

The wrong field and an omission-only cause are unknown; final model text was deliberately not retained.

Three excerpt-favored workflow pairs

Two completed-answer improvements

Long Unicode/spacing: both full-context answers failed JSON parsing; excerpt answers passed strict scoring.

One execution improvement

A correct excerpt answer was paired with a full-context execution error; only one side completed.

Next candidate fix: verify global counts and exact positions against originals before accepting an answer, then evaluate on a fresh frozen suite.

Sources: [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S19 — Discordant workflows](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/discordant-workflows.json).

## 25. The larger quality campaign repeated the compression win

*All physical task requests included*

ALL PHYSICAL TASK REQUESTS INCLUDED

The larger quality campaign repeated the compression win

Usage includes failed calls and recovery. Supplementary judge requests are reported separately; excerpts make zero summary-model calls.

Prompt tokens

Full context

1,593,640

Excerpts

625,273

Total task tokens

Full context

1,660,875

Excerpts

711,842

60.76%

fewer prompt tokens

57.14%

fewer total task tokens

Output: +28.76% Requests: 193 → 206 Paced task time: +18.67%

Paced request-time sums include shared spacing and failures, exclude judges, and do not establish production latency or billing savings.

Sources: [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S16 — Answer-effectiveness measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/measurement.json); [S17 — Answer-effectiveness records](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/result-projection.json).

## 26. Judgments were incomplete; preserved evidence stayed explicit

*Evidence quality and execution limits*

EVIDENCE QUALITY AND EXECUTION LIMITS

Judgments were incomplete; preserved evidence stayed explicit

Strict host scoring supplies the answer result. The supplementary Grok judge did not validate the whole campaign.

Supplementary judgments

Recorded outcome

Scheduled judgments

96

Valid / supporting

24 / 24 valid judgments

Failed / unrun

70 failed / 2 unrun

Disagreements in valid subset

0; failed cases remain unknown

Originals, wire and cleanup

All 187 completed workflows verified canonical text and wire delivery. Original proof: 190/192 total; all 192 session cleanups affirmative.

Whole-campaign status

Five execution errors; zero HTTP 429. The CLI exited 1, and the successful-execution and production-qualification gates remained false.

Sources: [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S16 — Answer-effectiveness measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/measurement.json); [S18 — Independent evaluation audit](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/independent-audit.json).

## 27. The current developer value is more room for useful context

*Practical developer experience*

PRACTICAL DEVELOPER EXPERIENCE

The current developer value is more room for useful context

The measured benefit applies to large completed tool outputs; natural coding-task completion remains unproven.

Potential useful workflow

Long build logs, inspection output or large read results can use fewer prompt tokens while preserving exact selected passages and accessible originals.

Observed applicability boundary

Every scoped-long excerpt workflow compressed. Native short controls stayed literal and showed zero compression; protected content limits possible savings.

In Pi:
/jev-context excerpts
/jev-context status

Turn off:
/jev-context off

Opt-in and session-scoped

Disabled by default. The ordinary extension uses excerpts when enabled. Status token numbers are estimates; provider usage supplies measured savings.

Enable the mode, then start a subsequent task turn.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 28. The next work should close the remaining correctness gap

*Proposed next steps*

PROPOSED NEXT STEPS

The next work should close the remaining correctness gap

These are proposed follow-ups. They are not implemented or qualified by the report.

1

Verify exact global facts

Add deterministic checks or required-original recovery for counts, positions, event multiplicity and final-write questions.

2

Run fresh natural developer tasks

Freeze a separate paired suite of real coding/read workflows, with strict success checks and all failures retained.

3

Reduce complete request time

Measure recovery frequency, output growth, pacing-free latency and cache behavior while holding task model and correctness fixed.

4

Repair supplementary judgments

Capture bounded failure classifications and obtain complete support checks without changing the host gold or hiding failed judgments.

Sources: [S03 — Developer experiments](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/EXPERIMENTS.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S19 — Discordant workflows](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/discordant-workflows.json).

## 29. Recorded comparisons preserve both wins and setbacks

*Measurement ledger*

MEASUREMENT LEDGER

Recorded comparisons preserve both wins and setbacks

Rows use different frozen workloads and protocols; they are milestones, not an apples-to-apples model or strategy ranking.

Experiment

Scope

Prompt change

Total-token change

Elapsed / quality

Repeated-line pilot

6 tasks / arm

−59.90%

−31.81%

+57.01%; 6/6 each

Full SF repetition codec

96 flows / arm

−0.298%

+3.06%

+5.98%; 88/96 → 89/96

First exact-excerpt smoke

6 flows / arm

−61.67%

−59.16%

+40.45%; quality deferred

Later caveman comparison

6 flows / arm

−14.88%

−7.03%

+130.54%; quality deferred

Exact-excerpt effectiveness

96 flows / arm

−60.76%

−57.14%

+18.67%; 84/96 → 86/96

Elapsed definitions vary: pilot task time; earlier campaigns summed workflow time; latest quality campaign summed physical task-request time including pacing, excluding judges. Billing is unmeasured.

Sources: [S06 — Fixed-Grok pilot](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-compression-pilot.md); [S07 — Full SF repetition comparison](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-workflow-sf-validation-root-1/result-projection.json); [S11 — First excerpt measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-smoke-root-1/measurement.json); [S14 — Caveman measurements](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-reduction-caveman-smoke-root-1/measurement.json); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md).

## 30. The report links directly to the preserved evidence

*Evidence index • private repository*

EVIDENCE INDEX • PRIVATE REPOSITORY

The report links directly to the preserved evidence

Implementation/evidence snapshot: b5d796c. Actual experiments retain their separately pinned execution sources and protocols.

S01  Package and controls

README.md

S02  Implementation evidence

VERIFICATION.md

S03  Developer experiments

EXPERIMENTS.md

S04  Prior-thread review

PRIOR_THREAD_REVIEW.md

S05  Context and routing progress

CONTEXT_ROUTING_PROGRESS.md

S06  Fixed-Grok pilot

context-compression-pilot.md

S07  Full SF repetition comparison

context-workflow-sf-validation-root-1/result-projection.json

S09  Exact-excerpt implementation

src/context-projection.ts

S11  First excerpt measurements

context-reduction-smoke-root-1/measurement.json

S14  Caveman measurements

context-reduction-caveman-smoke-root-1/measurement.json

S15  Answer-effectiveness results

context-effectiveness-root-1/RESULTS.md

S18  Independent evaluation audit

context-effectiveness-root-1/independent-audit.json

Every slide has clickable evidence references. The editable source includes all 26 source paths and full SHA-256 pins in evidence.json.

Sources: [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S18 — Independent evaluation audit](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/independent-audit.json).

## 31. Model identities and roles were explicit

*Appendix • model policy*

APPENDIX • MODEL POLICY

Model identities and roles were explicit

Google Gemma, user-selected xAI Grok, and user-attested OpenAI are the permitted lineages for this project.

Identity

Role in the work

Qualification boundary

google/gemma-3-1b-it

Default local classifier; RFDT base; decoder feature experiments.

Base quality and router safety failed.

google/gemma-3-4b-it

Reviewed larger first-pass classifier candidate.

C7 validation missed choice gate.

google/gemma-4-31B-it-qat-q4_0

Local autonomous agent/teacher and direct-label research.

Validation improved; timing gate failed.

llmgw/grok-4.6

Fixed task model and supplementary context judge.

Context control, not a trained student.

llmgw/gpt-5.6-sol

User's configured default; catalog/lineage inspected.

OpenAI mapping user-attested; no matched inference here.

Qwen and Chinese-lineage models were excluded. Local files have pinned sizes, revisions and SHA-256; this report contains no credentials or weights.

Sources: [S01 — Package and controls](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/README.md); [S02 — Implementation evidence](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/VERIFICATION.md); [S04 — Prior-thread review](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/PRIOR_THREAD_REVIEW.md); [S23 — Reviewed model registry](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/src/models.ts).

## 32. How to read the results and their practical limits

*Appendix • methods and interpretation*

APPENDIX • METHODS AND INTERPRETATION

How to read the results and their practical limits

A completed evaluation can contain failures. An observed token reduction is a narrower claim than production improvement.

Full denominator and complete physical work

All 192 scheduled workflows were recorded. The 399 task requests include failed calls and recovery; 94 supplementary judge requests are separate.

Synthetic and correlated evidence

Twenty-four source-blind originals became 24 scoped long variants. Two repetitions of those shared cases cannot establish population noninferiority.

Independent audit scope

Pins, scalar records and scorer provenance were audited. The CPU gold checker was added after inference began; earlier pre-freeze checks were author-attested. Final text was not retained for rescoring.

Cost, speed and installed behavior

Cache accounting is incomplete; dollars saved are unknown. Controlled sf-pi setup and paced timings do not establish natural installed task latency.

The report keeps the rewrite method, rejected students, answer regression and incomplete judge evidence explicit.

Sources: [S15 — Answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/RESULTS.md); [S18 — Independent evaluation audit](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/independent-audit.json); [S20 — Frozen synthetic fixture](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/fixtures/context-effectiveness/v1.json); [S24 — Answer-effectiveness protocol](https://github.com/barretts/simple-jev-ts/blob/b5d796c0e7bee0532e2f6c07989fada2393d6342/research/context-effectiveness-root-1/protocol.json).
