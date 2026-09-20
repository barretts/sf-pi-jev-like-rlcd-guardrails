# Prior local model-router thread: reusable findings

Reviewed thread: `01a0bc96-2e43-7c11-8e39-4dfbe5c28fbc`, originally working in
sf-pi with Simple Jev. This is a source and evidence review, with no new model
execution. The other thread's dirty worktree is preserved separately.

## Performance comparison

No matched trial ranks the two projects overall. The other project selected
between fast and strong assistant models; this project implements choice, truth,
and evidence-score judgments plus advisory Salesforce family selection.

The other project's specialized MiniLM HTTP qualification completed 60 records
with p95 9.219125 ms, 13/20 easy requests sent fast, and zero of 40 demanding or
ambiguous requests sent fast. Operational routing p95 in its real Pi confirmation
was 79.532708 ms. This is materially lower overhead than the larger Gemma direct
judgment workflow measured here, but the tasks, models, and timing scopes differ.
MiniLM has not been qualified for this project's model allowlist.

Its execution confirmation passed 45/48 routed answers; all 24 always-strong
baselines passed. Easy-task median latency improvement was 18.547469%, with a
95% bootstrap interval from -7.370035% to 28.201524%. The practical improvement
gate failed. Historical timeout usage and complete mixed-workload measurements
remain unknown. Catalog pricing indices are not verified billing savings.

This project's Gemma 4 successor passed the complete 194-record validation stage
and produced 152/156 correct judgments in the matched developer comparison,
versus 146/156 generated judgments. It missed the frozen twofold timing gates.
Neither project has proved the complete developer-workflow benefit.

## Candidate wins

1. A specialized Gemma feature classifier. The prior thread extracted normalized
   1,152-dimensional decoder features without a language-model output head. Warm
   MPS extraction took at most 24.854875 ms for two short 13-token inputs; this was
   feature feasibility, not routing quality or HTTP p95. The small learned head
   is a useful prospective alternative to positional answer letters for fixed
   routing classes. It is not an interchangeable general Jev classifier.
2. Cached-feature development. Several later head and normalization fits reused
   existing vectors with zero new decoder/tokenizer calls. This can reduce
   experimental cost before another full LoRA run. TRAIN-centered question
   features had zero unsafe fast routes among 2,099 consumed negatives and 7/9
   practical easy controls, but demoted 17 previously fast controls and remained
   rejected. Those consumed cohorts are training/regression evidence.
3. Preserve checks on every fast branch. A completed MiniLM/Gemma cascade retained
   ten unsafe routes, all through the old fast branch that bypassed Gemma. Gemma
   would have rejected all ten. A prospective verification policy must also
   measure useful easy coverage and the added classifier work.
4. Reuse adversarial regressions. Missing essential facts, misleading completeness
   claims, quoted routing instructions, format changes, and independent option
   order/label permutations exposed confident errors. Raising a threshold alone
   could not separate the original method's worst unsafe case from useful easy
   decisions. Imported consumed cases cannot become fresh acceptance cases.
5. Reuse Pi lifecycle lessons if model switching is added. Pi 0.85.1 captures the
   execution model before `before_agent_start`. The other thread used an active,
   cancellable provider dispatcher to select the current request's target. Our
   current hook returns advisory family context and does not switch models.
6. Measure and cache exact compilation. Our native compiler renders and tokenizes
   each complete prompt, then tokenizes prompt-plus-label for every answer label.
   A bounded exact compilation cache can retain already verified boundaries.
   Within-request shared-prefix KV reuse and suffix batching already exist. The
   prior CPU prefix-cache experiment failed its numerical parity tolerance after
   three controls; its performance gate did not run.

## Recommended sequence

Finish the current 1B student's export and unchanged full validation; separately
measure compilation overhead; test one fixed Gemma-feature routing hypothesis;
then run the complete paired Pi task protocol with the user's normal
`llmgw/gpt-5.6-sol` registration. The user confirmed that alias maps to an OpenAI
model. Its exact upstream version remains unspecified, and no gateway inference
has occurred in this project.

All additional helper computation, turns, failures, retries, and cleanup belong
to the assisted arm. Keep complete-task correctness and the existing 20% latency
or 30% generative-work conditions. Current reviewed Gemma lineage remains the
model basis for local classifier experiments.

A focused context-compression experiment is also a candidate: preserve concise
evidence from large completed tool results while retaining an accessible original
and unresolved work. The user selected their existing llmgw Grok 4.6 model as an
independent judge of context preservation. This selection is recorded here;
compression implementation and judge inference have not been performed at this
checkpoint. Actual token savings and downstream task correctness remain separate
acceptance requirements.

## Evidence locations

- Prior archive terminal summaries: lines 17323 and 17335.
- Actual HTTP qualification and canonical acceptance: archive lines 10910 and 10951.
- Actual Pi confirmation: archive lines 11532 and 11551.
- Completed rejected cascade: archive line 17291.
- Prior worktree: `/Users/bsonntag/.codex/worktrees/local-jev-model-routing/sf-pi`.
- Within it: `extensions/sf-model-router/service/EVALUATION.md`,
  `proofs/luna-low-v3-pilot-confirmation-execution-rejected.json`,
  `proofs/gemma3-last-token-feature-development-feasibility.json`, and
  `proofs/gemma-native-cache-cpu-rejected.json`.
- Current TypeScript sources: `native/main.cpp`, `src/automation.ts`,
  `src/backend.ts`, and `src/core.ts`; current outcomes: `EXPERIMENTS.md`.
