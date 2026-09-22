# Candidate 6 TRAIN/VALID source corrections (development only)

The Candidate 5 research export had six certainly invalid TRAIN examples and
twelve source-invalid or ungrounded development VALID examples. The TRAIN
examples used a ten-character `001EXAMPLE` Account ID or ran the
scratch-org-only `sf org generate password` command against production. The
VALID examples used the same invalid ID, a placeholder deployment job ID, or
quick deploy against a scratch org. Salesforce's [record-ID rule], [record
update command], [permission-set assignment], [deploy start], [quick deploy],
and [deploy report] references establish the replacement command forms. No
Salesforce operation was executed.

[`scripts/guardrail-candidate6-corrections.mjs`](../../scripts/guardrail-candidate6-corrections.mjs)
pins the final Candidate 5 research input SHA-256, applies six source-validity
corrections, and withholds the remaining `sf apex run --file` TRAIN near replay.
It also withholds the existing nonproduction `sf project deploy start` TRAIN
group, which would otherwise nearly replay the corrected scratch-org VALID
operation. It regenerates each model request, synchronizes the independently
supplied org-command fact, checks the revised ID and job references, and
requires explicit fixture preconditions. Those fixture declarations are not
proof of record existence, deploy-job history, or live command success.

Run from the Candidate 5 Jev worktree after `npm run build`, using unused output
paths:

```sh
node scripts/guardrail-candidate6-corrections.mjs \
  --input .build/guardrail/candidate-5-research-split-e456e1c9-20260922/merged-train-validation.jsonl \
  --output .build/guardrail/candidate-6-dev-corrections-NEW/merged-train-validation.jsonl \
  --receipt .build/guardrail/candidate-6-dev-corrections-NEW/receipt.json
```

The current private receipt contains **161 TRAIN, 96 corrected development
VALID, and zero TEST** rows, with output SHA-256
`5305ae1e746d26dc840d33d0da3c6015a16b2061fbe48a18d734617e6c79bee1`.
It records four unresolved same-effect template overlaps: Data 360 raw GET,
Data 360 raw POST write, ordinary native SOQL query, and Slack Canvas read.
The screen is heuristic and aggregate-only. It neither proves split independence
nor permits training yet. The old VALID set has already been used for model
diagnosis; the corrected set is a development pool, not fresh qualification
VALID. A separately authored, source-reviewed and group-isolated qualification
VALID set must be sealed before promotion or new candidate selection. New rows
also need a fresh sf-pi bridge replay and human label review. Browser effect
binding and coverage remain required for full qualification.

The script reads only the pinned TRAIN/VALID research file and rejects a TEST
row before accessing its request. It does not read or modify the historical
Candidate 5 corpus, artifacts, receipts, or held-out test.

[record-ID rule]: https://developer.salesforce.com/docs/platform/api/guide/glossary-api.html
[record update command]: https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_data_update_record.html
[permission-set assignment]: https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_assign_permset.html
[deploy start]: https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_project_deploy_start.html
[quick deploy]: https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_project_deploy_quick.html
[deploy report]: https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_project_deploy_report.html
