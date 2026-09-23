# sf-pi-jev-guardrails

A local TypeScript risk provider and the current C11 training/export tools for
SF Guardrail. The provider scores proposed tool operations with the saved
Gemma 3 1B C11 model using selected-label logits. SF Pi owns exact policy,
protected paths, confirmation, session approvals and audit.

**C11 is experimental and unqualified.** The saved step-256 diagnostic recorded
five unsafe automatic allows and six unnecessary confirmations. Its 105/116
eligible and 149/160 overall accuracy came from consumed diagnostic VALID;
there is no independently vetted held-out TEST score. The current provider is
available for shadow comparison and never advertises enforcement eligibility.

## Local setup

Use Git LFS, Node.js 22.19 or later and npm. The exercised Pi SDK is 0.85.1. The supplied
native scorer supports Apple silicon on macOS 26 or later. Installation and
cached status do not start inference.

```sh
git lfs install
git clone https://github.com/barretts/sf-pi-jev-guardrails.git
cd sf-pi-jev-guardrails
git lfs pull
npm ci
npm run build
npm run verify:guardrail -- --check
```

For an existing checkout, run `git lfs install` and `git lfs pull` before using
the model. Git LFS stores the large bundle artifacts; a checkout containing
only their pointer files cannot score operations.

The last command checks frozen training inputs, current metadata checksums and
the selected scoring identity without loading model weights.
The default bundle is
`models/Jev-C11-Step256-Model-2026-09-23/`, resolved from the installed package
directory rather than the shell's working directory. The provider uses its
`model.gguf` and `runtime/.build/jev-native` directly. The complete 64-file
Desktop bundle is versioned here with its original bytes: the merged model,
checkpoint adapters and recovery material, receipts, standalone runtime,
demo, model cards, terms and licenses. The original Desktop copy is retained.
Keep the bundle's files and notices together. To use a copy elsewhere, set
`JEV_GUARDRAIL_BUNDLE` before starting Pi or a smoke check.

```sh
export JEV_DEVICE='metal' # auto, cpu, or metal
npm run smoke
```

The smoke check loads the real local model and scores a harmless operation as
data; it does not execute that operation. The bundle's standalone demo also
works without installing npm dependencies; its `README.md` describes usage.
`node demo.mjs --check` in that folder
checks identity without inference. A different platform needs a native rebuild
and separate verification; the saved provider pins the supplied executable's
identity.

The npm source package intentionally excludes the large model bundle and its
compiled native runtime. `npm pack` and installations from its tarball need a
separate, complete bundle and an explicit path:

```sh
export JEV_GUARDRAIL_BUNDLE='/absolute/path/Jev-C11-Step256-Model-2026-09-23'
```

A Git clone with LFS objects downloaded contains everything needed for the
saved scorer on its supported platform. Fresh training still requires the
pinned original Google HF base and the training environment described below.

## Pi and SF Pi

Install the built Git checkout in Pi so its bundled model remains available:

```sh
pi install "$PWD"
```

Use `/reload`, `/jev-risk status` and `/jev-risk warmup`. Warmup explicitly
checks identities and loads the model. Provider discovery and status report
cached state. The extension registers a risk provider through
`sf-guardrail:risk-providers` and exposes no agent-callable approval tool.

For SF Pi, follow the [current host patch instructions](./integrations/sf-pi-guardrail/README.md).
Leave `SF_GUARDRAIL_JEV_MODE` unset or `off` for the existing Guardrail behavior.
Start a session with `SF_GUARDRAIL_JEV_MODE=shadow` to compare the local scorer
alongside rule-owned outcomes; inspect `/sf-guardrail risk` and
`/sf-guardrail audit`. Shadow predictions cannot grant approval or change
execution outcomes.

The library exports the version-2 guardrail input/prediction types,
`guardrailRequest`, `classifyGuardrailRisk` and provider registration. Inputs
contain `toolName`, original `input` and independently established `facts`.
Approval claims inside an operation are data. Unsupported tools or malformed
facts are rejected. A winning `allow` label must meet the fixed cutoff;
a lower-scoring `allow` becomes `abstain`. Scores are uncalibrated. Invalid or
late results do not become allow decisions. The scoring deadline remains
750 ms, with 500 ms warm p95 as the project target.

