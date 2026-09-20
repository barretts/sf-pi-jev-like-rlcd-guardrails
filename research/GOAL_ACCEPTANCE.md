# Full-goal acceptance contract

This contract defines prospective acceptance for working Pi context compression,
improved routing that uses the prior findings, and an isolated fixed-Grok
validation harness. The full goal is complete only when all three lanes pass
their applicable gates and the complete developer workflow passes the existing
quality and improvement conditions. Finishing a pilot, training a model,
exporting a model, passing mocked tests, or preparing a protocol does not complete
the goal.

The starting requirements remain those in [EXPERIMENTS.md](../EXPERIMENTS.md).
The prior routing findings are in [PRIOR_THREAD_REVIEW.md](PRIOR_THREAD_REVIEW.md),
and the historical compression control is in
[context-compression-pilot.md](context-compression-pilot.md). The additional
minimum populations and thresholds below are prospective requirements for new
confirmation. They do not rescore or replace earlier experiments.

## Freeze before execution

Before any confirmation inference, retain one immutable protocol with source and
runtime hashes, model/artifact identities, exact prompts, trusted interpretation
instructions, codec bounds, route thresholds, active tools, permissions,
timeouts, retry policy, repetition count, arm order, acceptance commands, and
the complete expected case/group/variant population. Fix the workload mix and
primary metrics before outputs exist. Keep targets outside agent and judge
inputs. Fixture authors must not use candidate predictions or consumed heldout
targets to construct fresh confirmation cases.

Use at least three counterbalanced repetitions for paired workflow confirmation.
Keep cold and warm conditions separate; record actual cache observations rather
than assuming a warm request or equal workspace path implies cache reuse.
Representations, option permutations, and repetitions are coverage cells of the
same scenario, not additional independent scenarios. Confidence intervals use
the independent scenario/group as the resampling unit; report the interval,
sample size, and observed distribution alongside the acceptance threshold.

Every scheduled cell remains in the denominator. A timeout, parse error,
cancellation, missing proof, unrun arm after quarantine, or incomplete response
is a failure or unresolved observation, never a correct decision. Keep every
attempt and any preset retry. Do not report improvement only among pairs where
the candidate happened to succeed. Changes after inspecting outputs require a
new candidate and new protocol; consumed cases remain regression/development
evidence.

## Context compression in actual Pi

### Runtime and preservation gates

1. Exercise the actual installed Pi `context` hook with a real SDK session. Its
   returned messages must become the next provider request, as shown by captured
   request identities and provider-visible content. A direct codec call or a
   simulated event alone cannot clear this gate.
2. The hook creates an ephemeral model-visible projection. Canonical session
   entries, original tool-result content, details, tool-call identity, and
   independently retained original hashes remain unchanged and accessible.
   Compare original bytes before/after successive hook calls, a continuation,
   a retry, branch changes, and session disposal. Repeated hooks are idempotent
   and never compress an already projected value as if it were the original.
3. Preserve message order, text-block order, image blocks and their bytes or
   stable references, other supported non-text blocks, role, tool name,
   tool-call ID, and error status. Unsupported layouts pass through intact.
   A completed capture can describe a timed-out or still-unknown operation;
   capture completion must not become confirmed operation success. Pending
   operations and unresolved work cannot disappear.
4. Every eligible text transformation reconstructs the exact original UTF-8
   text, including LF/CRLF/bare-CR terminators, blank lines, the final newline,
   adjacent-record multiplicity, negative values, failures, missing evidence,
   supersession, quoted instructions, and uncertainty. Retain the original hash
   independently of the encoded value. Images are preserved through the message
   projection; a text round trip alone cannot prove image preservation.
5. The trusted caller supplies the format label and interpretation instructions.
   Tool output cannot select a codec, inject privileged instructions, replace
   the trusted original hash, or request routing. Encoding-looking ordinary text
   remains literal. No fact selection, summarization, JSON minification, or
   semantic deletion is part of this lossless intervention.
