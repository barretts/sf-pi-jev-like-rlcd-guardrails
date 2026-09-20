# Implementation evidence

The TypeScript package is at `/Users/bsonntag/code/simple-jev-ts`, on `main` in the private repository `barretts/simple-jev-ts`. The initial delivered commit is `0fef15dab99ec01d8ec091359c773b3e2db942be`; the expanded source checkpoint is `7a8f823e0375419030b08d81de81efdc580d77e6`, committed and pushed privately. Subsequent real-model evidence is being recorded below. Native builds, weights, private run data, and raw proof files are excluded from Git.

The original Simple Jev checkout remains unchanged. The original sf-pi checkout remains unchanged, including its existing untracked `.logs/`. Manager work is isolated in `/Users/bsonntag/code/sf-pi-jev-manager`, branch `barretts/jev-external-manager`, against baseline `4f901db9c3f5076ea0305dea33ad6e8856e467da`. Global pi preferences are preserved; integration exercises use isolated agent/workspace directories. No public sf-pi push is part of this delivery.

## Inputs and identities

| Input                            | Identity                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Simple Jev behavior baseline     | `0dd5396ffce671ab7c4bfc031506d8e558cf8d23`                                                          |
| sf-pi baseline                   | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                          |
| pi SDK / TUI                     | `0.85.1`                                                                                            |
| llama.cpp source                 | `f072b103714dfa1eee531f80b24512faf38e3dd2`                                                          |
| Initial classifier               | `google/gemma-3-1b-it`                                                                              |
| GGUF publisher / revision        | `ggml-org/gemma-3-1b-it-GGUF` / `f9c28bcd85737ffc5aef028638d3341d49869c27`                          |
| Classifier file                  | `gemma-3-1b-it-f16.gguf`, 2,006,573,568 bytes                                                       |
| Classifier SHA-256               | `05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5`                                  |
| Reviewed 4B classifier candidate | `google/gemma-3-4b-it`, `ggml-org/gemma-3-4b-it-GGUF@d0976223747697cb51e056d85c532013931fe52e`      |
| 4B file / size                   | `gemma-3-4b-it-f16.gguf`, 7,767,474,336 bytes                                                       |
| 4B SHA-256                       | `29f4b518b636635613894282bda2a01bad964c8d474c4147343057b7ac442d50`                                  |
| Agent/teacher                    | `google/gemma-4-31B-it-qat-q4_0`                                                                    |
| Official GGUF revision           | `59dde24573e7e61570dba08b18a2e1fe246955ed`                                                          |
| Agent/teacher file               | `gemma-4-31B_q4_0-it.gguf`, 17,651,001,568 bytes                                                    |
| Agent/teacher SHA-256            | `179cfb99212709597eae5929112cfca677e1bbf566178b479ae1da0c4772874b`                                  |
| Agent chat template revision     | `842da3794eaa0b77d5f08bae87a17459d91ff475`                                                          |
| Agent chat template SHA-256      | `ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4`                                  |
| RFDT HF base revision            | `google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752`                                     |
| RFDT Python / MLX / Transformers | `3.13` / `0.32.2` / `5.11.0`                                                                        |
| RFDT MLX-LM source               | `9d1e356e7cc6549e7d1697adabe2ea01ff8e062c`                                                          |
| RFDT converter dependency        | PyTorch `2.11.0`                                                                                    |
| Frozen quality corpus            | 300 records, 150 groups, SHA-256 `cd3de2d07db024aeb0f8d22be394ffa9024307680efbe2967569c325bc7af3c9` |

All executed classifier/training fixtures use Gemma. No Qwen or Chinese-lineage model is used. CPU exactly expands verified F16 weights to a temporary F32 GGUF with F32 KV caches; Metal uses the source artifact and F32 KV caches. This remains an independent rewrite with source inspection permitted, not a source-separated clean-room process.

## Runtime evidence

The fresh real Metal exercise at `.build/runtime-proof.json` completed in 5.57 seconds and proved:

- Concurrent warmup callers share one initialized generation.
- Loaded status identifies actual `MTL0`, Gemma3 architecture, the approved artifact checksum/revision, and the full native source commit.
- Choice, score, and Noul return real results with zero generated output tokens.
- Natural single-user chat works under v1 and v2. The native renderer merges the appended question into the final user turn without altering logical v1 fixture messages.
- An in-flight large-context abort returns `AbortError: Cancelled`; the next classification succeeds.
- Actual native SIGKILL is followed by successful explicit generation-2 recovery. The failed request is not replayed.
- Disposal awaits child exit and removes the owned temporary directory.

