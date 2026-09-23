# C11 paused STOP handoff: local inventory findings

C11 cleared 90% on diagnostic validation — **90.52% eligible, 93.13% whole — not yet independently vetted.** These are prior diagnostic VALID results from the already selected step-256 F16 model and TRAIN-CAL-only accuracy cutoff. They are not an independent TEST result or guardrail qualification.

## Preserved runtime and repository state

- Primary worktree: `/private/tmp/simple-jev-ts-c11-score-20260923`.
- Observed primary HEAD: `286f8c6cc5d72ef3a66a3420eae13f0538c99856`; branch `barretts/jev-c11-score-20260923`; clean at the inventory snapshot.
- Latest pre-TEST browser-press runtime seal: `/private/tmp/simple-jev-ts-c11-score-20260923/reports/guardrail-risk-2026-09-21/candidate-11-evidence/independent-test/runtime-freeze-browser-press.json`; SHA256 `4e2f472070890285816e6cfaaa6ce30cc00e6ca5a7018ebe37412f38aeae2687`.
- Immutable selection freeze SHA256: `de5e57752ab41834891bb099a32f43589ae0e998ae8a465c197157b5817ed5a8`; selected cutoff `0.955913273071778`.
- All pinned model/registry/native/runtime/source-checkpoint files matched their expected SHA256 values; inventory `mismatches` is empty.
- Sixteen targeted worktrees were inspected read-only. The main checkout and all unrelated changes were preserved; exact HEAD/branch/status/upstream snapshots are in the inventory JSON.
- Heavyweight weights and export/checkpoint directories remain local in their existing `.build` locations. The documentation/evidence commit records paths and hashes; it does not itself bundle those weights.

## Preserved local models and prior diagnostic VALID findings

| Checkpoint | CAL cutoff | CAL correct | VALID eligible | VALID whole | Unsafe allows | Benign interruptions | F16 SHA256 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 128 | 0.5 | 36/42 | 104/116 (89.66%) | 148/160 (92.50%) | 5 | 7 | `22f89041387bf0cb08c8b4c18a9711f1d8cac9e3bd996d40c49e96856313e668` |
| 256 | 0.955913273071778 | 39/42 | 105/116 (90.52%) | 149/160 (93.12%) | 5 | 6 | `8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053` |
| 512 | 0.7232675366322204 | 40/42 | 102/116 (87.93%) | 146/160 (91.25%) | 8 | 6 | `5dea09a69e6769ff451fa18b8a89814d7e99a326e0c445643714f2f840608599` |

- All three historical diagnostic replays answered all 116 model-prepared rows, with zero attempted-model fallbacks. Their 160-case whole denominators include 44 code-owned decisions.
- Step 256 still made five unsafe automatic allows and six benign interruptions at its accuracy cutoff. Those failures must remain visible alongside the 90% accuracy headline; qualified/enforcement-eligible status remains false.
- The prior VALID corpus was used for checkpoint selection and is diagnostic evidence. The independent TEST accuracy/qualification objective has not been met.
- No completed C11 step-1024 model is identified in the preserved model manifests. A worktree named `final1024` is not completion evidence.

### Checkpoint 128

- F16 model: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-128-local-v1/model-f16.gguf`.
- FP32 fused export: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-128-local-v1/fused/model.safetensors`.
- Local adapter and import/precision evidence: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-128-local-v1/adapter/` and `precision-f16.json`.
- Historical source checkpoint artifacts: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-128-source-v1`.
- Registry: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-128-local-v1/f16-registry.json`.
- Preserved local-export entries: 51; source-checkpoint entries: 11. TEST-shaped preparation files were inventoried by stat metadata only.

### Checkpoint 256

- F16 model: `/private/tmp/simple-jev-ts-c11-step256-f16-import-20260923/.build/guardrail/candidate-11-step-256-local-v1/model-f16.gguf`.
- FP32 fused export: `/private/tmp/simple-jev-ts-c11-step256-f16-import-20260923/.build/guardrail/candidate-11-step-256-local-v1/fused/model.safetensors`.
- Local adapter and import/precision evidence: `/private/tmp/simple-jev-ts-c11-step256-f16-import-20260923/.build/guardrail/candidate-11-step-256-local-v1/adapter/` and `precision-f16.json`.
- Historical source checkpoint artifacts: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-256-source-v1`.
- Registry: `/private/tmp/simple-jev-ts-c11-step256-f16-import-20260923/.build/guardrail/candidate-11-step-256-local-v1/f16-registry.json`.
- Preserved local-export entries: 37; source-checkpoint entries: 11. TEST-shaped preparation files were inventoried by stat metadata only.

