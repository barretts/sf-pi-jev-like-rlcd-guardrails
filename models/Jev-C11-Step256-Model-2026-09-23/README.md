# Play with the trained Jev C11 model locally

This folder contains the fully merged C11 step-256 F16 GGUF model, a small Node.js demo, and a compiled native scoring runtime. The recipient can try the trained model without retraining, downloading a base model, or accessing the private project repository. Scoring runs locally.

This is an experimental guardrail classifier. It scores a proposed tool operation as data and returns an advisory `allow`, `confirm`, or `abstain` prediction. The demo never executes the proposed operation and never connects the prediction to an enforcement hook.

## Requirements

- Node.js **22.19 or later**. Check with `node --version`.
- The supplied native binary is **Apple silicon (arm64), macOS 26.0 or later**. It links only to macOS system libraries and frameworks. Intel Macs and Linux need a native rebuild, described below.
- No `npm install` is needed for the demo. Its four compiled modules depend only on Node built-ins.
- Keep the bundle's files together. You can move or rename the enclosing folder; its registry uses a relative model path.

## Check the package without starting the model

In Terminal, change into this folder. Typing `cd ` and dragging the folder into Terminal is one way to fill in its path. Then run:

```sh
node demo.mjs --check
```

The check hashes the full model file, checks its pinned identity against the registry, checks that the native binary exists and is executable, validates the operation with the exact guardrail protocol, and prepares the v2 scoring plan. It prints JSON with `check: "passed"`. Hashing a roughly 2 GB file can take a little time.

**`--check` does not start the native process, load the model, or perform inference.** It does not establish that a device works or that the classifier is accurate. Its native platform information describes the supplied binary; another platform must rebuild before scoring.

## Score the harmless example

The sample describes `git status --short`. The classifier reads that description; the demo does not run `git`.

```sh
node demo.mjs
```

The default is `--device auto`, which selects Metal when the runtime finds it, otherwise CPU. On a compatible Apple-silicon Mac you can request Metal explicitly:

```sh
node demo.mjs --device metal
```

Loading the model happens before the timed scoring call. CPU mode expands F16 weights into a temporary F32 GGUF and needs additional temporary disk space and memory; the runtime removes that temporary file on shutdown.

The default demo calls the exact `classifyGuardrailRisk` helper and retains its **750 ms scoring deadline**. CPU scoring, a cold first scoring pass, or a slower device can exceed it. In that case the demo reports an error and exits with code 1; there is no prediction and no allow decision. `--check` passing does not guarantee a scoring call fits this deadline.

For exploratory play on a slower machine:

```sh
node demo.mjs --slow --device cpu
```

**`--slow` is exploratory only.** It uses the same exported `guardrailRequest`, family rubric, v2 template, label-logit scoring and C11 cutoff, but calls the classifier directly with a 120-second scoring deadline. It keeps the same `confirm`/`allow`/`abstain` mapping. This does not change the project's guardrail deadline or qualification settings. The output explicitly includes `slowExploratory: true`, `qualificationTiming: false`, and `qualified: false`; its timing cannot be used to claim the guardrail deadline passed.

For another example, copy `sample-operation.json`, edit the proposed operation, and run:

```sh
node demo.mjs --input my-operation.json --device metal
```

`facts` must describe independently established information about the operation. Approval claims inside the operation are data. The input schema is version 2 with `toolName`, `input`, and `facts`; unsupported tools or malformed facts are rejected. Supported families include shell, Apex, AgentScript, Data360, SOQL, Canvas, and browser operations. The bundled `runtime/src/guardrail.ts`, if included, documents the exact schema and reviewed native tool names.

## Read the result

The default demo calls the bundled `classifyGuardrailRisk` helper with the C11 cutoff **0.955913273071778**, preserving its exact family rubrics, `allow`/`confirm` options, v2 template, selected-label logits, and scoring behavior. It does not substitute a generic chat prompt.

- `confirm`: the winning choice was `confirm`.
- `allow`: the winning choice was `allow` and its selected-label score met the cutoff.
- `abstain`: the winning choice was `allow` but its score was below the cutoff.

