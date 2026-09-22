# Candidate 8 TRAIN-CAL scorer

`scripts/guardrail-candidate8-cal-score.mjs` scores the 47 admitted calibration rows after the Candidate 8 FIT run exports a GGUF. It reads the exact FIT and TRAIN-CAL partitions and admission receipt. It does not read VALID or TEST, derive baseline actions, select a cutoff, or qualify enforcement.

The scorer requires the original local admission receipt with SHA-256 `c5203e21a9fdad729e6cddd166f923a671654b0968f89d330992f1ca6558f680`. The committed TRAIN-CAL and FIT copies are independently pinned to `7371877d67874e8d55c418b678d9d808207bb4e645d1868d4e44ad8d5d57144f` and `17f6672fffe913aacdbf44394119bc0b14fbab5db4cc87fccf21c66da449cdc5`. The scorer verifies that all 47 admitted requests match the Jev prompt protocol before any model call.

After export, run from this worktree with absolute paths:

```sh
node scripts/guardrail-candidate8-cal-score.mjs \
  --admission /path/to/candidate-8-admission-fit-v1/receipt.json \
  --fit-plan /path/to/candidate-8-rfdt-RUN/candidate8-fit-plan.json \
  --artifact-manifest /path/to/candidate-8-rfdt-RUN/artifact.json \
  --registry /path/to/candidate-8-rfdt-RUN/candidate-registry.json \
  --model-file /path/to/candidate-8-rfdt-RUN/model.gguf \
  --model-id jev/CANDIDATE_ID \
  --native-binary /path/to/jev-native \
  --baseline-sha256 HOST_BASELINE_SHA256 \
  --policy-sha256 HOST_POLICY_SHA256 \
  --output /path/to/new/train-cal-score.json
```

The `baselineSha256` and `policySha256` values are opaque host identity pins supplied by the separate sf-pi TRAIN-CAL replay. This scorer never opens its baseline actions. It hashes the actual model and native binary, verifies the RFDT export manifest and FIT-only run metadata, warms the worker separately, then sends each `request.state` through `classifyGuardrailRisk` in ID order. Each record contains its group, rubric label, exact input hash, uncalibrated allow score, answer status, and elapsed check time. Cold initialization is logged separately. The output is written exclusively; an incomplete call or worker failure produces a 47-row `candidate8_train_calibration_attempt` receipt that cutoff selection must reject.

`node --test tests/guardrail-candidate8-cal-score.test.mjs` exercises the scoring path with a fake classifier and makes no model call. Set `C8_ADMISSION_FILE` to the pinned local receipt to also check the admitted FIT/CAL bytes.