The sample duplicate-charge request produced a billing route, support score approximately 1.9995/2, and v2 refund score approximately 0.98995. The corresponding unchanged v1 refund score remained approximately 0.01. This is a regression diagnostic, not a claim that v2 meets the authored quality gates. Each v2 candidate is bound by its report's logical prompt hashes.

Twenty-five focused runtime/backend tests passed, including shared initialization, caller cancellation, deadlines, malformed replies, explicit recovery, TERM/KILL escalation, and the disposal/directory-creation race. The native protocol checks exercised malformed envelopes, size/depth/numeric limits, and late cancellation bookkeeping without inference. The one-active-plus-16-pending capacity, pre-expansion admission, and bounded cleanup are implemented and tested.

## Quality evidence

The fixed authored corpus was frozen before inference. State/chat pairs share their context group and split. Choice pairs reverse candidate order; Noul contains 40 true, 40 false, and 20 unknown records. Known refund and dog regressions are fixed validation records. The held-out test split remains untouched during candidate selection.

After fixing native chat rendering, paired validation completed all 60 records with zero execution errors:

| Validation candidate | Choice accuracy | Clear Noul accuracy | Noul Brier | Normalized score MAE | Regressions |
| -------------------- | --------------: | ------------------: | ---------: | -------------------: | ----------: |
| v1, chat fix         |            0.50 |                0.50 |    0.49010 |              0.25437 |         2/6 |
| v2 candidate 2       |            0.80 |                0.50 |    0.46013 |              0.20082 |         4/6 |
| v2 candidate 3       |            0.50 |                0.50 |    0.20341 |              0.23031 |         4/6 |
| v2 candidate 4       |            0.65 |              0.6875 |    0.23902 |              0.25325 |         4/6 |
| v2 candidate 5       |            0.80 |                0.75 |    0.21736 |              0.41724 |         4/6 |
| v2 candidate 6       |            0.65 |                0.75 |    0.21736 |              0.14929 |         4/6 |
| v2 C7, Gemma 3 4B    |            0.85 |                1.00 |    0.00180 |              0.07971 |         6/6 |
| v2 C8, Gemma 3 4B    |            0.80 |                1.00 |    0.00411 |              0.07971 |         6/6 |
| v2 C9, Gemma 3 4B    |            0.80 |               0.875 |    0.12233 |              0.07971 |         4/6 |

These candidates **fail the quality gates**. Gates require choice ≥0.90, clear Noul ≥0.95, Brier ≤0.10, normalized score MAE ≤0.10, all known regressions, and zero errors. Candidate 2's prompt manifest SHA-256 is `e5b1a1d005e0d5845c260d173c032e9e88f5861b1c52f29f635be3adfcdd49ad`; reports retain the exact artifact/template identity and per-record prompt hashes. Selected-record dataset hashes differ from the whole-file frozen corpus hash by design.

The initial candidate-5 invocation omitted `JEV_MODEL_FILE` and failed configuration on all records. Its report was replaced by the correctly configured real run above. C7's prompt was frozen for stronger-artifact validation, with prompt-region SHA-256 `5fb3187d5a77359c8b52996d30c3d7c9911b6d6234b8351599aefc17a1fc40fa`. Labels and held-out records are not changed to improve metrics.

The independently hashed 4B F16 artifact completed C7 validation with 60 records and zero execution errors. Only the formal choice gate failed: 17/20 correct versus the required 18/20. Clear Noul was 16/16 correct, Brier `0.0018000026`, score normalized MAE `0.0797098268`, and all six marked regressions passed. Its four unknown Noul cases had uncertainty MAE `0.4899893714`, a substantial answer limitation even though that metric is outside the agreed formal gates. The report and execution attribution are `.build/quality-v2-validation-gemma4b-candidate7.json` and its `-attribution.json` companion. These results do not authorize final held-out evaluation or default promotion; generic prompt refinement continues.

C8's canonical choice objects and JSON answer boundary improved state choice accuracy to 10/10, while chat scored 6/10. Overall choice fell to 0.80, and unknown Noul remained poor at uncertainty MAE `0.4899736232`. C8 was not promoted. C9 standardizes the context presentation for choice/Noul state and chat without changing their roles or caller input, and uses a three-way Noul truth table. Ordered score plans remain exactly unchanged. Controlled validation diagnostics precede the full fixed validation run; no held-out inference is used to select the prompt.