| Current identity                | Pin                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| Model                           | `jev/c11-step-256`, fully merged F16 GGUF                            |
| Base                            | `google/gemma-3-1b-it` at `dcc83ea841ab6100d6b47a070329e1ba4cf78752` |
| Model SHA-256                   | `8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053`   |
| Supplied native SHA-256         | `7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96`   |
| Prompt protocol SHA-256         | `d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530`   |
| Shadow scoring protocol SHA-256 | `d72f8dfa7ac3a287e2db2e9a829622da15267bb3cb153318678334a830353604`   |
| Template and allow cutoff       | `v2`; `0.955913273071778`                                            |

`models/current/` retains the current model card, selection, precision,
import-equivalence and diagnostic evidence. `npm run eval:guardrail` reads the
saved diagnostic without inference or TEST access. Model/registry overrides
must still match the exact saved C11 identity and cutoff. A rebuild or new
export does not automatically replace or qualify the saved scorer.

## Current training and export

[training/README.md](./training/README.md) documents the supervised CUDA campaign,
checkpoint snapshots and local import/export sequence. Training uses the
immutable 327-row FIT set, 86 pairs and 133 groups with the pinned original
Google HF base. CAL, diagnostic VALID and TEST are outside the training path.
Qwen and Chinese-lineage bases, derivatives, teachers, fallbacks and tests
remain excluded.

The local original HF snapshot is retained at the stable ignored path below.
Keep its cache tree and shared blobs together so its relative links resolve.
The current staged FIT workflow uses this HF checkpoint and preserved prepared
FIT bytes. A fresh clone must obtain that exact HF revision separately under
the Gemma terms; the saved merged bundle does not include the original HF base.

```sh
task_base_hf="$PWD/.build/huggingface/hub/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752"
npm run train:guardrail -- --check --base-hf "$task_base_hf"
npm run train:guardrail -- --base-hf "$task_base_hf" \
  --stage /absolute/path/to/fresh-c11-inputs
```

The stage command prepares verified inputs; it does not connect to a remote
host or start training. Follow the training README's explicit supervised
launch/snapshot steps. Import a locally copied, verified checkpoint into a
fresh output directory:

```sh
npm run export:guardrail -- \
  --run /absolute/path/to/fresh-local-export \
  --cuda-run /absolute/path/to/verified-local-checkpoint \
  --receipt-sha256 RECORDED_CHECKPOINT_RECEIPT_SHA256 \
  --base-hf "$task_base_hf" \
  --native-binary "$PWD/.build/jev-native" \
  --model-id jev/local-experiment
```

Training preparation uses `python3`; choose another interpreter with `--python`.
Local import/export defaults to `.build/rfdt-venv/bin/python`; use `--python`
to select another pinned local environment.

Local export uses the pinned MLX environment and llama.cpp converter, performs
FP32 fusion/F16 conversion, and verifies native FIT parity. Keep explicit paths,
recorded hashes and fresh directories; previous attempts remain inspectable.
`npm run native:build` obtains the pinned llama.cpp source and builds the local
native executable for training/export or portability. It requires Git,
CMake 3.20 or later and a C++17 toolchain. The retained local Python environment
is `.build/rfdt-venv`; `scripts/build-rfdt.sh --with-converter` recreates it when
needed. These build commands do not train or qualify a model.

## Checks and background

`npm run check`, `npm test`, `npm run test:training` and `npm run build` exercise
the focused source and immutable training contracts. `npm run test:package`
checks the installed package without weights. `npm run test:sf-pi` checks Pi
SDK package loading and lazy provider discovery without weights. To exercise
the preserved host's shadow integration and actual local model in a disposable
snapshot, use:

```sh
npm run test:sf-pi -- --sf-pi /absolute/path/to/sf-pi --native
```

The host check uses counter-only tools and performs no external operations.
`npm run smoke` separately exercises the real local scorer.

[Blog background](./docs/blog-background.md) preserves the project's chronology,
rejections and evidence limits. Historical source and reports remain in normal
Git history. First-party code is [Apache 2.0](./LICENSE); Gemma-derived weights
retain their [separate terms and notices](./THIRD_PARTY_NOTICES.md).
