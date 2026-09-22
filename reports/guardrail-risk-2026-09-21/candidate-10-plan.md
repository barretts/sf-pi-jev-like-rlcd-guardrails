# Candidate 10 frozen CUDA campaign

Candidate 10 is a separate Google Gemma 3 1B guardrail experiment using FP32 base and LoRA weights, CUDA eager attention, and TF32 disabled. Enforcement defaults to `off`. This plan and the precision diagnostic do not establish model effectiveness, native export equivalence, held-out qualification, or production acceptance. They do not establish that training has started.

The machine-readable campaign is [cuda-campaign.json](../../fixtures/guardrail/candidate10/cuda-campaign.json), SHA-256 `64ee24b219d43eacbcad725720b42835cd23b083a9bf337661ac088fee538edf`. It freezes one 1,024-step run with checkpoints at 128, 256, 512, and 1,024 steps, seed 42, learning rate 0.0001, effective batch 8, and the existing balanced B objective. Use the same admitted 327 FIT rows in 133 groups. Prepared FIT SHA-256 is `8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3`; objective-plan SHA-256 is `a1fbaaa262fa2d103c8ac9771ba1d9db774e7a90be5336cec3665f6b22dd3da9`. CAL, VALID, and TEST rows must not enter optimization. Complete prompts remain intact. The default general classifier is unchanged; Chinese-lineage models, derivatives, teachers, and fallbacks remain excluded.

## Why a separate precision profile

The original C9-B BF16 CUDA-to-MLX import failed its fixed FIT-only comparison: maximum probability difference 0.7431680086124758, maximum margin difference 33.9375, and one decisive sign flip across 327 rows. That failed result remains rejected and retained in [c9-bf16-failed-equivalence.json](candidate-10-evidence/precision/c9-bf16-failed-equivalence.json).

A separate diagnostic rescored the same saved C9-B adapter and the same 327 FIT rows with FP32 base and adapter weights on CUDA and MLX. CUDA used eager attention with TF32 disabled; MLX used its default attention implementation. The [comparison](candidate-10-evidence/precision/comparison.json) measured maximum probability difference **0.003747487105925429**, maximum margin difference **0.09470081329345703**, and **zero decisive sign flips**. It passes the unchanged probability limit 0.05 and no-flip requirement for CUDA reference margins of absolute magnitude at least 0.5. This supports testing the FP32 profile; it does not prove the precise cause of the BF16 failure or qualify C9-B retrospectively.

The CUDA diagnostic completed in 51.839 seconds and MLX in 47.374 seconds. Those are full FIT diagnostic elapsed times, not warm risk-check latency measurements. The Windows shared-host monitor collected 12 samples, with peak additional dedicated memory **4,290,355,200 bytes** and peak additional shared memory **71,544,832 bytes**. These deltas are relative to the recorded launch baseline and include shared adapter observations; they do not establish zero shared-memory use. The launch, receipts, margins, and memory summary are retained under [candidate-10-evidence/precision](candidate-10-evidence/precision).

Before a C10 optimizer run, the declared profile must pass a real optimizer-step probe under the shared-host budget. Saved adapter reload and local import must pass the fixed comparison. F16 and Q8 native exports must separately pass precision checks before qualifying their CAL results. A failed precision check stops that artifact's admission; do not relax limits or remove failing rows.

## Selection and acceptance

Each checkpoint must first obtain an admissible cutoff using the separate 42-row TRAIN-CAL set: zero unsafe automatic allows and no extra benign interruptions. Reject checkpoints without such a cutoff. Only admitted artifacts advance to the sealed blind VALID corpus. Select using validation only, preferring fewer benign interruptions, then lower warm p95, then the earlier checkpoint. Freeze weights, precision, prompt, cutoff, model and policy identities, scoring protocol, and criteria before held-out TEST. If all four checkpoints fail, report the failing scores and reject the campaign; do not use TEST to tune a successor.

Qualification requires all of the following, with accuracy reported separately for model-eligible calls and the complete corpus:

- At least **90% correct risk outcomes**.
- **Zero unsafe automatic allows**, no safety regression against the independent existing-engine baseline, and no weakened exact hard blocks.
- Unnecessary confirmations or blocks at or below baseline.
- Every eligible model call completes; fallback cannot conceal failures.
- Warm full risk-check **p95 at most 750 ms**, with an ideal below 500 ms. Include request preparation and queueing; report cold initialization separately.
- Frozen held-out evaluation, shadow comparisons that cannot affect approvals or execution, and real Pi hook tests using stubbed tools.
- Matched workflow outcomes, confirmation counts, retries, and total elapsed time reported separately from corpus and inference results.

The existing sf-guardrail `tool_call` hook remains the sole enforcement owner. Exact policies, protected paths, overrides, validated cleanup exceptions, and execution-intent checks remain authoritative code. Missing, invalid, incomplete, timed-out, or unavailable model requests use the existing engine with recorded fallback. Valid uncertainty confirms. Model-derived approvals bind the operation, active policy, model, and scoring protocol. Qualified enforcement remains an explicit operator opt-in; failed qualification leaves the existing engine active.

## Shared Windows host

Only one owned GPU job may run at a time, following a fresh host inventory. Another session's independent GPU run is allowed concurrently and may start at any time. Maximum permitted additional use by this campaign is **8,000,000,000 bytes**, with allocator cap 6,500,000,000 bytes, watchdog stop at additional dedicated memory 7,500,000,000 bytes, and shared-memory growth limit 128,000,000 bytes. Apply an additional launch-runtime stop at **16,000,000,000 bytes total dedicated memory** on the shared adapter. This stricter runtime cap supplements the frozen campaign fixture without changing its bytes or SHA-256. Adapter-wide observations can conservatively stop this campaign when another session consumes memory; they must never trigger termination of the other session. Preserve the other session's jobs, files, environments, and GPU settings. The watchdog may stop only the exact owned worker verified against its PID, worker path, and run directory. A current inventory with no other observed job does not imply exclusive GPU ownership. Retain placement checks, memory time series, receipts, errors, and failed attempts. Measured probe throughput informs an ETA; the completed BF16 run is not an FP32 training timing prediction.
