# C10 local checkpoint import and scoring preparation

The local-only runner prepares a fresh v2 RFDT run from the pinned 327-row admitted FIT source, imports a pinned completed CUDA training checkpoint (including a supported checkpoint-memory snapshot), exports F16, writes a private unqualified artifact registry, and executes the formal FIT-only F16 precision check. It does not run remote jobs, train a model, alter the default registry, enable enforcement, read TEST, or claim qualification.

Build the current checkout first with `npm run build`. Use a Python executable from the local RFDT environment containing the pinned MLX/export dependencies, including Torch 2.11.0. Export requires the pinned `.vendor/llama.cpp` checkout. The source checkpoint root must contain `launch.json`, memory evidence, `run/{plan,receipt,exit}.json`, `run/fit-margins.jsonl`, and `run/adapter/` as required by the importer. Use the root extracted from the checkpoint bundle, not just its adapter directory. Preserve the externally recorded receipt pin.

```sh
node scripts/guardrail-candidate10-local-checkpoint.mjs \
  --run /ABS/FRESH/candidate-10-step-128-local-v1 \
  --fit /ABS/admitted-candidate9-fit.jsonl \
  --cuda-run /ABS/extracted-step-128-snapshot-root \
  --receipt-sha256 ACTUAL_64_CHARACTER_RECEIPT_SHA256 \
  --base-hf /ABS/pinned-gemma-3-1b-it-snapshot \
  --base-gguf /ABS/gemma-3-1b-it-f16.gguf \
  --native-binary /ABS/jev-native \
  --python /ABS/rfdt-venv/bin/python \
  --checkpoint 128 \
  --model-id jev/guardrail-candidate10-step128-f16
```

The FIT source must hash to `8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25`; prepared FIT must match the CUDA training hash during import. Output must be a nonexistent directory. A failed attempt remains intact; retry using a new run directory. Checkpoints 256, 512, and 1024 use the same runner with their actual receipt pin and distinct model/run identities. Adapter import validates checkpoint, precision helper, source reload, shared-host memory, and provenance before marking the local run trained.

Successful output contains `manifest.json`, `artifact.json`, `model-f16.gguf`, `f16-registry.json`, `precision-f16.json`, `adapter/cuda-import-report.json`, the fixed import comparison and FIT margins, and `local-checkpoint-handoff.json`. The private registry grants no enforcement qualification. A failed F16 precision check returns nonzero and retains its result. Q8 quantization, its runtime/provenance manifest, and formal Q8 precision checking belong to the separate native stage. Both precision attempts must remain in the evaluation manifest; a passing selected format cannot conceal the other attempt.

After native artifact preparation and explicit file/runtime pinning, the formal evaluator receives its dedicated manifest:

```sh
node scripts/guardrail-candidate10-evaluate.mjs \
  --manifest /ABS/candidate10-native-evaluation-manifest.json \
  --manifest-sha256 ACTUAL_64_CHARACTER_MANIFEST_SHA256 \
  --output /ABS/FRESH/candidate10-step128-evaluation
```

Use the evaluator's current manifest schema and prospective baseline freeze, source artifacts, exact code/runtime hashes, and sealed VALID metadata. The evaluator owns CAL admission before VALID access; do not bypass it by invoking VALID scoring directly. Selection remains validation only. This runner has been syntax checked and formatted; it has not been executed on a completed C10 training checkpoint as part of this change. Its successful execution cannot establish accuracy until the formal evaluator produces accepted results. Native worker and warm latency evidence remain separate from import/export success.
