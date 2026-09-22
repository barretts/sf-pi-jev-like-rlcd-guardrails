# Candidate 9 CUDA training receipt

The user authorized the shared Windows RTX 4060 Ti host with an 8,000,000,000-byte maximum for this job. This experimental C9-B backend uses an isolated FIT-only input directory and distinct worker/watchdog process identities. It does not modify other sessions' runs, environments, or GPU settings. Only its own verified worker can be stopped by the watchdog.

## Completed one-step probe

Remote run: `/home/barrett/jev-cuda/c9-b-cuda-probe-20260922-v3`.

- Worker code commit: `6f377ed`.
- Real optimizer steps completed: 1; adapter changed; successful exit.
- Worker elapsed time: 57.356 seconds, including initial and final FIT scoring.
- CUDA model parameters: 444; buffers: 5; pre-step gradients: 104; post-step optimizer state tensors: 208. Placement checks passed on `cuda:0`.
- PyTorch peak allocated: 2,189,920,768 bytes; peak reserved: 2,260,729,856 bytes.
- Windows peak dedicated increase: 2,430,164,992 bytes.
- Windows peak shared increase: 71,303,168 bytes. This is below the 128,000,000-byte watchdog threshold, but is not evidence of zero shared-memory growth.
- Windows time series: 15 samples. The requested sleep interval was 2 seconds; counter collection adds time, so actual samples are roughly 4–5 seconds apart. Transient changes between samples remain unobserved.
- Caching allocator cap: 6,500,000,000 bytes; watchdog dedicated increase stop: 7,500,000,000 bytes; hard maximum: 8,000,000,000 bytes.

The first two probes failed closed when Windows counter collection consumed the SSH run-control input. Version 3 fixes the subprocess stdin handling and preserves the failed histories. The probe establishes execution and bounded observed memory, not effectiveness or a speed improvement.

Raw receipts and the memory time series are retained in `candidate-9-evidence/cuda/probe-v3/`.

## Sustained run launched

Remote run: `/home/barrett/jev-cuda/c9-b-cuda-train-20260922-v3`; worker PID 7334, watchdog PID 7333. Its plan requests 256 optimizer steps with the same pinned FIT inputs and budget settings. CUDA free memory before launch was 15,962,472,448 bytes. An SSH control session remains open for Windows counter availability. Later progress and completion must be established from this exact run's journal and exit receipt.

The watchdog observes adapter totals: another session's increased usage can stop our run. Such a stop must not trigger termination or cleanup of the other session. No CAL, VALID, or TEST data was transferred.

## Qualification boundary

No C9 CUDA effectiveness score has been produced. The saved/reloaded adapter, cross-backend margins, F16 export, and Q8 export need equivalence checks before CUDA output can enter the selector. A trained adapter, lower FIT loss, or a successful memory probe does not satisfy qualification. Enforcement remains off and the current rule engine remains active.
