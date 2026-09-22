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
operation. A blind VALID v2 request-only screen and independent effect review
found another genuine near replay of `git reset --hard`; the whole
`train-shell-git-history-rewrite` TRAIN group is withheld. The script also
normalizes three TRAIN Salesforce REST Contact reads from `/query/?q=` to the
documented [`/query?q=` path][query resource], preserving their bounded and
broad contrast.
It regenerates each model request, synchronizes the independently
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

The current private receipt contains **158 TRAIN, 96 corrected development
VALID, and zero TEST** rows, with output SHA-256
`cb50f35f9d0eedf7c366b5093d216839b26c1c7a7103902b81a368addd8a5f09`.
It is stored under `candidate-6-dev-corrections-v4-20260922`; v1-v3 are
superseded development receipts, not training inputs.
It records four unresolved same-effect template overlaps: Data 360 raw GET,
Data 360 raw POST write, ordinary native SOQL query, and Slack Canvas read.
The screen is heuristic and aggregate-only. It neither proves split independence
nor permits training yet. The old VALID set has already been used for model
diagnosis; the corrected set is a development pool, not fresh qualification
VALID. The [separate blind VALID and TEST sets](../../blind-c6-20260922/README.md)
are sealed but the VALID file-policy labels are under source review. The
158 TRAIN rows and final 18-row TRAIN supplement screen at zero exact,
canonical, group, template, and same-effect matches against both blind sets.
The [model-free host replay](../../.build/guardrail/candidate-6-corrected-host-preflight-v2-20260922/receipt.json)
matched all 158 TRAIN and 96 historical VALID requests with zero eligibility
fallback; it found 23 and 24 label-versus-baseline disagreements, respectively.
That result is host-input parity, not model accuracy or training admission.
Human label review and fixture prerequisites remain open. Browser effect
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
[query resource]: https://developer.salesforce.com/docs/platform/api-rest/guide/resources-query.html
