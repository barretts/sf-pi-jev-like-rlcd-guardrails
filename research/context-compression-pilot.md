# Fixed context-compression validation pilot

This pilot asks whether one fixed representation of repeated completed-tool output preserves the facts needed for six narrow extraction tasks. The intervention is lossless run-length encoding of identical consecutive lines. The comparison changes the supplied context representation while keeping the task, answer model, and inference configuration fixed.

The corpus is [context-compression-validation.json](../fixtures/context-compression-validation.json). It contains six newly authored synthetic traces and literal expected JSON objects. No real identities, endpoints, credentials, heldout datasets, previous corpus outputs, compressor source, or model predictions were used to author these cases. Repetitions expand a small set of authored progress and record lines; the expected answers were written separately from that expansion. The fixture author did not make model calls. This is a small synthetic validation corpus, not independent human gold or an unseen test set.

## Fixed cases

Each record has exactly `id`, `group_id`, `task`, `context`, and `expected`. The `context` is a completed tool capture. A timeout case has a completed capture wrapper but an unresolved underlying operation; those are different facts. Context sizes below count UTF-8 bytes of the decoded context string, including its final newline, rather than escaped JSON file bytes.

| Case                          | Context bytes | What must survive                                                                                                                                                                |
| ----------------------------- | ------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `late-unit-failure`           |         9,797 | Compilation and a smoke check pass before the final unit test fails; the final failed title and count control the answer.                                                        |
| `timeout-outcome-unknown`     |         9,912 | Queue acceptance and a keepalive precede a wrapper timeout; the operation outcome remains unknown and no durable receipt is present.                                             |
| `negative-enabled-row-count`  |        10,402 | Identical adjacent negative rows are distinct emitted records. There are 21 enabled negative records totaling -102, three disabled negative records, and two zero-value records. |
| `required-proof-missing`      |        10,262 | A malformed scan file and an absent running-artifact observation remain missing required evidence, even though the collection wrapper exits successfully.                        |
| `quoted-untrusted-route-text` |        10,379 | Quoted requests to override the task and route to a privileged runner are artifact data. The validator rejects the note with two violations and executes no routing action.      |
| `superseded-artifact-success` |        11,076 | A later failed attempt supersedes an earlier cached success. The earlier artifact is invalidated and the latest attempt registers no usable artifact.                            |

Facts appear near the start, between repeated runs, and near the end. Repeated progress lines are intentionally realistic static polling messages without per-poll timestamps. The allocation case also repeats data rows, so a transformation cannot treat every repeated line as semantically ignorable noise. Counts must retain multiplicity.

## Preset procedure and correctness checks

Freeze the fixture bytes, compressor version, task prompts, answer-model configuration, and judge configuration before inference. Record their identifiers in the run artifacts. Do not alter cases, expected objects, compression rules, routing, or prompts after seeing model outputs. A later revision is a new validation version and requires reporting its change rather than replacing the earlier result.

Use Grok4.6 as the answer model in both arms. Record the exact runtime model identifier and provider configuration; a model label alone is insufficient attribution. Use the same decoding settings, response budget, task prompt, and non-context instruction text in both arms. The raw arm receives the authored context. The compressed arm receives the fixed encoded representation and the fixed interpretation instructions required by that representation. Record those interpretation instructions as part of the intervention. Do not route different cases to different models or choose representations based on answer predictions.

Run each raw/compressed pair under the same preset repetition policy. Keep every attempted response, including parse errors, timeouts, empty responses, and unsuccessful requests. Infrastructure failures are unresolved observations and cannot be scored as correct. If retries are preset, report them rather than retaining only a successful response. This corpus has one scenario per `group_id`; group identifiers are attribution units, not training or test splits.

Answer correctness uses the literal `expected` object in the fixture. The task asks for one JSON object without Markdown or commentary. Apply these checks before assigning a correct result:

1. The complete response parses as one JSON object. Fences, explanatory prose, trailing non-whitespace text, duplicate object keys, and a non-object root fail the format check.
2. The response has exactly the expected keys. Extra keys and missing keys fail.
3. Values match the literal expected JSON values, including strings, booleans, nulls, numbers, and ordered arrays. Object key order is irrelevant. Numeric task fields must be integers; JSON numeric spellings such as `0` and `0.0` have the same parsed value.
4. A missing or unknown outcome stays missing or unknown where the trace says so. Earlier passing checks, acknowledgements, file existence, and cached success cannot replace the final facts requested by the task.

Report paired per-case correctness and format failures, raw-arm failures, compressed-arm failures, and compressed regressions separately. A compact answer matching an already incorrect raw answer does not demonstrate correctness. Passing this fixed corpus requires every raw and compressed response to satisfy the preset expected-value checks, with no unresolved observations. With six cases, results are descriptive; do not extrapolate an estimated population failure rate or general superiority.

## Separate context-preservation check

Context preservation is a separate evidence lane from answer correctness. First perform a deterministic byte-for-byte reconstruction check for every context: decoding the fixed encoded form must reproduce the original UTF-8 context, including line order, repeated-line counts, and the final newline. A smaller representation that cannot round-trip is not this lossless intervention. The fixture author did not run or inspect the compressor; these checks belong to the pilot runner.

A separate context-preservation judge then receives the task, raw context, encoded context, and the fixed interpretation instructions. Its request is separate from the answer requests and uses a fixed, recorded model/configuration across all pairs. Do not give that judge the answer model's predictions or use its assessments to revise the fixture, expected answers, or intervention. The judge assesses whether the represented context retains the required facts and their usable distinctions: order and supersession, timeout versus confirmed completion, absence of evidence, untrusted quotation boundaries, and occurrence counts for repeated records. Record the judge's full response and any failure to obtain a judgement. Treat it as a model assessment, not independently established ground truth.

