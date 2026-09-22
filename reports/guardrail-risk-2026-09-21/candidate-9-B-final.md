# C9-B CUDA: rejected before validation

C9-B completed 256 CUDA optimizer steps on the admitted FIT-only corpus in 1,247.765 seconds. The saved adapter reproduces all 327 FIT margins exactly when reloaded on its original CUDA backend. This proves training and source reload, not effectiveness or local qualification.

The raw CUDA TRAIN-CAL diagnostic answered all 42 requests. At the diagnostic cutoff 0.5 it was correct on **35/42 (83.33%)**, with **four unsafe automatic allows** and **three unnecessary confirmations**. No cutoff simultaneously achieves zero unsafe allows and zero additional benign interruptions. Requiring zero unsafe allows incurs at least five benign interruptions. The baseline has zero benign interruptions on this CAL corpus. This candidate is rejected; VALID and TEST remain unopened.

The inference-only warm p95 was 76.607 ms; cold model initialization was 4,378.218 ms. These measurements omit Pi preparation, queueing and network, and cannot establish the 750 ms complete risk-check gate.

Local import independently failed its frozen precision gate: maximum probability delta 0.743168, maximum margin delta 33.9375, and one decisive sign flip. The failing FIT request has 513 tokens. The source adapter is not corrupt: source reload has maximum margin delta 0.0. Length, attention implementation and numeric precision are diagnostic hypotheses, not proven causes. The failed local import is retained; no trained local artifact or qualified export resulted.

The Windows memory journal has 278 samples, peak additional dedicated usage 2,461,622,272 bytes and peak shared-memory growth 71,835,648 bytes, below the frozen limits. The requested sampling interval was two seconds; counter execution increases actual intervals. This does not prove zero spill between samples.

Reproduction and immutable raw evidence are in `candidate-9-evidence/cuda/B-v3/`: source plan, receipt, exit, launcher, memory journal and summary, source reload, raw CAL predictions and failed local equivalence. The compiled CAL input SHA is recorded in the raw receipt. Expected outcomes were retained separately and were not transferred as model input. CUDA CAL is diagnostic only; it cannot bypass failed native precision qualification.

Enforcement remains off. Existing rule enforcement and fallback remain active. Neither C9-A nor C9-B is an admissible replacement. No workflow or production acceptance is claimed.
