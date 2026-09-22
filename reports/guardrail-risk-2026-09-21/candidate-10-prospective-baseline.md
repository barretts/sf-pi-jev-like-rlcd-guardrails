# Candidate 10 prospective baseline freeze

C10 adds a qualification verifier to the sf-pi bridge. That changes the bound runtime identity, so C10 uses a new prospective baseline freeze. Existing C9 source, admission, baseline, preflight, scoring criteria and failed results remain unchanged.

The independent model-free replay compared all 42 TRAIN-CAL operations and all 160 sealed VALID operations with their original C9 baseline records. There were **zero differing cases or fields**. The code-owned hard blocks remain intact. No candidate was scored, provider invoked, tool executed, external operation performed, or held-out TEST body opened by this producer.

| Binding                         | Frozen identity                                                    |
| ------------------------------- | ------------------------------------------------------------------ |
| sf-pi host HEAD                 | `a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a`                         |
| C10 baseline runtime            | `0a23e057fb433fc4ee2ecd42465b377c660db5e024b6a406f6994497eba693b2` |
| Unchanged default policy        | `e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347` |
| Original C9 baseline runtime    | `4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421` |
| Unchanged TRAIN-CAL source      | `84dfedfb0a1aea2b5e39fd33bd40a913edf96daf89129accdc59e622ce7d57bd` |
| Unchanged sealed VALID manifest | `b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc` |
| New prospective freeze manifest | `2f0d16ebcf65e1504b5b740215e59f31aa2e45cd45fc8a21212c86c184e2209f` |

The manifest is [candidate-10-evidence/baseline/manifest.json](candidate-10-evidence/baseline/manifest.json). It binds the new CAL baseline, VALID preflight and TRAIN host projection receipts by SHA256. The host must be clean and committed. Outputs use exclusive creation; altered source bytes, missing case identities, duplicate identities, changed routing/facts/policies/decisions, or nonpreserved hard blocks reject the freeze.

CAL compared prepared input digests, baseline decisions, eligibility gates, rule routes, rule IDs and independent-fact reconstruction routes. VALID compared operation digests, policy digests, prepared risk-input digests, labels, family/group inventory, routing, fallback reasons and baseline decisions. These comparisons establish that the new verifier did not change the baseline's operation decisions or model inputs on these sources.

CAL baseline decisions remain 38 allow / 4 confirm / 0 block. VALID remains 112 allow / 46 confirm / 2 block, with 116 model-prepared cases, 39 code-owned rule fallback cases, 5 pre-model missing/stale/ambiguous-fact fallback cases and zero preparation errors. Those fallback lanes are part of the full corpus and must be reported separately from model-eligible scores.

The replay reconstructs independently authored org and browser facts, stubs environment detection, isolates its fake agent directory, and calls the Safety Kernel directly. It runs no actual Pi tool execution. Existing labels remain independently authored under the operation-policy rubric; this replay does not relabel disagreements with the baseline. Original machine-authored / human-review-pending disclosures remain in the receipts. This baseline evidence does not establish model effectiveness, held-out independence, a successful qualification, matched workflow results or production acceptance. Existing TEST authorship/independence disclosures still require the planned audit before any TEST qualification.

Reproduce on the frozen bridge without altering the existing evidence directory:

```sh
node scripts/guardrail-candidate10-baseline-freeze.mjs \
  --sf-pi /private/tmp/sf-pi-guardrail-c10-qualification-20260922 \
  --sf-deps /private/tmp/sf-pi-guardrail-c10-qualification-20260922/node_modules \
  --host-commit a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a \
  --baseline-sha256 0a23e057fb433fc4ee2ecd42465b377c660db5e024b6a406f6994497eba693b2 \
  --output-dir reports/guardrail-risk-2026-09-21/candidate-10-evidence/baseline-reproduction
```

The producer relies on existing built Jev runtime files and records their hashes and commit in the receipts. Hashes of new producer scripts are recorded. A reproduction at a different Jev commit may change metadata receipt hashes; semantic equivalence and all immutable source/host/policy bindings must still pass.

Validation: both model-free replay programs completed and all 202 operation comparisons passed. Node syntax checks and Prettier checks pass for the three new producers. No C9 or main-worktree files were edited. The initial invocation with a nonexistent sf-pi dependency directory failed before replay; the successful invocation used the new bridge's installed dependencies. A preformatting draft is preserved under `.build/guardrail/candidate-10-baseline-preformat-draft-20260922`; only the final postformatting freeze above is authoritative.
