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
bounded versus broad SOQL disclosure, Account REST GET versus POST, unresolved
org variants, and Apex trace status versus trace start. A proposed Prompt
Builder help versus Save as New Version TRAIN group remains outside this
supplement while the browser qualification corpus lacks defensible VALIDATION
and TEST risk groups.
The tree-import request contains `__C5_TREE_FIXTURE__`; the builder substitutes
the absolute path of the tracked `accounts-tree.json` before sending the
request to the mocked sf-pi host functions. Related variants remain in one
TRAIN group. Four unresolved-org variants are retained only under `heldCases`:
their guessed identity must use sf-pi's rules fallback, and the builder refuses
to pass them to the model or consult real local org authentication.

The Data 360 DLO names, Canvas ID, Slack scopes and Account record ID are
fixture placeholders;
neither external journey acceptance nor a successful Slack API response is
established here. Canvas commands refer to sf-pi's `SLACK_USER_TOKEN` name as
an unexpanded shell variable. These labels judge the requested operation
under mocked facts, not whether an authenticated service would accept it.

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
checks. The v3 baseline
sends browser presses without a fresh page to rules fallback, leaving its
browser risk coverage gate unmet. A revised, source-pinned qualification
corpus and baseline are required before training; a proposed v4 browser
addendum was held because page facts do not establish focus or layout.
The builder deliberately pins the v3 corpus SHA-256. Any future revised
corpus requires separate source and split review, then an explicit update to
that pin and the supplement's corpus identity; the builder will not silently
accept a different corpus.
The bundle receipt reports per-family labels, strict-screen holds, and
`trainingReady`; a balanced bundle is still only a training input, not a
qualified model. Human label review and live API acceptance remain separate.

The following proposals are deliberately absent: Tooling `executeAnonymous`
because it overlaps reserved Anonymous Apex semantics; an AgentScript
authoring-bundle prerequisite and a separate REST PATCH pair that requires
an existing Account record ID;
the executed-heredoc contrast because the final host reports ambiguous org
facts and uses rules fallback;
and a distinct browser VALIDATION preview/activation pair because of reserved
semantic overlap and unresolved preview-data sensitivity. No held-out TEST
request or label appears in this supplement or its resulting bundle.
