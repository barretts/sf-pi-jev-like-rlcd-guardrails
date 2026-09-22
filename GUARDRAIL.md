# Local Jev risk engine for SF Guardrail

The objective is equal or better semantic risk detection with no additional unnecessary confirmations or blocks. Jev supplies an uncalibrated risk judgment. SF Guardrail's existing `tool_call` hook alone applies policy, requests approval, records audit events and permits execution.

The risk classifier uses complete original tool input and independently resolved org/browser facts. Existing rule classifications, reasons and risk labels are excluded from the model request. Selected next-token logits score `allow` and `confirm`; an allow score below 0.99 requires confirmation. Exact file protections, hard blocks, custom policy, explicit overrides and validated temporary cleanup remain code-owned.

## Local configuration

Build Jev and the local SF integration separately. The baseline-bound integration patch is retained under `integrations/sf-pi-guardrail/`. Registration and cached status checks do not load a model or fetch weights. With the default `off` mode, session startup also stays lazy. The dedicated risk worker has a separate queue from the general classifier.

Operator configuration controls the SF hook:

| Setting                         | Behavior                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `SF_GUARDRAIL_JEV_MODE=off`     | Default; existing engine only                                                             |
| `SF_GUARDRAIL_JEV_MODE=shadow`  | Existing engine enforces; session comparisons record hypothetical Jev outcomes            |
| `SF_GUARDRAIL_JEV_MODE=enforce` | Qualified model supplies semantic judgments; exact policy and operational fallback remain |

Set a separate candidate through `JEV_GUARDRAIL_MODEL_ID`, `JEV_GUARDRAIL_MODEL_FILE`, and `JEV_GUARDRAIL_ARTIFACT_REGISTRY`. `JEV_GUARDRAIL_QUALIFICATION` points to its verified real-bridge held-out report. The general classifier's model and artifact registry are unchanged. An unqualified model can be tested in shadow mode; enforcement falls back to rules.

When Jev is enabled and the operator mode is exactly `shadow` or `enforce`, the general Jev extension awaits risk-worker warmup during `session_start`, before tool requests begin. Enabling Jev or changing its prompt template also awaits retirement and warmup. Cold initialization is separate from the 500 ms warm risk-check budget. Startup failures remain visible in provider status and leave SF's rule fallback available. Opt-in startup does not initialize the general classifier, score a tool request or grant approval.

Pi print and RPC modes await extension binding. API embeddings must also call and await `AgentSession.bindExtensions`; creating a session alone does not run `session_start`. In a headless embedding, inspect the returned Jev runtime's `guardrailRisk.status()` after binding for readiness and initialization failures. The slash commands use Pi's UI notification surface, which provides no visible output in headless mode.

`/jev-risk status` displays cached provider readiness and qualification. `/jev-risk warmup` explicitly verifies and loads the candidate. `/sf-guardrail risk` displays session comparisons and operational fallback reasons. Failed requests, missing facts, unavailable models, invalid responses and timeouts retain the existing engine's decision. A valid uncertain judgment requires approval. Model-derived approvals bind the complete operation, active policy, model and scoring protocol. Disable and shutdown dispose owned workers.

## Reproduce training and evaluation

Use the reviewed original Google Gemma 3 1B Instruct checkpoint at `dcc83ea841ab6100d6b47a070329e1ba4cf78752`, the pinned RFDT runtime and llama.cpp converter. Do not use historical adapters, teachers or alternate model lineages. Qwen and Chinese-lineage models, derivatives, teachers, fallbacks and tests remain excluded.

The authored operation corpus is under `fixtures/guardrail/`. Labels follow its explicit policy rubric. The SF baseline exporter executes the actual Safety Kernel with controlled org and browser facts and mocked execution. It does not execute destructive commands or external mutations. Related syntax variants share a group and split; TRAIN, validation and TEST remain separate.

From the SF integration checkout, export the baseline with the dedicated corpus test. Set `JEV_REPO` to the absolute Jev checkout path and use an isolated `PI_CODING_AGENT_DIR`:

```sh
PI_CODING_AGENT_DIR="$PWD/.build/corpus-test-agent" \
GUARDRAIL_CORPUS_PATH="$JEV_REPO/fixtures/guardrail/corpus.json" \
GUARDRAIL_BASELINE_OUTPUT="$JEV_REPO/.build/guardrail/baseline.json" \
npm test -- extensions/sf-guardrail/tests/guardrail-corpus.test.ts --maxWorkers=1
```

