# Candidate 8 model and cutoff freeze before prospective VALID

**Status: TRAIN and TRAIN-CAL only.** This records the 256-update candidate and
its selected cutoff before any real Candidate 8 VALID or held-out TEST model
score. The current sf-guardrail engine remains active. The local model is not
qualified for enforcement.

The original Google `google/gemma-3-1b-it` base at revision
`dcc83ea841ab6100d6b47a070329e1ba4cf78752` was fit in isolated Jev source
commit `af98a60101844f8994c764037e4c98edc19bf479`. RFDT prepared 226 FIT
rows in 77 groups, zero internal validation rows, and zero internal test rows.
The separate TRAIN calibration held 47 rows in 17 disjoint groups. The fixed
pair-margin objective ran all 256 updates, changed the adapter, reduced its
TRAIN loss from 11.551 to 0.027, and verified checkpoint reload. These are
training checks, not prospective effectiveness results. The exported F16 GGUF
is 2,006,573,408 bytes, SHA-256
`5b2c6be87fef227ea02c71f91b853010f089501035b872a888b100b5d746237f`.
Its local file is
`/private/tmp/simple-jev-ts-guardrail-c8-fit-20260922/.build/guardrail/candidate-8-rfdt-256-v1/gemma-3-1b-rfdt-f16.gguf`;
the large weights are not committed to Git. The [run evidence](./candidate-8-evidence/runs/256/)
contains the fixed plan, run and artifact manifests, training report, adapter
metadata, worker progress, and all export attempt receipts. The first export
attempt lacked a local pinned converter checkout link; the second encountered
the rebuildable fused directory left by the first. The third completed with the
same trained adapter. [Its inventory](./candidate-8-evidence/runs/256/SHA256SUMS)
verifies 13 small evidence files and does not include the GGUF or adapter
weights.

The real local model answered **47/47** admitted TRAIN-CAL requests with no
attempted model fallback. Cold initialization was 1.394 seconds separately;
direct warm model scoring had p95 512.4 ms and maximum 526.0 ms. Those timings
exclude the sf-pi host preparation and queueing needed for the risk-check
latency gate. The [raw model score receipt](./candidate-8-evidence/cal/model-score-256.json)
has SHA-256 `029b5b4773b487c28f8bbcf3b48d0f2cb1524fe0ce9ace88ca2079df18e209b9`.

The predeclared TRAIN-CAL selector accepted a cutoff of
`0.9967565871733567` (logit cutoff `5.727880477905251`), with scoring
protocol SHA-256
`57f1998c932a431b2aa75244943947a78fde120a0ccd654bf17a4037998190a9`.
The [cutoff receipt](./candidate-8-evidence/cal/cutoff-freeze-256.json),
SHA-256 `6b6c06ea3262ba13d0da1d15e4b744ac474bf182d63715b43170d5a9f7d80229`,
binds the model, native scorer, admitted FIT/CAL sources, sf-pi host
`bdbf6292f383a8b2e12cd236aafb2be9c335f463`, runtime baseline
`1e5e8167f25ce8fb440d7bf8054be44a27d67c0fa71272a5558b01204c24bd0e`,
and policy SHA-256
`06aa441885847cce10b5432120b535657b780726b83327cbfd170b1b455bef22`.
The same 47-case TRAIN-CAL comparison had zero unsafe automatic allows but
**14 unnecessary confirmations**, versus zero for the existing engine. Its
`selected_with_cal_benign_excess` reason is a warning, not an effectiveness
pass. [The CAL evidence inventory](./candidate-8-evidence/cal/SHA256SUMS)
verifies both committed receipts.

The next selection gate is a real, prospective shadow replay of the corrected
96-case Candidate 8 VALID set: source SHA-256
`83c6568bca079f1148feb92ee2b2ecc87f72cfc0d2466ac4838b58cec6bb2714`,
model-free preflight SHA-256
`6e1105e8b78ee030d61b9321fd51cd6bb95978d3f504ff966b5232f99bd04bba`.
Its matched existing-engine baseline is 84/96 correct, with 11 unsafe
automatic allows and **one** unnecessary interruption. Selection requires
zero unsafe automatic allows, no safety or exact hard-block regression, at
most one unnecessary interruption, all 59 prepared model calls answered with
no attempted-call fallback, and warm full risk-check p95 at or below 750 ms.
The sub-500 ms target is an ideal. The six pre-model incomplete-input
fallbacks must remain explicit and cannot be counted as model answers.
No cutoff, model weights, or acceptance criterion may be adjusted using VALID
to rescue this candidate. A failed VALID result rejects it without opening
held-out TEST. Even a passing VALID result would still require a separately
frozen pre-TEST qualification gate and a passing held-out TEST and actual
enforce-path workflow check.
