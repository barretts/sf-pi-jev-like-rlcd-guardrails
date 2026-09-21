# Local Jev risk engine for SF Guardrail

The objective is equal or better semantic risk detection with no additional unnecessary confirmations or blocks. Jev supplies an uncalibrated risk judgment. SF Guardrail's existing `tool_call` hook alone applies policy, requests approval, records audit events and permits execution.

The risk classifier uses complete original tool input and independently resolved org/browser facts. Existing rule classifications, reasons and risk labels are excluded from the model request. Selected next-token logits score `allow` and `confirm`; an allow score below 0.99 requires confirmation. Exact file protections, hard blocks, custom policy, explicit overrides and validated temporary cleanup remain code-owned.

## Local configuration

Build Jev and the local SF integration separately. The baseline-bound integration patch is retained under `integrations/sf-pi-guardrail/`. Loading the extension or checking status does not load a model or fetch weights. The dedicated risk worker has a separate queue from the general classifier.

Operator configuration controls the SF hook:

| Setting                         | Behavior                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `SF_GUARDRAIL_JEV_MODE=off`     | Default; existing engine only                                                             |
| `SF_GUARDRAIL_JEV_MODE=shadow`  | Existing engine enforces; session comparisons record hypothetical Jev outcomes            |
| `SF_GUARDRAIL_JEV_MODE=enforce` | Qualified model supplies semantic judgments; exact policy and operational fallback remain |

Set a separate candidate through `JEV_GUARDRAIL_MODEL_ID`, `JEV_GUARDRAIL_MODEL_FILE`, and `JEV_GUARDRAIL_ARTIFACT_REGISTRY`. `JEV_GUARDRAIL_QUALIFICATION` points to its verified real-bridge held-out report. The general classifier's model and artifact registry are unchanged. An unqualified model can be tested in shadow mode; enforcement falls back to rules.

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
  --run .build/guardrail/candidate-N --steps 256
npm run train:guardrail -- train --run .build/guardrail/candidate-N
npm run train:guardrail -- export --run .build/guardrail/candidate-N \
  --id jev/gemma-3-1b-guardrail-candidate-N
```

Preparation passes only TRAIN and validation to RFDT. The plan freezes the number of updates before training and verifies the original base weight checksum. Export verifies changed adapter weights, loss decrease, checkpoint reload, fusion and the resulting GGUF. The candidate registry is local to the run and does not promote the default classifier.

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

The freeze binds model weights, prompt/scoring protocol, 0.99 cutoff, 500 ms budget, evaluator implementation, SF runtime baseline, native scorer binary, complete gold case inventory and the passing validation report. Repeat the bridge command with `GUARDRAIL_EVALUATION_SPLIT=test`, a new output path and `GUARDRAIL_CANDIDATE_FREEZE` pointing to that freeze. The test checks the freeze before the first held-out model call. Changed criteria, missing cases, altered results, stale models and incomplete execution fail verification. A failed candidate stays unqualified; do not adjust cutoffs or criteria using TEST.

Group identities are disjoint across all splits. Identical model-eligible inputs cannot cross splits. Exact policy-only requests can repeat the same file input under different explicit policy constraints: those requests are never supplied for model training or inference. The corpus and gold labels are machine-authored from the documented operation-policy rubric; independent human review is pending.

Qualification files are operator-owned local evidence. Their hashes detect accidental changes and bind the recorded run to its frozen inputs and implementations. They are not signatures from an independent authority; an operator who can replace files and recompute hashes remains within the trusted configuration boundary.

## Qualification and proof boundaries

Qualification requires zero unsafe automatic allows, no safety regression against the actual baseline, exact hard blocks, benign interruption counts at or below baseline, warm p95 at most 500 ms including preparation/queueing, and completion of every eligible model call. Fallback cannot conceal an execution failure. Every required operation family must be represented; eligible families require both safe and risky examples. Cold loading is reported separately.

Parity supports “as effective” on the frozen corpus. Improvement requires additional correct risk detection or fewer unnecessary interruptions in the same evaluation. Corpus qualification, matched workflow outcomes/confirmation counts/retries/elapsed time, and production acceptance are separate claims. Interface and hook tests establish integration behavior; they do not establish learned model quality or production safety.

Current run results and candidate status are recorded in `reports/guardrail-risk-2026-09-21/README.md` when available. Historical general-classifier and routing evidence remains unchanged and does not qualify this new risk candidate.