6. Enforce and record finite limits before allocation. The current codec defaults
   are 16 MiB original/encoded text, 250,000 lines, 100,000 segments, and 250,000
   repeats per row; any different limits must be frozen explicitly. Reject
   noncanonical encodings, invalid Unicode, malformed rows, extra/accessor
   fields, unsafe/fractional/nonpositive counts, contradictory metadata,
   unexpected versions, hash mismatches, and expansion beyond any bound. Hook
   failures and ineligible/over-bound results preserve the original message and
   record a skip/failure; they do not truncate context or stop the agent silently.
7. With compression disabled, the hook leaves messages and instructions
   unchanged. Enabling or disabling it must not change available tools,
   permissions, guardrails, retry behavior, or the chosen execution model.

### Usable reduction and complete-task gates

Retain the six historical cases as consumed regressions. Add at least 12 fresh,
independently authored multi-step workflow groups: at least four containing
failure/unknown/missing-evidence outcomes, four containing multiplicity/order or
supersession, and four containing nonrepetitive output, images, mixed blocks, or
untrusted format/instruction text. Declare eligibility without looking at
answers. Include uncompressible controls in the complete mixed workload.

Compare ordinary Pi with the hook disabled against the same main model, tools,
task, acceptance commands, workspace path, settings, and hook-enabled Pi.
Measure the entire provider-visible prompt, including format labels,
interpretation instructions, envelopes, reference markers, and extra turns.
The capacity gate requires at least a 20% reduction in aggregate actual prompt
tokens across predeclared eligible workflows, no prompt-token increase across
the full mixed suite, exact reconstruction/preservation in every applicable
cell, and no downstream accepted-task correctness regression. Byte reduction
alone cannot clear the token gate. Missing trustworthy token accounting leaves
that gate unresolved.

Record local transformation time, complete all-attempt workflow elapsed time,
median paired latency ratio, aggregate elapsed ratio, p95, completions,
input/output/cache token counts, and actual cache-hit observations separately.
The hook must have median paired and aggregate elapsed ratios no greater than
1.0 on the full confirmation suite. Report any tail or workload-stratum
regression even if aggregate gates pass. A preservation judge belongs to
validation overhead; if installed in the production path, its calls, latency,
and tokens belong to the candidate workflow. No dollar, energy, or billing
claim follows from bytes, logical Jev tokens, or total prompt tokens.

## Routing that improves accepted work

### Lifecycle, dispatch, and safety gates

Family recommendation and fast/strong execution-model selection are separate
outputs and have separate denominators. Declare which output a candidate
implements. A family-advice-only hook cannot satisfy execution-model routing.

The current `before_agent_start` advice is insufficient for same-prompt model
switching: the reviewed Pi version captures its execution model before that
event. Demonstrate an active provider dispatcher or an equivalent verified
current-request boundary. For every scheduled request, record the prompt ID,
route decision, actual provider/model used for that same request, and dispatcher
generation. A decision applied only to the next prompt fails.

Exercise overlapping requests, queued continuations, repeated lifecycle events,
retries, session/branch changes, shutdown, and cancellation during classifier
work and provider streaming. Cancellation propagates to owned work; stale
decisions cannot dispatch or contaminate a later prompt. Classifier failure,
unknown evidence, unavailable capability, or uncertain ownership falls back to
the declared strong path without expanding permission. All models remain inside
the reviewed allowlist and the user's existing authorized registrations.

Every fast branch must pass the current safety verification. The prior cascade's
old-fast bypass is forbidden. Test quoted routing instructions, missing essential
facts, misleading completeness, contradictory evidence, unavailable tools,
privileged/account actions, mixed-family needs, and format changes. Preserve
tool inventory, guardrail authority, authorization boundaries, and automatic
retry policy. A route never grants permission or substitutes for an acceptance
check.

### Fresh route-quality and useful-coverage gates

Freeze at least 20 independently authored easy controls and at least 40
strong-required controls: at least 20 demanding and 20 ambiguous scenarios, with
unsafe-action and missing-evidence cases represented in those groups.
Require zero unsafe fast routes in every repetition and coverage cell, and at
least 10/20 easy controls correctly sent fast in every repetition. An all-strong
policy therefore does not pass useful coverage. Reject easy routes whose
downstream accepted answers regress against the matched always-strong arm.

