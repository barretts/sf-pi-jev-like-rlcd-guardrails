# Developer improvement experiments

Objective: make Jev a reliable improvement in developer speed and resource cost using models, tooling, and access already available. A fast classifier call is insufficient: the complete developer task must finish correctly sooner, or use measurably less work with equivalent results.

Baseline source: `2256923373128e812eb6fa5db2226fd2a08d194c`. Work branch: `feat/developer-improvement`. The original Simple Jev and sf-pi checkouts remain preserved. Only reviewed Google Gemma models are eligible. No Qwen or Chinese-lineage model, new account, purchase, or credential is needed.

The earlier student and its failed final test remain immutable historical evidence. The new developer corpus is a separate experiment, not a replacement for that test or a retroactive approval. New training and hypothesis selection use only new training/validation groups. Final tests are reserved until a candidate and its evaluation conditions are frozen.

## What would count as success

- A representative, independently checkable developer decision/task suite covers routing, evidence scoring, and factual/uncertain judgments. It includes realistic failures, partial results, competing operations, excluded/quoted instructions, unavailable capabilities, and changed evidence.
- Correctness meets the existing numeric quality gates: choice accuracy at least 0.90, clear Noul accuracy at least 0.95, Noul Brier at most 0.10, normalized score MAE at most 0.10, zero execution failures, and every marked regression. The new experiment additionally requires uncertain Noul MAE at most 0.10. Abstentions are reported separately and never counted as correct completed decisions.
- Matched decision-workflow trials achieve at least a twofold median improvement in time to an accepted result, with no accuracy regression. Complete pi task trials must demonstrate at least a 20% median improvement or at least 30% less generative work with equivalent correctness and no material latency regression. Measure repetitions and distributions rather than choosing the fastest case.
- The evaluation includes ordinary pi without Jev, the current Jev implementation, and the candidate as appropriate. Cache state, model, task, source/tool snapshot, settings, trial order, and all extra Jev work are recorded. Cold and warm results stay separate.
- Functional checks establish a correct diagnosis/decision and, for repair tasks, resolution of the original failure with the relevant behavior preserved. Synthetic tools and local fixture evidence are identified explicitly; they cannot establish live Salesforce org outcomes.
- Tool inventory, permissions, Guardrail authority, and automatic retry behavior remain unchanged. Advice is optional, and insufficient evidence remains visible.
- Resource cost means actual computed tokens, generated tokens, engine work, model memory, and measured runtime here. No remote API bill, energy savings, or dollars saved are inferred from local token counters.

## Initial hypotheses and falsifiers

### H1: Semantically grounded routing improves useful decisions

The current many-option letter mapping can return confident wrong routes. Score each available family's direct relevance against an explicit operation boundary using the existing v2 score compiler, instead of mapping descriptions to arbitrary letters. Compare current choice and relevance policies on authored developer pilot cases, then the frozen new train/validation corpus.

Falsified by poor coverage, incorrect high-confidence recommendations, unstable answers under equivalent ordering, slower complete accepted tasks without compensating quality benefit, or treating abstentions as success. Thresholds and any model changes are selected on train/validation only.

### H2: A compact, equivalent tool schema reduces agent prefill work

The generic Jev tool contributed 7,453 JSON characters to a 70,729-character tool catalog in the previous actual run. Share repeated JSON definitions while preserving the accepted/rejected argument contract, tool name, execution, inventory, and every permission. Compare actual provider catalogs and separately measured cold/warm requests.

Falsified by validation or reference-resolution differences, changed successful arguments, unchanged prompt work, or a latency claim based only on schema character counts.

### H3: Typed developer recipes replace expensive repeated judgments

Offer fixed, concise diagnostic/evidence recipes with local deterministic rendering. The helper supplies grounded structured advice before the main assistant's next step, without an extra authored assistant turn. Compare against the same main model constructing judgments itself and completing the same independently checked task.

Falsified by incorrect diagnosis, missed uncertainty, unnecessary requests, or unchanged/slower time to a correct completed task. Turning main-model reasoning off is a separate ablation and cannot be credited to Jev alone.

### H4: Reuse avoids repeated work without stale judgments

Exact validated-content reuse may help repeated reviews; retained native prefixes may help multiple questions about substantial shared developer evidence. Both require identity/order/generation isolation and comparison against fresh computation, including changed input and cancellation/recovery.

