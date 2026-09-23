# Candidate 11 complete-population accuracy milestone

The C11 step-256 F16 model reached **105/116 correct model-eligible decisions (90.52%)** on the frozen diagnostic VALID corpus when its allow cutoff was selected from the 42 TRAIN-CAL rows by accuracy alone. All 116 eligible requests received one real model answer; there were no attempted-model fallbacks or replay errors. The resulting whole-corpus outcome was 149/160 (93.13%), including 44 decisions owned by code rather than the model. This is the first complete C11 replay to cross the 90% model-eligible accuracy target.

This is an **exploratory diagnostic result, not guardrail qualification or an independent held-out TEST result**. The accuracy-only cutoff procedure was chosen after earlier fixed-0.5 VALID diagnostics had been inspected, although the cutoff value itself uses only TRAIN-CAL scores. At this cutoff, step 256 still has five unsafe automatic allows and six unnecessary confirmations; the current safety selector rejects it because the baseline has zero unnecessary confirmations. Production enforcement remains off. Do not describe this result as safe to replace sf-guardrail's risk engine.

| C11 F16 checkpoint | TRAIN-CAL-only accuracy cutoff | CAL correct | VALID eligible correct |  VALID whole correct | Unsafe allows | Benign interruptions | Answered eligible calls | Warm VALID p95 |
| ------------------ | -----------------------------: | ----------: | ---------------------: | -------------------: | ------------: | -------------------: | ----------------------: | -------------: |
| 128                |                            0.5 |       36/42 |       104/116 (89.66%) |     148/160 (92.50%) |             5 |                    7 |                 116/116 |     130.746 ms |
| **256**            |          **0.955913273071778** |   **39/42** |   **105/116 (90.52%)** | **149/160 (93.13%)** |         **5** |                **6** |             **116/116** | **131.165 ms** |
| 512                |             0.7232675366322204 |       40/42 |       102/116 (87.93%) |     146/160 (91.25%) |             8 |                    6 |                 116/116 |     129.205 ms |

The original fixed-0.5 diagnostics yielded 104/116, 103/116 and 103/116 eligible correct at steps 128, 256 and 512 respectively. The table recomputes decisions at a cutoff chosen separately for each checkpoint using **only** its CAL record scores and labels: candidate cutoffs are 0, 0.5, 1 and the midpoints of adjacent unique CAL scores; maximize correct CAL labels, breaking ties by distance to 0.5 and then the lower cutoff. The script then applies that already selected cutoff to all 116 eligible VALID scores. It does not read TEST. The cutoff is not the existing zero-unsafe safety cutoff and is not installed as an enforcement configuration.

The three repaired native replays used the same frozen 160-case VALID source, host baseline and policy. They ran after the native-worker recovery change at `be4c59fa4314e01d6d243a14d108e0c61160d27b`, which prevents a retired worker generation from invalidating every later call. Each replay answered all 116 eligible calls with no errors or attempted-model fallbacks. Direct risk-check timing includes preparation and queueing, but not full Pi hook/fact-resolution or workflow time. Cold initialization was approximately 1.34–1.38 seconds and is separate from the warm p95 values. The recovery change passed 23 focused tests, and this worktree's TypeScript build passed.

Step 256 model SHA256: `8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053`. Its F16 artifact is at `/private/tmp/simple-jev-ts-c11-step256-f16-import-20260923/.build/guardrail/candidate-11-step-256-local-v1/model-f16.gguf`. CUDA-to-MLX import and native F16 precision each covered all 327 FIT rows, with maximum probability deltas `0.000017387740331720192` and `0.0015098066640104046`, and zero decisive flips. Step 512 was imported from the genuine last complete checkpoint of the stopped Windows campaign; the worker stopped at 664/1024 steps. No 1024 model or score exists for C11.

The replay, pinned manifest and derived accuracy result for each checkpoint are retained under `candidate-11-evidence/step-128/`, `step-256/` and `step-512/`. In particular, the step-256 evaluation SHA256 is `d35343b813a0a97e9b762466707589fb6f39ee937f1c9501941da3f4aaa9bdec`; its pinned manifest SHA256 is `70aa491b81881191826fcd7b6d80e1c9436e57f151d4942ef16ec3768d54fedb`. The local executable evidence is reproducible with:

```sh
node scripts/guardrail-candidate11-accuracy-diagnostic.mjs \
  --evaluation reports/guardrail-risk-2026-09-21/candidate-11-evidence/step-256/repaired-diagnostic-valid-evaluation.json
```

The remaining work toward an enforceable sf-guardrail replacement is reducing unsafe allows and unnecessary confirmations on shell and `herdr_pane` operations, then running independent held-out qualification. Accuracy on this consumed diagnostic VALID set is established; generalization, safety parity, full-hook behavior and production acceptance are not.
