# Candidate 6 matched Pi workflows

Run the same five representative workflows through the **real Pi SDK and
sf-guardrail `tool_call` hook** with `off`, `shadow`, and fixture-only `enforce`.
The assistant response and approval choices are scripted. Every requested
tool is replaced by a counter-only in-memory stub; no shell, file, Salesforce,
Slack, browser, or network operation is dispatched. Pi model network access is
disabled. A deterministic risk-provider stub exercises Jev's integration
contract, not Candidate 6 inference.

The runner pins SF Pi commit `dd97a1a`, its baseline identity, the SDK
collector source, and the frozen request/approval definition. It refuses a
changed host or collector rather than silently producing a comparison from a
different workflow. Its receipt includes the raw SDK report hash, per-workflow
accepted outcomes, confirmations, retries, tool errors and elapsed time.

From the Jev worktree, with the committed SF Pi worktree and its existing
dependency tree available:

```sh
node scripts/guardrail-candidate6-matched-workflows.mjs \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --sf-deps /private/tmp/sf-pi-guardrail-risk-20260921/node_modules \
  --output-dir .build/guardrail/candidate-6-matched-workflows-dd97a1a-001

C6_SF_PI=/private/tmp/sf-pi-guardrail-candidate5-20260922 \
C6_SF_DEPS=/private/tmp/sf-pi-guardrail-risk-20260921/node_modules \
  node --test tests/guardrail-candidate6-matched-workflows.test.mjs
```

The output directory must be new. `receipt.json` gives the compact comparison;
`sdk-report.json` retains all Pi operation, risk-comparison, approval, and audit
records. Neither file is a qualification receipt.

The checked model-free run produced the following outcome counts:

| Mode                 | Stub operations accepted | Confirmations | Retries | Hard blocks | Semantic stub checks | Rule fallbacks |
| -------------------- | -----------------------: | ------------: | ------: | ----------: | -------------------: | -------------: |
| Off                  |                     9/10 |             3 |       0 |           1 |                    0 |              0 |
| Shadow               |                     9/10 |             3 |       0 |           1 |                    4 |              0 |
| Fixture-only enforce |                     9/10 |             4 |       0 |           1 |                    4 |              0 |

Shadow preserved the baseline approval and execution outcomes exactly. The
scripted `enforce` run had **one extra confirmation** for a repeated shell
operation. That is visible evidence of the integration behavior, not evidence
that the Candidate 6 model meets the requirement to avoid extra interruptions.
The exact protected-path block survived all three modes. The collector audits
all four semantic checks and six exact-policy checks in each opt-in mode; it
fails the run if a check, comparison, or expected stub execution is missing.

Timing separates SDK setup and session startup from the warm workflow and
per-risk-check measurements. `coldModelInitializationMs` is `null` here because
the provider is a stub and no local model is loaded. The warm risk-check p95
is a short scripted-hook diagnostic, **not** the model's under-750-ms gate or
the sub-500-ms target. Model warmup, model effectiveness, held-out TEST, live
external operations, and production acceptance remain separate work.

The SDK collector sets a fixture-only `qualified` flag to reach the enforce
branch. This flag does not represent a qualification receipt and never changes
the installed guardrail configuration. Real enforcement remains off until a
candidate passes the frozen qualification and operator opt-in.
