# Jev C11 step256 — trained F16 model for local experiments

This folder contains the fully merged trained candidate `jev/c11-step-256`, not just a training adapter. The `model.gguf` file includes the weights and tokenizer needed by a compatible Gemma 3 GGUF loader. You do not need to retrain, download the base model, or reconstruct the adapter.

The accompanying demo uses Simple Jev's version-2 risk-classification prompt and the frozen safe-score cutoff `0.955913273071778`. Its outputs are advisory judgments. It does not execute the original tool request, obtain approval, or activate SF Guardrail enforcement. Exact policy remains the responsibility of the host integration.

## Measured effectiveness

**C11 cleared over 90% on diagnostic validation and has not been independently vetted.**

| Diagnostic VALID measurement | Result |
| --- | ---: |
| Model-eligible correct | **105/116 — 90.52%** |
| Overall correct, including code-owned actions | **149/160 — 93.13%** |
| Eligible model answers | 116/116 |
| Attempted-model fallbacks / replay errors | 0 / 0 |
| Unsafe automatic allows | **5** |
| Unnecessary confirmations | **6**, versus baseline **0** |
| Warm direct risk-check p95 on the measured host | 131.165 ms |

These are exploratory results on consumed diagnostic VALID. The model and cutoff were frozen before new TEST authoring, but the prospective TEST corpus failed independence review and was never scored. This candidate fails the guardrail safety and interruption requirements. There is no independent held-out TEST score, passing qualification, or production admission. Treat the selected-token scores as uncalibrated.

The detailed report is included at `docs/C11-results.pdf`. This bundle is for experimentation with the trained weights; default guardrail enforcement remains `off`.

## Identity

- Base: `google/gemma-3-1b-it`.
- Base revision: `dcc83ea841ab6100d6b47a070329e1ba4cf78752`.
- Training: fresh guardrail LoRA and optimizer, 327 FIT rows, with no validation or TEST training rows. The step256 adapter is already merged.
- Model format: F16 GGUF, 2,006,573,408 bytes.
- Model SHA256: `8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053`.
- Source commit: `85b12f998141081ebd9199982541a7a50520724f`, branch `barretts/jev-c11-score-20260923` in `barretts/simple-jev-ts`.
- Exact lineage, registry metadata, cutoff, measurements, and executable identity are recorded in `MODEL-CARD.json`.

The copied GGUF bytes are unchanged from the frozen measured artifact. The portability wrapper resolves local paths at launch; it does not change the model or the scoring prompt. The original protected-path policy, approval/session handling, and full Pi integration are not activated by the standalone demo.

## Requirements and sharing

The ready-built native executable is for Apple-silicon Macs on macOS 26 or newer. The Node wrapper needs Node 22.19 or newer and uses Node built-in modules only. Other platforms can build the bundled native C++ source against the pinned llama.cpp revision; this compiles an inference runtime, not a model training job. CPU experiments may take longer than the production risk-check deadline.

Send the **whole folder**, including `README.md`, the demo, runtime, model, checksums, and license notices. The runtime and model are supplied together so a recipient does not need access to the private GitHub repository. Read `GemmaTerms.txt`, `PROHIBITED_USE_POLICY.txt`, and `NOTICE.md`; the model remains governed by the Gemma terms, while the first-party runtime code has its separate Apache license.
