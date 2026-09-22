# Candidate 11 FIT org-fact counterfactual source draft

**Not admitted, not training-ready, not qualified.** These 24 draft RFDT rows form 12 indivisible allow/confirm pairs. They extend only three already-admitted FIT request forms: Account delete through bash, Account REST create through bash, and the same REST create through herdr_pane. The active C10 corpus and run are unchanged.

Each operation gets two neutral aliases (`C11TargetA`, `C11TargetB`) and two misleading aliases (`C11ProdNamed`, `C11SandboxNamed`). Within every pair the entire original tool input is identical. Only independently supplied org facts change between verified sandbox and production. Both misleading aliases occur under both fact scenarios, so the name cannot establish org type. No expected label, existing rule classification, or baseline reason enters the request state.

[fit-counterfactuals.draft.jsonl](fit-counterfactuals.draft.jsonl) preserves the existing FIT request/questions/targets shape. [pairs.draft.json](pairs.draft.json) lists explicit safe/risky members. [source-notes.draft.json](source-notes.draft.json) records source case IDs/lines, label rationale, and pending admission.

## Group ownership and label basis

All four delete pairs retain `c5-draft-diversity-local-salesforce-02`, inherited from admitted FIT lines 94–95. All eight REST create pairs retain `c5-salesforce-rest-account-basic-info`, inherited from FIT lines 100–101 and 103–104. The 12 pairs are therefore **two existing operation groups**, not twelve new independent groups. Every new alias variant must stay with all related original FIT members; never assign these aliases to CAL/VALID/TEST.

The explicit [operation-policy-v2 rubric](../RUBRIC.md) allows Salesforce operations to independently verified nonproduction orgs that the existing operation policy permits, and confirms production durable writes. These labels follow the already-admitted deletion and REST creation interpretations. They do not come from baseline classification or model disagreement. Exact custom policy remains authoritative: an operator block/confirm override, protected-resource constraint, or missing/guessed org resolution invalidates this draft's ordinary-policy allow precondition and must remain host-owned. No custom-policy variation is represented as a semantic-model allow.

## What remains pending

Facts here are **authored mocked independent-host-resolution scenarios**, not live org lookups. The [current frozen C10 host replay](host-fit-replay-c10.draft.json) exercised the real resolver/session fact mechanism using a separate explicit mock scenario catalog; it did not derive org type from alias spelling, tool-supplied facts, targets or baseline decisions. Current C10 host commit `a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a` and runtime `0a23e057fb433fc4ee2ecd42465b377c660db5e024b6a406f6994497eba693b2` prepared all 24 rows with full fact-state parity and rubric consistency: 24 eligible, zero code-owned floors, 12 sandbox allows and 12 production confirms. [The historical C9 replay](host-fit-replay.draft.json) is preserved separately; all per-row statuses/prepared states match for these cases. Complete admission/source review, group/operation overlap clearance, prompt preparation, and a separate future campaign freeze remain required before training. The aliases have not been resolved against a real org, and no Salesforce operation executed.

This draft changes alias context while retaining operation forms, so it addresses shortcut reliance on names and explicit pair training of fact dependence. It adds no new operation coverage and does not establish that accuracy will improve. Source FIT SHA-256 is `8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25`. Only that FIT body and the original rubric were used; no CAL/VALID/TEST case body or prediction was inspected.

A local structural check parsed all 24 rows, verified unique IDs, checked exact tool/input equality within all twelve pairs, checked sandbox/production labels and org facts, and confirmed inherited common group IDs. This check establishes source structure only.

## Prospective FIT sampler

[C11FitSampler](../../../rfdt/c11_fit_sampler.py) covers every explicit pair once, then cycles through inherited operation groups and through pairs within each group. It retains exactly half pair units and the existing singleton label/family/item sampling rules. It is a separate source module; the frozen C10 worker and CUDA campaign remain byte-identical. [Six focused CPU tests](../../../rfdt/test_c11_fit_sampler.py) pass, including coverage, group weight, exact schedule, determinism and malformed pair ownership.

[The sampler diagnostic](../../../rfdt/c11_fit_sampler_diagnostic.py) separately compares unchanged C10 sampling on admitted 327 FIT rows, the prospective sampler on the same 327 rows, and a conditional 351-row source-only combination. The sole AgentScript pair receives 512/4096 pair draws under current C10 and 49/4096 under the prospective policy on the same 327 rows. The conditional 351-row combination gives it 48 draws and covers all 98 explicit pairs by step 128; all 12 new pairs appear then. Full row/pair/group exposure is retained locally in `.build/guardrail/c11-fit-sampler-comparison.json`. This demonstrates coverage, without establishing model improvement or data admission.

[cuda-campaign.draft.json](cuda-campaign.draft.json) fixes prospective fresh-training choices for the optional supplement while remaining inactive: seed 42, FP32, effective batch 8, learning rate 1e-4, the existing symmetric loss and 128/256/512/1024 schedule. It has no admitted prepared/objective hashes and is not accepted by the frozen C10 launcher. Admission and a separate future campaign freeze remain required.

[The separate fresh C11 entry](../../../rfdt/c11_cuda_campaign.py) and [pinned 327-FIT config](cuda-campaign-327-fit.json) can exercise the prospective sampler on unchanged admitted data, with zero dependency on this optional 24-row supplement. The experiment is explicitly C11, starts on original Google Gemma with new LoRA and empty optimizer, and retains FP32/loss/prompt/batch/memory/reload settings. Nine campaign tests plus six sampler tests pass on CPU. No GPU launch occurred. Before any launch, the intended direct command requires the existing independent **8 GB incremental / 16 GB total dedicated-memory watchdog** and **root-owned control supervision**; this entry alone is not a supervised shared-GPU launch path. The unchanged C10 launcher, importer and worker FP32 fusion checks still require C10 identities, so separate authorized staging/compatibility work remains before a complete C11 launch/import/export path. No Mac model speed benchmark is performed while the native checkpoint pipeline needs the Mac. The intended command and exact hashes are in `/private/tmp/c10-fit-learning-assessment.md`.

```sh
python3 -B -m unittest discover -s rfdt -p 'test_c11_fit_sampler.py' -v
python3 rfdt/c11_fit_sampler_diagnostic.py \
  --source-fit reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/fit.jsonl \
  --prepared-fit /private/tmp/simple-jev-ts-c9-cuda-port-20260922/.build/guardrail/candidate-10-prepare-smoke-v1/train.jsonl \
  --pairs reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/pairs.json \
  --families reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/families.json \
  --draft fixtures/guardrail/candidate11
```