The exact expected-value check decides answer correctness. The round-trip check establishes literal information retention. The separate judge supplies an additional assessment of whether the encoded representation communicates the relevant distinctions. A successful result in one lane cannot silently clear a failure or unknown result in another.

## Limits on saving claims

Measure raw and encoded context bytes and, when available, actual answer-request input tokens from the provider. Include representation instructions and envelope overhead in the compressed request measurement. Keep output tokens, judgement-request tokens, retries, inference latency, and local transformation time as separate recorded quantities. Report actual measurements rather than equating fewer bytes with fewer billed tokens.

These six traces validate a narrow completed-tool context intervention. They do not measure full-pi or full-workflow savings, live tool behaviour, multi-step agent completion, deployment clearance, quality on unseen tasks, or the economics of production traffic. In particular, input-context reductions alone cannot establish total workflow cost or time savings, and the added preservation-judge request is part of the pilot's measurement overhead.

## Running the fixed pilot

The experimental codec is [context-compression.ts](../src/context-compression.ts), and the runner is [context-compression-eval.mjs](../scripts/context-compression-eval.mjs). This pilot does not install a Pi context hook or replace stored tool results. The caller retains the original text and its independently trusted digest; only the candidate model input uses the compact representation.

Build and prepare a fresh output first:

```sh
npm run build
node scripts/context-compression-eval.mjs \
  --output .build/context-compression-pilot/result.json
```

Preparation makes no inference requests. It writes a protocol containing the fixture, source and runtime hashes, full interpretation prompts, selected registration, settings, and alternating pair order. To consume that exact preparation with the existing gateway credential:

```sh
node scripts/context-compression-eval.mjs \
  --output .build/context-compression-pilot/result.json \
  --api-key-file "$HOME/opt/eval-agents/secrets/llmgw-key" \
  --run
```

The runner verifies that the frozen protocol still matches current inputs and refuses to overwrite an attempted run. A new experiment requires a fresh output path. It sends the credential only to the exact configured gateway, does not follow redirects, and retains selected numeric usage counters and assistant answers without authentication headers. HTTP errors, incomplete responses, invalid answer formats, and unknown usage remain visible. The process exits unsuccessfully if any expected answer, preservation judgement, or inference request fails.

## Observed result on 2026-09-20

The completed [third run](context-compression-pilot/run-03-completed/result.json) used the existing `llmgw/grok-4.6` registration for both answer arms and for six separate preservation requests. Both answer arms passed all six literal expected objects, every context reconstructed exactly, all six preservation judgments passed, and all 18 calls finished successfully. The selected gateway rejects the temperature field, so both arms omitted it; the provider temperature is unobserved. The task response allowance was 2,048 tokens and the judge allowance was 32,768 tokens. These are response limits, not estimates of actual consumption.

| Measurement across all six tasks                     | Original context | Compressed context |
| ---------------------------------------------------- | ---------------: | -----------------: |
| Correct task answers                                 |              6/6 |                6/6 |
| Context UTF-8 bytes                                  |           61,828 |             14,550 |
| Reported task prompt tokens, including cached tokens |           13,858 |              5,557 |
| Reported task completion tokens                      |            3,376 |              6,195 |
| Reported cached task prompt tokens                   |           13,568 |              5,120 |
| All-attempt client elapsed time                      |         20.864 s |           32.760 s |

The compressed representation reduced context bytes by 76.47% and task prompt tokens by 59.90%. Recorded local compression across all six traces took 2.63 ms. Task completion tokens increased and client elapsed time was 57.01% higher. This is a narrow context-capacity observation with preserved sample answers; it does not qualify as a speed improvement. The repeated run observed substantial remote prompt caching, leaving 290 uncached original prompt tokens versus 437 uncached compressed prompt tokens. Billing savings cannot be derived from the reduction in total prompt tokens.

The six separate judge requests consumed another 18,291 prompt and 32,180 completion tokens and 192.547 seconds. That overhead belongs to this validation exercise. It is not installed in a production context hook. The model's preservation judgments supply additional assessment; the deterministic round trips establish exact information retention.

Earlier outcomes remain available. [Run 1](context-compression-pilot/run-01-temperature-rejected/result.json) retained all 18 HTTP 400 errors because the gateway rejected the temperature field. Its [selected diagnostic](context-compression-pilot/run-01-temperature-rejected/gateway-diagnostic-selected.json) records that reason without authentication data or unrelated fallback catalog entries. [Run 2](context-compression-pilot/run-02-judge-limit/result.json) answered all six tasks correctly in both arms, with zero reported cached prompt tokens, but five of its six judges exhausted the 4,096-token response allowance. Those incomplete judgments remain unknown. Its compressed task prompts also used 59.90% fewer tokens while aggregate client latency increased by 55.76%.

Run 3 changed the judge response allowance and timeout, preserving all 12 task request hashes from Run 2 exactly. Each version retains its protocol and source snapshots. Independent audits verified all populations, expected-answer gates, reconstructed request hashes, snapshot pins, round trips, usage and timing totals: [Run 2 audit](context-compression-pilot/run-02-judge-limit/independent-audit.json) passed 257 checks and [Run 3 audit](context-compression-pilot/run-03-completed/independent-audit.json) passed 260. Raw gateway response bodies were not retained, so their recorded digests cannot be independently recomputed. Neither successful preservation judging nor these repeated synthetic cases establishes a full Pi workflow gain or unseen-task quality.