C9's 14-request controlled diagnostic produced bit-exact selected logits for all seven same-options state/chat pairs (maximum difference zero). Reversing the options caused all three tested choice groups to change from correct to wrong, isolating an option-label binding failure after context normalization. The complete fixed C9 validation still failed as shown above, with unknown MAE `0.4033487549` and zero execution errors. C9 is retained as a frozen student-training compiler because it provides consistent context and answer formatting; this is an explicit training choice, not a claim that its base-model quality improved. The report binds source SHA-256 `6c019fadb85344f0e1c7b42a1d5cb98bab9fb2d0c885fa137c939b558d2e2944` and prompt manifest `f95f1e1da29bcb20073e0535008ae60d7adae86630bf896e24b43a2ebb2b48e5`. The tracked v1 checker remains exact at 72 Plans and 432 answer/usage comparisons; additional independent checks preserve all tested v2 score plans.

The tracked compatibility checker passed 72 exact whole-Plan comparisons and 432 exact answer/usage comparisons between current v1 code and initial TypeScript commit `0fef15dab99ec01d8ec091359c773b3e2db942be`, with zero differences. It reports intentional metadata-envelope changes separately. This comparison complements the captured upstream Python fixtures; it does not claim arbitrary Python/JavaScript coercion equivalence.

## pi, Manager, and browser evidence

The initial deterministic pi exercise established `session.prompt()` → argument validation → tool dispatch → real Gemma inference → tool result → next assistant turn, with one execution in two assistant turns and all 23 sf-pi extensions loaded alongside Jev. Its stream function authored the tool call. It does not establish autonomous selection; the real-provider Gemma4 exercise is a separate required lane.

The final Manager change is local commit `f927d52f57185bb5f2d62e8f0cb6997a6656752c`, with tested tree `a95fd8662f9d5d39e491601b662c1b181cb55dab` and exactly ten changed files. Its final typecheck, full lint/generated-catalog checks, 281 focused tests across 27 files, and bounded full suite passed: **4,301 tests passed, 39 skipped; 599 files passed, one skipped**, exit 0. The worktree is clean, with no stash or sf-pi remote push. The baseline-bound patch at `integrations/sf-pi-manager/0001-feat-manager-discover-independent-external-extensions.patch` has SHA-256 `3ef59cbcb4ffd7162d5d1e29203ea36da12bfda2986605eea7408362cfee9a97`; temporary-index application reproduced the tested committed tree exactly. Review fixes cover scope-specific factory caching, stale factory promises, action completion refresh, and reserved contribution IDs.

The expanded pi proof at `.build/pi-proof-final.json` loaded all 24 real factories and 33 startup tools from the updated isolated sf-pi worktree and Jev. It exercised public Manager detail/settings/deep-link/actions/enablement and then actual v2 Metal classifier dispatch, all three answers, 401 input tokens, and zero outputs. Two user/final pairs produced two routing and two three-rubric evaluation reports. Repeated settled/end events created no duplicates; no extra assistant/tool turn or active-tool change occurred. The load-only proof stayed cold. Both Apex advice prompts selected `code-analyzer`, exposing a routing accuracy limitation; hook execution is proven, correct routing is not.

The live browser proof at `.build/browser-proof-final/actual` passed in isolated headless Chrome. All ten screenshots were inspected. It exercised a real all-three classifier POST (403 input tokens, zero outputs), exact response rendering, literal script markup, malformed client JSON without another POST, structured HTTP 422, local docs, four actual saved advisory reports checked against their source records, read-only inspection, and scoped 404s. There were no page errors or external requests. Server closure and native exit were independently verified. This software browser proof used a separate temporary profile and changed no user tabs.

Separate cold browser passes at `.build/rfdt-inspector-proof-final` and `.build/rfdt-native-inspector-proof-final` displayed byte-identical snapshots of the real trained and exported run manifests. The native snapshot's referenced report hash and summary were independently checked, and its failed quality gates rendered as false. Inspector support now includes `native_validation` and `native_test` as well as MLX summaries. Numeric metrics, boolean gates, known artifact labels, and SHA-256 identities are exposed; paths, raw results, bindings, prompts, and training files are omitted. Production-shaped HTTP/privacy regressions passed. Each browser pass made only 15 GETs, with zero POSTs, external requests, page errors, model loads, or native generations; both screenshots per pass were inspected. Owned browser/server closure was verified independently.

