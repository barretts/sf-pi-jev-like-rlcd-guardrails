# Candidate 11 scoring setup

This is an executable setup for a future root-authorized C11 checkpoint. Verification so far uses synthetic cases, mocked native scoring/host replay, and tiny regular GGUF artifacts whose provenance is checked by the existing export verifier. It is CPU evidence only. No C11 model, actual CAL/VALID/TEST case body, native scoring run, GPU launch, live controller, Mac benchmark, admission, or enforcement activation is demonstrated here.

C11 uses the existing manifest v1, the existing CAL cutoff selector, the corrected prospective host baseline freeze and source seals, and the existing VALID shadow replay and gates. C10 entry points retain explicit C10 identity. There is no C11 TEST or qualification entry in this change.

## Prerequisites and frozen identity

Root must supply a completed, independently staged C11 CUDA checkpoint and the local checkpoint handoff from `scripts/guardrail-candidate11-local-checkpoint.mjs`. Selected checkpoints are 128, 256, 512 or 1024. The original source objective remains C9 B with `steps: 256`; the derived C11 objective has `purpose: candidate11_train_only`, the frozen C11 sampler and `steps: 1024`, even for earlier selected checkpoints. Source/checkpoint receipt steps select the actual checkpoint.

The campaign is `fixtures/guardrail/candidate11/cuda-campaign-327-fit.json`, SHA256 `366f88e048acc672fa85b46b5b4bfe82582b374e14df93eaef5f334517149ebd`. Initialization is `original_google_gemma_base_fresh_lora_empty_optimizer`. The original objective SHA256 is `a1fbaaa262fa2d103c8ac9771ba1d9db774e7a90be5336cec3665f6b22dd3da9`.

The source FIT identity is `8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25`. Prepared TRAIN bytes have the separate SHA256 `8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3`. Branch counts are 327 TRAIN, zero validation and zero test. The campaign admits no supplement rows.

Implementation pins are enforced in `C11_SOURCE_RUNTIME` in the existing shared evaluator. They cover the real C11 campaign module and sampler, shared objective worker and worker contract, unchanged FP32 helper, importer, memory monitor, launch producer and original objective definition. The importer SHA256 is `4dcc19d891c435fbd4abcd09b2a5243eb31110895e710a8286ac18f4ee56f466`. The launch producer SHA256 is `5abc631c362c8c9f67efca80ba693da0c73b8187856cc30f59d198397deaa841`; the monitor SHA256 is `3b532d0f0053157cfb31b6b4b108b63a2a54a6d724dcf95a236c5c04b5b518d5`. The unchanged helper SHA256 is `ce62f5b1928d981c3276776f9100f10f252f3904337774be63a74347b46a5256`.

The numerical contract preserves the demonstrated C10 profile: expand the full floating base tree to FP32 before loading LoRA, then use the existing embedding-scale correction in both import and fusion. CUDA uses eager attention with matmul and cuDNN TF32 disabled. Local MLX attention, norm and GELU remain as implemented. Reload tolerance remains `1e-5`; probability delta tolerance remains `.05`, decisive reference margin `.5` and decisive flips zero.

## Root-owned command sequence

These are templates, not execution evidence. Every path passed to manifest assembly is absolute. Output files/directories must be fresh. `c11_run_dir` is the completed local import/F16 export run, `c11_source_dir` is the selected staged CUDA checkpoint root, and the quantizer/source/native paths are the already frozen local tools. The variable names below are task-specific; set them before using the templates.

First derive Q8 from the verified F16 weights:

```sh
node scripts/guardrail-candidate11-q8.mjs \
  --run "$c11_run_dir" \
  --native-binary "$c11_native_binary" \
  --quantizer-binary "$c11_quantizer_binary" \
  --quantizer-source "$c11_quantizer_source"
```