From Jev, prepare a new run with a unique path:

```sh
npm run build
npm run train:guardrail -- prepare --bundle /absolute/path/baseline.json \
  --checkpoint /absolute/path/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752 \
  --run .build/guardrail/candidate-N --steps 1536
npm run train:guardrail -- train --run .build/guardrail/candidate-N
npm run train:guardrail -- export --run .build/guardrail/candidate-N \
  --id jev/gemma-3-1b-guardrail-candidate-N
```

Preparation passes only TRAIN and validation to RFDT. The plan freezes the number of updates before training and verifies the original base weight checksum. Export verifies changed adapter weights, loss decrease, checkpoint reload, fusion and the resulting GGUF. The candidate registry is local to the run and does not promote the default classifier.

Candidate 2's 256-update run failed validation usability. Candidate 3 completed 1,536 fixed updates and fit all 252 TRAIN decisions, but failed native bridge validation on unsafe allows, safety regressions and unnecessary interruptions. Candidate 4 is running the same fixed 1,536-update profile with 48 additional TRAIN counterfactuals; validation is unchanged and RFDT preparation contains no TEST rows. Its outcomes remain pending. Training fit does not qualify a model; every validation and held-out gate must still pass.

`eval:guardrail` can produce direct-classifier diagnostics. These cannot qualify enforcement: real SF bridge validation must include preparation and queueing, and all eligible model calls must finish. Run bridge validation from the SF checkout, with `JEV_GUARDRAIL_MODEL_FILE` set to the exported artifact path printed by the previous command:

```sh
PI_CODING_AGENT_DIR="$PWD/.build/corpus-test-agent" \
GUARDRAIL_CORPUS_PATH="$JEV_REPO/fixtures/guardrail/corpus.json" \
GUARDRAIL_BASELINE_OUTPUT="$JEV_REPO/.build/guardrail/baseline.json" \
GUARDRAIL_JEV_ROOT="$JEV_REPO" \
GUARDRAIL_EVALUATION_SPLIT=validation \
GUARDRAIL_EVALUATION_OUTPUT="$JEV_REPO/.build/guardrail/candidate-N/bridge-validation.json" \
JEV_GUARDRAIL_MODEL_ID=jev/gemma-3-1b-guardrail-candidate-N \
JEV_GUARDRAIL_MODEL_FILE=/absolute/path/to/exported-candidate.gguf \
JEV_GUARDRAIL_ARTIFACT_REGISTRY="$JEV_REPO/.build/guardrail/candidate-N/candidate-registry.json" \
npm test -- extensions/sf-guardrail/tests/guardrail-corpus.test.ts --maxWorkers=1
```

Only a candidate passing every validation gate may be frozen for TEST from Jev:

```sh
npm run eval:guardrail -- freeze --bundle /absolute/path/baseline.json \
  --validation /absolute/path/bridge-validation.json \
  --output .build/guardrail/candidate-N/freeze.json
```

The freeze binds model weights, prompt/scoring protocol, 0.99 cutoff, 500 ms budget, evaluator and scoring-client module bytes, SF runtime baseline, native scorer binary, complete gold case inventory and the passing validation report. The client binding includes the backend, model loader and guardrail provider, so rebuilding changed scoring or model-loading code invalidates an old receipt. Repeat the bridge command with `GUARDRAIL_EVALUATION_SPLIT=test`, a new output path and `GUARDRAIL_CANDIDATE_FREEZE` pointing to that freeze. The test checks the freeze before the first held-out model call. Changed criteria, missing cases, altered results, stale models and incomplete execution fail verification. A failed candidate stays unqualified; do not adjust cutoffs or criteria using TEST.

The validation measurement seal includes the same implementation hash. A code change after validation requires fresh validation before freezing; an old validation report cannot be attached to a new freeze. Historical rejected reports retain their original seals and results.

Group identities are disjoint across all splits. Identical model-eligible inputs cannot cross splits. Exact policy-only requests can repeat the same file input under different explicit policy constraints: those requests are never supplied for model training or inference. The corpus and gold labels are machine-authored from the documented operation-policy rubric; independent human review is pending.

