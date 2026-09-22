# C10 checkpoint 128 measured results

Checkpoint 128 does not satisfy the ≥90% replacement goal or the original safety/usability gates. The real CUDA saved adapter imported successfully, exported to F16, and completed native scoring. Formal CAL rejected it because zero unsafe allows requires four unnecessary confirmations, above the baseline's zero. Formal VALID did not run. A separate fixed-cutoff diagnostic VALID run provides an actual quality score while remaining explicitly ineligible for enforcement.

| Dataset / fixed cutoff 0.5       | Correct outcomes | Accuracy | Unsafe automatic allows | Benign interruptions | Answered eligible calls |
| -------------------------------- | ---------------: | -------: | ----------------------: | -------------------: | ----------------------: |
| TRAIN-CAL                        |            36/42 |   85.71% |                       4 |                    2 |                   42/42 |
| Diagnostic VALID, whole corpus   |          135/160 |  84.375% |                      12 |                   13 |                 116/116 |
| Diagnostic VALID, model eligible |           91/116 |   78.45% |                       — |                    — |                 116/116 |

The diagnostic VALID baseline matched 128/160 outcomes, with 32 unsafe automatic allows and zero benign interruptions. The candidate corrected 26 baseline risks but introduced six safety regressions and 13 benign interruptions. Exact hard blocks were preserved. There were zero errors, attempted-model fallbacks, or deadline misses. This is an unqualified diagnostic result, not a candidate selection or held-out TEST result.

Warm direct risk-check p95 was 132.826 ms on CAL and 128.727 ms on diagnostic VALID, including direct Jev prompt preparation and queueing. CAL cold initialization was 1,336.28 ms. These timings do not establish matched Pi workflow latency or production acceptance.

CUDA-to-MLX import precision passed all 327 FIT rows: maximum probability delta 0.000015728992592556335 and zero decisive flips. F16 native precision also passed all 327 FIT rows, maximum delta 0.0018980210225024718, zero flips. Q8 completed all 327 calls but failed the unchanged 0.05 limit with maximum delta 0.08432151451033865 and zero flips; the Q8 derivative remains rejected independently of F16.

F16 SHA256: `3a655bbdbb7d97331007b88c2614ca3e3e9ac1a7d573b5d40a75c471cfa0b893`.
Source CUDA receipt SHA256: `8ba3b15b4aec1d56e03f01c5c8a06cb364d98a472feeb1c6d34ab44f4ccda53a`.
Executable evaluation manifest file SHA256: `9be0db13a01fbba4b7e745f4ac9c17492b5196b5a90c8121c404320b61eba639`.

Raw calibration, formal rejection, diagnostic VALID records, precision attempts, import proofs, manifests, and an aggregate summary with file hashes are retained under `candidate-10-evidence/step-128/`. Actual invocation stages were the local checkpoint runner, pinned Q8 stage, primary manifest assembler, formal evaluator, then the separately labeled diagnostic VALID runner after CAL rejection. No TEST scoring or external tool execution occurred. Enforcement remains off. Full Windows training continues under the parent; this local task did not launch or modify remote workers.
