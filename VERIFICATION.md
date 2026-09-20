# Implementation evidence

Observed locally on 2026-09-19. The standalone package is at `/Users/bsonntag/code/simple-jev-ts`. No tracked changes were made to the original Simple Jev or sf-pi checkouts. Global pi settings were not changed; installation and coexistence checks used an isolated agent directory.

## Attributed inputs

| Input                             | Identity                                                                   |
| --------------------------------- | -------------------------------------------------------------------------- |
| Simple Jev behavior baseline      | `0dd5396ffce671ab7c4bfc031506d8e558cf8d23`                                 |
| sf-pi coexistence source snapshot | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                 |
| pi SDK and loader                 | `@earendil-works/pi-coding-agent@0.85.1`                                   |
| llama.cpp build                   | `f072b103714dfa1eee531f80b24512faf38e3dd2`                                 |
| Source model                      | `google/gemma-3-1b-it`                                                     |
| GGUF publisher/revision           | `ggml-org/gemma-3-1b-it-GGUF` / `f9c28bcd85737ffc5aef028638d3341d49869c27` |
| Artifact                          | `gemma-3-1b-it-f16.gguf`, 2,006,573,568 bytes                              |
| Verified SHA-256                  | `05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5`         |

All executed classifier models were Gemma. The CPU backend exactly expands the verified F16 source weights to a temporary F32 artifact and uses F32 KV caches. Metal executes the verified F16 source artifact with F32 KV caches. Temporary runtime artifacts are removed on disposal. No Qwen or Chinese-lineage weights were used.

## Results

| Evidence lane                  | Observed result                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                     | `npm run check` and `npm run build` passed                                                                                                   |
| Unit/integration contracts     | 33 tests passed across 4 test files                                                                                                          |
| Python baseline                | Exact prompt fragments matched; scoring fixtures agreed within `1e-6`                                                                        |
| Formatting                     | `npm run format:check` passed                                                                                                                |
| Dependencies                   | `npm audit` reported zero vulnerabilities                                                                                                    |
| Native build                   | Pinned llama.cpp and `jev-native` built successfully                                                                                         |
| Native CPU cache equivalence   | Maximum candidate-probability difference `2.9647678045918724e-7`                                                                             |
| Native Metal cache equivalence | Maximum candidate-probability difference `3.021096278511812e-8`                                                                              |
| Shared-prefix execution        | 294 shared tokens; 781 computed tokens versus 1,369 for independent full-prompt forwards                                                     |
| Forward counts                 | 2 cached forwards versus 3 independent full-prompt forwards                                                                                  |
| Native template                | 3/3 rendered prompts matched independent Jinja2 reference, including BOS and assistant prefill                                               |
| Context forms                  | State and alternating text chat both exercised with real Gemma                                                                               |
| pi installation                | Local package installed into isolated pi settings                                                                                            |
| pi/sf-pi coexistence           | All 23 sf-pi extension factories and the Jev factory loaded; real pi tool wrapper executed `jev_classify` successfully on CPU and Metal      |
| Fresh pi agent loop            | Prompt, argument validation, tool dispatch, Metal Gemma result, and next assistant turn completed; one successful execution in two turns     |
| HTTP transport                 | Real localhost requests returned 200 for classification/alias and 422 for invalid model/unsupported history; raw logits present when enabled |
| Disconnect                     | Aborted fetch followed by successful classification                                                                                          |
| Native process failure         | After SIGKILL, health returned 503; next classification restarted the backend and returned 200                                               |
| Packaging                      | Dry-run tarball excluded weights, native vendor checkout, and build artifacts                                                                |

The coexistence run emitted an `sf-pi-manager:actions` MaxListeners warning while loading the sf-pi bundle. Loading and classification completed successfully; no sf-pi code was changed to suppress it.

## Reproduction and limits

See README.md for setup and commands. Native tests use a 2,048-token branch limit, 4 suffix sequences, and a 4,096-token suffix budget. They establish the tested pipeline and cache behavior, not exhaustive model/context/hardware compatibility.

The fresh main-path exercise used `session.prompt()` and pi's actual agent loop with all 24 extension factories loaded. Argument validation, tool hooks, `jev_classify` execution, tool-result delivery, and the next assistant turn completed in two orchestration turns with one successful tool execution. The existing `scripts/pi-smoke.mjs` now reproduces this path. Its orchestration model is a deterministic non-generating harness: no main-model provider request occurs. Classifier inference is real local Gemma on Metal. Autonomous tool selection and evaluation of answer quality remain deferred.

For the context “I was charged twice for my subscription. Please refund the duplicate charge,” Gemma returned choice `billing` with confidence `0.9999407017823707`, support score `1.9997425468829404` on a zero-to-two rubric, and refund Noul score `0.010000005244026045`. The refund score contradicts the explicit request. This exercise proves the execution path and exposes an answer-quality problem; it does not establish reliable truth judgments. Reported classifier usage was 793 input tokens and zero output tokens.

The token counts prove avoided repeated processing, not a latency ratio. No held-out classification benchmark, remote inference service, RFDT workflow, deployment, or CI run is claimed. This remains an independent rewrite with source inspection allowed, not a strict separated clean-room process.

Raw local proof artifacts are retained under `.build/` and excluded from Git. The repository has branch `main`, no commits or remote, and no stash entries; nothing was pushed or published.