For family routing, add at least two ordinary fresh requests and two adversarial
or boundary requests for each declared available family, plus at least four
each for `general`, `mixed`, and unavailable-family situations. These controls
may overlap the execution-routing population if that overlap is frozen and
reported. Retain unavailable families as absent; do not fabricate a capability
to make a target routable. Require at least 0.90 overall family-choice accuracy,
every marked safety/boundary regression, and the full per-family report.

For every independent routing scenario, include the original order and two
independently generated option/label permutations. Compare semantic routes after
undoing the permutations. Require invariant safety and semantic decisions in
all cells; letter accuracy pooled across orders is insufficient. Freeze learned
heads, normalization, thresholds, and any feature extraction on TRAIN/VALIDATION
only. Cached-feature fits and imported adversarial cases from the prior thread
are useful development/regression work, not fresh generalization evidence.

If the classifier also supplies factual or score judgments, preserve the
existing full quality gates: choice >=0.90, clear Noul >=0.95, Brier <=0.10,
normalized score MAE <=0.10, unknown Noul MAE <=0.10, zero execution failures,
and every marked regression. For the R7 selection contract, all three original
suites and the additional 24/26 individual developer-score condition remain
mandatory. Passing routing alone cannot approve a broader classifier.

### Complete workflow and operational timing gates

Run the full frozen routing workload through actual Pi against the same-prompt
always-strong baseline, with current Jev as a separate comparison where
applicable. Use at least three counterbalanced repetitions. Independently check
final task acceptance, including original failure resolution and preserved
behavior for repairs. The candidate must match or exceed baseline accepted-task
correctness overall and in every declared workload stratum, with no paired
baseline-success/candidate-failure regression. Report fresh easy coverage and
accepted correctness together.

Measure routing time at the operational boundary from request availability to
the actual selected provider dispatch, including context preparation,
tokenization, feature extraction, classifier queuing, guard verification, cache
lookup, dispatcher work, and retries. Freeze a warm operational-router p95 bound
of 100 ms for the new routing confirmation, using at least 60 actual dispatches
per repetition. Report cold initialization and cold dispatch separately. The
prior 9 ms HTTP qualification and approximately 80 ms Pi observation are
historical measurements on a different classifier/task, not this bound's proof.

Complete workflow improvement retains the existing conditions: at least a 20%
median paired improvement in elapsed time, or at least 30% less actual generated
work with no elapsed regression. Require full quality, coverage, complete usage,
and functional acceptance first. For either claim, aggregate elapsed ratio must
be <=1.0; the generated-work alternative also requires median paired elapsed
ratio <=1.0. Count all classifier/verification/provider work, helper turns,
retries, failures, and cleanup. Report per-repetition and stratum distributions.
Standalone decision-workflow speed retains both frozen twofold timing gates;
it cannot substitute for the complete Pi task gate. A failed/partial suite or
unknown work accounting cannot produce a positive resource claim.

## Fixed-Grok harness isolation

1. Use the selected existing `llmgw/grok-4.6` registration, exact allowed gateway,
   and a frozen sanitized registration digest. Resolve only that registration;
   do not enumerate unrelated model catalogs, execute credential commands in
   preparation, change global Pi/model configuration, or mutate another session.
   Preparation installs a fetch-deny guard before any provider/SDK import and
   proves zero inference and credential resolution.
2. The run uses an explicit selected-registration/endpoint allowlist, no model
   routing, automatic fallback, hidden retries, redirect following, account
   login, or new credential. Wrong gateway/API/model/returned identity fails
   closed. Record the actual returned model and available upstream attribution;
   do not invent an exact weight identity from the alias. Secrets stay outside
   protocols, snapshots, logs, errors, transport metadata, and answers.
3. Freeze fixture, source/runtime, request construction, task/judge instructions,
   decoding fields, budgets, deadlines, pair order, and retry policy. Both answer
   arms use the same model and non-context settings. The selected gateway rejects
   temperature: omit it in both arms and record that provider temperature is
   unobserved. Judge-only changes require a new run version and unchanged task
   request hashes; every earlier failure remains available.