C11 Q8 keeps the existing four CLI inputs. It requires a linked C11 local handoff, actual C11 campaign/source/code identity, exact local import-report equality with `run.training` after excluding only the established export-added `fusion` key, and the complete existing passing F16 verifier bound to model and native binary. The F16 record inventory and probability metrics are recomputed and matched to imported FIT reference margins before a quantizer child can start. The quantizer revision, binary and loader-visible library inventory are frozen, the output tensor stays unquantized, and no importance matrix is used. The generic FIT checker writes `precision-q8.json` before exiting for precision failure; the derivation manifest, registry and retained output paths are preserved. A failed Q8 attempt is not overwritten.

Assemble F16 for formal scoring:

```sh
node scripts/guardrail-candidate11-manifest.mjs \
  --handoff "$c11_run_dir/local-checkpoint-handoff.json" \
  --cuda-run "$c11_source_dir" \
  --q8-manifest "$c11_run_dir/candidate11-q8-manifest.json" \
  --q8-registry "$c11_run_dir/q8-registry.json" \
  --precision-q8 "$c11_run_dir/precision-q8.json" \
  --quantizer-binary "$c11_quantizer_binary" \
  --native-binary "$c11_native_binary" \
  --sf-deps "$c11_sf_deps" \
  --format f16 --output "$c11_f16_manifest"
```

The assembler copies reviewed VALID source/manifest identities from the unchanged host freeze without opening those bodies. It pins the CAL inputs and checkpoint/export files, runtime implementation, selected model, prompt/scoring dependencies and host identities. C11 additionally pins the historical `launch.json` and retained Q8 registry inside the existing `files` map. A checkpoint snapshot also pins `memory.snapshot.json`; its producer, selected receipt SHA256, checkpoint and worker/monitor identity must match. The final worker-exit alternative pins the existing records described below. Both branches bind historical launch evidence to the frozen producer and exact campaign/code inventory.

The assembler prints the exact manifest SHA256 and a formal invocation. Use that printed SHA256:

```sh
node scripts/guardrail-candidate11-evaluate.mjs \
  --manifest "$c11_f16_manifest" \
  --manifest-sha256 "$c11_f16_manifest_sha256" \
  --output "$c11_formal_results"
```

Formal CAL veto returns `rejected_cal` before any VALID source, manifest or preflight body read. Accepted CAL freezes the existing selected cutoff and runs the same prospective host shadow replay. A passing status remains `valid_pass_test_and_hook_pending`, `qualified: false`; it does not grant TEST access, candidate qualification or enforcement. To select Q8, assemble a separate manifest with `--format q8_0`; its own full FIT precision proof must pass.

A correct failed Q8 precision attempt can remain alongside selected passing F16. Wrong Q8 purpose/model/native/provenance, duplicated or nonfinite margin records, wrong references, or altered aggregates reject the handoff even when F16 is selected.

The separate diagnostic entry explicitly benchmarks VALID at fixed `.5` after running CAL:

```sh
node scripts/guardrail-candidate11-diagnostic-valid.mjs \
  --manifest "$c11_f16_manifest" \
  --manifest-sha256 "$c11_f16_manifest_sha256" \
  --output "$c11_diagnostic_results"
```

This reports CAL's actual admission decision and can continue after a CAL veto. Both the diagnostic report and its VALID result keep `diagnosticOnly: true`, `enforcementEligible: false`, `candidateAdmission: false` and fixed diagnostic cutoff `.5`; top-level `qualified` remains false. Diagnostic outcomes cannot become formal admission evidence.

## CPU verification and remaining boundary

`npm run build` completed normally. Focused checks are `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s rfdt -p test_cuda_import.py` and `node --test tests/guardrail-candidate11-scoring.test.mjs tests/guardrail-candidate10-evaluate.test.mjs`. Synthetic mocked assembly/scoring keeps the real manifest validator, exact C11 identity checks, margin math, CAL preparation/selector, VALID population validator, route validator, result summarizer, artifact verifier and trained export verifier. The importer execution check uses a synthetic adapter and mocked MLX/model functions. No mock injection is exposed by CLI.

The current snapshot path requires existing genuine root checkpoint staging. It preserves the supervised 8 GB incremental budget, 6.5 GB allocator cap, 7.5 GB dedicated-delta stop, 128 MB shared-growth stop and 16 GB total dedicated stop. It does not attach a guard, launch, signal, sample memory or produce attestations.

