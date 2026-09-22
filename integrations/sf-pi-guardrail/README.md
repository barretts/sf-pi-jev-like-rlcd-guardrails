# SF Guardrail semantic risk integration

These local patches let the existing SF Guardrail tool-call hook obtain semantic
risk judgments from Simple Jev. The hook owns enforcement, approval, session
grants and audit records. Exact policy constraints remain in code. The extension
uses no Jev implementation imports: it discovers one versioned provider through
`sf-guardrail:risk-providers`.

## Candidate 5 integration

| Artifact                 | Revision                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| SF Pi baseline commit    | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                     |
| Baseline tree            | `4e08ddb00626e8d47852f604564b10f135082f1a`                                     |
| Local integration commit | `5e2ee1e3073ad17d47ec6ce3510234e522b1a188`                                     |
| Integration tree         | `7368f83a0108b7c602d9f7cc1fa6d3886928391a`                                     |
| Patch                    | [candidate5-sf-pi-from-4f901db9.patch](./candidate5-sf-pi-from-4f901db9.patch) |
| Patch SHA-256            | `5bc6dc989bb3cc961bc204036f6dd64434ef06e4969a7da8f0e96965bf1c66dc`             |
| Patch size               | 319,144 bytes                                                                  |

This binary Git diff captures the version-2 Jev risk input, the optional SF Pi
bridge, policy floors, fallback, corpus exporter, and related hook and workflow
checks. Provider discovery and the provider event remain version 1. SF Pi
supplies independently observed browser-page facts when available, but
`sf_browser_press` and non-exact-floor `sf_browser_click` fall back to the
existing rules. The host cannot establish the live page and focused element for
a key press or guarantee that a cached click reference still names the same
target. Direct `agent-browser` CLI commands retain their existing confirmation
floor. Unverified Salesforce org facts also fall back to rules. These
safeguards leave candidate 5's browser coverage gate open.

The patch was generated from the two pinned commits with `git diff --binary
--full-index`. It passed `git diff --check` and `git apply --index --check`.
Applying it in a fresh detached worktree at the pinned baseline reproduced the
integration tree above exactly. The verification checkout was removed afterward;
the active SF Pi branch and index were not changed. The patch has not been
pushed or installed in the user's active Pi environment.

No candidate 5 model has completed training or qualification. This patch is
integration source, not evidence of model effectiveness or permission to enable
`enforce`. The existing risk engine remains active while the browser coverage
and all other qualification gates are unresolved.

## Current local use

Use a fresh SF Pi worktree at the pinned baseline, then apply the current patch:

```sh
git -C /path/to/sf-pi worktree add --detach /tmp/sf-pi-jev-risk 4f901db9c3f5076ea0305dea33ad6e8856e467da
git -C /tmp/sf-pi-jev-risk apply --index /path/to/simple-jev-ts/integrations/sf-pi-guardrail/candidate5-sf-pi-from-4f901db9.patch
git -C /tmp/sf-pi-jev-risk write-tree
```

The final command should print `7368f83a0108b7c602d9f7cc1fa6d3886928391a`.
Install that local SF Pi package and the separately built Jev extension in an
isolated Pi environment when exercising it. See [GUARDRAIL.md](../../GUARDRAIL.md)
for candidate selection, training, and the reproducible bridge evaluation.

## Historical candidate 4 integration

| Artifact                         | Revision                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| SF Pi baseline                   | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                                                           |
| Local integration commit         | `df22795e1eb0d44cdae3a6269929794858dcb6f6`                                                                                           |
| Integration tree                 | `368241cef98569779904763bc20f0688a9773ca9`                                                                                           |
| Exported baseline bundle SHA-256 | `7668c347e040ae314995c11093e0ee877bd8c2f46c98ed7ac6ccbd6d5d080db0`                                                                   |
| Runtime source identity SHA-256  | `333d737bc6a167c342854242a9a6a9d3a160cc68fa28e7ea9dd1a3d14e2730f6`                                                                   |
| Patch                            | [0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch](./0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch) |

The patch is one email commit with a `base-commit` trailer for the exact SF Pi
baseline above. Its SHA-256 is
`c03309ed3ab04e9f20891ca97643f9dd7e83fecf9abbef5f6bab930ed86bbc4f`
and its size is 267,881 bytes. It includes the optional Jev provider, the
runtime risk floors, corpus exporter, SDK workflow harness, and the related
documentation. Applying it with `git am` in a fresh detached worktree at the
exact baseline reproduced the integration tree above. The active SF Pi branch
and index were not changed by that verification. This patch has not been pushed
or installed in the user's active Pi environment.

### Historical local replay

Use a fresh SF Pi worktree at the pinned baseline, then apply the retained patch:

```sh
git -C /path/to/sf-pi worktree add --detach /tmp/sf-pi-jev-risk 4f901db9c3f5076ea0305dea33ad6e8856e467da
git -C /tmp/sf-pi-jev-risk am /path/to/simple-jev-ts/integrations/sf-pi-guardrail/0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch
git -C /tmp/sf-pi-jev-risk rev-parse 'HEAD^{tree}'
```

The final command should print `368241cef98569779904763bc20f0688a9773ca9`.
Install that local SF Pi package and the separately built Jev extension in an
isolated Pi environment when exercising it. See [GUARDRAIL.md](../../GUARDRAIL.md)
for candidate selection, training and the reproducible bridge evaluation.

## Operation modes

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
Cold startup is separate from the 750 ms per-call warm deadline. Qualification
still requires warm p95 at most 500 ms, including preparation and queueing;
strictly below 500 ms is preferred. A timed-out eligible call fails
qualification even when the measured p95 meets the limit. Headless embeddings
can inspect the returned Jev runtime's `guardrailRisk.status()` after binding;
the slash commands use a UI notification surface with no headless output.

## Verification scope

The candidate 5 patch reproduces the exact integration tree
`7368f83a0108b7c602d9f7cc1fa6d3886928391a` from the pinned baseline. The
historical candidate 4 patch was replayed with `git am` and reproduced tree
`368241cef98569779904763bc20f0688a9773ca9`. Its qualification baseline was
exported twice with byte-identical output; the SHA-256 is in the historical
table. The corpus, model, scoring protocol, exporter, and native runtime must
match the same frozen qualification receipt before model enforcement.

The SF Pi hook and SDK harness use stub tools to exercise blocks, confirmations,
audit records, fallback, and shadow isolation without performing dangerous
external operations. These checks and the patch replay establish integration
behavior; they do not establish local-model effectiveness. The current model
results, matched-workflow measures, and remaining qualification gates are in the
[evidence report](../../reports/guardrail-risk-2026-09-21/README.md).

Model-derived approvals are bound to one operation attempt and the active policy,
model, and scoring protocol. The existing hook still owns exact policy blocks and
native session handling. `off` remains the default; a candidate that fails its
frozen qualification leaves the existing engine active.
