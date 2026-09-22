# Candidate 6 research handoff

`scripts/guardrail-candidate6-research-merge.mjs` is a model-free, nonqualifying
merge gate. It checks the pinned corrected development pool (158 TRAIN and 96
historical diagnostic VALID rows), the separately preflighted 18-row TRAIN
supplement, their receipts, the current sf-pi source identity, and the Jev
scoring protocol. Every RFDT request must regenerate from its recorded state;
IDs, inputs, and operation groups must remain distinct across the two sources.

Run from this Jev worktree with the current sf-pi worktree:

```sh
node scripts/guardrail-candidate6-research-merge.mjs \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --output-dir .build/guardrail/candidate-6-research-merge-NEW
```

The output directory must be fresh. The gate writes **separate** files:

- `train.jsonl`: 176 TRAIN rows only (158 corrected plus 18 supplement).
- `historical-diagnostic-valid.jsonl`: 96 historical VALID rows only. This file
  is for diagnosis, not candidate selection or qualification.
- `receipt.json`: source hashes, current host identity, blind byte seals,
  aggregate request-only collision counts, and proof limits.

The historical 96-row VALID pool is distinct from the prospective sealed
Candidate 6 VALID v3 split (54 cases). The sealed TEST v2 split (47 cases) and
prospective VALID split are not copied into either JSONL. Their original bytes
are hashed as opaque streams; the existing blind screen reads requests and
returns only aggregate exact, canonical, group, template, and same-effect
collision counts. Zero reported collisions is a necessary screen, not proof of
semantic independence.

The receipt deliberately sets `trainingReady: false`,
`humanLabelReviewed: false`, and `qualification: false`. It also records zero
model calls, zero `prepareRfdt` calls, and zero external tool executions. No
candidate may be selected from the historical diagnostic file. Separate label
review and admission are still required before TRAIN use; prospective candidate
selection is VALID v3 only, with TEST v2 reserved for a frozen candidate.
