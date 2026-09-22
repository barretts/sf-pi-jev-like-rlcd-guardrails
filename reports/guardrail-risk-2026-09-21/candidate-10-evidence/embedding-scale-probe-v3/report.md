# C10 one-step FIT-only embedding scale proof

The original FP32 CUDA/local bridge failed the unchanged 0.05 maximum probability difference gate. The installed MLX Gemma architecture rounds its embedding normalizer through BF16 even when all model weights are FP32. With hidden size 1152 it multiplies embeddings by 34.0, while Hugging Face FP32 uses 33.941123962402344.

This A/B experiment uses the same saved one-step CUDA adapter, all 327 admitted FIT rows, original native tokenizer/prompt parity checks, and the same local FP32 model. The second arm installs an explicit local Gemma subclass that changes only embedding normalizer construction. It preserves every parameter tensor identity, child module, mask operation, cache operation, and tied head; it does not modify packages or global classes.

| FIT precision comparison against saved CUDA margins | Original MLX normalizer | Explicit FP32 normalizer |
| --- | ---: | ---: |
| Completed rows | 327 | 327 |
| Maximum probability difference | 0.06853587219102553 | 0.0001460751333436372 |
| Maximum margin difference | 0.4600334167480469 | 0.0012226104736328125 |
| Decisive sign flips, source margin magnitude ≥0.5 | 0 | 0 |
| Fixed probability difference limit | 0.05 | 0.05 |
| Precision result | Fail | Pass |

The original arm reproduces the prior failure exactly. Changing the scale alone eliminates that failure on this saved probe. This demonstrates precision agreement on FIT for this adapter; it does not establish risk effectiveness, validation or test accuracy, exported native agreement, workflow acceptance, or full-check latency.

The complete A/B run took 70.39592775001074 seconds with peak MLX memory 5,045,561,068 bytes. This is experiment runtime, not per-risk-check latency. Three MLX tests run on CPU verify parameter inventory and identities, tied-head configuration preservation, exact normalizer math, global/sliding masks at sequence lengths 511–514, repeated-wrapper rejection, and rejection of BF16 weights. The source campaign and RFDT worker were not changed by this experiment.

Reproduce from the CUDA-port worktree using its existing probe assets (replace the absolute model/python locations if needed):

```sh
/Users/bsonntag/code/simple-jev-ts/.build/rfdt-venv/bin/python rfdt/gemma3_fp32_fit_diagnostic.py \
  --model /Users/bsonntag/code/simple-jev-ts/.build/hf-session-1_s2hbhu/home/hub/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752 \
  --adapter .build/guardrail/candidate-10-probe-source-v1/run/checkpoints/step-1/adapter \
  --adapter-sha256 6d4e010adc063f5e694863859937a2d4fabd4158da294d2f13ca415ba0136766 \
  --data .build/guardrail/candidate-9-B-cuda-local-v1/train.jsonl \
  --reference .build/guardrail/candidate-10-probe-source-v1/run/checkpoints/step-1/fit-margins.jsonl \
  --reference-sha256 274662f41a263759213783e679acba674cbc8d8271ce4cf2e3af60c46b5694cf \
  --output .build/guardrail/candidate-10-probe-mlx-scale-repeat
```

The receipt binds FIT, source reference, adapter, helper, script, and worker hashes. Raw margins for both arms are retained alongside it. Any future integration must bind the explicit architecture helper and rerun the strict bridge/export checks; this experiment cannot substitute for those gates. No CAL, VALID, or TEST inputs were read.