Falsified by stale output, cross-request contamination, logit/answer changes beyond the declared arithmetic policy, incorrect usage accounting, or benefits confined to repeated synthetic strings. Unique requests and real repeated-work frequency are included in the result.

### H5: Concise tool results preserve decisions with less follow-up context

The current generic tool sends the full diagnostic response to the main model and the inspector. A concise model-visible result may retain exact answers, requested raw fields, usage, artifact/template identity, and uncalibrated status while keeping execution diagnostics in full tool details. Compare actual follow-up provider token work and completed developer outcomes, not just serialized length.

Falsified by lost requested evidence, different decisions, hidden uncertainty/provenance, inaccessible full details, or no measurable downstream benefit. Advanced diagnostic requests remain explicit.

## Evidence ledger

| Round                 | Status                         | Evidence                                                                                                                                                                                            | Next decision                                                                                                                  |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Baseline inspection   | Completed                      | Previous actual pi: 154.268 s total versus 2.338 s Jev; 33 tools; 479 + 267 main-model generated tokens. Two Apex advice prompts routed incorrectly.                                                | Optimize end-to-end work and correctness together.                                                                             |
| New protocol          | In progress                    | This document; new full-family corpus being authored independently.                                                                                                                                 | Freeze data before candidate inference.                                                                                        |
| H1 pilot, official 1B | Failed usefulness              | `.build/improvement-experiments/routing-pilot-1b.json`: current choice 1/13 correct; both relevance policies abstained 13/13; no execution errors.                                                  | Test the available 4B model and representative training; do not adopt the prompt change.                                       |
| H1 pilot, official 4B | Improved baseline, still fails | `.build/improvement-experiments/routing-pilot-4b.json`: choice 10/13 correct; both relevance policies abstained 13/13. Choice 13.32 s/9,992 computed tokens versus relevance 34.70 s/30,071 tokens. | The relevance-prompt hypothesis is rejected for these untrained models; train representative semantics before adopting advice. |
| H2 schema             | Equivalent; real token saving  | Actual pi validator/coercion parity passed 98 vectors. Owned Gemma 4 native tokenizer: full 33-tool prompt 20,640 → 20,051 tokens, saving 589/2.85%; Jev declaration 2,515 → 1,926, saving 23.42%.  | Retain the equivalent schema reduction; complete-task latency and quality gains remain unproven.                               |
| H3 first repair pair  | Candidate running              | Ordinary pi changed only the allowed source, passed tsc and all 5 tests, then exceeded the 600-second workflow deadline during its final explanation. The assisted arm remains live.                | Retain the ordinary workflow timeout separately from its passing code checks; inspect the candidate and cache effects.         |
| H5 result serializer  | Bounded candidate implemented  | Nine focused tests pass. A saved actual browser classifier response shrinks from 2,193 to 1,450 bytes while preserving answers, distributions, requested raw fields and provenance.                 | Wire after the current run ends, retaining the complete response in details; measure actual downstream tokens and outcomes.    |

Raw measurements stay in ignored private `.build` directories. Source hypotheses, runnable evaluators, authored fixtures, and result summaries are committed. Hosted CI is optional for this goal; local functional and real-model evidence are the acceptance basis.

## Additional complete pi workflow

The repair lane retains all four tasks and every failure. A separate evidence-review lane will cover every record in the frozen developer validation split, grouped into deterministic mixed batches with equivalent state/chat variants kept together. Both ordinary pi and assisted pi read the same gold-free JSON input through the normal builtin `read` tool; final answers are checked independently against private authored targets. All existing tools remain visible, and remote/account operations remain unauthorized for these local fixtures.

An experimental `jev_classify_loaded` tool will accept an explicit reference to a successful builtin read that pi has already performed. It will consume a strict JSON request bundle from session memory, preserving the source hash and actual native responses. It will not open files. This tests whether avoiding repeated generation of source and questions pays for the additional helper call and main-model turn. The Gemma 4 template does not expose tool-call IDs, so the read result needs a small visible reference marker; its context and runtime cost belong to the candidate.

The proposed full review suite contains all 78 validation records across 39 independent context groups, in 13 six-record batches, with three counterbalanced repetitions per arm. These counts become binding only after the complete corpus is frozen. Representation pairs and repetitions do not increase the independent scenario count. The current untrained routing failures and earlier failed student remain part of the evidence; a useful review result cannot establish faster repairs or reliable default routing by itself.
