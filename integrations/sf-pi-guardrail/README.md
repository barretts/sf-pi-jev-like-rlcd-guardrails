# SF Guardrail semantic risk integration

This local patch lets the existing SF Guardrail tool-call hook obtain semantic
risk judgments from Simple Jev. The hook owns enforcement, approval, session
grants and audit records. Exact policy constraints remain in code. The extension
uses no Jev implementation imports: it discovers one versioned provider through
`sf-guardrail:risk-providers`.

| Artifact                               | Revision                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| SF Pi baseline                         | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                                                           |
| Local integration commit               | `beaa11c057c84e96b4d53b57ac1fdfe9c7a2a2d2`                                                                                           |
| Integration tree                       | `85351e72e8a5d8cecfd64914eb9a6ea46edd405b`                                                                                           |
| Runtime qualification baseline SHA-256 | `0f31a95043fc761347a9ccc51dc673b6aaea77d9ca61bd129f789eaa51fa1f45`                                                                   |
| Patch                                  | [0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch](./0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch) |

The patch includes a base-commit trailer. Applying it to the exact baseline in a
separate temporary Git index reproduced the integration tree above. It has not
been pushed or installed in the user's active Pi environment.

## Local use

Use a separate SF Pi checkout at the pinned baseline, then apply the patch with
`git am`. Install that local SF Pi package and the separately built Jev extension
in an isolated Pi environment when exercising it. See [GUARDRAIL.md](../../GUARDRAIL.md)
for candidate selection, training and the reproducible bridge evaluation.

`SF_GUARDRAIL_JEV_MODE` defaults to `off`. `shadow` records comparisons while the
existing engine enforces. `enforce` requires a warmed candidate with a verified
held-out qualification matching this SF runtime, model, prompt protocol and
native binary. Unqualified candidates and operational failures retain the rule
decision. Runtime changes require fresh qualification; do not reuse an old
receipt after changing this patch.

## Verification scope

TypeScript and full lint passed, including generated catalog/documentation,
formatting, SPDX, architecture and lifecycle checks. Documentation build and
validation stages preceding the complete test suite also passed. The focused
guardrail and runtime-surface run passed 315 tests; the export-only corpus test
passed separately. The actual SDK tests use `createAgentSession` and stub tools
to prove blocking, approval, audit, fallback and shadow invariance.

The complete SF suite required environment-specific partitions: the broad run
passed 4,214 tests with one unrelated AgentScript import timeout, which passed
alone on retry. Seventy state-bound tests passed with isolated Pi state, and
eight localhost fixtures passed under narrowly approved local execution. The
uniform `npm test` and `validate:ci` wrappers did not pass in one sandbox
environment. Full run details and model results are recorded in the
[guardrail evidence report](../../reports/guardrail-risk-2026-09-21/README.md).

These checks establish local integration behavior and patch reproducibility.
Real model effectiveness, workflow benefit and production acceptance are
separate proof boundaries. The conservative model-confirmation session setting
remains pending an explicit user decision after automatic approval review
rejected restoration of the baseline's implicit session option; see the evidence
report for the resulting limitation.