Qualification files are operator-owned local evidence. Their hashes detect accidental changes and bind the recorded run to its frozen inputs and implementations. They are not signatures from an independent authority; an operator who can replace files and recompute hashes remains within the trusted configuration boundary.

## Reproduce matched Pi workflows

The SF integration's SDK test has an optional real-model workflow arm. It registers the general Jev driver, awaits normal `AgentSession.bindExtensions`/`session_start`, and then uses `AgentSession.prompt`, the existing guardrail hook, and registered counter-only tools. The assistant requests and user choices are scripted; org facts are mocked. The frozen workflows cover safe reads and harmless quoted commands, identical shell and Apex requests, a Data 360 rehearsal/live pair, and an explicit protected-path block. They are authored independently of held-out test results.

Run this from the SF integration checkout after the candidate has finished training and export. Avoid concurrent model or training work when measuring latency. Supply a new report path:

```sh
PI_CODING_AGENT_DIR="$PWD/.build/sdk-proof-agent" \
SF_DISABLE_LOG_FILE=true \
JEV_DEVICE=metal \
GUARDRAIL_SDK_LOCAL_MODEL=1 \
GUARDRAIL_SDK_LOCAL_JEV_MODULE="$JEV_REPO/dist/extension.js" \
GUARDRAIL_SDK_LOCAL_MODEL_ID=jev/gemma-3-1b-guardrail-candidate-N \
GUARDRAIL_SDK_LOCAL_MODEL_FILE=/absolute/path/to/exported-candidate.gguf \
GUARDRAIL_SDK_LOCAL_ARTIFACT_REGISTRY="$JEV_REPO/.build/guardrail/candidate-N/candidate-registry.json" \
GUARDRAIL_SDK_LOCAL_QUALIFICATION="$JEV_REPO/.build/guardrail/candidate-N/bridge-test.json" \
GUARDRAIL_SDK_LOCAL_OUTPUT="$JEV_REPO/.build/guardrail/candidate-N/sdk-workflows.json" \
npm test -- --run extensions/sf-guardrail/tests/jev-risk-sdk.test.ts \
  -t 'compares frozen representative SDK workflows with the actual local Jev model provider'
```

Omit `GUARDRAIL_SDK_LOCAL_QUALIFICATION` for an unqualified candidate: the arm runs only `off` and `shadow` and records that enforcement was omitted. A supplied receipt must pass the real provider's verification and match the current SF runtime before `enforce` runs. The explicit model flag makes missing artifacts fail preflight; ordinary source tests skip this arm without loading a model.

The report records accepted operation outcomes, confirmation choices and counts, session grants, retries, errors, comparisons, fallback reasons, and complete per-call audit entries. Baseline `off` stays lazy and has no model startup. Shadow and enforcement warm their owned worker through awaited session startup, with no manual provider warmup. SDK setup ends before extension binding; `sessionStartMs` includes all startup handlers. For opt-in model modes, `localRiskColdInitializationMs` is that inclusive startup duration, including artifact/model initialization and other handlers; it is null for off. Warm workflow time and total elapsed time remain separate. Scripted approval selection adds no human deliberation time. Shadow must preserve the baseline's outcomes and approvals. Current conservative model session handling may add a confirmation for repeated shell requests; the collector exposes this limitation rather than asserting prompt parity.

## Qualification and proof boundaries

Qualification requires zero unsafe automatic allows, no safety regression against the actual baseline, exact hard blocks, benign interruption counts at or below baseline, warm p95 at most 500 ms including preparation/queueing, and completion of every eligible model call. Fallback cannot conceal an execution failure. Every required operation family must be represented; eligible families require both safe and risky examples. Cold loading is reported separately.

Parity supports “as effective” on the frozen corpus. Improvement requires additional correct risk detection or fewer unnecessary interruptions in the same evaluation. Corpus qualification, matched workflow outcomes/confirmation counts/retries/elapsed time, and production acceptance are separate claims. Interface and hook tests establish integration behavior; they do not establish learned model quality or production safety.

Current run results and candidate status are recorded in `reports/guardrail-risk-2026-09-21/README.md` when available. Historical general-classifier and routing evidence remains unchanged and does not qualify this new risk candidate.