### Checkpoint 512

- F16 model: `/private/tmp/simple-jev-ts-c11-step512-f16-import-20260923/.build/guardrail/candidate-11-step-512-local-v1/model-f16.gguf`.
- FP32 fused export: `/private/tmp/simple-jev-ts-c11-step512-f16-import-20260923/.build/guardrail/candidate-11-step-512-local-v1/fused/model.safetensors`.
- Local adapter and import/precision evidence: `/private/tmp/simple-jev-ts-c11-step512-f16-import-20260923/.build/guardrail/candidate-11-step-512-local-v1/adapter/` and `precision-f16.json`.
- Historical source checkpoint artifacts: `/private/tmp/simple-jev-ts-c11-supervision-20260923/.build/guardrail/candidate-11-step-512-source-v1`.
- Registry: `/private/tmp/simple-jev-ts-c11-step512-f16-import-20260923/.build/guardrail/candidate-11-step-512-local-v1/f16-registry.json`.
- Preserved local-export entries: 27; source-checkpoint entries: 11. TEST-shaped preparation files were inventoried by stat metadata only.

## Native runtime, dependencies, and process state

- Native binary: `/private/tmp/simple-jev-ts-c9-cuda-port-20260922/.build/jev-native`; SHA256 `7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96`.
- Node executable: `/opt/homebrew/Cellar/node/26.5.1/bin/node`; SHA256 `32d01dcba604f99bf508f5e6e9ff77dc31369fff5130faba9303ea375caac025`.
- Host/dependency checkout: `/private/tmp/sf-pi-guardrail-c10-qualification-20260922`; host HEAD `a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a`.
- Installed dependency lockfile: `/private/tmp/sf-pi-guardrail-c10-qualification-20260922/node_modules/.package-lock.json`; SHA256 `caae3014f29b68c4b1bda5e1d263755a63dcc6c2b0561a6f73a4bc8c8fb27eed`.
- Installed dependency contents were not exhaustively hashed; the installed lockfile and repository/runtime hashes define this inventory boundary.
- The filtered local process snapshot found no process matching the known C11 root/export/checkpoint paths. This is a local snapshot; it does not establish current Windows state. No process signals were sent. Raw argv, environment, credentials, and unrelated Mac-job details are absent from the receipt.

## Independent TEST and remote-stop boundaries

- Existing94 rejection, fresh160 v1 independence rejection/sentinel failure, fresh160 v2 sentinel failure/browser-tool-contract diagnostic, all earlier runtime seals, and the selected freeze remain preserved as local metadata artifacts.
- No completed independent TEST model score, admitted final preflight/baseline seal, or guardrail qualification is asserted by this inventory.
- No TEST body was opened, corpus reviewed, model initialized, prediction made, or new evaluation test run during this STOP inventory.
- User constraint: do not engage the Windows CUDA host until the user clears it. No SSH, remote GPU checks, or training occurred.
- Narrow local filename search found no explicit Windows/remote stop receipt in the targeted artifact roots.
- Parent-supplied historical session fallback: `/Users/bsonntag/.codex/sessions/2026/09/21/rollout-2026-09-21T17-30-05-01a0c617-37fd-7eb3-831a-6a56c9f42fbd.jsonl` — present (169909092 bytes); contents not opened by inventory agent. Any historical stop record extracted from it is historical evidence, not current remote verification.

## Inventory asset

- JSON: `/private/tmp/simple-jev-ts-c11-independent-test-scorer-20260922/reports/guardrail-risk-2026-09-21/candidate-11-evidence/independent-test/paused-stop-local-artifact-inventory.json`.
- SHA256: `4093de17d332aafdfa261b13bc107d3e1631f19b8afb4ab787401511c96c44fd`.
- The JSON retains exact model/export/source/registry paths, sizes/modes/mtime/hash observations, expected-versus-observed SHA comparisons, targeted Git snapshots, and sanitized local process status.
