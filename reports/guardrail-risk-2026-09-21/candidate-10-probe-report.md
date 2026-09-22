# Candidate 10 one-step CUDA probe

The C10 FP32 CUDA optimizer probe completed **one real optimizer step**. Sustained 1,024-step training is **held** because the same saved probe adapter failed the fixed CUDA-to-MLX FIT-only precision gate. This is execution and precision evidence, not a trained-candidate effectiveness score, CAL admission, native export qualification, or held-out result. Enforcement remains off.

## Source execution

The [launch record](candidate-10-evidence/probe/v1/cuda-launch.json) preserves the exact worker and watchdog invocations, pinned input/code hashes, owned process identities, and shared-host limits. It used the frozen campaign SHA-256 `64ee24b219d43eacbcad725720b42835cd23b083a9bf337661ac088fee538edf` in probe mode with `--steps 1`; no CAL, VALID, or TEST data entered optimization. The one-step override is a probe, not completion of the frozen campaign.

The [run exit](candidate-10-evidence/probe/v1/cuda-run-exit.json) records success and **145.80478094499995 seconds** elapsed, including probe overhead. The [step receipt](candidate-10-evidence/probe/v1/cuda-step-1-receipt.json) records changed adapter weights, 444 CUDA parameters, 5 buffers, 104 gradients before the update, and 208 optimizer tensors afterward. Peak reserved Torch memory was **4,370,464,768 bytes**. The saved adapter's [source reload](candidate-10-evidence/probe/v1/cuda-step-1-reload.json) matched all **327 FIT margins exactly**, maximum margin difference **0.0**, against the fixed reload limit `0.00001`.

The [memory summary](candidate-10-evidence/probe/v1/cuda-memory-summary.json) retains **32 samples**, peak additional dedicated memory **4,533,624,832 bytes**, peak total dedicated memory **5,246,676,992 bytes**, and peak additional shared memory **71,303,168 bytes**. These adapter-wide observations are relative to the recorded launch baseline and do not establish zero shared-memory use. Our budget was 8,000,000,000 bytes, allocator cap 6,500,000,000, dedicated-delta stop 7,500,000,000, shared-growth limit 128,000,000, and supplemental total-dedicated stop 16,000,000,000. Another session is allowed to use the GPU concurrently; only the verified owned worker may be stopped.

## Local precision failure

The first local attempt failed before inference because the manually generated adapter manifest omitted the `campaign` property required by the diagnostic. The v2 attempt added that manifest property; weights and scoring settings were unchanged. This setup correction does not constitute model tuning or a passing precision result.

The [v2 comparison](candidate-10-evidence/probe/v1/cross-backend-v2.json) compared all **327 FIT rows** and measured:

| Metric | Result | Fixed requirement |
| --- | ---: | ---: |
| Maximum probability difference | **0.06853587219102553** | ≤ 0.05 |
| Maximum margin difference | 0.4600334167480469 | Diagnostic |
| Decisive sign flips | **0** | 0, for source margins with absolute value ≥ 0.5 |
| Precision gate | **Failed** | All requirements pass |

The earlier FP32 diagnostic on the C9-B adapter passed this comparison, but that result cannot substitute for the C10 probe adapter's failing result. No row was removed and no precision threshold relaxed.

An independent implementation inspection found MLX's BF16 embedding normalizer evaluates to **34.0**, while the FP32 Hugging Face normalizer is `sqrt(1152)`, approximately **33.941125**. The numeric discrepancy is confirmed; its causal contribution to the observed margin differences remains a hypothesis. A correction experiment is pending and must be recorded separately with unchanged fixed comparison criteria. It has not established a successful fix.

## Retained artifacts and remaining gates

The [artifact SHA-256 manifest](candidate-10-evidence/probe/v1/sha256.json) binds the copied launch, run plan, exits, receipts, memory journal, source reload, source FIT margins, MLX v2 receipt/margins/exit, and failing comparison. Adapter weights are deliberately excluded from this evidence commit; their hash remains in the source receipt. Original invocations are recorded where available in the launch evidence; no local command is reconstructed as an observed invocation.

Before sustained training, resolve the cross-backend discrepancy through an isolated experiment and rerun the fixed precision gate. Source optimizer success alone is insufficient. After a successful campaign, saved-adapter reload, local import, F16/Q8 export equivalence, CAL admission, blind validation, frozen held-out qualification, genuine native-provider workflows, and full preparation-and-queue latency gates still remain. This probe provides no C10 risk accuracy, unsafe-allow, or workflow effectiveness score.
