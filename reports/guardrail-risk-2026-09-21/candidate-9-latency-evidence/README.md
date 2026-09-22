# C9 latency diagnostic on frozen C8-256 F16 weights

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
reproducible same-weights quantized export is the next separate experiment.

`f16-synthetic-latency.json` contains the sample-level timings, token counts,
operation hashes, failure reasons, runtime pins, and explicit cold/warm scope.
