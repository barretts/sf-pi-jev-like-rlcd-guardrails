# C10 preparation: sf-pi integration validation

Observed on 2026-09-22 against `/private/tmp/sf-pi-guardrail-c9-host-20260922`, branch `barretts/jev-guardrail-c9-host`, HEAD `4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a`. The worktree was clean before and after validation. No tracked code or configuration changed. No SSH, GPU, network inference, or dangerous external operations were used.

## Results

| Command | Observed result | Duration |
| --- | --- | --- |
| `GUARDRAIL_SDK_WORKFLOW_OUTPUT=candidate-10-evidence/pi/sdk-workflow.json GUARDRAIL_SDK_REPRESENTATIVE_OUTPUT=candidate-10-evidence/pi/sdk-representative.json npm test -- extensions/sf-guardrail/tests` | 34 files passed; 430 tests passed, 2 skipped | 6.39 s |
| `npm run test:runtime-surface` | 1 file passed; 31 tests passed | 10.79 s |

The first invocation of each command exited 127 before running tests because this worktree had no dependencies (`vitest: command not found`). Validation used a temporary `node_modules` symlink to the existing installation at `/private/tmp/sf-pi-guardrail-risk-20260921/node_modules`; the link was removed afterward. No installation, lockfile change, or change to that dependency directory occurred.

The two intentional skips were the environment-gated external corpus baseline evaluation and the native local Jev model workflow. Neither was configured. No sealed VALID or TEST content was read.

## Evidence exercised

The suite executed existing tests for the real sf-guardrail hook with counter-only tools and for actual Pi `AgentSession.prompt`/`ExtensionRunner` dispatch with scripted providers and counter-only custom tools. These covered hard blocks despite model allows or headless opt-ins; denied uncertain predictions and misleading approval claims; confirmed dispatch exactly once; shadow preservation of prompt choices, execution, and session approval; headless blocking; provider outages and audit entries; changed policy/model/provider/qualification invalidation; malformed, unavailable, duplicate and revoked providers; incomplete/stale org/browser inputs; cancellation; deadline accounting including preparation/final bookkeeping; and recovery after late timed-out model responses. Approval scope and revocation, exact policy, safety kernel and baseline identity tests also passed.

Runtime-surface attestation executed the real extension factories and controlled registration lifecycle and checked commands, providers, tools and events against manifests. This is registration-surface evidence, not live credentialed Salesforce acceptance.

## Matched workflows measured with scripted predictions

The small identical-shell workflow accepted both stub requests in both off and shadow modes, with one confirmation, one session grant reuse, zero retries and zero errors in each mode. SDK setup/workflow/total milliseconds were off `49.426334 / 3.654500 / 53.080834`, shadow `4.806875 / 34.626417 / 39.433292`. The setup includes SDK session initialization and is not a local model cold initialization.

The frozen representative workflow collector covered 10 operations across safe reads/quoted shell text, identical shell and Apex requests, Data 360 rehearsal/live intent, and an exact protected-path block. In off, shadow, and fixture enforce modes alike: 9 accepted operations, 3 confirmations, 3 session grants, 0 retries, 0 unsafe automatic allows, one expected protected-path blocked tool result, and 0 unexpected tool errors. Shadow and fixture enforce modes completed all 4 scripted semantic checks and all 6 exact-policy comparisons.

| Fixture mode | SDK setup ms | Session startup ms | Workflow ms | Total ms |
| --- | ---: | ---: | ---: | ---: |
| off | 5.651167 | 0.179292 | 5.954875 | 11.821917 |
| shadow | 6.316709 | 0.183583 | 57.414334 | 63.966084 |
| enforce | 5.385250 | 0.197375 | 57.858125 | 63.485334 |

Enforce mode above is an isolated test fixture with mocked configuration and a scripted provider. No production enforcement was enabled. Scripted selection adds no human deliberation time. These single-pass timings are collector diagnostics, not a model latency qualification or comparative performance claim.

## Artifacts and SHA-256

| Artifact | SHA-256 |
| --- | --- |
| [guardrail-tests.log](candidate-10-evidence/pi/guardrail-tests.log) | `4bd539347060558f7385ed0c30ed831fbfa302c794af78b08b7461160110afeb` |
| [runtime-surface.log](candidate-10-evidence/pi/runtime-surface.log) | `fe26488bfb19d76842d9284b10bc9615180e21a4ea5f6a97d963b3f5230ebfca` |
| [sdk-workflow.json](candidate-10-evidence/pi/sdk-workflow.json) | `4e3fd26c057092c4d6ac069bb10e3486d69204ecc22f804c88f3cc3cb324b42b` |
| [sdk-representative.json](candidate-10-evidence/pi/sdk-representative.json) | `4d3453798c60fd1f1a78ac3d16c418af2d326e39af4dfe3fe48356e68a61e036` |

Representative collector workflow definition SHA-256: `0039df8fc5568b3be141f4f28f253b7f32e429019e3b4e288cb42029f56e7fc4`. Recorded baseline SHA-256: `4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421`.

## Proof boundaries

This validates current sf-pi bridge, code policy, approval, audit, fallback and registration behavior under controlled fixtures. It does not establish C10 training success, saved-adapter or F16/Q8 equivalence, candidate accuracy, native-worker disposal or recovery, real model warm p95, held-out qualification, live external workflows or production acceptance. Worker ownership/shutdown/disposal must be checked in the Jev runtime suite and eventual genuine native-provider workflow. No failed candidate can be admitted from these passing fixture results.
