# Prospective source-blind validation v3 author protocol

Content freeze declaration UTC: `2026-09-20T19:09:26.729863Z`.
Fixture SHA-256: `879c57db43eb20d3cc35d209d364a5aa0a7271e687e3afd4b31761c821e682a8`.
The exact protocol SHA-256 and completed permission-seal UTC are reported to ROOT outside this document to avoid a self-referential hash.

## Authorship and scope

This is new machine-authored validation material, written by the delegated author at ROOT's request. It has not received human review. It is authored fact-extraction material with checked gold, not a claim of an independent human benchmark, natural production distribution, held-out population, or completed model evaluation. No inference outcomes existed in the author's work before content freeze.

The author invented all trace facts and questions. The author did not inspect project source, old fixtures or corpora, any other agent's artifacts or outputs, model results or predictions, Git, memories or rollout records, credentials or configuration, network resources, models, or GPU state. Filesystem access was limited to creating this directory and reading/writing the two authored files. Computation used Python standard-library functions and CPU only. Terminal commands were inline authoring and gold checks; no persistent generator/check script was added.

Case and family labels were assigned prospectively by the author under ROOT's requested coverage. The labels describe intended semantics; they do not imply empirically established statistical independence. Each case has its own trace and requested answer. Two pairs were deliberately split into singleton families: scoped multiline header extraction versus exact multiline body-line counting, and token lookalike lookup versus exact full-line readiness lookup. This yields 24 distinct cases across 14 declared families.

## Exact transport and host-only gold

The JSON structure is exactly `{"version":1,"cases":[{"id":string,"family":string,"question":string,"trace":string,"expected":object}]}`. The version identifies this authored envelope, not an existing project schema. ROOT may adapt transport to its evaluator before inference without changing these frozen question, trace, expected, id, or family values. Any necessary authoring correction requires a new version and a new freeze; never edit this material after inference or outcome inspection.

For model inputs, forward only each case's question and trace. Expected answers are host-only and must never be forwarded. Keep this fixture, protocol, and any gold-bearing adapted corpus outside every model/helper file-access allowlist. The author has not forwarded gold to a model. ROOT is responsible for enforcing that boundary during evaluation, including autonomous tool calls. Preserve exact Unicode code points, LF/CRLF distinctions, whitespace, and record order when adapting transport.

Every question specifies a JSON object with exact keys and string/integer types. Host scoring must check key-set equality, JSON types, and exact values; booleans do not satisfy integer fields. Compare strings as exact Unicode code-point sequences without normalization or trimming. Parse returned JSON before scoring. Extra keys or prose are failures of the requested answer format. Gold does not depend on codec knowledge, helper internals, or external facts. Instruction-looking text is explicitly stored data in its cases.

## Prospective evaluation declaration

ROOT's stated plan is four arms: raw/read-only, compact/read-only, raw/helper, and compact/helper, using all 23 SF units, the same Grok model, autonomous tool calls for helper arms, and four counterbalanced repetitions. This document records that prospective plan only; the author did not inspect model configurations or perform inference. ROOT must freeze evaluator transport, arm definitions, allowed helper access, repetition order, and scoring before actual inference. Report any deviation honestly. This fixture is not evidence that any arm, codec, model, or helper succeeded.

## Gold verification before freeze

Construction-derived gold was checked by two complete, separately implemented stdlib recomputations over the final trace strings. Both passed all 24 cases, all 56 answer fields per implementation, and exact field-type checks: 48 full-case comparisons and 112 type/value field comparisons in total.

Implementation A used regex record grammars, datetime ISO parsing and UTC conversion, Fraction arithmetic, diff marker reconstruction, sets, sequential record parsers, and JSON decoding. Implementation B used literal prefixes/partitions, signed-offset arithmetic on calendar ordinals, integer numerator/denominator accumulation reduced with gcd, before/after assignment maps, occurrence-count maps, exact delimiter indexing, and Python literal decoding for the JSON-compatible quoted strings. Unicode fields were extracted independently without normalization. Both diff implementations validated full old/new hunk counts and start positions. Both timestamp implementations checked that the maximal instant is unique. The arithmetic cross-checks produced integer `66` across 42 terms and rational `5749/1260` across 32 terms. These are host verification facts and must not appear in model inputs.

## Size and declared families

Fixture size: 64,014 bytes. Aggregate trace UTF-8 size: 49,023 bytes. Minimum trace: 1,100 bytes. Maximum trace: 3,204 bytes. Every trace is between 1 and 6 KiB. Cases v3-20, v3-22, v3-23, and v3-24 are short controls dominated by nonrepeated context records; v3-22 deliberately includes three real matching body events. Their role is to reduce reliance on repeated-text savings; no entropy or codec incompressibility claim is made. The majority of other traces repeat useful records, occurrences, contexts, or legitimate log noise while retaining task-critical exceptions.

| Author-assigned family | Cases |
|---|---:|
| config_diff_control | 2 |
| explicit_arithmetic | 2 |
| heterogeneous_full_line_lookup | 1 |
| heterogeneous_token_lookalike_lookup | 1 |
| legitimate_repeated_event_counts | 2 |
| literal_signed_prefix_rows | 2 |
| multiline_exact_body_line | 1 |
| multiline_record_scoped_header | 1 |
| ordered_last_write | 2 |
| quoted_instructions_are_data | 2 |
| status_progression_final_failure | 2 |
| timestamp_unordered_offsets | 2 |
| unicode_crlf_literal_fidelity | 2 |
| unique_error_needle | 2 |

## Freeze and permission seal

After both gold checks passed, the author created this protocol once with exclusive creation and applied mode 0444 to both files and mode 0555 to their directory. SHA-256 and actual modes were verified at seal time. This is a filesystem permission seal, not tamper-proof storage; a privileged process could alter it. ROOT must recheck these exact hashes immediately before inference and after evaluation. No author edits are permitted after this declaration. A change requires a separately named versioned fixture with a fresh declaration, never a mutation informed by outcomes.
