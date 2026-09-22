# C9 latency diagnostic on frozen C8-256 weights

This receipt measures the same C8-256 GGUF (`5b2c6be8...`) and native scorer
(`7fafa2a0...`) used in the rejected C8 VALID run. It comes from committed
evaluator source `b125120` based on C8 delivery `4881df6`. The C8 VALID
report (`8f6489ab...`) remains frozen; this probe does **not** rescore VALID or
open TEST. It executes no tool command.

The evaluator first initialized Metal, then sent one fixed, full **7,164-byte**
harmless request through the selected-logit classifier as a **cold startup
probe**. Initialization took **1,510.378 ms**; the first long inference took
**874.293 ms**, for **2,384.671 ms** total startup. The probe had a separately
declared 2,500 ms startup cap. Every subsequent synthetic risk check retained
the guardrail's **750 ms** caller, classifier queue, and request deadlines.

| Full-request warm probe        | Answered | Deadline misses | Direct p95 |
| ------------------------------ | -------: | --------------: | ---------: |
| Sequential short/long, 3 each  |    3 / 6 |               3 | 803.766 ms |
| Two contended short/long pairs |    0 / 4 |               4 | 809.982 ms |
| All warm probes                |   3 / 10 |               7 | 809.982 ms |

Short successful requests used **364 computed prompt tokens** and took
**171.032–324.379 ms**. One long warm request completed in **713.964 ms** at
**1,406 computed prompt tokens**; the other long attempts timed out. A
successful cold long request used 1,536 tokens and spent **30.647 ms** in
native compilation and **841.165 ms** in native evaluation. The successful
warm long request spent **28.755 ms** compiling and **684.734 ms** evaluating.
Native evaluation covers prompt prefill and selected-logit scoring. It emits
**zero output tokens**, so there is no generated-token decode phase. Native
tokenization and KV state are rebuilt for each request; prefix reuse is only
among answer branches within a request. The full original inputs were sent,
and each sample is keyed by its original-operation SHA-256 in the JSON.

These synthetic direct-classifier times exclude sf-pi policy evaluation and
fact preparation. Instrumentation exposes existing queue/native metrics and
adds overhead. The earlier **534.085 ms** C8 VALID p95 remains the
qualification-relevant full-host result across all 59 eligible requests,
including its two 750 ms deadline fallbacks. This synthetic receipt is a
performance diagnosis, not a revised C8 safety or effectiveness score. The
fixed long startup probe did not make all warm calls meet 750 ms, so a
reproducible quantized export of the same C8 weights was measured separately.

`f16-synthetic-latency.json` contains the sample-level timings, token counts,
operation hashes, failure reasons, runtime pins, and explicit cold/warm scope.

## Same-weights Q8_0 performance experiment

The committed `q8_0-export-manifest.json` pins an export of the frozen C8 F16
weights through local llama.cpp revision `f072b103` and quantizer binary SHA-256
`e2c48c54...`. The output tensor was left unquantized; all other quantizable
tensors used Q8_0. The resulting GGUF is `438fc15c...` and 1,069,306,208
bytes, versus 2,006,573,408 bytes for F16. The quantized artifact is an
ignored local build artifact; the manifest and its hash permit verification.

Both variants were then measured using the **same committed evaluator**
`fa9d720`, the same synthetic operation hashes, full original requests, native
scorer, and a 750 ms deadline on every warm check. The long cold probe again
had its separately declared 2,500 ms startup cap. Q8_0 ran first, followed by
F16; each was a single run, so device and thermal variability remain possible.

| Paired full-request warm probe  | F16 answered | Q8_0 answered | F16 direct p95 | Q8_0 direct p95 |
| ------------------------------- | -----------: | ------------: | -------------: | --------------: |
| Sequential, 3 short + 3 long    |        2 / 6 |         6 / 6 |     808.369 ms |      709.785 ms |
| Contended, two short/long pairs |        0 / 4 |         2 / 4 |     812.875 ms |      837.713 ms |
| All warm                        |       2 / 10 |        8 / 10 |     812.875 ms |      837.713 ms |

Q8_0 reduced the missed warm checks in this run from **8 to 2**, but its two
contended deadline misses and **837.713 ms** all-call p95 still fail the hard
750 ms requirement. Its cold initialization was **6,506.295 ms** and fixed
long probe **1,616.822 ms**, versus **2,063.662 ms** and **1,138.015 ms** for
the paired F16 run. Cold costs are reported separately and are not warm-check
latencies. The Q8_0 long cold probe used all 1,536 prompt tokens and spent
392.907 ms compiling plus 1,218.357 ms in native evaluation; it was never a
live 750 ms risk check.

Only **two distinct requests** received scores under both variants within
their deadlines. The fixed long cold probe's uncalibrated allow score changed
from **0.733928** (F16) to **0.748782** (Q8_0), an absolute difference of
**0.014854**. The repeated short request changed from **0.999868081** to
**0.999872533** (absolute difference **0.000004452**). This narrow comparison
shows that quantization changes scores; it cannot establish decision fidelity,
safety parity, or whether the frozen cutoff transfers. The Q8_0 model has not
passed TRAIN-CAL, VALID, TEST, or host enforcement qualification. These two
paired receipts are performance diagnostics and do not revise the rejected C8
effectiveness result.

`f16-paired-latency.json` and `q8_0-synthetic-latency.json` retain every
answered and timed-out attempt, operation SHA-256, phase timing, token counts,
scores when available, and cold/warm scope. They include no held-out TEST data
and no tool command was executed.
