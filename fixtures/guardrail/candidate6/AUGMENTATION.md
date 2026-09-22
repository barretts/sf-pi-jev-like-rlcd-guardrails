# Candidate 6 separate TRAIN augmentation proposal

[`train-augmentation.json`](./train-augmentation.json) is a machine-authored,
source-pinned **proposal**, separate from the existing Candidate 6 development
pool. It has six TRAIN requests in three matched safe/risky groups. None is in
prospective VALID or sealed TEST. It is not yet admitted for training or
qualification; `humanLabelReviewed` remains `false`. No authored request was
executed.

The source JSON SHA-256 is
`c8538642a18468d5e4607bd650a5dbd8c728791f142ed6496e74434ec7e92409`.
`node --test fixtures/guardrail/candidate6/train-augmentation.test.mjs` checks
the pin and grouped TRAIN-only shape. Regenerate it with
`node fixtures/guardrail/candidate6/build-train-augmentation.mjs`; changing
the source requires a new pin, host replay, and blind screen.

The contrasts address known _historical aggregate_ candidate-5 failure themes
without copying individual historical validation requests: bounded versus
2,000-row Contact PII disclosure; printing a truncation command versus
executing it through `sh -c`; and a remote Git rewrite rehearsal versus a live
force-with-lease push. The safe Git rehearsal uses `--dry-run --no-verify`,
because ordinary dry runs can still invoke a pre-push hook. Labels follow the
[`operation-policy-v2` rubric](../RUBRIC.md), independently of the existing
rule result. The Salesforce SOQL runner, [Git's push documentation](https://git-scm.com/docs/git-push),
and [POSIX redirection contract](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_07_02)
support these request forms.

A proposed Data 360 POST query-versus-transform pair was removed as a whole
group. Without `allow_confirmed`, sf-pi's dispatcher refuses the requests
before execution; adding that execution-intent flag triggers a code-owned
native policy floor, making the pair model-ineligible. Existing Candidate 6
rows still cover Data 360. The model must not replace the execution-intent
check or learn from an ineligible contrast.

The request-only aggregate blind screen must be rerun against the final six-row
source and the current prospective VALID/TEST seals. Zero matches in the
screen's fingerprints is necessary but does not prove semantic independence.

`scripts/guardrail-candidate6-augmentation-preflight.mjs` uses sf-pi's real
rule baseline and Jev input preparation with independently mocked org facts
and stubbed execution. The final six-row [host replay](../../.build/guardrail/candidate-6-augmentation-preflight-dd97a1a-v2/receipt.json)
on committed sf-pi `dd97a1a9` found every row eligible, unfloored, prepared,
and fact-matched, with zero model calls or external operations. Its receipt
SHA-256 is `e3398d714b0136ed24197bd1c66ec7582ce66dd7e69c94a003a66cd30ce18ffa`.
Whole-group rubric/source admission remains necessary before these rows enter
research training.