The strict snapshot branch is unchanged at 128, 256, 512 and 1024. It requires a bound `sourceSnapshot` and a genuine post-completion journal sample. Earlier checkpoints cannot use the final worker-exit alternative. A final run may exit between monitor samples; that journal cannot be promoted into snapshot evidence or repaired with a fabricated sample.

For C11 step 1024 only, the importer and scorer also accept the genuine completed-campaign `worker_exit` envelope. Root-owned collection must preserve these existing files in the selected source root:

- `launch.json`, `memory.summary.json`, the complete raw `memory.jsonl` and the frozen supervisor's complete raw `root-guardian.jsonl`.
- `run/plan.json`, `run/receipt.json`, `run/adapter/`, `run/fit-margins.jsonl` and the saved-reload record, copied byte for byte from `run/checkpoints/step-1024/`.
- The genuine top-level campaign `run/exit.json` with `ok: true`, `steps_completed: 1024` and positive finite `elapsed_seconds`. Retain the genuine checkpoint exit separately at `run/checkpoints/step-1024/exit.json`, with its `completed_time_unix`.

The raw run root alone is insufficient: the completed checkpoint plan and receipt, adapter and reload evidence must be staged there. Collection must retain the genuine historical records; it must not reshape exits or append a sample.

The final verifier requires the frozen supervisor's actual `watching` record with both PIDs and positive birth ticks, healthy observations joined to exact typed raw journal records, and one terminal `worker_exit` with the matching worker PID after checkpoint completion. The frozen producer's terminal record contains only `status`, `worker_pid` and `time_unix`; no invented launch hash, birth tick or confirmation field is required there. Historical launch commands must match the owned worker and monitor paths, inputs, campaign/code hashes and original stop flags. PIDs must be distinct; simultaneous process birth ticks may be equal.

The final journal may end before checkpoint completion. A genuine monitor sample that finishes after the guardian records worker exit is also permitted. Complete lines, finite counters, both clock orderings, baseline deltas, sample count, recomputed peaks and every original memory stop are still checked. Guardian stop/error outcomes, unfinished or nonfinal exits, source/identity drift, unbound healthy observations and altered budgets reject the source.

The importer adds `final_envelope_sha256` only to C11 final result/training metadata. Its six keys are `sourceLaunch`, `sourceExit`, `sourceCheckpointExit`, `sourceMemory`, `sourceMemoryJournal` and `sourceGuardian`. These newly computed raw-byte hashes bridge the imported evidence to the existing manifest `files` map; scoring requires exact equality, including the memory summary hash. The original `cuda_source` receipt is unchanged, and C10 imported results have no new field. A structurally valid source repinned after import still fails this binding.

The corrected supervisor uses the captured worker pidfd for a bounded five-second confirmation after worker identity disappears. Watchdog identity loss while the owned worker remains live instead triggers an immediate stop after a zero-time pidfd observation. After confirmed worker exit, the supervisor waits up to twenty seconds for the captured monitor pidfd and validates its complete journal and summary, including at least two real samples, recomputed positive peaks and unchanged stops, before emitting the same terminal `worker_exit` record. The monitor captures worker birth ticks and its full command, checks the captured pidfd before each new counter call and waits on that pidfd between samples. A successful sample already in flight is retained.

A real PowerShell nonzero remains a fatal `monitor_error`, including after worker exit. Future `CalledProcessError` rows retain the return code and captured stderr capped at 500 characters, then the monitor writes its failed summary and re-raises the original error. The failed probe's original stderr is unavailable; its failure cause is unknown, and its original artifacts are preserved. CPU mocks do not establish WSL kernel ordering or the cause of that PowerShell failure.

Root-owned collection must independently retain the genuine completed monitor files and establish durable transfer before importing; pidfd readiness is a process-exit observation, not a storage-durability receipt or portable child exit-status receipt. Synthetic final-envelope import, manifest-to-scorer success and supervision race checks verify the executable CPU contract only. A genuine corrected C11 collection, model import/F16 export, native precision/scoring run and runtime proof remain outstanding. Training, campaign, sampler, worker, helper and importer bytes remain unchanged by the supervision correction.
