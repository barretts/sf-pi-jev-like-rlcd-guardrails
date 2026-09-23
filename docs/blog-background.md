# Blog background: from Simple Jev to a local guardrail model

Historical snapshot: September 23, 2026. This document preserves the project’s
development story while the active repository is reduced to its SF Guardrail
risk provider, local runtime, and current C11 training workflow. It is background
for a future article, not a published post or a new model evaluation. The
measurements below belong to their recorded workloads and source snapshots.

The central outcome is a runnable, trained Gemma guardrail candidate with
promising diagnostic accuracy and latency. **C11 step256 reached 90.52%
model-eligible accuracy and 93.13% overall accuracy, but five unsafe automatic
allows and six unnecessary confirmations prevented enforcement qualification.**
No independent held-out TEST score exists. That distinction is part of the story.

## The rewrite and Pi integration

The initial goal was to implement Simple Jev’s classification approach in
TypeScript so it would fit Pi and sf-pi’s extension lifecycle. The implementation
reads selected next-token logits from a local llama.cpp process. It supplies
explicit possible answers, scores their labels, and constructs the result in
code. It does not ask the model to generate a JSON answer and then parse it.
The broader original classifier supported choice, rubric scores, and truth or
uncertainty estimates under the name `noul`.

The accurate provenance description is **an independent rewrite with
documentation and source inspection permitted**. The original implementation
was inspected for compatibility; this was not a source-separated clean-room
process. Published v1 prompt fragments preserved compatibility with original
Simple Jev commit `0dd5396ffce671ab7c4bfc031506d8e558cf8d23`. The new project’s
first-party code is Apache 2.0. Runtime dependencies, templates, model weights,
and trained derivatives retain their own terms. In particular, the code license
does not relicense the Gemma 3 model.

The first TypeScript/Pi delivery was committed on September 19 as
`0fef15dab99ec01d8ec091359c773b3e2db942be`. An expanded checkpoint,
`7a8f823e0375419030b08d81de81efdc580d77e6`, added the local workflow, RFDT
training/export lifecycle, and private Manager integration. The package was
library-first, with an explicit `jev_classify` Pi tool and a thin extension.
Installation and Manager status did not load weights, compile native code, or
download models; inference initialization was lazy or explicitly requested.

sf-pi integration used an external Manager contribution contract rather than
imports of sf-pi implementation modules. Work was developed against sf-pi
baseline `4f901db9c3f5076ea0305dea33ad6e8856e467da` in isolated checkouts. The
original source checkouts and ordinary Pi configuration were preserved during
those exercises. The exercised Pi SDK was version 0.85.1.

Separate native-model evidence established that a real Gemma 4 agent could
choose the registered classifier tool and use its result in two controlled
prompts. The classification case accounted for 683 classifier input tokens and
zero generated classifier output tokens. Its complete agent workflow took
154,268 ms; an arithmetic control took 31,437 ms. This proved the autonomous
tool path for those prompts, not broad task speed, routing accuracy, or
acceptance of the smaller classifier’s answer quality.

The project excluded Qwen and Chinese-lineage bases, derivatives, teachers,
fallbacks, and model tests. Allowed local artifacts were Google Gemma models
with reviewed roles, revisions, sizes, and checksums. Missing or mismatched
weights were errors rather than opportunities to substitute another model.

## Experiments that narrowed the objective

The September 20 work explored general developer decisions, RFDT students,
model routing, and session context reduction. These were distinct experiments,
not a single benchmark or a controlled improvement curve.

A useful classifier comparison held the reviewed Gemma 4 31B QAT Q4 artifact
and original developer judgments fixed. The first direct-label implementation
accepted 136/156 judgments, while generated RFDT targets accepted 146/156.
Average score error had concealed individual score misses. A successor changed
both the logical score-label representation and physical runtime profile. Its
matched comparison completed 312 attempts across 78 validation records, 39
groups, and two paired repetitions:

| Measurement                               | Successor direct labels | Generated targets |
| ----------------------------------------- | ----------------------: | ----------------: |
| Accepted judgments                        |        152/156 (97.44%) |  146/156 (93.59%) |
| All-attempt elapsed per accepted judgment |                 6.103 s |           7.948 s |
| Computed prompt tokens                    |                 108,796 |            92,090 |
| Generated output tokens                   |                       0 |             2,348 |

