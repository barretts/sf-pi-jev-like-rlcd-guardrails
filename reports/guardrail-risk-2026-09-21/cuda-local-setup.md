# Local use of a CUDA-trained guardrail candidate

The CUDA training run is isolated from other sessions on the Windows host. Local import uses an explicit completed-run receipt pin and preserves the Google Gemma 3 base, revision, original FIT prompts, objective, and CUDA provenance. It does not select or enable a model.

Prepare a new FIT-only local RFDT run with the frozen C9 compiler settings. Copy only this job's completed CUDA receipts, adapter, and FIT margins into a new local source directory. The source directory must retain `launch.json`, `memory.summary.json`, and `run/{plan.json,receipt.json,exit.json,fit-margins.jsonl,adapter/}`. Do not copy another session's files or sealed evaluation splits.

```sh
node dist/cli.js rfdt import-cuda \
  --run /absolute/new-local-prepared-run \
  --cuda-run /absolute/copied-cuda-run \
  --receipt-sha256 THE_SHA256_OF_RUN_RECEIPT_JSON \
  --model-path /absolute/pinned-gemma-base \
  --python /absolute/local-rfdt-python

node dist/cli.js rfdt export \
  --run /absolute/new-local-prepared-run \
  --model jev/gemma-3-1b-guardrail-cuda-candidate \
  --model-path /absolute/pinned-gemma-base \
  --python /absolute/local-rfdt-python
```

Import rejects incomplete/probe runs, changed source identities, invalid tensor shapes, missing CUDA placement proof, failed memory monitoring, or changed FIT prompts. It reloads the saved adapter through MLX and checks all 327 FIT margins against the CUDA reference. Fixed cross-backend limits are a maximum selected-label probability difference of 0.05 and no sign changes for CUDA margins whose magnitude is at least 0.5. These are bridge checks, not task qualification. A failed attempt is retained, and the run stays prepared.

The existing exporter then fuses the imported adapter in float32 and uses the pinned llama.cpp F16 converter. Create an experimental artifact registry from the verified export descriptor without modifying the default registry. Check the F16 artifact, and again any Q8 artifact, before using its task scores:

```sh
node scripts/guardrail-cuda-export-check.mjs \
  --run /absolute/exported-cuda-run \
  --model-file /absolute/candidate.gguf \
  --model-id jev/gemma-3-1b-guardrail-cuda-candidate \
  --registry /absolute/experimental-registry.json \
  --native-binary /absolute/jev-native \
  --output /absolute/new-precision-report.json
```

This FIT-only check compares native inference at the final exported precision with the local saved-adapter reference, using the same fixed numerical limits. It saves a failing report if inference or equivalence fails. Model qualification still requires the frozen calibration selector, blind validation, selected-candidate freeze, and held-out TEST gates. Enforcement defaults to off and existing rule fallback remains authoritative until qualification passes.

## Implementation validation

The integrated implementation at `dc5428f` passed TypeScript checking, build, formatting, and the full Jev suite: 57 files, 1,109 tests. Five additional Python import tests passed, covering failed/probe runs, changed source identities, absent optimizer placement evidence, memory-limit violations, and fixed numerical comparison limits. The CLI help exposes the import command. These checks establish the implementation contract; acceptance of the actual CUDA adapter and final exported precision requires the separate receipts described above.
