# Candidate 10 Pi SDK workflow readiness

`scripts/guardrail-candidate10-workflows.mjs` prepares an isolated archived copy of the pinned sf-pi host, runs its actual `AgentSession.prompt` and extension tool dispatch, and registers native Jev scoring through a dedicated fixture adapter. Its tools record execution receipts; they cannot execute the requested shell, Salesforce, Slack, file, or browser operation. The existing sf-guardrail hook owns every approval and block.

The runner requires accepted validation and a successful frozen held-out corpus report. It refuses missing, changed, or mismatched evidence before creating SDK tools. The held-out report remains `qualified:false`; this runner does not issue an enforcement receipt. It performs **off and shadow** workflows. Actual native enforcement must run separately after genuine C10 qualification is supported and verified by the sf-pi bridge. An `enforce:true` manifest is rejected.

Run with a fresh absolute output directory:

```sh
node scripts/guardrail-candidate10-workflows.mjs \
  --manifest /absolute/workflow-input.json \
  --manifest-sha256 SHA256_OF_MANIFEST_BYTES \
  --output /absolute/new-workflow-evidence
```

The input is a version 1 JSON object with `purpose:"candidate10_actual_sdk_workflows"`, `enforce:false`, absolute `sfPi` and `sfDeps` (the separately installed matching sf-pi dependency workspace), pinned `hostCommit`, nonempty `modelId`, and frozen `modelSha256`, `protocolSha256` (selected scoring protocol), `calibrationSha256`, `baselineSha256`, `minimumAllowScore`, and canonical `freezeSha256`. Each of the following fields is `{path:absolute,sha256:SHA256_OF_FILE_BYTES}`:

- `evaluation`: accepted C10 evaluation report, identical to the freeze's `evaluationReport` pin.
- `test`: successful C10 held-out corpus report with all gates true and the same canonical freeze hash.
- `freeze`: frozen TEST plan. This runner reads metadata, not held-out source bodies.
- `model`, `registry`, `binary`: selected exported weights, artifact registry, native executable.
- `importReport`, `localPrecision`, `selectedPrecision`: successful saved CUDA import, full FIT equivalence, and selected native export precision reports. Export precision must bind the selected model and native binary hashes.
- `backend`, `guardrail`: built Jev `dist/backend.js` and `dist/guardrail.js`.
- `adapter`: this repository's `scripts/guardrail-candidate10-workflow-adapter.mjs`.
- `sdkTest`: pinned host `extensions/sf-guardrail/tests/jev-risk-sdk.test.ts`.
- `dependencyLock`: pinned host `package-lock.json`. Its bytes must match the installed `sfDeps` workspace lock, and the installed Pi SDK and pi-ai package versions must match their locked versions. Package metadata hashes are retained and rechecked after dispatch.

The immutable representative SDK workflow specifies a protected-file block override. The adapter records that isolated fixture policy fingerprint separately from the corpus policy and uses the frozen candidate cutoff, model, and scoring protocol. It deliberately declares `qualified:false`. Its worker warms during awaited SDK session startup and is disposed between modes and on shutdown. Native model or worker generation changes reject a prediction.

`sdk-shadow.json` retains matched requests, accepted outcomes, confirmation choices/counts, retries, audit decisions, model comparisons, per-operation elapsed time, total workflow time, and cold initialization. `workflow-status.json` reports eligible-call completion and full hook comparison p95; fallback cannot satisfy completion. The hard bound is every eligible warm check below 750 ms, with sub-500 ms p95 recorded as the ideal. Corpus performance, shadow workflow predictions, actual enforce execution, and production acceptance remain separate claims. The runner does not transfer data or launch remote GPU jobs.

Current verification: two Node tests pass for matching identity admission, rejection of enforce/failed or empty gates/changed cutoffs, and byte tampering before SDK setup. No C10 native workflow measurement has been produced yet; an accepted artifact is still required.