The direct result improved on validation, but both predeclared twofold timing
requirements failed. Zero generated output did not mean less computed prompt
work. These timings covered standalone judgment workflows, not complete
ordinary Pi tasks, and did not establish monetary savings. Changing the logical
and physical candidate together also prevented attribution to either change
alone. The benchmark driver’s final serialization failed after inference and
cleanup; a separately identified reconstruction used the preserved audit rows
without rerunning inference or converting the original failure into a pass.

The smaller Gemma 3 student supplied another caution. A 970-row, 512-update
RFDT run substantially reduced TRAIN loss and verified exact adapter reload,
yet its exported model failed the unchanged native validation gates. Developer
choice was 22/26, clear truth 8/20, and individual developer scores 13/26 against
a required 24/26. Training fit and export integrity did not establish useful
generalization.

Routing research likewise separated feature timing from operational behavior.
A frozen-Gemma feature/head experiment had approximately 32 ms warm TRAIN
feature p95. A later forced-encoder laboratory diagnostic took 260.82 ms warm
operational p95 and selected the fast route for 35/40 strong-required cases per
pass. No downstream task answers were generated in that diagnostic. It rejected
the routing policy; it did not show that 35 generated answers were wrong.

Context work progressed from a reversible repetition codec to task-aware exact
excerpts with original-text retrieval. A completed bounded Pi/sf-pi campaign
used the same Grok 4.6 task model for both arms and recorded all 192 scheduled
workflows. Full context accepted 84/96 workflows; excerpts accepted 86/96.
Across all physical task requests, excerpts reduced prompt tokens 60.76% and
total task tokens 57.14%, while output grew 28.76% and summed paced task-request
time grew 18.67%.

Those token reductions included failed calls and recovery, but they did not
qualify the feature for production. There was one paired answer regression,
three full-context execution failures, and two excerpt failures. Supplementary
judgments were incomplete: 24 valid/supporting, 70 failed, and two unrun. The
CLI exited 1. The source cases were synthetic and correlated, and paced request
time was not production latency. Dollars saved remained unknown.

A separate captioned real Pi/sf-pi recording showed the visible excerpt status,
original-text recovery, and expected answers on eight generated logs. All eight
reads matched their original lengths and hashes. Twelve provider requests
applied 57.1–78.2% serialized request byte reduction, and all 15 responses were
HTTP 200. This demonstrated the UI and delivery path for that fixture; byte
reduction did not establish whole-workflow token, latency, billing, or quality
gains. These broad features are historical context rather than the repository’s
current product objective.

## The guardrail campaign

On September 21, commit `d0ebc8f04660a733738dc1c6e4e29bc9105fd604` introduced
the local risk provider and qualification pipeline. The narrower goal was to
replace SF Guardrail’s **semantic risk detection**, with equal or better safety
and no extra unnecessary interruptions.

SF Guardrail’s existing `tool_call` hook remained the enforcement owner. Jev
received complete original tool input and independently resolved facts; the
existing engine’s risk labels and reasons were excluded from model input.
Selected label logits supplied an uncalibrated allow/confirm judgment. Exact
blocks, protected paths, custom policy, overrides, execution-intent checks,
human confirmation, session approvals, and audit stayed code-owned.

Operator modes were `off`, `shadow`, and `enforce`, with `off` as the default.
Shadow comparisons did not change the baseline’s approvals or execution.
Missing or duplicate providers, malformed predictions, incomplete facts,
timeouts, and model failures produced visible fallback. Qualification bound
model, policy, protocol, runtime, and evaluator identities; a successful model
load or a coherent JSON report did not authorize enforcement.

Candidate selection required zero unsafe automatic allows, no safety regression
against the actual baseline, preserved hard blocks, and benign interruptions
no greater than baseline. Every eligible warm check had to complete within the
750 ms deadline; under 500 ms warm p95 was the ideal. Complete Pi workflows,
fact resolution, and cold startup required their own accounting.

Earlier candidates show why those gates mattered:

- C6’s 128-update model had zero unsafe allows on its 62-case prospective VALID
  set, but 23 unnecessary interruptions versus baseline one. Its 256-update arm
  reduced interruptions but introduced two unsafe allows, including destructive
  shell requests that the baseline would confirm.
