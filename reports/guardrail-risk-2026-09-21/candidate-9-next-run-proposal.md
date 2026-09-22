# Candidate 9: bounded recovery proposal after C8 VALID

**Status:** prospective proposal only. No C9 corpus, model fit, cutoff, or
qualification is claimed here. C8's independent VALID has been consumed for
diagnosis; its case text and labels must not become C9 training examples or a
second qualification set. The existing held-out TEST remains sealed.

## What C8 established

The [C8 real-model VALID report](candidate-8-valid-real-256-evidence/report.json)
evaluated 96 cases under final sf-pi runtime identity
`1e5e8167f25ce8fb440d7bf8054be44a27d67c0fa71272a5558b01204c24bd0e`.
The candidate caught seven risks the rule baseline missed, but it had five
unsafe automatic allows versus the baseline's 11, one regression where the
baseline required confirmation, and 17 benign interruptions versus the
baseline's one. Two of 59 attempted prepared calls hit the 750 ms deadline;
57 returned a model answer. Warm p95 was 534.09 ms and maximum was 751.78 ms.
The exact hard blocks remained intact. C8 therefore fails safety,
interruption, completion, and latency gates; it is not qualified.

The [frozen C8 cutoff receipt](candidate-8-frozen-selection/cutoff-256.json)
already exposed a decisive TRAIN-internal calibration failure: at the
selected cutoff `0.9967565872`, it recorded 14 benign interruptions among 24
safe CAL rows against zero for the rule baseline. It marked the cutoff
`accepted: true` with reason `selected_with_cal_benign_excess`. That allowed a
prospective VALID run despite a predeclared benign-parity veto. C9 must reject
such an arm **before** independent VALID; a research-only score can be reported
separately but cannot be promoted into candidate selection.

The [C8 fit receipt](candidate-8-evidence/train/admission.json) admitted 226
rows in 77 fit groups, with only 31 explicit matched pairs. Several native
lanes had predominantly safe model examples: `sf_soql` 13 allow/one confirm,
`sf_apex` 13/one, and `agentscript_lifecycle` six/zero; the Data 360 tool
family likewise had many safe-only actions and only two `data360_api` confirm
rows. The [training report](candidate-8-evidence/runs/256/training-report.json)
shows fit loss dropping from 11.55 to 0.027 over 256 updates, without the
needed calibration separation. Additional steps alone are not a supported
remedy. In VALID, unsafe allows clustered in Salesforce CLI (one), Data 360
(two), and SOQL (two); safe interruptions clustered in shell, `herdr_pane`,
Salesforce CLI, Canvas, and browser. Safe and risky scores overlap within
lanes, so moving the single global cutoff cannot fix both errors.

## Proposed C9 run contract

1. **Data and review.** Retain admitted C7/C8 TRAIN groups after source and
   host revalidation. Prior C8 CAL may enter C9 _fit_ after the new split is
   sealed; it cannot serve as C9 cutoff calibration. Author new examples from
   the operation-policy rubric and tool contracts, without viewing or copying
   C8 VALID case bodies. For each model-eligible lane—shell, `herdr_pane`,
   Salesforce CLI, Data 360, SOQL, Canvas, and browser—target at least ten
   new fit matched safe/risky groups and three group-disjoint CAL matched
   groups. A lane whose risky operations are wholly code-owned floors instead
   gets safe model controls plus separate floor tests, rather than fake model
   negatives. Vary syntax, indirect effects, target-org facts, quoted harmless
   text, and missing/stale facts across complete groups. Review every label
   against the rubric independently of the baseline and model.
2. **Objective.** Freeze at most two 256-update arms from the same reviewed
   Google Gemma 3 1B base, with no Qwen or Chinese-lineage model, derivative,
   teacher, or fallback. Arm A uses C8's paired objective on the expanded
   corpus; arm B uses family-and-label-balanced sampling and equal-weight
   selected-token cross-entropy plus symmetric safe/risky logit anchors and
   explicit matched-pair separation. A fixed starting specification for arm B
   is half of draws from explicit pairs, equal sampling across eligible
   families and labels, cross-entropy weight 1, anchor weight 1 with
   `d_safe >= 2` and `d_risky <= -2`, and pair weight 0.5 with
   `d_safe - d_risky >= 4`, where `d` is the selected allow-minus-confirm
   logit. Pair IDs must name one reviewed controlled-risk change, never all
   same-group cross-products. Freeze
   sampler, weights, margins, seeds, prompt, host, and schedule before fit.
   Compare arms only on a new TRAIN-internal, group-disjoint C9 CAL set.
3. **CAL veto and cutoff.** Replay normal rules with independently supplied
   facts on the final C9 host, pinning per-case decisions and policy/runtime
   hashes. For each arm, use only C9 CAL logits to choose the smallest cutoff
   above every risky CAL score with the prespecified margin. Reject if no
   cutoff also keeps safe CAL interruptions at or below that same host's
   measured baseline, if any risky CAL case auto-allows, if any eligible call
   lacks a model answer, or if a code-owned floor weakens. An arm that fails
   this veto does not see C9 VALID for selection. Report calibration counts
   even when every arm is rejected.
4. **Fresh qualification boundary.** Independently author and seal a new C9
   VALID population before fitting, targeting at least 140 cases in 70
   complete groups, with new operation templates and whole groups disjoint
   from fit/CAL and C8 VALID. Include prepared safe and risky cases in every
   lane where both routes exist; cover safe-only model lanes,
   hard blocks, code floors, unavailable providers, and missing/stale facts
   separately. Screen only aggregate overlap after TRAIN freezes. Select at
   most one CAL-passing arm using this VALID set and the existing gates: zero
   unsafe automatic allows, no safety regression or hard-block demotion,
   benign interruptions no higher than the baseline, all eligible model
   calls answered, independent label review complete, warm p95 ideally at most
   500 ms, and every warm call below the 750 ms hard deadline. Do not open
   held-out TEST until weights, cutoff, host, and criteria are frozen and
   VALID passes.

## Latency work before C9 VALID

The two deadline misses were the first two post-warmup model requests **and**
the largest operations, about 7 KB each. A 5.5 KB operation later answered in
485 ms. A matched fake-provider run took 52 ms and 6 ms on the two large
requests, pointing toward the model/worker path, but the current receipt does
not isolate queue, tokenization, prompt prefill, or decode. Add evaluator-only
phase timing and token counts keyed by operation hash. Benchmark a fixed
inference probe during warmup and synthetic short/long inputs with the
complete original request preserved; count probe cost as cold initialization.
Then run the unchanged spent C8 VALID population once as a _performance
diagnostic only_, followed by fresh C9 VALID for qualification. Do not solve
the miss by truncating input, declaring long operations ineligible, or raising
the outer 750 ms deadline.