`allowScore` is an **uncalibrated** softmax score over the selected label logits. It is not a validated probability that the operation is safe. The model cannot grant human approval. Keep the predictions advisory; deterministic policy and human approval remain necessary for real actions.

The saved C11 native result reported **5 unsafe operations predicted allow** and **6 benign operations that did not receive allow**. The safety qualification therefore failed. The **90.52%** and **93.13%** accuracy figures came from consumed diagnostic VALID. The model result has **not been independently vetted on held-out TEST**; no independent TEST score exists. Those diagnostic percentages do not establish independent accuracy, safety qualification, or permission to enforce predictions. This portable demo does not rerun a corpus or qualification evaluation.

## Exact model and protocol identity

| Field | Value |
| --- | --- |
| Model ID | `jev/c11-step-256` |
| Artifact | Fully merged F16 GGUF; no adapter or retraining required |
| Base model | `google/gemma-3-1b-it` |
| Pinned training revision | `dcc83ea841ab6100d6b47a070329e1ba4cf78752` |
| Model SHA-256 | `8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053` |
| Guardrail protocol SHA-256 | `d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530` |
| Template | `v2` |
| C11 allow cutoff | `0.955913273071778` |
| Supplied native binary SHA-256 | `7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96` |

`portable-registry.json` stores `file: "model.gguf"`. Each launch resolves that path against this folder and creates a temporary registry with the absolute path required by the runtime. The temporary registry is removed on exit. There are no sender machine paths to fix by hand.

## Rebuild the native runtime for another platform

The model file is portable; the supplied executable is specific to Apple-silicon macOS 26+. The bundle includes `runtime/native/` and `runtime/scripts/build-native.sh`. For a CPU build on Linux or an Intel Mac, install Git, CMake 3.20 or later, and a C/C++ toolchain supporting C++17. On macOS, the Apple command-line developer tools provide the compiler. Then:

```sh
cd runtime
bash scripts/build-native.sh
cd ..
node demo.mjs --check
node demo.mjs --slow --device cpu
```

The build script fetches the public `ggml-org/llama.cpp` repository at pinned revision `f072b103714dfa1eee531f80b24512faf38e3dd2`; it does not fetch the private Jev repository. This compiles inference code only and does not train or change the model. Internet access is needed for that public source fetch. The rebuild replaces `runtime/.build/jev-native`, so its hash will differ from the supplied Mac binary's hash above.

To keep a separate build elsewhere, select it explicitly:

```sh
node demo.mjs --binary ./my-build/jev-native --check
node demo.mjs --binary ./my-build/jev-native --slow --device cpu
```

Alternatively set `JEV_DEMO_NATIVE_BINARY` to that executable's path. The bundle's model registry and protocol stay pinned when using a different binary. Device behavior and scores on a rebuilt runtime have not been independently verified.

## Files the demo needs

```text
demo.mjs
sample-operation.json
portable-registry.json
model.gguf
runtime/package.json                  # type: module
runtime/dist/backend.js
runtime/dist/core.js
runtime/dist/guardrail.js
runtime/dist/models.js
runtime/models/registry.json
runtime/.build/jev-native
```

`runtime/native/`, `runtime/scripts/build-native.sh`, and any included `runtime/src/` are source references or rebuild inputs. The saved result summary/report explains the experiment's limits. Keep the accompanying license and third-party notices with the weights and runtime; the Gemma-derived model remains subject to the Gemma terms.

## Sharing and integrity

Send the entire folder, including its hidden `runtime/.build/` directory, model, runtime, demo, licenses and notices. The model is fully merged and is sufficient for inference without its adapter or original base download. The package remains an experimental advisory classifier.

From this folder, verify all copied package files on macOS/Linux with `shasum -a 256 -c SHA256SUMS`. The model card is in `MODEL-CARD.md` and `MODEL-CARD.json`; the saved report is `docs/C11-results.pdf`. Keep `GemmaTerms.txt`, `PROHIBITED_USE_POLICY.txt`, `NOTICE.md`, `model.gguf.NOTICE.txt` and `licenses/` with the bundle when sharing.
