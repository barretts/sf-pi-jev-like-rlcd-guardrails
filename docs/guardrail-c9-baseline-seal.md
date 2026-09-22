# Future C9 held-out baseline seal

Candidate 8 failed VALID, so its TEST remains sealed and its provider remains unqualified. This protocol is for a newly trained and VALID-selected future candidate. It does not change C8's result, sf-pi enforcement, or the rule fallback.

The trust boundary is chronological. Before the first held-out model score, the blind corpus owner must run `scripts/guardrail-c9-test-baseline.mjs` against the sealed C9 TEST source and a pinned sf-pi checkout. The script invokes sf-pi's real Safety Kernel, execution-intent previews, exact policy floor, fact preparation, and `evaluateJevRisk` in shadow mode. Its only provider is a local sentinel that records the exact risk input and returns a fixed comparison. It loads no Jev model, registers no tool, and executes no external operation. The script refuses source, host, policy, or runtime bytes that differ from the supplied pins.

The blind owner archives the exact `preflight.json` and `baseline-seal.json` bytes and commits the **seal-file SHA-256** with the selected candidate's pre-TEST record before any model TEST call. Only that digest needs to be shared with the scorer at this stage. The selection freeze SHA, source SHA, sf-pi commit and baseline runtime SHA, effective base policy SHA, Jev runtime commit and identity SHA, scorer protocol SHA, runner SHA, and fact-stub SHA are bound in both files. Each preflight row freezes the original operation hash, gold label, baseline action, model eligibility/routing, effective per-case policy, and model-visible input hash. A change to any row changes the preflight SHA and then the seal SHA.

The source format is `schema_version: "c9.1"`, `split: "test"`, with cases containing `id`, `group_id`, `family`, `operation: {tool,input}`, `fixture: {cwd,observations?,policyBehaviors?}`, and `expected.decision` (`allow`, `require_approval`, or `hard_block`). The blind owner must independently review those labels and facts. The source SHA is fixed in the selected candidate's pre-model record; it must not be taken from a scored report.

Build Jev from the pinned source, then inspect identities without reading TEST:

```sh
node scripts/guardrail-c9-test-baseline.mjs \
  --sf-pi /absolute/pinned/sf-pi \
  --sf-deps /absolute/sf-pi/node_modules \
  --identity-only
```

In the blind worktree, after the source and selected candidate are frozen, run the same script with the absolute source path, its independently recorded SHA, the selection freeze SHA, the host/runtime/policy identities printed above, and a new output directory:

```sh
node scripts/guardrail-c9-test-baseline.mjs \
  --sf-pi /absolute/pinned/sf-pi \
  --sf-deps /absolute/sf-pi/node_modules \
  --source /absolute/blind-c9/test.json \
  --source-sha256 SOURCE_SHA256 \
  --selection-freeze-sha256 SELECTION_FREEZE_SHA256 \
  --host-commit HOST_COMMIT \
  --host-runtime-sha256 HOST_RUNTIME_SHA256 \
  --policy-sha256 POLICY_SHA256 \
  --jev-runtime-commit JEV_RUNTIME_COMMIT \
  --jev-runtime-sha256 JEV_RUNTIME_SHA256 \
  --output-dir /absolute/new/baseline-output
```

`createC9PreModelBaselineSeal` validates every source/preflight row before producing the seal. Later, `verifyC9ScoredAgainstBaseline` requires the independently committed seal-file SHA, the exact raw source and preflight bytes, and an independently archived scored host-report SHA. It joins every scored row to frozen gold, operation, baseline, routing, policy, and model input, then joins projected metrics to exact report bytes. A scorer cannot repair a disagreement by re-pinning its own preflight; the external seal SHA remains authoritative. Missing rows, duplicate IDs, missing model calls, changed identities, and altered projected results fail.

The verifier returns `qualification: false` by design. The future C9 qualifier still needs separate prospective VALID acceptance, held-out safety and interruption gates, complete real-model calls, warm latency including preparation and queueing, a real Pi hook with stubbed tools, and a final operator-pinned receipt. No code here creates `qualified: true` or changes sf-pi's `off` default. A local hash cannot prove when a file was created or that a model truly generated a self-reported score: preserve the blind pre-model commit, scorer command and output, and immutable report pin as independent evidence.