The actual CLI benchmark at `.build/bench-proof-final.json` completed 43/43 requests across eight combinations of 256/1,024-character context, 1/3 branches, and 1/4 concurrent callers, with two iterations each. Cold first request was 1.5077 seconds; warm median was 0.08898 seconds (n=2). Overall p50/p95/p99 were 0.23173/0.59468/1.13045 seconds, including cold and queue time. Measured work was 13,527 computed prompt tokens and zero outputs, approximately 2,964 prompt tokens per backend second. Sixty-five resource samples observed native peak RSS 4,806,901,760 bytes, orchestrator peak RSS 156,696,576 bytes, and zero owned temporary disk on Metal. `.build/bench-validation-final.json` verified queue wait, exact identities/code hashes, native exit, and temporary-directory removal. These one-machine observations with two iterations do not establish stable tail latency; RSS is not device memory.

## RFDT evidence

The Python worker's CPU random tiny **Gemma** fixture proved selected-position gradients, adapter changes, loss reduction from `1.6776810884` to `0.6417329311`, adapter reload probability difference `0`, and float32 fused probability difference `7.4505805969e-8`. Pinned conversion dependencies are installed and the llama.cpp converter's help path works. This fixture does not establish training on the official Google checkpoint, native GGUF equivalence, quality gates, or student promotion.

The initial unauthenticated checkpoint check returned HTTP 401 `GatedRepo`. After the user's session authorization, the exact pinned Google checkpoint downloaded successfully: 2,039,043,660 blob bytes, eight complete blobs, and no incomplete blobs. The authenticated doctor reports `training_ready: true` and verified all 180 prepared rows and 980 answer-label boundaries against the native tokenizer, with v2 and no extra special tokens. Optimization uses that exact local snapshot offline. The temporary session credential and credential-owner metadata were removed after download; `.build/hf-session-cleanup-proof.json` records removal and cache preservation. No global Hugging Face login or Git credential changed, and no alternate checkpoint is substituted.

The actual native preparation proof at `.build/rfdt-native-prepare/prepare-proof.json` compiled 180 frozen training records into 60 choice, 60 score, and 60 Noul branches using the approved Gemma1B tokenizer and current v2 template. Prompt lengths were 170–328 tokens with distinct valid answer-token IDs. The source SHA-256 is `7935316728623500ca906dde371355ab9d0550deffa7797e9c3fddc43f792abd`; prepared SHA-256 is `1da456847a5d6f95a841250bc1711f093cd05be2f37493bc1de55d7da2c60c83`. Validation/test branches were zero, and this stage performed preparation rather than optimization or held-out inference.

The real pinned Google 1B run completed eight optimizer updates, batch size one with gradient accumulation eight, learning rate `0.0001`, seed 42, and rank-16 Q/V LoRA across all 26 layers. Mean selected-label loss across all 180 training rows decreased from **3.2808412340 to 1.6308661991**. Adapter weights changed, and fresh checkpoint reload reproduced probabilities across all 180 rows with maximum difference **0**. The adapter SHA-256 is `a6e5c3d293640341ed2ea00fdc2b774573aab3b4db961a98371b46c7b438abc3`. Optimization took 46.655 seconds; the complete owned CLI job took 102.307 seconds and exited 0. Evidence is `.build/rfdt-real-train-job.json` and `.build/rfdt-native-prepare/training-report.json`. The base safetensors were independently hashed at 1,999,811,208 bytes, SHA-256 `3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6`, matching the pinned Hub LFS identity. This proves actual selected-position training, loss reduction, and reload on the official checkpoint; fusion, exported-native quality, and pi student execution remain separate stages. No held-out record was inferred during training.

The first converter attempt rejected the official tokenizer's untrained image placeholder at ID 262144, beyond the text model's 262144-row embeddings. The text-only export now removes only that known placeholder, fails on unexpected out-of-range additions, preserves every trained vocabulary entry and valid special token, and records source/projected file hashes. Both tokenizers match all 180 prepared prompts and 980 answer boundaries. Float32 fusion and the unmodified pinned converter then exported F16 GGUF at 2,006,573,408 bytes, SHA-256 `ee9398c9f670d7abb8493e42736c57310cfe742fe4d3dfdede23b35c18be22e6`. A frozen C7 package kept this historical student's compiler independent of subsequent prompt candidates.

