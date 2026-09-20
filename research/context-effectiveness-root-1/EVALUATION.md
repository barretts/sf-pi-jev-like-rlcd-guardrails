# Exact-excerpt answer-effectiveness evaluation, prospective V1

This campaign is running. It has no final answer-quality conclusion yet.

The intervention is the existing exact-excerpt implementation, with Google/local model training held fixed by using the same configured Grok 4.6 task model in both arms. Actual Pi sessions load all 23 controlled SF extension factories. They use genuine builtin `read` and the registered `jev_context_read` recovery tool; access to other files and tools is blocked. Original short traces and long scoped variants are evaluated in both arms, in two counterbalanced repetitions: 192 scheduled workflows, 96 per arm.

The 24 original V3 cases were authored without inspecting project source or inference outcomes. The author recorded two separately implemented pre-freeze gold recomputations covering 24 cases and 56 fields each. This author attestation is not a human benchmark or a separately published executable checker. Original fixture SHA-256: `879c57db43eb20d3cc35d209d364a5aa0a7271e687e3afd4b31761c821e682a8`.

The 24 long variants contain exact byte-preserving copies of the original evidence inside explicit delimiters, surrounded by deterministic unrelated padding. Their questions scope every line/count/record operation to that exact enclosed text, so the original gold remains unchanged. Automated checks independently extract and compare the enclosed text, including Unicode, whitespace and CRLF. These are synthetic long-output stress cases, not natural production traces. The gold-bearing fixture lives outside every session's authorized workspace and is never sent to task or judge models.

Primary scoring parses the final answer as JSON and checks exact key set, type and field value. Extra keys, prose, numeric coercion, missing fields and altered strings fail. Workflow errors and unrun slots remain in the denominator. Results include paired regressions and improvements, with separate summaries for original short controls, long variants and the subset with actual provider-wire compression. A correct literal fallback is not evidence that compressed answers are correct. Pending pairs must not be interpreted as completed answer failures.

A supplementary Grok judge checks factual support against the question and complete original trace, without gold or arm identity, for each first-repetition workflow: 96 planned judgments, 48 per arm. It cannot override exact scoring. Judge failures, malformed responses and unrun slots remain visible. Judge requests use the same shared five-second pacing, zero retries and bounded response/timeout limits. Their physical usage is logged separately from task/compressor token reduction.

The completed comparison will report full coverage, exact acceptance and paired regressions, compression applicability, factual-support judgments and disagreements, physical token usage, recovery overhead, and lifecycle/wire/original preservation. A small repeated synthetic evaluation cannot prove population noninferiority or production usefulness. A negative answer-quality result is a valid evaluation conclusion; it will not be removed or reclassified to obtain a passing result.

Frozen run protocol SHA-256: `17c0649f10a4d9733afaef650660bd2923c9efa6e580fd1f169791b2dfdf95ab`. Private runtime journal: `.build/context-effectiveness-root-1/result.json`. Public evidence will contain only approved synthetic fixtures and scalar/hash projections, never captured SF instructions, provider bodies, credentials or free-form errors.

Local preparation checks: 21 focused Node protocol tests passed. The actual inference campaign is separate evidence and is not yet complete.

An additional reproducible Python gold checker was implemented after inference began. It independently verified all 24 original cases (56 fields) and all 24 exact long scopes against unchanged gold. Its timing is explicit in `gold-check.json`; it is not a second prospective blind author. Seven adversarial CPU tests passed, covering altered gold, malformed diff hunks, repeated-record counts, lookalikes, physical versus timestamp order, unknown usage and full error/unrun denominators. A separate Python scalar/hash auditor checks each saved workflow and frozen source pin, reconstructs family/stratum and paired outcomes, and reports judge disagreements. Final model text was deliberately not persisted, so aggregate auditing is not independent answer rescoring.

The original author's protocol recorded ROOT's earlier plan for a four-arm codec/helper experiment. This campaign preserves that author's questions, traces and gold, but follows its separately frozen two-arm exact-excerpt protocol. It does not claim to execute the author's four-arm protocol.

To reproduce with a new output directory, prepare first and use the returned protocol SHA for execution:

```sh
node scripts/context-reduction-smoke.mjs --prepare \
  --output "$PWD/.build/context-effectiveness-new" \
  --quality-fixture "$PWD/fixtures/context-effectiveness/v1.json" \
  --strategy excerpts --with-sf-pi \
  --sf-pi-path /Users/bsonntag/code/sf-pi-jev-manager

node scripts/context-reduction-smoke.mjs --run \
  --output "$PWD/.build/context-effectiveness-new" \
  --quality-fixture "$PWD/fixtures/context-effectiveness/v1.json" \
  --strategy excerpts --with-sf-pi \
  --sf-pi-path /Users/bsonntag/code/sf-pi-jev-manager \
  --expected-protocol-sha RETURNED_SHA \
  --api-key-file /Users/bsonntag/opt/eval-agents/secrets/llmgw-key

python3 scripts/context-effectiveness-gold.py \
  --fixture fixtures/context-effectiveness/v1.json \
  --output .build/context-effectiveness-new/gold-check.json

python3 scripts/context-effectiveness-audit.py \
  --directory .build/context-effectiveness-new \
  --fixture fixtures/context-effectiveness/v1.json \
  --output .build/context-effectiveness-new/independent-audit.json
```

The audit reports both paired completed-answer outcomes and paired whole-workflow acceptance. A correct compressed answer paired with a raw execution error is a workflow improvement, not proof that the compressed answer was more factually accurate than a completed raw answer. Results also separate short and long usage and retain per-case repetitions. The two repetitions are correlated observations of invented cases and are not treated as independent population samples.
