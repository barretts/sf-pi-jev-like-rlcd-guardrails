# Candidate 6 prospective VALID bridge evaluation

`scripts/guardrail-candidate6-valid-eval.mjs` evaluates only the byte-sealed `blind-c6-20260922/c6-valid-v4.json` set. It refuses changed VALID data, manifest, schema, Jev scorer/protocol, sf-pi commit, or sf-pi risk runtime. All seven imported Jev distribution modules are checked against fixed SHA-256 pins **before import** and again after replay. It does not open the reserved held-out TEST cases. The local sf-pi Safety Kernel supplies the baseline; Jev is called through the actual `evaluateJevRisk` shadow bridge, using the original tool request and independently replayed fixture facts. Shell, Salesforce, Slack, Data 360, and browser tool handlers are never dispatched.

The 62-case VALID population has 37 model-prepared requests, 14 exact policy floors, 8 ineligible file-tool requests, and 3 explicit pre-model fallbacks. One fallback is an invalid Jev protocol input, one has unverified org identity, and one legacy browser case has no authored full snapshot. The four other legacy browser cases are exact policy floors. Browser rows with authored full snapshots require their ref line, snapshot hashes, label, role, and normalized page URL to match the host's observed state. Those observations describe click intent, not a proved live effect.

After a Candidate 6 `scripts/guardrail-candidate6-train.mjs export` run, evaluate its fused GGUF with:

```sh
node scripts/guardrail-candidate6-valid-eval.mjs \
  --sf-pi /absolute/path/to/committed/sf-pi-worktree \
  --sf-deps /absolute/path/to/sf-pi/node_modules \
  --run /absolute/path/to/.build/guardrail/candidate-6-rfdt-RUN \
  --model-id jev/CANDIDATE_ID \
  --output-dir /absolute/path/to/.build/guardrail/candidate-6-valid-eval-NEW
```

The run must contain `candidate6-training-plan.json`, `manifest.json`, `artifact.json`, and `candidate-registry.json`. The evaluator checks fixed SHA-256 pins for the admitted TRAIN dataset and its admission and merge receipts, the original Google Gemma 3 1B weights recorded by the training plan, the actual compiled TRAIN digest, the exact decision cutoff and compiler limits, zero-byte RFDT internal validation/test files, fused artifact hash, and registry identity. The RFDT internal files are distinct from the reserved held-out TEST set; the runner checks their sizes and never reads their contents. Cold provider initialization is separate from warm per-request times. Each warm time starts before the Safety Kernel baseline and includes model-input preparation, queueing, scoring, and bridge decision construction. The hard acceptance check is every prepared call at or below 750 ms and nearest-rank p95 at or below 750 ms; sub-500 ms p95 is reported as the ideal. All 37 prepared calls must return valid model comparisons. The report compares unsafe automatic allows, hard blocks, safety regressions, and benign interruptions with the same host baseline. A fallback cannot count as a completed model call.

The report remains `qualification: false` even when prospective VALID selection gates pass. Passing VALID permits a candidate to be frozen; it does not qualify enforcement. The model, prompt/scoring protocol, decision cutoff, and gates must be frozen before a separate held-out TEST run. Fake-provider tests use an explicit `C6_VALID_FAKE_PROVIDER_TEST=1` harness switch and always set `candidateSelectionEligible: false`. Their scores and timing are never local-model evidence.