4. Answer arms and preservation judgments are separate stateless requests. A
   judge receives raw/candidate context, task, and fixed interpretation rules,
   but no expected target, answer prediction, earlier judge result, or shared
   conversation. Neither answer model nor judge may choose cases or revise the
   intervention. Untrusted context remains data in every request.
5. Validate complete bare JSON, duplicate-key rejection, exact expected keys and
   values, and bounded response size. Preservation output has the exact frozen
   schema, all required booleans true, and no issues. Truncation, unknown finish
   state, incomplete response, or failed request remains unresolved/failing.
   Retain every scheduled attempt, including HTTP errors and response limits.
6. Deterministic round trips decide literal retention; independently authored
   expected answers decide task correctness; Grok judges provide an additional
   model assessment. All applicable lanes must pass. Retain request/response
   identities, selected numeric usage, cache accounting, and timings; explicitly
   identify any response digest whose original body was not retained and cannot
   be independently recomputed.
7. Demonstrate mocked adversarial/protocol regressions without network, followed
   by a fresh complete run of the fixed corpus using the exact new harness and
   codec source. All raw answers, compact answers, preservation checks, and calls
   must complete successfully. Historical v1 pilot results cannot qualify the
   new `jev-tool-text-v2` representation or a new runtime hook. Successful judging
   alone cannot clear Pi integration or complete-workflow benefit.

## Evidence lanes and current completion state

| Lane | What it establishes | Current evidence and remaining work |
| --- | --- | --- |
| Source and deterministic checks | Codec/dispatcher/scorer contracts, bounds, preservation, isolation, denominator handling | Historical codec/protocol checks exist; new v2 codec and runtime changes need their exact source checks and original-preservation coverage. Mocked checks do not establish model quality or actual dispatch. |
| Training, reload, and export | Actual optimization and artifact lineage | R7 completed 512 updates, exact adapter reload, and export. It does not pass selection: all 194 native validation rows executed, but every suite failed unchanged quality; individual developer scores were 13/26 against required 24/26. R7 remains rejected, unapproved, and unpromoted. |
| Native quality and independent reconstruction | Complete original grades/coverage and attributable artifact results | R7 host reconstruction preserves the full denominator and rejection. Recovery did not retain raw RPC logits and fingerprinted the binary after execution; full independent native parity and positive speed are not established. No new TEST or approval followed. |
| Fixed-Grok pilot | Narrow context retention and measured sample prompt usage | Historical v1 run 3 passed six raw answers, six compact answers, round trips, and six judges. Prompt tokens fell 59.90%, but task elapsed rose 57.01%; uncached prompts rose from 290 to 437. New harness/v2 inference and fresh confirmation remain necessary. |
| Actual Pi integration | Provider-visible context hook, same-prompt dispatch, cancellation, original immutability | Existing family hook is advisory. The full runtime compression and execution-routing gates require separately attributed actual SDK/provider evidence. Historical pilot and load-only proofs cannot clear them. |
| Full downstream task confirmation | Accepted correctness and complete workflow benefit | Run every declared group/variant/repetition and preserve failures. Existing full-review preparation covers 78 records/39 groups, 13 batches, three repetitions, and 234 judgments per arm; configured-provider inference remains pending upstream verification in the reviewed evidence. Review benefit cannot establish repair or default-routing benefit. |
| Resource claims and cleanup | Actual usage, cache behavior, timing scope, ownership boundaries | Complete numeric work, all-attempt timing, owned exits/closed streams, and affirmative cleanup are required. Quarantine uncertain workspaces and retain later unrun slots as failures. No measured billing, energy, production deployment, or general DX gain is established. |

The remaining work is to finish and verify the immutable-original Pi context
projection, exercise same-prompt routing dispatch and cancellation, freeze the
fresh route/workflow populations and exact harness version, perform complete
paired confirmation with trustworthy usage/timing/cleanup, and independently
reconstruct all gates. A replacement classifier must pass the unchanged quality
selection before any approval; R7 cannot be promoted to complete this goal.

Record each lane as passed, failed, or unresolved with exact artifact/source/run
identities. The final acceptance record must name the full population, the failed
and unresolved gates, and the measured claim it supports. The goal stays open
while any required gate is failed or unresolved.
