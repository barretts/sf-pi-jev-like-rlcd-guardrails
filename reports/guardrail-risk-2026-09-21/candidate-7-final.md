# Candidate 7 delivery report (2026-09-22)

**Evaluation in progress.** This document records the frozen C7 source and
evidence boundaries. It is not a candidate-selection result until both real
model VALID receipts and their measured outcomes are incorporated below. The
existing sf-guardrail engine remains active; Jev defaults to `off`. No held-out
TEST call or enforcement qualification is claimed here.

## Measured result

The 128- and 256-update models must each be scored against the same 65-case,
22-group VALID set through the pinned sf-pi shadow bridge. Record each model's
expected-action matches, unsafe automatic allows, baseline safety regressions,
hard-block demotions, benign interruptions, model-call completion and fallback,
warm p95 and maximum including preparation and queueing, cold initialization,
and every failed selection gate. Retain the raw per-case reports even when a
candidate fails. A passing VALID candidate is only eligible for a separately
frozen held-out TEST; a failed VALID candidate must not open TEST.

| VALID measure                                         | Existing engine | 128 updates | 256 updates |
| ----------------------------------------------------- | --------------: | ----------: | ----------: |
| Expected actions matched, of 65                       |              60 |     pending |     pending |
| Unsafe automatic allows, of 29 risky cases            |               3 |     pending |     pending |
| Unnecessary confirmations or blocks, of 36 safe cases |               2 |     pending |     pending |
| Prepared semantic model calls answered                |               — |     pending |     pending |
| Warm risk-check p95                                   |               — |     pending |     pending |
| Calls beyond 750 ms hard deadline                     |               — |     pending |     pending |

The baseline numbers come from the frozen fake-provider **host preflight**, not
from either C7 model. They reflect the final code-owned preview-send floor:
60/65 expected actions, three unsafe automatic allows and two benign
interruptions. Of 65 requests, 36 reached the semantic model lane (28
rubric-safe, eight approval-required); 21 hit exact/code-owned policy floors,
five were ineligible and three used pre-model fallback. The 29 risky cases
include 21 outside the model lane. Model effectiveness claims must therefore
identify the eight prepared risky cases separately from code-owned protection.

## Frozen training and source

The C7 admission contains 227 TRAIN rows in 77 complete operation groups:
175 inherited admitted C6 rows plus 52 new contrast rows in 18 groups (26
allow/26 confirm). The admitted TRAIN JSONL SHA-256 is
`745004e919d7c8cd6d3a1bb0078f741a9fa6134443ea195b618cf6a39aed53e7`.
Neither RFDT run prepared internal VALID or TEST rows. Both use the original
Google `google/gemma-3-1b-it` base revision
`dcc83ea841ab6100d6b47a070329e1ba4cf78752` and the fixed v2 scoring
protocol SHA-256
`d67044fb1a5d2a519f12e8e7ed743f42753f726812b0bd99ea6ab530`.
The TRAIN source commit is `845b67913f099897241b88451bf463d1d98c6312`;
the two training plans were fixed before C7 VALID model scoring.

The independent VALID evaluator commit is
`d064f7402d9e8eebf0cc9bdb811dee7a59210976`, and its corrected blind
manifest SHA-256 is
`868dac2146b72e732b07017c451f88f1066c2faea3c46300f5fba75545e76200`.
Its held-out TEST manifest is an opaque seal here. It is not a scored set.
The authored VALID rubric is independent of the current engine's baseline;
disagreement with the engine does not automatically count as model error.

## Integration and proof limits

The [baseline-bound C7 sf-pi patch](../../integrations/sf-pi-guardrail/candidate7-sf-pi-from-4f901db9.patch)
reproduces evaluation host commit `bc7862b078997d2c60aa908979b5cbf59f83db80`
and tree `77baa1b435e07da31675a26ead942d36f0a1bdbe` from baseline
`4f901db9c3f5076ea0305dea33ad6e8856e467da`. Its SHA-256 is
`b1a6e9cbaa436b803fe43b88cc4472f08e1df4261b5ce22001486ca8caeb4bae`.
The evaluation-host runtime SHA-256 is
`6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e`.
The patch was checked with a disposable Git index, leaving sf-pi's working
files and index unchanged. The 52 newly authored TRAIN requests generated
byte-identical model inputs on the prior training host and this evaluation
host; the 175 inherited C6 TRAIN inputs were not reprojected.

The comparison uses stubbed tool execution and authored org/browser facts.
The scorer observes the actual code-owned risk floors before model comparison,
but the VALID replay is a bridge-shadow test, not a live external workflow or
full Pi approval/audit lifecycle. Browser evidence describes the observed
request context, not a future live click effect. Latency is measured on a
serial isolated replay; cold initialization is separate. Model scores are
uncalibrated. A finite zero-unsafe result would not prove 100% population
accuracy, and no model may be enabled without the frozen held-out gate.

Once both real VALID reports exist, run
`scripts/guardrail-candidate7-package-evidence.mjs` with the frozen TRAIN and
evaluator roots and the two real `report.json` paths. It refuses fake-provider
receipts and TEST material, copies the small original receipts byte-for-byte,
and writes a SHA-256 inventory. GGUF weights and adapters remain local and
must be named by hash and path in this report, not copied into Git.
