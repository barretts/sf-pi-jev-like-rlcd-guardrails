# Simple Jev for TypeScript and pi

Independent implementation of Simple Jev's v1 classifier behavior, with a reusable TypeScript library, a standalone pi extension, and optional HTTP serving. Model execution uses a local llama.cpp subprocess; the model's next-token logits determine the answers. No generated JSON completion is parsed.

The initial supported artifact is **Google Gemma 3 1B Instruct, F16 GGUF**. Qwen and Chinese-lineage models, including derivatives, merges, and distilled variants, are excluded from implementation, examples, testing, and fallback selection. A checksum allowlist enforces the initial artifact selection; configuration cannot bypass it.

This is an independent rewrite with documentation and source inspection permitted, not a strict source-access-separated clean-room process. Prompt text intentionally matches the source project's published v1 contract. The reference baseline is Simple Jev commit `0dd5396ffce671ab7c4bfc031506d8e558cf8d23`. This package is private/local pending a separate publication and licensing decision.

## Setup

Requirements: Node ≥22.19, npm, Git, CMake ≥3.20, a C++17 compiler, supported pi `>=0.84.0 <1.0.0`, and approximately 2 GB for the source weights plus build and runtime memory. CPU initialization expands those verified weights exactly to a temporary F32 GGUF (approximately 4 GB), uses F32 KV caches, and removes the temporary file on disposal. Budget additional disk and RAM for that expansion; first use includes conversion cost. Native compilation is explicit; installation and extension registration do not build or download anything.

```sh
npm ci
npm run build
npm run native:build
```

