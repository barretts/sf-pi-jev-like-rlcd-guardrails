# Candidate 6 TRAIN supplement

This directory holds a separate, machine-authored TRAIN-only proposal. It is not
part of the trainable bundle or any frozen qualification corpus. Its 18 requests
form eight matched groups across shell, Salesforce, Data 360, SOQL, and Slack
Canvas operations. The Salesforce pair has both `bash` and `herdr_pane` variants
in the same group. Every request states mocked fixture preconditions and, where
needed, independently resolved org facts. Labels follow
[`operation-policy-v2`](../RUBRIC.md), not the current guardrail's decision.

The entire `c6-supp-shell-python-unlink` matched group was withheld after an
aggregate blind screen found same-effect/quoted-harmless-text conceptual overlap
with sealed TEST material. Neither the sealed request bodies nor labels were
opened while making this revision. The remaining groups still require their
own admission screen.

Source checks:

- Salesforce's [sObject REST reference](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-basic-info.html), [record creation example](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-basic-info-post.html), [CLI data query reference](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_data_query.html), and [QueryAll guide](https://developer.salesforce.com/docs/platform/api-rest/guide/dome-queryall.html) support the Salesforce and SOQL request forms. The installed `@salesforce/plugin-api` and `@salesforce/plugin-data` commands were also checked for the used flags and body handling.
- Salesforce's [Data 360 Connect API reference](https://developer.salesforce.com/docs/data/connectapi/references/spec?meta=type%3AOutput+D360+Node+Input) lists both data-space GET/PATCH and member GET/PUT paths. Its PATCH request schema requires `label` and `description`, both present here. Its PUT request sample uses the nested `members.members[]` object with `memberName` and a filter; the proposal follows that shape. The local `sf-data360` registry and dispatcher were checked separately for host routing and execution behavior. Actual fixture DLO and field availability remain assumptions for mocked evaluation.
- Slack's [section lookup](https://docs.slack.dev/reference/methods/canvases.sections.lookup/), [canvas edit](https://docs.slack.dev/reference/methods/canvases.edit/), and [access set](https://docs.slack.dev/reference/methods/canvases.access.set/) references support the POST methods, required bodies, and scopes used here. The access-change fixture assumes the canvas was already shared directly with the named user, as Slack requires.

Regenerate the static JSON with `node fixtures/guardrail/candidate6/build-train-supplement.mjs`.
Run the structural and syntax-only checks with
`node --test fixtures/guardrail/candidate6/train-supplement.test.mjs`.
Neither command sends Salesforce, Data 360, or Slack requests, calls a model, or
executes the authored shell operations. The tests read only this supplement and
historical C5 TRAIN proposals.

The model-free host preflight requires an explicit SHA-256 pin for the authored
JSON and a fresh output directory under `.build/guardrail`:

```sh
node scripts/guardrail-candidate6-supplement-preflight.mjs \
  --sf-pi "$SF_PI" --sf-deps "$SF_DEPS" \
  --supplement-sha256 f6bcd88d9dc546db1f7f7236db55ad5559c82fce3643f18af2d316a9419a2443 \
  --output-dir .build/guardrail/candidate-6-supplement-preflight-NEW
```

It uses mocked host facts and a local discovery stub, and requires every row
to be eligible, unfloored, and unchanged after `prepareJevRiskInput`. On success
it writes an 18-row RFDT TRAIN JSONL and a source-bound receipt with
`trainingReady: false`. The preflight never executes a fixture request or calls
a model. Its failure tests cover a changed source hash and an exact policy floor.

For the pinned JSON above and sf-pi commit `dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277`, the fresh [host preflight](../../.build/guardrail/candidate-6-supplement-preflight-dd97a1a/receipt.json) reached the model input on all 18 requests with no policy floor or fallback. Its dataset SHA-256 is `1976ec21b7e7c3fec3d76d635a754d2db8c620ae0f8c206719adc919992cfeeb`; receipt SHA-256 is `d61128c1ed102b738d1e96ca7256a05ae63a428488e1ca30dc752700c800d7b1`. This eligibility must be rechecked if either source changes. Request-only blind split collision screens have zero matches on the prospective drafts, but do not prove semantic independence. Human review of labels and live fixture preconditions remains outstanding. A source-backed request and a rubric label are not measured model predictions or qualification.
