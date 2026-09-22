# Candidate 5 TRAIN supplement

`train-supplement.json` is source-authored TRAIN material for the separate
guardrail RFDT candidate. It does not change the default Jev classifier or the
sealed v3 corpus. The paired requests share an operation group, and their
expected actions come from the unchanged operation-policy rubric plus the
[candidate-5 interpretation](./POLICY.md), not from sf-guardrail's current
decision. The `observations` fields are independently mocked host facts; no
Salesforce, Slack, browser, or shell operation in this fixture is executed.

The supplement covers Data 360 transform validation versus creation, Slack
Canvas metadata versus deletion, shell and `herdr_pane` Salesforce reads versus
writes, independently verified sandbox versus production record operations,
bounded versus broad SOQL disclosure,
Account REST GET versus POST, and Apex trace status versus trace start. The
Prompt Builder help versus Save as New Version TRAIN group is being added to
the append-only candidate-5 corpus revision, so it is not duplicated here.
The tree-import request contains `__C5_TREE_FIXTURE__`; the builder substitutes
the absolute path of the tracked `accounts-tree.json` before sending the
request to the mocked sf-pi host functions. Related variants remain in one
TRAIN group. The revised corpus's browser examples require version-2
`facts.browserPage`; the host sends missing or stale page evidence to the
existing rules.

`scripts/guardrail-candidate5-bundle.mjs` rebuilds every supplemented risk
input with the final sf-pi host and rejects examples that hit exact policy,
are model-ineligible, repeat a reserved group/request, or collide with a
reserved coarse or related-operation signature. Existing sealed TRAIN rows
are subject to the same screen. The builder reads reserved request shape for
collision checks without reading reserved labels or emitting reserved
examples. It writes a TRAIN+VALIDATION-only bundle and an admission receipt,
both at new exclusive paths. Use the final corpus and baseline exported from
the same sf-pi commit:

```sh
node scripts/guardrail-candidate5-bundle.mjs \
  --corpus /absolute/path/to/final-corpus.json \
  --baseline /absolute/path/to/final-sf-baseline.json \
  --baseline-sha256 VERIFIED_BASELINE_SHA256 \
  --sf-pi /absolute/path/to/sf-pi-candidate5 \
  --output .build/guardrail/candidate-5/training-input-bundle.json \
  --receipt .build/guardrail/candidate-5/training-input-bundle-checks.json
```

Do not run this command until the sf-pi baseline passes its full coverage
checks. The old v3 baseline now sends browser presses without a fresh page to
rules fallback, leaving its browser risk coverage gate unmet. A revised,
source-pinned qualification corpus and baseline are required before training.
The bundle receipt reports per-family labels, strict-screen holds, and
`trainingReady`; a balanced bundle is still only a training input, not a
qualified model. Human label review and live API acceptance remain separate.

The following proposals are deliberately absent: Tooling `executeAnonymous`
because it overlaps reserved Anonymous Apex semantics; unverified AgentScript
authoring-bundle and Account record-ID prerequisites; unknown-org variants
until final-host asynchronous lookup proof is bound to the same baseline;
the executed-heredoc contrast because the final host reports ambiguous org
facts and uses rules fallback;
and a distinct browser VALIDATION preview/activation pair because of reserved
semantic overlap and unresolved preview-data sensitivity. No held-out TEST
request or label appears in this supplement or its resulting bundle.
