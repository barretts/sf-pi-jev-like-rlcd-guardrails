# C10 checkpoint 256 measured results

Checkpoint 256 improves the fixed-cutoff diagnostic scores over checkpoint 128 but remains below the ≥90% replacement goal and fails safety/usability qualification. The actual CUDA adapter imported successfully, exported to F16, and passed native precision. Formal CAL rejected it because preventing every unsafe allow requires three unnecessary confirmations above the baseline's zero. Formal VALID did not run. The separately authorized diagnostic VALID used cutoff 0.5 and remains ineligible for enforcement.

| Dataset / fixed diagnostic cutoff 0.5 | Correct outcomes | Accuracy | Unsafe automatic allows | Benign interruptions | Answered eligible calls |
| ------------------------------------- | ---------------: | -------: | ----------------------: | -------------------: | ----------------------: |
| TRAIN-CAL                             |            37/42 | 88.0952% |                       3 |                    2 |                   42/42 |
| Diagnostic VALID, whole corpus        |          142/160 |   88.75% |                      10 |                    8 |                 116/116 |
| Diagnostic VALID, model eligible      |           98/116 |   84.48% |                       — |                    — |                 116/116 |

The unchanged diagnostic VALID baseline matches 128/160 outcomes, with 32 unsafe allows and zero benign interruptions. The model corrected 27 baseline risks but introduced five safety regressions and eight benign interruptions. Exact hard blocks remain preserved. All 116 eligible model calls completed; there were zero errors, attempted-model fallbacks, or deadline misses. These diagnostic results do not select or qualify a candidate.

Warm direct risk-check p95 was 194.243 ms on CAL and 183.870 ms on diagnostic VALID, including direct Jev prompt preparation and queueing. CAL cold initialization was 1,339.61 ms. These timings do not establish matched Pi workflow latency or production acceptance.

CUDA-to-MLX import precision passed 327 FIT rows with maximum probability delta 0.000005863234908143333 and zero decisive flips. F16 native precision passed all 327 calls, maximum delta 0.002654558965682674 and zero flips. Q8 completed 327 calls but failed the unchanged 0.05 limit with maximum delta 0.07034278306332523 and zero flips. Its separate rejected derivation does not invalidate the passing F16 export.

F16 SHA256: `036823c5a9e7c3ef9207064fd98cf4a4a4c1c818d45704d578de5f9f555a706b`.
Source CUDA receipt SHA256: `8ed16078fcfd50559fd842846bc0ded76b6ce4769f31b26c5114c3dd0c425476`.
Executable evaluation manifest file SHA256: `5118f45db229f99190ecd2daec83948aaa1ab320161d7b827eb98f1fa480769a`.

Raw outcomes and precision/import proofs are retained in `candidate-10-evidence/step-256/` with an aggregate summary and file hashes. Local preparation/import/export/Q8 stages ran in the CUDA-port worktree; the current primary integration assembler and evaluators ran against the frozen sf-pi host with absolute local artifact paths. No TEST scoring or external tool execution occurred. Production enforcement remains off and qualification remains false. This task launched or modified no remote workers.
