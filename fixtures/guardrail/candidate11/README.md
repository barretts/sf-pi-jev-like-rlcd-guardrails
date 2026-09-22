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

[The separate fresh C11 entry](../../../rfdt/c11_cuda_campaign.py) and [pinned 327-FIT config](cuda-campaign-327-fit.json) can exercise the prospective sampler on unchanged admitted data, with zero dependency on this optional 24-row supplement. The experiment is explicitly C11, starts on original Google Gemma with new LoRA and empty optimizer, and retains FP32/loss/prompt/batch/memory/reload settings. Nine campaign tests plus six sampler tests pass on CPU. No GPU launch occurred. Before any launch, the intended direct command requires the existing independent **8 GB incremental / 16 GB total dedicated-memory watchdog** and **root-owned control supervision**; this entry alone is not a supervised shared-GPU launch path. The isolated C11 compatibility branch extends the existing explicit launcher/importer/local profile handling; the active C10 worktree and frozen C10 campaign remain untouched. No Mac model speed benchmark is performed while the native checkpoint pipeline needs the Mac. The intended command and exact hashes are in `/private/tmp/c10-fit-learning-assessment.md`.

```sh
python3 -B -m unittest discover -s rfdt -p 'test_c11_fit_sampler.py' -v
python3 rfdt/c11_fit_sampler_diagnostic.py \
  --source-fit reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/fit.jsonl \
  --prepared-fit /private/tmp/simple-jev-ts-c9-cuda-port-20260922/.build/guardrail/candidate-10-prepare-smoke-v1/train.jsonl \
  --pairs reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/pairs.json \
  --families reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/families.json \
  --draft fixtures/guardrail/candidate11
```


## Explicit C11 launch/import/export compatibility

The real 327-FIT campaign is `cuda-campaign-327-fit.json`, separate from the inactive optional-supplement draft. Its exact campaign digest is pinned by `rfdt/c11_cuda_campaign.py`. Its source pins cover the shared objective/contract worker and C11 sampler; the external launcher code map separately pins the C11 campaign module, avoiding a circular campaign/worker hash. Every imported checkpoint must retain the original source objective as `source_objective_plan` and the exact derived C11 objective, fresh-base initialization, sampler identity, and existing reload proof. Checkpoints remain 128/256/512/1024, with 327 rows, 86 pairs, effective batch 8, the unchanged symmetric loss, and zero validation/test training rows.

Root stages a fresh inputs directory using the existing shape: `base/`; `fit/prepared-train.jsonl`, `fit/pairs.json`, `fit/families.json`; `code/objective-plan-B.json`; and the C11 campaign bytes under `code/cuda-campaign.json`. The selected external code map pins exactly `c11_cuda_campaign.py`, `c11_fit_sampler.py`, `cuda_worker.py`, `worker.py`, `gemma3_fp32.py`, and `cuda_memory_monitor.py`. Root separately pins the staged producer `cuda_campaign_launch.py`. The producer lazily imports only the selected campaign, so neither minimal candidate inventory depends on the other candidate's module.

Only root may execute the future commands below. There was no C11 GPU/model run during compatibility implementation. Root must attach the independent control guard immediately after its own launch, pin the produced `launch.json`, retain control of the process handles, and stop the identified worker if attachment fails. The guard captures this launch's actual worker/watchdog birth ticks and exact commands; it imports no C10 PID, birth-tick, or path constant. It stops only its identified worker through pidfd TERM, confirmed wait, then KILL and confirmed wait if required. It also stops on a missing, invalid, errored, or stale watchdog. The existing 8 GB incremental hard budget, 7.5 GB dedicated-delta stop, 6.5 GB allocator cap, 128 MB shared-growth stop, and 16 GB total dedicated stop stay unchanged.

```sh
python3 code/cuda_campaign_launch.py \
  --candidate candidate11 --inputs FRESH_C11_INPUTS \
  --code-sha256-json ROOT_PINNED_CODE_MAP --run-root FRESH_C11_RUN \
  --adapter-tag ROOT_PINNED_ADAPTER --mode probe
python3 code/cuda_campaign_launch.py supervise \
  --run-root FRESH_C11_RUN --launch-sha256 ROOT_PINNED_LAUNCH_SHA256
```

A successful probe is not training or qualification. A separately authorized fresh training run uses `--mode train` and the same supervision contract. At an admitted completed checkpoint, root uses the existing `snapshot` subcommand to retain the complete bound watchdog-journal prefix after a post-completion sample. Root assembles a fresh import snapshot with the selected checkpoint's `plan.json`, `receipt.json`, `exit.json`, `reload.json`, `fit-margins.jsonl` and `adapter/` under `run/`, plus the original `launch.json` and the snapshot's `memory.jsonl`, `memory.summary.json` and `memory.snapshot.json`. The importer checks campaign/source/producer/helper identity, receipt pin, full journal statistics and timestamp bracketing before importing.

```sh
python3 code/cuda_campaign_launch.py snapshot \
  --run-root FRESH_C11_RUN --checkpoint FRESH_C11_RUN/run/checkpoints/step-128 \
  --output FRESH_MEMORY_SNAPSHOT
node scripts/guardrail-candidate11-local-checkpoint.mjs \
  --run FRESH_LOCAL_C11_RUN --fit ADMITTED_FIT --cuda-run ROOT_STAGED_IMPORT_SNAPSHOT \
  --receipt-sha256 ROOT_PINNED_CHECKPOINT_RECEIPT --base-hf ORIGINAL_GOOGLE_BASE \
  --base-gguf APPROVED_BASE_GGUF --native-binary ROOT_PINNED_NATIVE \
  --python APPROVED_MLX_PYTHON --checkpoint 128 --model-id jev/c11-step-128
```

Local import and fusion expand the complete floating base tree to FP32 before LoRA loading and use the same unchanged embedding-scale helper bytes/digest. CUDA retains FP32 base/LoRA, eager attention, and matmul/cuDNN TF32 off; the local MLX attention/norm/GELU paths are unchanged. Reload margin tolerance remains 1e-5, and CUDA-to-MLX/F16 probability delta and decisive-flip gates remain 0.05, margin 0.5, zero flips. The F16 handoff uses existing preparation/import/export/precision APIs and is independent of a later retained Q8 attempt. No precision gate is loosened by a Q8 failure.

Focused CPU/stdlib mocks cover minimal selected staging, all four checkpoint launch/snapshot/import attestations, source and memory tampering, PID birth/command identity, confirmed stops, complete-tree FP32 ordering during load/fusion, and the C11 local F16 API sequence. These establish compatibility only. Root launch/attachment, real C11 training and saved reload, local numerical equivalence, F16 and Q8 precision, guarded CAL-to-VALID evaluation, TEST qualification, host latency/safety, and enforcement authorization remain separate proof gates. No CAL/VALID/TEST case body or prediction is exposed to training authors.