That eight-step GGUF completed the fixed 60-record native validation with zero execution errors, but failed quality: choice `0.35`, clear Noul `0.625`, Brier `0.2174535236`, score normalized MAE `0.2477375068`, and regressions 4/6. Unknown Noul uncertainty MAE was `0.0365668591`. The report is bound to the exact exported artifact and run. No permanent approval or held-out test was attempted; a longer fresh training run is required. This proves the actual training → reload → fusion → GGUF → native-validation path, including enforcement of failed gates.

The TypeScript workflow validates targets/provenance, grouped splits, native boundaries, local teacher labels/cache, manifests, and conversion/export identities. Public approval recomputes the fixed native acceptance suite from recorded probability distributions and checks derived answers, report hashes, template, run, prepared-data identity, and exact exported GGUF. User training splits cannot replace the fixed acceptance corpus. Per-run exclusive evaluation prevents validation/test races; a permanent artifact-specific reservation prevents repeated final tests. Local artifact entries are restricted to classifier-only Gemma derivatives with pinned base lineage. Abort and output-overflow cleanup awaits subprocess close with TERM/KILL escalation and bounded retained output. Eighty-eight focused tests covered these checks; the final expanded suite below includes them.

Artifact registry updates now also hold an exclusive per-registry lock through read, merge, atomic rename, and cleanup. Concurrent or abandoned locks fail explicitly with `ERR_ARTIFACT_REGISTRY_BUSY`; there is no implicit retry or stale takeover. Four public-API regression cases prove that successful distinct-ID approvals are retained, another process's lock is untouched, failures clean up the owned lock, and failed acceptance creates no registry. Forty-four focused model/concurrency tests passed.

## Verification and delivery boundaries

An independent fresh private GitHub clone of checkpoint `7a8f823e0375419030b08d81de81efdc580d77e6` passed **200 tests across 19 files**, including the final RFDT approval, distribution, concurrency, and subprocess-cleanup fixes. TypeScript check and formatting passed. The current v1 compatibility checker passed 72 whole-Plan and 432 answer/usage comparisons. A fresh Node26 CI-style install with dependency scripts and audit disabled passed compilation and CLI tests. The repeated fresh package consumer passed library/extension imports, public TypeScript declarations, both installed bin symlinks, and actionable missing-model doctor behavior. The checkpoint package contained 61 files, 159,942 compressed bytes and 799,670 unpacked bytes, including the Manager patch and notices, with no weights, native vendor binaries, fetched templates, logs, or private run data. Its SHA-256 was `24d7d3c980d1f45165f0a28bf1bc0b430fe5061aeac085fc0b5be16199871d26`. Subsequent source/documentation changes alter that archive identity.

[Hosted check run 35490473201](https://github.com/barretts/simple-jev-ts/actions/runs/35490473201) completed successfully for that exact checkpoint on **Node 22 and 26**, including compilation, the full tests, build, compatibility, formatting, and fresh package consumers. This proves the source/package CI lane; real GPU, autonomous provider, RFDT, and held-out evidence remain separately attributed. Subsequent commits require their own hosted CI result.

After the tokenizer export, C9 compiler, registry concurrency, and native-inspector fixes, the complete local suite passed **231 tests across 21 files**, along with TypeScript check/build, formatting, and 72/432 exact v1 compatibility comparisons. A repeated package consumer passed all import, declaration, installed-bin, and missing-model checks. Its 61-file source payload was approximately 166 KB compressed/820 KB unpacked, excluding models and Python bytecode. The package explicitly lists the RFDT worker and requirements files so locally generated Python caches cannot enter the payload. This source checkpoint's own hosted result is recorded after push.

Automatic approval review initially rejected `npm audit --json` because it considered sending dependency metadata to npm outside the existing authorization. After the user's explicit approval, the command completed with exit 0 and reported zero known vulnerabilities in the current dependency graph. The report is retained at `.build/npm-audit-final.json`. This is an advisory-database result, not a claim that the package has no security defects.

Earlier CPU/Metal cache/full-forward differences were `2.9647678045918724e-7` and `3.021096278511812e-8`, respectively; three native rendered prompts matched an independent Jinja2 reference including BOS and assistant prefill. Earlier real HTTP transport verified classification/alias responses, invalid-input errors, diagnostics, disconnect recovery, and explicit native failure recovery. Those baseline checks are preserved and do not substitute for new live surfaces.

No cloud API charge, billing savings, universal model accuracy, exhaustive hardware/context parity, public publication, real RFDT training, or held-out clearance is inferred from infrastructure success. Model terms remain separate from the first-party Apache license. Final branch/HEAD/private remote/CI/patch identities must be verified at delivery.