Review [Gemma's terms](https://ai.google.dev/gemma/terms), then fetch the pinned artifact if you accept them:

```sh
npm run model:fetch -- --accept-gemma-terms
export JEV_MODEL_FILE="$PWD/models/gemma-3-1b-it-f16.gguf"
export JEV_MODEL_ID='google/gemma-3-1b-it'
export JEV_DEVICE='cpu' # auto, cpu, or metal
pi install "$PWD"
```

In pi, run `/reload`, `/jev doctor`, and `/jev warmup`. `/jev` and `/jev status` show cached readiness/configuration. The first classifier tool call also initializes the model. A missing model, unavailable native executable, or incorrect checksum produces an error with no substitute model. Each backend verifies the full artifact checksum during initialization.

Use the same installation in a pi session with sf-pi enabled. The extension is generic and imports no sf-pi implementation modules. It does not change Salesforce routing, tool permissions, or Guardrail authority. Classification answers are advisory and their confidence values are uncalibrated.

## Tool input

The `jev_classify` tool accepts exactly one non-null `state` or text `messages`. Model selection is process configuration, not a tool argument. Ordered question/candidate arrays preserve source order even for numeric-looking IDs:

```json
{
  "state": "Mia owns a red bicycle. Her dog is named Max.",
  "questions": [
    {
      "id": "color",
      "type": "choice",
      "instructions": "What color is Mia's bicycle?",
      "criteria": [
        { "id": "red", "description": null },
        { "id": "blue", "description": null }
      ]
    },
    {
      "id": "support",
      "type": "score",
      "instructions": "How well is bicycle ownership supported?",
      "criteria": ["Unsupported", "Partly supported", "Fully supported"]
    },
    { "id": "dog", "type": "noul", "instructions": "Is Mia's dog named Max?" }
  ]
}
```

Results appear as JSON text and typed tool details, containing `model`, `answers`, and `usage`. Choice returns the highest-probability candidate; score returns the expected zero-based rubric index; Noul maps the expected nine-bin rating to `[0.01, 0.99]`. Output-token usage is zero. Exceptions use pi's normal tool failure handling.

Set `ENABLE_OPEN_JEV_ADVANCED_METRICS=1` before launching pi to enable diagnostic answers and execution metrics. `options.raw_logits: true` additionally exposes original selected logits. Prompts and numerical answers are unaffected by diagnostic settings.

## Library

```ts
import { Classifier, configFromEnv } from "simple-jev-ts";
const classifier = new Classifier(configFromEnv());
try {
  const result = await classifier.classify(
    {
      model: classifier.config.modelId,
      state: "The bicycle is red.",
      questions: [{ id: "red", type: "noul", instructions: "Is it red?" }],
    },
    new AbortController().signal,
  );
  console.log(result.answers);
} finally {
  await classifier.dispose();
}
```

`validateRequest`, `preparePrompt`, `buildResponse`, and `parseHttpRequest` are also exported. `InferenceAdapter` separates model execution from scoring. Direct TypeScript requests use the ordered tool-style question representation; `parseHttpRequest` converts the original object-shaped HTTP representation. Callers must dispose native-backed instances. One adapter belongs to one classifier; do not invoke its compile/evaluate operations concurrently.

## HTTP server

```sh
node dist/server.js --model-file "$JEV_MODEL_FILE" --model google/gemma-3-1b-it --device cpu
```

Endpoints: `POST /v1/classifier`, alias `/v1/systemone`, `GET /health`, `/docs/`, `/redoc`, and `/openapi.json`. The HTTP request representation retains the original question/candidate objects. Unknown top-level fields are ignored; questions/options are strict. The ordered JSON reader preserves numeric-looking source keys. Duplicate JSON object keys are rejected.

```sh
curl http://127.0.0.1:8000/v1/classifier \
  -H 'Content-Type: application/json' \
  -d '{"model":"google/gemma-3-1b-it","state":"The bicycle is red.","questions":{"color":{"type":"choice","instructions":"What color?","criteria":{"red":null,"blue":null}}}}'
```

Defaults: localhost port 8000, 16,384 tokens per branch, 100 branches per request, 32 suffix sequences per batch, and a conservative 32,768-token suffix budget. The schema permits up to 256 questions and 2–50 choice/score entries. One request runs at a time; 16 additional requests may wait. Further requests receive 429 and `Retry-After: 1`. Input is not truncated. Runtime failures return 500; invalid requests return 422. Cancellation is observed between model forwards, with safe cleanup before another request executes.

## Compatibility and verification

- Gemma's native template merges the logical system instructions into its first user turn. The adapter uses the GGUF's Jinja template, includes the model BOS token, and appends the incomplete assistant answer prefix. It rejects unsupported roles or non-alternating histories instead of rewriting them.
- Both input interfaces share the exact v1 classifier fragments and scoring rules. Probabilities are normalized over permitted labels only. Responses are not guaranteed identical to Hugging Face inference: engine arithmetic and weight representation differ.
- Advanced metadata identifies `llama.cpp`. Native suffix batches do not pad; padding metrics are zero, and forward/token counts reflect actual execution. Prefix KV state is reused only within a request.
- Canonical JSON sorts object keys by Unicode code points and uses ECMAScript number formatting. Arbitrary floating-point prompt byte parity is not guaranteed across languages. Exact Pydantic coercions/error wording and generated documentation markup are outside the compatibility target.
- HTTP transport imposes an 8 MiB body limit. CLI devices are `auto`, `cpu`, and `metal`; HF revision/dtype loading flags are not supported. Registry extension requires reviewed provenance, checksum, template, and cache checks.

```sh
npm run check
npm test
npm run build
JEV_DEVICE=cpu npm run smoke
node scripts/pi-smoke.mjs
node scripts/http-smoke.mjs
```

Unit tests need no weights, Python, credentials, or live service. Captured Python fixtures verify exact prompt fragments and scoring within `1e-6`. The CPU build disables BLAS and weight repacking to keep the reference arithmetic consistent. Full-forward comparison evaluates each complete question independently. The native smoke test verifies cached/full-forward probabilities within `1e-5`, zero outputs, prefix reuse, and both context forms. The HTTP smoke test exercises real localhost transport, errors, diagnostics, and recovery after disconnect. The pi smoke test sends a prompt through the real session and agent loop, validates and dispatches `jev_classify`, executes local Gemma inference, and passes the result to the next assistant turn. Its orchestration harness is deterministic and sends no provider request. It does not establish autonomous agent tool selection or task quality.

Native model/runtime builds and downloaded weights stay outside Git. RFDT, automatic routing/evaluation hooks, sf-pi Manager integration, and browser demos are deferred.

For an independent native-template check after smoke, run `python3 scripts/template-check.py` with Python ≥3.12 and Jinja2 installed. For full sf-pi coexistence testing, create an isolated source/dependency copy at `.build/sf-pi` and run `node scripts/pi-smoke.mjs --with-sf-pi`; no user settings or original sf-pi checkout are changed.

[Implementation evidence](./VERIFICATION.md) records the tested model/runtime identities, CPU and Metal cache checks, pi/sf-pi coexistence, and real HTTP recovery results.

## Deferred

- Hardening
- Recovery
- Concurrency
- Security
- Cleanup
- Edge cases
- Governance
- Cost
- Compliance
- Scale
- Answer quality
- Autonomous tool selection
- RFDT
- Automatic routing and evaluation hooks
- sf-pi Manager integration
- Browser demos