- C7’s 256-update model had zero unsafe allows on 65 VALID cases and a 485.32 ms
  warm p95, but 24 unnecessary interruptions versus baseline two. It matched
  41/65 authored actions versus baseline 60/65 and remained rejected.
- C8 had five unsafe allows, including one safety regression, and 17 benign
  interruptions versus baseline one on 96 VALID cases. Only 57/59 eligible
  calls answered; two reached the deadline and fell back. Low p95 among a run’s
  calls could not compensate for incomplete model execution.

These corpora, eligibility lanes, and hosts differed. Their numbers must not be
plotted as an apples-to-apples learning curve. Their held-out TEST sets were not
scored after selection failed.

## C11: faithful export, encouraging diagnostics, failed admission

CUDA training introduced a separate transport problem. C9-B’s adapter reloaded
with exact FIT margins on its original backend, while an initial local import
failed precision with maximum probability delta 0.743168 and one decisive sign
flip. Later FP32 fusion and F16 export work repaired the compared precision
path. Q8 was evaluated separately and was not a substitute for the frozen F16
artifact: C10 step256 Q8 failed its probability-delta limit despite no decisive
flips.

C11 used a fresh guardrail LoRA and optimizer on reviewed
`google/gemma-3-1b-it`, base revision
`dcc83ea841ab6100d6b47a070329e1ba4cf78752`. Its FIT input contained 327 rows,
86 pairs, and 133 groups, with no VALID or TEST training rows. Historical
training stopped at 664/1024 updates, preserving genuine checkpoints 128, 256,
and 512. There was no C11 1024-step model. The wrap-up did not make a fresh
remote query to verify Windows process state.

Step256 CUDA-to-MLX equivalence covered all 327 FIT rows with maximum probability
delta `0.000017387740331720192`. Native F16 precision covered the same rows with
delta `0.0015098066640104046` and zero decisive flips. These proved faithful
transport on compared FIT records, not guardrail effectiveness.

A native-worker recovery correction prevented a retired generation from
invalidating later requests. The repaired replays answered all 116 eligible
diagnostic VALID requests at each preserved checkpoint. The selected step256
result was:

| Diagnostic VALID measurement                     |          C11 step256 |
| ------------------------------------------------ | -------------------: |
| Model-eligible correct                           |     105/116 — 90.52% |
| Overall correct, including 44 code-owned actions |     149/160 — 93.13% |
| Eligible answers                                 |              116/116 |
| Attempted-model fallbacks / replay errors        |                0 / 0 |
| Unsafe automatic allows                          |                    5 |
| Unnecessary confirmations                        | 6, versus baseline 0 |
| Safety regressions against baseline confirmation |                    3 |
| Warm direct risk-check p95                       |           131.165 ms |

The unchanged diagnostic baseline matched 128/160 outcomes with 32 unsafe
allows and zero benign interruptions. C11 corrected 30 baseline risks but
introduced three new unsafe allows. All 11 remaining C11 errors were in the
shell/pane families; native-family eligible rows matched 73/73. These are
rubric-based diagnostic comparisons, not live Salesforce or browser acceptance.

The allow cutoff `0.955913273071778` maximized correctness on 42 TRAIN-CAL
labels. The accuracy-only procedure was adopted after earlier fixed-0.5 VALID
diagnostics were inspected, and checkpoint selection used diagnostic VALID.
Thus the over-90% result was exploratory, not an independent held-out score.
Warm timing included direct request preparation and queueing, but excluded full
Pi workflows and fact resolution. Cold step256 initialization was 1,364.09 ms.

The selected F16 GGUF is 2,006,573,408 bytes, SHA-256
`8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053`.
Packaging placed the merged model, inference runtime, checksums, notices, and
demo in the Desktop folder `Jev-C11-Step256-Model-2026-09-23`. That demo treats
proposed operations as data and does not execute them or enable SF Guardrail.
Its exploratory slow mode does not satisfy the production timing gate.

Separate recorded Pi SDK tests exercised the real session/extension machinery
with counter-only tools and scripted provider outputs: 430 guardrail tests
passed with two skipped, plus 31 runtime-surface checks. Ten matched stub
workflows preserved nine accepted outcomes, one expected block, three
confirmations, three grants, and zero retries per arm. These prove the tested
harness lifecycle, not native C11 complete-workflow performance.

