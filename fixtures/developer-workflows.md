# Developer workflow decision corpus

This frozen authored corpus tests Salesforce capability routing, developer evidence scoring, and factual judgments with explicit uncertainty. It contains synthetic local contexts, source snippets, execution records, and requirements. Its organizations, people, commits, paths, identifiers, and outcomes are fictional. Labels follow the supplied evidence and task contract; no model or teacher supplied the answers.

The corpus contains **546 records representing 273 independent scenarios**. Each scenario has one state record and one chat record with the same evidence and target. Paired records test representation and ordering robustness; they are not independent statistical samples.

| Split      | Scenarios | Records | Choice | Score | Noul |
| ---------- | --------: | ------: | -----: | ----: | ---: |
| Train      |       195 |     390 |    130 |   130 |  130 |
| Validation |        39 |      78 |     26 |    26 |   26 |
| Test       |        39 |      78 |     26 |    26 |   26 |
| Total      |       273 |     546 |    182 |   182 |  182 |

## Ground truth and coverage

Choice questions use the actual `availableRouteFamilies` catalog: `agentscript`, `apex`, `flow`, `lwc`, `data360`, `soql`, `docs`, `browser`, `code-analyzer`, `slack`, and `herdr`, plus `mixed` and `general`. Each target has five training scenarios, one validation scenario, and one test scenario, giving exactly 10/2/2 records per target. The state contains a hypothetical active tool inventory using names present in the installed sf-pi source. Chat contains the identical structured evidence serialized as canonical JSON. Candidate lists are rotated and reversed between paired variants. Three general scenarios restrict the active catalog; inactive capabilities are absent from their candidates.

The cases distinguish Apex authoring/testing/tracing from scanner diagnostics, Flow authoring from an Apex cause, LWC source work from rendered browser inspection, Salesforce CRM queries from Data Cloud operations, source lookup from supplied-text explanation, agent lifecycle work from similarly named Apex classes, and orchestration planning from executing multiple operations. Excluded work, quoted instructions, and source/log strings do not become requested operations. `mixed` requires multiple distinct requested capability operations. `general` also covers requests for which no active specialized family applies.

Score questions grade **0–4 earned points** against four observable requirements. They include relevant versus unrelated tests, target/version/commit identity, partial completion, cancellation, cleanup, no replay, cache integrity, source/evidence mismatch, Apex bulk behavior, CRUD/FLS checks, SOQL binding, deployment attribution, and rollback. Rubric wording varies across cases. **44 records in 22 scenarios have fractional targets**: the stated policy awards half a point for exactly one established component of a named two-component requirement. Fractions are earned credit, not model confidence. Ordered integer anchors remain unchanged between each state/chat pair; RFDT normalizes fractional targets between adjacent anchors.

Noul questions evaluate a specific proposition from the supplied facts. `true` means established, `false` means contradicted, and `null` means neither established nor contradicted. Pending historical snapshots are explicitly separated from the observation time. Acceptance, scheduling, coverage, a stale report, or an unrelated passing test cannot establish a later completed outcome. Noul labels are 52 true / 52 false / 26 unknown training records and 10 / 10 / 6 records in each other split. Truth-criteria object order is reversed between paired variants.

The score and Noul scenarios each cover approximately equal numbers of local TypeScript and Salesforce tasks. TypeScript cases include async control flow, queues, tests, package consumers, runtime values, streams, atomic writes, and recovery. Salesforce cases include Apex, sharing/CRUD/FLS distinctions, SOQL, partial DML, asynchronous jobs, validation, deployments, and rollback. Hypothetical authorization inside a fixture is classification data; it grants no authorization to send Slack messages, activate resources, or deploy anything in this session.

## Split isolation and evaluation rules

Every scenario and both of its variants belong to one split. IDs and exact semantic context strings are unique across scenario groups. Broad concepts recur across splits, but held-out scenarios use different evidence and requirements; this is scenario isolation, not a claim of topic isolation or real-world sampling.

Use only `train` rows for optimization. Use `validation` for prompt, threshold, model, and hypothesis selection. Do not perform test inference or use test answers to tune a candidate. Freeze the candidate, source, policy, model identity, cache state, and evaluation conditions before the single final test. Record paired agreement and scenario-level results alongside record-level quality metrics. Speed and resource claims require matched completed-task measurements; the dataset alone establishes neither.

The previous quality corpus and failed student final test remain historical evidence. This corpus does not replace the existing public RFDT approval suite or retroactively approve that student. Any new candidate must satisfy the root experiment's frozen acceptance protocol. The fixture is compatible with `QualityRecord` and persisted `RfdtExample`; supplied targets require no teacher labeling.

## Frozen identities and data checks

Freeze date: 2026-09-20. JSONL size: **1,111,668 bytes**.

- Raw JSONL SHA-256: `c0af6534a4939921758607f658dd9c59edb764377722ae255dfdaecc6e815a87`.
- Quality-normalized dataset SHA-256: `2c33906806ab68b7f5aab8b3115da8c97042ed14cd7a10df8257062273ee7d5c`.
- Normalized train SHA-256: `cddfc0c63c9971a52a29d3c9453fd949d793af09f6c7c70e97d9d27237f8093d`.
- Normalized validation SHA-256: `0b96e0c14d55045d7c00c74c104b1850b923bb11c884f1e88c491d1737276f30`.
- Normalized test SHA-256: `ffcb442bdfb9f0067ac6f4cbc46fc0d93d13135bf0e9cf1bd76d46207f026204`.
- Unchanged legacy `quality.jsonl` SHA-256: `cd3de2d07db024aeb0f8d22be394ffa9024307680efbe2967569c325bc7af3c9`.

Raw and normalized digests differ because the quality API normalizes optional request properties and serialization. Always name which identity a report or training input binds.

Data-only verification accepted all rows using the existing quality loader and persisted RFDT validator, checked every target, compiled every v2 prompt without inference, checked pair labels and ordering, confirmed active candidates and split/group/context isolation, checked for session-token patterns and personal workspace paths, and verified the legacy corpus hash. No model inference, training, build, network request, or commit was performed while authoring this fixture. Existing normalized Request objects can contain undefined optional properties; validate RFDT inputs from persisted JSON or after a JSON round trip.
