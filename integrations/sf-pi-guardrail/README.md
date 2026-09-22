# SF Guardrail semantic risk integration

This local patch lets the existing SF Guardrail tool-call hook obtain semantic
risk judgments from Simple Jev. The hook owns enforcement, approval, session
grants and audit records. Exact policy constraints remain in code. The extension
uses no Jev implementation imports: it discovers one versioned provider through
`sf-guardrail:risk-providers`.

| Artifact                               | Revision                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| SF Pi baseline                         | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                                                           |
| Local integration commit               | `e09085fd1a05cc836b2f377325aea33f9ced1cf1`                                                                                           |
| Integration tree                       | `ef7b70ad1f107ec989ac783f68883815338e6a91`                                                                                           |
| Runtime qualification baseline SHA-256 | `0f31a95043fc761347a9ccc51dc673b6aaea77d9ca61bd129f789eaa51fa1f45`                                                                   |
| Patch                                  | [0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch](./0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch) |

The patch contains five email commits: the provider integration, the optional
real-model Pi workflow harness, the ADR 0052 historical policy clarification,
the per-call model-completion check and normal Jev session startup in the SDK
harness. It includes a base-commit trailer and has SHA-256
`327ca9e5519cd660c1316499311363dfdb56d714b45fa158b984fdacfe224a62`, with 175,031
bytes. Applying all five commits sequentially to the exact baseline with a private
Git index and object store reproduced every intermediate and final tree above.
The real SF index, all 1,749 tracked files and 33 runtime sources remained unchanged.
It has not been
pushed or installed in the user's active Pi environment.

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

With Jev enabled, the general Jev extension awaits risk-worker warmup during
session startup for exact `shadow` and `enforce` opt-in modes. Default `off`
stays lazy. Startup failures remain recorded in provider status and retain the
existing SF fallback. API embeddings must await `AgentSession.bindExtensions`
before tool execution; creating a session alone does not start extensions.
Cold startup is separate from the 500 ms warm check budget. Headless embeddings
can inspect the returned Jev runtime's `guardrailRisk.status()` after binding;
the slash commands use a UI notification surface with no headless output.

## Verification scope

TypeScript and full lint passed, including generated catalog/documentation,
formatting, SPDX, architecture and lifecycle checks. Documentation build and
validation stages preceding the complete test suite also passed. The focused
guardrail and runtime-surface run passed 315 tests; the export-only corpus test
passed separately. The actual SDK tests use `createAgentSession` and stub tools
to prove blocking, approval, audit, fallback and shadow invariance.

The SDK workflow harness adds a source check with ten frozen representative
operations: seven CPU/scripted SDK tests passed and the optional native arm
was skipped. Shadow/enforcement source tests now require eight matching semantic
judgments and two exact-policy comparisons, with one comparison per SDK call. TypeScript, file ESLint and an independent replay passed. The
real-model arm uses the genuine Jev provider and requires a matching held-out
qualification for enforcement. Candidate 3 completed the actual native
off/shadow arm after training: both modes executed nine operations, preserved
one exact block, and used three confirmations and three grants. Shadow answered
all eight semantic requests and recorded two exact-policy comparisons. The
existing engine enforced throughout; this proves the mocked SDK workflow's
shadow isolation, not model effectiveness or qualified enforcement.

Candidate 3 was rejected by separate native bridge validation: six unsafe
automatic allows, five safety regressions, and 19 unnecessary interruptions
versus baseline three. Its warm p95 was 213.736 ms, and all 144 eligible calls
answered. No held-out test or qualified enforce arm ran. Candidate 4 is training
with the same fixed settings and 48 additional TRAIN cases; its results remain
pending. Current receipts and proof boundaries are in the
[evidence report](../../reports/guardrail-risk-2026-09-21/README.md). The genuine
qualified-arm invocation is documented in [GUARDRAIL.md](../../GUARDRAIL.md).

The current optional native arm registers the general Jev driver and awaits
normal session startup, without manual provider warmup. Seven actual SF source
tests passed with that arm skipped; TypeScript, file lint and formatting passed.
The earlier candidate 3 native result used manual provider warmup and does not
prove this updated driver path. Its native run remains pending after training.
Startup timing includes all handlers and is separate from setup, warm workflow
and total elapsed time.

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