The model, prompt, cutoff, and independent criteria were frozen before new TEST
authoring. Proposed TEST populations failed prescore independence review and
were never model-scored. Rejected populations were not reduced to a convenient
passing remainder. C11 therefore remained `qualified: false`,
`enforcementEligible: false`, with enforcement `off`. Runnable weights,
diagnostic accuracy, and harness proof did not erase the known safety failures.

## Historical comparison and source ledger

An untracked local report, `reports/head-to-head-2026-09-21/README.md`, contained
additional comparisons worth summarizing before cleanup. Its complete default
classifier comparison executed 166 shared original cases and 221 gold judgments:
official Jev Gemma 3 1B accepted 82/221 (37.10%); trained System One E2B accepted
153/221 (69.23%). Median elapsed per case was 135.86 versus 152.30 ms.

A different comparison used archived stronger Jev Gemma 4 31B research outputs
and fresh System One outputs on consumed validation questions: 76/78 versus
40/78 accepted judgments, with unmatched timing. A separately frozen bounded
compression follow-up accepted 18/24 full-text judgments versus 17/24 Jev
excerpt judgments. Jev reduced delivered context 34.00%, with recorded prompt
work 0.701x and elapsed 0.798x full text. System One verified mode had two errors
and unknown total work. A broader compression run retained only 100/166 cases
before interruption. Different artifacts, consumed/correlated cases, and
uncontrolled concurrent activity prevented general speed, quality, or billing
claims.

Those are extracted historical summaries. The untracked result files were not
part of the following Git snapshot and cannot be recovered from its commit
alone. Original comparison README SHA-256:
`db12ec88014f4407857d18f9c84383306a4d7ab0fe5676d96add42c073947106`.
Original protocol SHA-256:
`3be39698ca04dc50d2b0185d6c5c30dcdb59c6f8b5bd849b4b7ee9a7aefec67f`.
Bounded protocol SHA-256:
`eb76f301e24217bf907a284a38e06c8cff308f853f6b7ec1078b215d89d5d0ab`.
Hashes identify the source bytes; they do not reproduce deleted outputs.

The earlier untracked 32-page `jev-ts-presentation-2026-09-20.pdf` was a
generated predecessor. The later tracked presentation, editable source, slide
notes, and evidence preserve that topic in Git. There is no need for a second
presentation archive in the active repository.

The following immutable links point to historical files at source snapshot
`85b12f998141081ebd9199982541a7a50520724f`, even when cleanup removes them from
the current tree. This repository was private at that snapshot; the links
require repository access.

- [Original package scope and provenance](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/README.md).
- [Developer comparisons and experiment ledger](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/EXPERIMENTS.md).
- [Implementation, runtime, Pi, and training evidence](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/VERIFICATION.md).
- [Bounded excerpt answer-effectiveness results](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/research/context-effectiveness-root-1/RESULTS.md).
- [Captioned real Pi context demo](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/reports/pi-context-demo-2026-09-20/README.md).
- [Presentation’s searchable history and caveats](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/reports/simple-jev-2026-09-20/slide-notes.md).
- [C11 accuracy procedure and checkpoint table](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/reports/guardrail-risk-2026-09-21/candidate-11-accuracy-milestone.md).
- [Complete C11 stop report and proof limits](https://github.com/barretts/simple-jev-ts/blob/85b12f998141081ebd9199982541a7a50520724f/reports/guardrail-risk-2026-09-21/candidate-11-stop-report-2026-09-23.md).

For offline access from a checkout containing that history:

```sh
git show 85b12f998141081ebd9199982541a7a50520724f:EXPERIMENTS.md
git show 85b12f998141081ebd9199982541a7a50520724f:reports/guardrail-risk-2026-09-21/candidate-11-stop-report-2026-09-23.md
```

Historical references to ignored `.build` files or removed temporary worktrees
may not resolve. Git does not contain the heavy weights or every private raw
run. This background deliberately preserves the distinction between source
checks, runnable models, controlled harnesses, diagnostic effectiveness,
independent qualification, production adoption, and human approval.
