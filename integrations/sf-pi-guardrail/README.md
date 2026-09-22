# SF Guardrail semantic risk integration

This local patch lets the existing SF Guardrail tool-call hook obtain semantic
risk judgments from Simple Jev. The hook owns enforcement, approval, session
grants and audit records. Exact policy constraints remain in code. The extension
uses no Jev implementation imports: it discovers one versioned provider through
`sf-guardrail:risk-providers`.

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

## Local use

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

The single patch was generated from the committed SF Pi integration tree and
replayed with `git am` in a fresh detached worktree at the exact baseline. Its
resulting tree was identical to `368241cef98569779904763bc20f0688a9773ca9`.
The qualification baseline exported from that committed integration was produced
twice with byte-identical output; its SHA-256 is pinned above. The corpus,
model, scoring protocol, exporter, and native runtime must be checked against
the same frozen qualification receipt before model enforcement.

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
