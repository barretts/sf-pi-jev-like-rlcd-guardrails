# sf-pi-jev-guardrails training and F16 export

Run the relative `training/` and `scripts/` commands below from the repository root on the appropriate machine; the CUDA host needs this extracted repository or equivalent verified staged code.

This folder retains the current C11 recipe and its fixed, admitted 327-row FIT population: 86 explicit allow/confirm pairs and 133 operation groups. The prepared prompts are the exact TRAIN-only bytes used by the original campaign. There are no validation, TEST, teacher-generated, or draft supplement rows in training. Input files preserve their original IDs and provenance fields unchanged.

The recipe starts from the original Google `google/gemma-3-1b-it` revision `dcc83ea841ab6100d6b47a070329e1ba4cf78752`, with fresh rank-16 q/v LoRA and an empty optimizer. It uses FP32 base/LoRA, eager attention, TF32 off, seed 42, effective batch 8, learning rate `1e-4`, the symmetric row/pair objective, and the C11 pair/group sampler. The schedule is 1024 updates with checkpoints at 128, 256, 512 and 1024. The original selected Desktop model is step 256; its historical run stopped at step 664. New outputs remain unqualified and never replace the pinned current model automatically.

`provenance/` preserves original source fingerprints and unchanged step-256 producer receipts. Those hashes describe the original producer. `recipe.json` and `code-sha256.json` contain fresh fingerprints for this extracted implementation. The existing Desktop model remains independent of this training folder.

## Verify and stage

From the repository root, `npm run build` compiles the small TypeScript orchestration layer. These checks load no model and start no training:

```sh
npm run verify:guardrail
npm run train:guardrail -- --check
npm run train:guardrail -- --check --base-hf .build/huggingface/hub/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752
```

Stage inputs in a fresh directory on the machine that will run CUDA. Staging verifies and copies the original base files, frozen FIT inputs, recipe and selected implementation. It does not connect to another machine or launch a GPU process. The original base GGUF is unnecessary because the exact prepared FIT token IDs are retained; training and import independently verify them against the original HF tokenizer.

```sh
npm run train:guardrail -- --base-hf /absolute/original-google-snapshot --stage /absolute/fresh-inputs
```

The staging receipt is `fresh-inputs/stage.json`. It includes the recipe SHA-256 and each base/input/code identity. Use the SHA-256 from that receipt for the launch below.

## Supervised CUDA execution

`requirements-cuda.txt` records the last documented Windows/WSL CUDA profile: PyTorch `2.10.0+cu128` and CUDA 12.8. The original C11 producer receipts omitted library versions, so this file is not proof of their exact environment. New runs verify the declared profile and record actual runtime versions. Local export uses the separately pinned MLX environment and PyTorch `2.11.0` converter.

Run these commands only on an authorized CUDA host. Supply that host's GPU adapter tag. A probe performs one update and cannot serve as a training checkpoint. A training launch needs its independent supervisor attached immediately; preserve the process handles and stop the identified worker if attachment fails.

```sh
python3 training/launch.py --inputs /absolute/fresh-inputs --recipe-sha256 RECIPE_SHA256 --run-root /absolute/fresh-run --adapter-tag GPU_ADAPTER_TAG --mode train
python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())" /absolute/fresh-run/launch.json
python3 training/launch.py supervise --run-root /absolute/fresh-run --launch-sha256 LAUNCH_JSON_SHA256
```

The worker and watchdog remain distinct. Supervision binds their exact commands and process birth identity and confirms stops. Memory limits remain 8 GB incremental, 6.5 GB allocator, 7.5 GB dedicated-delta stop, 128 MB shared-growth stop, and 16 GB total dedicated stop. Missing, invalid, errored or stale monitoring stops the identified worker.

After an admitted checkpoint completes and both a subsequent watchdog sample and a healthy supervisor observation covering it are available, capture a fresh ready-to-import snapshot:

```sh
python3 training/launch.py snapshot --run-root /absolute/fresh-run --checkpoint /absolute/fresh-run/run/checkpoints/step-256 --output /absolute/fresh-snapshot
```

For a completed 1024-step campaign, wait for the worker, watchdog and independent supervisor to finish successfully, then create the final snapshot with the actual terminal receipts:

```sh
python3 training/launch.py snapshot --run-root /absolute/fresh-run --checkpoint /absolute/fresh-run/run/checkpoints/step-1024 --output /absolute/fresh-final-snapshot
```

The final route retains the campaign exit and checkpoint exit separately, copies the completed memory journal and the supervisor's genuine terminal `worker_exit` proof, and places the selected checkpoint data into the same import layout. Missing or unsuccessful terminal evidence is rejected; an active checkpoint snapshot cannot stand in for a completed final campaign.

The snapshot contains `launch.json`, the complete bound watchdog and supervisor journal prefixes and summary/snapshot receipts, and `run/` with the selected checkpoint's plan, receipt, exit, reload proof, FIT margins and adapter. Preserve its hashes while transferring the snapshot to the local export machine. The export command requires the SHA-256 of `fresh-snapshot/run/receipt.json`.

## Local import, fusion and F16 export

The local environment is Python 3.13, MLX `0.32.2`, MLX-LM commit `9d1e356e7cc6549e7d1697adabe2ea01ff8e062c`, Transformers `5.11.0`, and PyTorch `2.11.0` for conversion. `scripts/build-rfdt.sh --with-converter` installs these pinned dependencies; `scripts/build-native.sh` supplies the pinned llama.cpp converter and native scorer. Existing installations remain usable at `.build/rfdt-venv/bin/python`.

```sh
npm run export:guardrail -- --run /absolute/fresh-local-export --cuda-run /absolute/fresh-snapshot --receipt-sha256 CHECKPOINT_RECEIPT_SHA256 --base-hf /absolute/original-google-snapshot --native-binary /absolute/jev-native --python /absolute/local-mlx-python --model-id jev/c11-reproduced-step256
```

Import verifies the supervised producer, checkpoint reload, input/base/adapter identities and complete memory journal before loading the adapter. It expands the complete floating base tree to FP32 before LoRA loading, uses the FP32 Gemma embedding-scale helper, and compares all 327 FIT margins. Fusion preserves FP32 before pinned conversion to F16. Native verification compares the same 327 FIT rows with probability-delta limit 0.05, decisive margin 0.5 and zero decisive sign flips.

Outputs include the F16 GGUF, artifact/run manifests, a scoped registry, import equivalence and native precision receipts. Precision fidelity is separate from guardrail safety. The current Desktop model has five known unsafe automatic allows and six unnecessary confirmations; it is unqualified and enforcement ineligible. Exporting new weights never supplies qualification, assigns a new cutoff, or authorizes enforcement.

Run `npm run test:training` for dependency-free parser, sampler, supervision and attestation checks. The preserved local environment also runs the optional CPU PyTorch gradient and MLX ordering/fusion tests. No test executes Salesforce requests or opens held-out TEST case content.
