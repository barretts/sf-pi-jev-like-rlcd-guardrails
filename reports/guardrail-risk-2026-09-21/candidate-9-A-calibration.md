# C9-A v3 calibration result

C9-A v3 completed 256 MLX optimizer steps, verified adapter reload, and exported pinned F16 and Q8 artifacts. Both native calibration runs answered all 42 eligible calls. Both fail the necessary score-separation condition for C9 admission: no decision cutoff can simultaneously allow all 21 safe cases and require approval for all 21 risky cases.

| TRAIN-CAL observation | F16 | Q8 |
| --- | ---: | ---: |
| Answered / admitted | 42 / 42 | 42 / 42 |
| Warm p95, including preparation and queue | 136.29 ms | 143.05 ms |
| Warm maximum | 139.20 ms | 207.38 ms |
| Cold backend initialization | 1,358.17 ms | 853.85 ms |
| Minimum safe allow score | 0.138542 | 0.119368 |
| Maximum risky allow score | 0.953305 | 0.954215 |
| Minimum extra benign interruptions at any zero-unsafe cutoff | 6 | 6 |

The baseline on these same calibration groups has zero unnecessary interruptions. The safe minimum is below the risky maximum, so the required zero-unsafe, zero-extra-interruption cutoff does not exist. This is a failing calibration result; neither precision advances on the strength of this run.

For a diagnostic at cutoff 0.5, both precisions produce **37/42 correct outcomes (88.10%)**, with **3 unsafe automatic allows** and **2 unnecessary confirmations**. Cutoff 0.5 is an illustrative calibration observation, not a selected or frozen operating cutoff. The zero-unsafe requirement is unsatisfied at that cutoff. The baseline has 17 unsafe allows and no benign interruptions on TRAIN-CAL; these observations do not establish superiority or qualify either model.

The precommitted admission requires all calls to complete under the hard 750 ms warm limit, zero unsafe allows, and unnecessary interruptions at or below baseline. Timing and completion passed here; the safety/usability combination failed. No deadline failure was concealed by fallback. Scores remain uncalibrated. This TRAIN-CAL result is separate from blind VALID, held-out TEST, matched workflow results, and production acceptance. No VALID or TEST body was opened for this result. Enforcement stays off.

The F16 SHA-256 is `512e9edca284a7c89b3d3963fdecc8a2147212f6069283ea0a37fe575aadc0ac`; Q8 is `c0c352a4435d4a1584b07057c9998cb304641d971fdb072dd6d4ceb50f47a444`. Raw per-call results and a machine-readable summary are retained in `candidate-9-evidence/cal/A-v3-{f16,q8,summary}.json`. Their source pins bind admission, FIT/CAL corpora, pairs, families, objective, run, export, native scorer, host, policy, and protocol. Q8 provenance was committed before scoring in `f8d4436`.

Two launcher errors occurred before inference: the first supplied the run manifest in place of `artifact.json`; the second identified a nonexistent native binary path in the scorer worktree. They produced no model scores and did not open evaluation bodies. Correcting the invocation used the same fixed model and sources; the successful commands used the exported artifact manifest and the exact native binary from the FIT compiler. No criterion or model weight changed.

Reproduction uses `scripts/guardrail-candidate9-cal-cli.mjs` with the complete absolute paths and source SHA-256 pins recorded by each raw result. C9-B CUDA training remains a separate experiment; it needs saved-adapter, cross-backend, and exported-precision checks before its scores can enter selection.
