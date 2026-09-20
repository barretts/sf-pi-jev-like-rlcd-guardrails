# Exact-excerpt answer-effectiveness evaluation

The bounded evaluation is finished. It used the same configured Grok 4.6 task model in both arms, genuine Pi builtin reads, exact-excerpt compression with original retrieval, and all 23 controlled SF extension factories.

Exact workflow acceptance was **84/96 (87.50%) with full context** and **86/96 (89.58%) with excerpts**. Wrong answers and execution errors remain in these denominators.

| Outcome | Full context | Exact excerpts |
|---|---:|---:|
| Scheduled workflows | 96 | 96 |
| Recorded workflows | 96 | 96 |
| Accepted answers | 84 | 86 |
| Wrong completed answers | 9 | 8 |
| Execution errors | 3 | 2 |
| Unrun workflows | 0 | 0 |
| Workflows with actual wire compression | 0 | 48 |

Across matched workflows, **1 favored full context** and **3 favored excerpts**. These include execution failures; they are not necessarily differences between two completed answers.

Among **48 pairs with actual compression**, 42 accepted both workflows, 1 favored full context, 3 favored excerpts, and 2 accepted neither. Correct literal fallbacks are excluded from this compressed subset.

The independently reconstructed completed-answer and execution outcomes are: both_accepted: 83, both_incorrect: 6, execution_error_pair: 4, improvement: 2, regression: 1.

## Applicability and task families

| Stratum | Full-context accepted | Excerpt accepted | Excerpt workflows actually compressed |
|---|---:|---:|---:|
| native-short | 41/48 | 41/48 | 0 |
| scoped-long | 43/48 | 45/48 | 48 |

| Family and stratum | Full-context accepted | Excerpt accepted |
|---|---:|---:|
| config_diff_control / native-short | 4/4 | 4/4 |
| config_diff_control / scoped-long | 4/4 | 4/4 |
| explicit_arithmetic / native-short | 4/4 | 4/4 |
| explicit_arithmetic / scoped-long | 4/4 | 4/4 |
| heterogeneous_full_line_lookup / native-short | 2/2 | 2/2 |
| heterogeneous_full_line_lookup / scoped-long | 2/2 | 2/2 |
| heterogeneous_token_lookalike_lookup / native-short | 2/2 | 2/2 |
| heterogeneous_token_lookalike_lookup / scoped-long | 2/2 | 2/2 |
| legitimate_repeated_event_counts / native-short | 4/4 | 4/4 |
| legitimate_repeated_event_counts / scoped-long | 4/4 | 4/4 |
| literal_signed_prefix_rows / native-short | 0/4 | 0/4 |
| literal_signed_prefix_rows / scoped-long | 1/4 | 2/4 |
| multiline_exact_body_line / native-short | 2/2 | 2/2 |
| multiline_exact_body_line / scoped-long | 2/2 | 1/2 |
| multiline_record_scoped_header / native-short | 2/2 | 2/2 |
| multiline_record_scoped_header / scoped-long | 2/2 | 2/2 |
| ordered_last_write / native-short | 3/4 | 3/4 |
| ordered_last_write / scoped-long | 4/4 | 4/4 |
| quoted_instructions_are_data / native-short | 4/4 | 4/4 |
| quoted_instructions_are_data / scoped-long | 4/4 | 4/4 |
| status_progression_final_failure / native-short | 4/4 | 4/4 |
| status_progression_final_failure / scoped-long | 4/4 | 4/4 |
| timestamp_unordered_offsets / native-short | 4/4 | 4/4 |
| timestamp_unordered_offsets / scoped-long | 4/4 | 4/4 |
| unicode_crlf_literal_fidelity / native-short | 2/4 | 2/4 |
| unicode_crlf_literal_fidelity / scoped-long | 2/4 | 4/4 |
| unique_error_needle / native-short | 4/4 | 4/4 |
| unique_error_needle / scoped-long | 4/4 | 4/4 |

## Physical usage

Whole-campaign task/compressor prompt reduction was **60.76%**, across every physical task and compressor request, including failed ones. Supplementary judge requests are reported separately. No failed request is assumed to cost zero. This aggregate of attempted workflows is not a successful-workflow performance qualification.

| Request class and arm | Physical requests | Known-usage requests | Unknown-usage requests | Prompt tokens | Output tokens | Total tokens |
|---|---:|---:|---:|---:|---:|---:|
| task/compressor / raw | 193 | 193 | 0 | 1593640 | 67235 | 1660875 |
| judge / raw | 47 | 12 | 35 | unknown | unknown | unknown |
| task/compressor / compressed | 206 | 206 | 0 | 625273 | 86569 | 711842 |
| judge / compressed | 47 | 12 | 35 | unknown | unknown | unknown |

Missing cache accounting prevents a billing or uncached-token savings claim. Physical multiplicity is preserved even when request hashes repeat. No summary model was introduced by the excerpt strategy.

## Supplementary Grok judgments

| Arm | Scheduled | Valid judgments | Supported | Unsupported | Failed | Invalid format | Unrun |
|---|---:|---:|---:|---:|---:|---:|---:|
| raw | 48 | 12 | 12 | 0 | 35 | 0 | 1 |
| compressed | 48 | 12 | 12 | 0 | 35 | 0 | 1 |

Valid judge/gold disagreements: **0**. Grok judgments cannot override the strict frozen gold. Failed or missing judgments do not establish support; their cause is not inferred from HTTP status alone.

## What this establishes

This determines exact-answer effectiveness on the complete frozen synthetic comparison, including short controls and long scoped variants. It does not establish population noninferiority, natural production effectiveness, developer task completion, billing savings, or a production qualification. Two repetitions of shared invented evidence are correlated observations.

All 48 gold cases were independently recomputed on CPU against unchanged expected answers. That reproducible checker was implemented after inference began; the source-blind author had separately attested two pre-freeze checks. Final answer text was deliberately not persisted. The independent audit verifies scorer provenance, source pins, individual scalar/hash workflow records and aggregate calculations; it is not an independent rescoring of model text.

Protocol SHA-256: `17c0649f10a4d9733afaef650660bd2923c9efa6e580fd1f169791b2dfdf95ab`. Final sanitized result SHA-256: `d42a2f6a786ac5dcbaf4ffa117244ca5b4ebfef66bd7538f399ea002de3883d4`. Fixture SHA-256: `50705ffe1f622d72a5bb96018006240a8c77ec84975a612cad1495303b174f2a`.

Verified pins: 26 runtime/source files and 24 controlled SF files. Runtime credential cleanup completed. HTTP 429 responses: 0. See `independent-audit.json`, `result-projection.json`, the archived source and the prospective protocol for individual results and boundaries.

Additional measured tradeoffs: task/compressor total tokens fell **57.14%**, while output tokens increased **28.76%**. Summed physical task-request elapsed time, including shared pacing and failed requests but excluding judges, increased **18.67%**. This is a controlled request-time measurement, not production latency.

All **187 completed workflows** verified exact canonical originals, provider-wire delivery and affirmative session cleanup. Exact-original proof was available in 190/192 total workflow records; two failed workflows lack that affirmative proof. All 192 session cleanup records and final runtime credential cleanup were affirmative.

The one answer regression is `quality-v3-22-long__r1`, an exact multiline body-count/position task. Its excerpt workflow returned valid JSON matching one of two expected fields despite a recovery turn. The second repetition passed. The two completed-answer improvements are the long Unicode/spacing case, where both raw final answers failed JSON parsing and excerpt answers passed strict scoring. One additional workflow improvement was a correct excerpt answer paired with a raw execution error. These facts do not establish an omission-only cause or a universal accuracy guarantee.
