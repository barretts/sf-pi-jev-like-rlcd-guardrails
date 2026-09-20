# Simple Jev for TypeScript and pi

A local TypeScript classifier library, the `jev_classify` pi extension, experimental session context compression and model routing, an HTTP API and browser playground, and an RFDT training/export workflow. Classification reads selected next-token logits from a local llama.cpp process. It does not generate or parse a JSON completion.

The default classifier uses **Google Gemma 3 1B Instruct**; a reviewed **Gemma 3 4B Instruct** candidate is also available for explicit evaluation. The local agent and teacher use the official **Google Gemma 4 31B Instruct QAT Q4_0** artifact. Qwen and Chinese-lineage models, including derivatives, merges, distills, teachers, tests, and fallback models, are excluded. Artifacts must match reviewed registry entries, roles, revisions, byte sizes, and SHA-256 checksums. Missing or incorrect weights produce an error.

This is an independent rewrite with documentation and source inspection permitted. Published v1 prompt fragments retain compatibility with Simple Jev commit `0dd5396ffce671ab7c4bfc031506d8e558cf8d23`; it is not a source-separated clean-room process. First-party code is [Apache 2.0](./LICENSE). See [NOTICE](./NOTICE) and [third-party notices](./THIRD_PARTY_NOTICES.md) for provenance and separate model terms. The repository and npm package remain private.

## Setup

Requirements: Node ≥22.19, npm, Git, CMake ≥3.20, a C++17 compiler, and pi. The exercised SDK version is `0.85.1`. Apple Silicon Metal is the intended local workflow; CPU classification is supported. Native compilation and downloads are explicit. Installing the extension or opening Manager does not start inference, compile code, or fetch weights.

```sh
npm ci
npm run build
npm run native:build
```

Review [Gemma 3's terms](https://ai.google.dev/gemma/terms) before fetching that model:

```sh
npm run model:fetch -- --accept-gemma-terms
export JEV_MODEL_FILE="$PWD/models/gemma-3-1b-it-f16.gguf"
export JEV_MODEL_ID='google/gemma-3-1b-it'
export JEV_DEVICE='metal' # auto, cpu, or metal
node dist/cli.js doctor
node dist/cli.js warmup
pi install "$PWD"
```

In pi, run `/reload`, `/jev doctor`, and `/jev warmup`. The first tool call also initializes the classifier. `doctor` verifies prerequisites and the artifact without loading the model. `/jev status` and Manager use cached state.

The default Gemma 3 weights occupy approximately 2 GB. CPU initialization expands verified F16 weights exactly into a temporary F32 GGUF of approximately 4 GB and uses F32 KV caches. Metal uses the verified source artifact and F32 KV caches. Allow disk and RAM for context and any CPU expansion. Temporary runtime files are removed on disposal. The 4B F16 candidate occupies approximately 7.77 GB and is selected explicitly:

```sh
node dist/cli.js model fetch --model google/gemma-3-4b-it --accept-gemma-terms
export JEV_MODEL_FILE="$PWD/models/gemma-3-4b-it-f16.gguf"
export JEV_MODEL_ID='google/gemma-3-4b-it'
```

The optional Gemma 4 agent/teacher adds approximately 17.65 GB of weights and substantial memory; the target machine is an Apple M3 Max with 96 GiB unified memory. A reviewed artifact is eligible for execution; its review alone does not establish the quality gates.

## pi and sf-pi

The stable public tool is `jev_classify`. `/jev` opens Jev's own sf-pi Manager page when the external-contribution contract is installed. Standalone pi supports the tool and commands.

| Command                                                            | Purpose                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `/jev status`                                                      | Cached readiness, effective preferences, runtime identity |
| `/jev doctor`                                                      | Check binary, model, checksum, and configuration          |
| `/jev warmup`                                                      | Explicitly load the classifier                            |
| `/jev enable [project\|global]` / `/jev disable [project\|global]` | Change scoped lifecycle setting                           |
| `/jev routing on\|off [project\|global]`                           | Advisory family recommendation before a user turn         |
| `/jev evaluation on\|off [project\|global]`                        | Evaluate a settled answer on three rubrics                |
| `/jev template v1\|v2 [project\|global]`                           | Select pi/hooks prompt version                            |
| `/jev routing-report` / `/jev evaluation-report`                   | Show latest session report                                |

Defaults are enabled, **routing off**, **evaluation off**, and template **v2**. Settings live under `jev` in pi's global or project `settings.json`; project values override global values per field. Writes preserve unrelated keys using atomic private temporary files. Disabling awaits disposal. Reenabling creates a fresh lazy classifier.

Routing discovers Salesforce capability families from active tools and includes `mixed` and `general`. It adds advisory context. It never changes active tools, permissions, Guardrail authority, or retry behavior. Evaluation runs once per persisted user/final-assistant pair after the run settles and scores coverage, evidence, and clarity from zero to two. It creates no new assistant turn. These estimates are uncalibrated.

The Manager contract is a general external-extension contribution seam; Jev imports no sf-pi implementation modules. External rows own their settings and enable/disable callback and stay out of bundled disabled-file lists and bulk toggles. The sf-pi change is developed in a separate worktree against baseline `4f901db9c3f5076ea0305dea33ad6e8856e467da`. The baseline-bound patch and setup instructions are retained under `integrations/`. The original sf-pi checkout is preserved; no public sf-pi push is required.

### Session context compression and current-request routing

Context reduction is **disabled by default**. The installed extension provides these session controls:

| Command                                | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `/jev-context on` / `/jev-context off` | Enable or disable context reduction                     |
| `/jev-context status`                  | Inspect the current mode and cached reduction estimates |
| `/jev-context reset`                   | Reset session context-reduction state                   |
| `/jev-context excerpts`                | Select task-aware exact excerpts and enable reduction   |
| `/jev-context caveman`                 | Select the injected summary mode and enable reduction   |

The ordinary `registerExtension` path selects task-aware exact excerpts when reduction is enabled. Selected excerpts retain the source text verbatim; full original tool results remain in memory and persisted session history for retrieval. The request view omits other text, so excerpt delivery alone does not establish answer correctness. The default `targetReduction` is `0.5`, a requested reduction target. Status labels token counts as estimates; actual provider usage needs separate measurement. The current acceptance target is a measured **50% reduction in whole-workflow prompt tokens**. A [completed bounded answer-effectiveness evaluation](./research/context-effectiveness-root-1/RESULTS.md) recorded 86/96 accepted excerpt answers versus 84/96 with full context, with one paired regression. Production answer quality remains unqualified.

The `jev_context_read` tool retrieves retained original text using a host-issued `reference` handle. Its optional `offset` is a one-based line number; `limit` defaults to 100 lines and is capped at 200. An optional `byteOffset` is a zero-based UTF-8 boundary for paging a long line. Each page contains at most 16 KiB of original text; JSON escaping and metadata add response overhead. Use `nextOffset` or `nextByteOffset` to continue. References are handles, not filesystem paths.

Caveman mode uses an optional host-injected `ContextCompressionOptions.summarize` callback. A host can supply a Grok summarizer, but the extension does not resolve credentials or start an additional model automatically. Without a callback, caveman mode falls back to excerpts. The callback receives `{task, reference, excerpt, maxOutputBytes, signal?}` and returns `{text, complete}`; a host owns its transport and credential handling.

Standalone `registerContextCompression` calls with no strategy retain the existing lossless default for compatibility. That strategy replaces sufficiently repetitive completed-tool text with an exactly reversible representation. Original tool results remain preserved. A separate caller-owned manifest identifies transformed blocks; quoted instructions or format-like text inside a tool result do not authorize a transformation. Bounds, unsupported providers, or a failed final request check fall back to original text. The current provider support is OpenAI completions and the owned routing dispatcher when its targets use that API.

These controls do not write global or project settings or select a task model. Enabling reduction during a turn takes effect after the next turn captures its current task.

With the external Manager contract installed, `Jev Context Compression` exposes the same session toggle and cached status. Open it with `/sf-pi open jev-context settings project`. The `project` argument chooses a Manager view; the page's controls still apply only to this session. Status distinguishes tool-text savings from the serialized request reduction, including tool schemas and instructions. Byte reduction does not establish token, latency, or billing savings.

Hosts can import `registerExtension` from `simple-jev-ts` and explicitly supply `contextCompression` or `routingDispatcher` options. The ordinary install does not discover or qualify a routing artifact automatically. A host must bind approved target registrations, the exact classifier artifact and qualification hashes, classification, and the supplementary eligibility guard. Both the dispatcher and context compression start with opt-in defaults; unqualified routing cannot select the fast target.

For a configured dispatcher, these commands are available:

| Command                                    | Purpose                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `/jev-routing status`                      | Inspect cached mode, target availability, qualification, and latest request |
| `/jev-routing use`                         | Select the `jev-routing/current-request` dispatcher for subsequent prompts  |
| `/jev-routing off` / `/jev-routing strong` | Use the configured strong target without classification                     |
| `/jev-routing shadow`                      | Observe a qualified routing decision while executing the strong target      |
| `/jev-routing auto`                        | Dispatch eligible requests using the qualified classifier and safety guard  |
| `/jev-routing fast`                        | Request fast routing when qualified and eligible; retain strong fallback    |

Routing selects the target inside the active provider stream for the same prompt. This addresses Pi's model capture before `before_agent_start`; changing the model in that later hook cannot route the current prompt. The dispatcher preserves cancellation, tool schemas, and attribution to the executing target. Automatic and fast modes require a complete result matching the qualified classifier artifact and an eligible input. Missing facts, uncertain or failed classification, unsupported input, and unavailable targets require fallback or an explicit error. An explicit fast preference does not bypass those checks. Host target attestations permit Google Gemma, the user's selected xAI Grok, and an attested OpenAI registration; prompt text cannot supply a model or lineage claim.

When configured, `Jev Model Routing` provides session controls, qualification availability, the latest selected target, and fallback/cancellation status in Manager. `/sf-pi open jev-routing settings project` opens its page. Its fast and automatic actions explain unavailable qualification or targets instead of silently enabling them. The existing `/jev routing on|off` remains advisory Salesforce capability routing; it does not activate this model dispatcher.

## Tool input and answers

Supply exactly one non-null `state` or a text `messages` history. Model selection is process configuration, not a tool argument. Ordered questions and candidates preserve source order, including numeric-looking IDs:

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

Results are JSON text and typed tool details with `model`, `answers`, `usage`, and `metadata`. Choice returns the highest-probability candidate. Score returns the expected zero-based rubric index. Noul maps the expected nine-bin rating to `[0.01, 0.99]`; v2 explicitly defines integer bins 1=false, 5=unknown, 9=true. The classifier generates zero output tokens. Confidence is normalized over permitted labels only and is not a calibrated probability of correctness.

`options.template_version` explicitly selects `v1` or `v2`. HTTP and library default to **v1**; pi, advisory hooks, evaluation CLI, and browser default to **v2**. v1 logical prompt fragments and scoring remain intact. Gemma's native template merges the system instruction into the first user turn. The selected question is merged into a final user turn for native rendering when necessary, while logical v1 fixtures remain unchanged. Unsupported roles and other invalid non-alternating histories are rejected.

Set `ENABLE_OPEN_JEV_ADVANCED_METRICS=1` for diagnostic distributions and execution metrics. `options.raw_logits: true` exposes original selected logits. Always-present metadata records the actual template and available backend/artifact identity. Logical `usage.input_tokens` counts unique token prefixes across the branch prompts; advanced computed-token and forward counts describe actual execution. `branch_prompt_tokens` is the sum of full branch lengths. Do not infer a latency ratio or billed token work from logical usage.

The pi tool's model-visible text is compact: an ordered answer array retains question IDs, exact estimates, available distributions, requested raw fields, usage, provenance, and advisory/uncalibrated status. The complete classifier response remains in tool `details`. Library and HTTP responses retain their existing representation.

An experimental second tool, `jev_classify_loaded`, handles a request bundle already returned by pi's builtin `read`. A bundle has this shape:

```json
{
  "records": [
    {
      "id": "review-1",
      "request": {
        "state": "The relevant test is still running. No result is available.",
        "questions": [
          {
            "id": "verified",
            "type": "noul",
            "instructions": "Has the relevant test passed?"
          }
        ]
      }
    }
  ]
}
```

A successful complete builtin read of a valid bundle receives a `Jev loaded request reference` marker. Supply its explicit `read_tool_call_id` to `jev_classify_loaded`; the tool classifies the observed text from session memory in record order. It does not open a path or accept model selection in the bundle. Partial/truncated reads are rejected, later reads of the same path supersede earlier references, and session changes or disabling clear references. Full actual responses and source identity remain in tool details. A later classification failure preserves completed records in the final error result and saved pi session, with explicit incomplete status. Retention of pending failure receipts is bounded to the classifier's 17-request capacity and is cleared with the session.

This path is under evaluation. Local integration checks establish its argument, lifecycle, and accounting behavior; reliable developer judgments and a complete-workflow speed improvement remain unproven. The frozen corpus, hypotheses, failures, and acceptance conditions are recorded in [EXPERIMENTS.md](./EXPERIMENTS.md).

The earlier [context-compression pilot](./research/context-compression-pilot.md) measured a lossless representation of repeated completed-tool lines with the existing Grok 4.6 gateway model in both comparison arms. That experiment predates the new Pi hook. Its six fixed samples retained correct answers with about 60% fewer prompt tokens, while observed answer latency increased by about 57%. Provider caching also prevents inferring billing savings from those prompt counts.

The new `scripts/context-workflow-eval.mjs` prepares frozen paired workflows using the actual Pi SDK, a builtin read tool, the opt-in compression hook, and fixed Grok 4.6 task execution. Optional Grok judgments provide a separate check; literal expected answers remain host-only. Preparation does not resolve credentials:

```sh
node scripts/context-workflow-eval.mjs \
  --fixture fixtures/context-compression-v2-validation.json \
  --output .build/context-workflow-eval
```

Executing a prepared run requires `--run` and an explicit `--api-key-file` pointing to an existing local credential file. The [first live four-session smoke](./research/context-workflow-smoke-root-1/result-projection.json) received HTTP 400 before any tool execution in both arms. It remains a gateway transport/harness failure, with unknown token usage and no answer-quality finding. Subsequent fixes kept the Grok task model fixed while correcting SDK compatibility and simplifying the compression instructions.

The [third public smoke](./research/context-workflow-public-smoke-root-3/result.json) completed all four sessions correctly, and its separate Grok judge passed. Across the two paired repetitions, baseline prompt tokens totaled 5,262 versus 3,646 with compression, a 30.71% reduction. Total tokens were 5,502 versus 4,129; summed workflow times were 13.6855 s versus 12.0309 s. This establishes working tool dispatch, context transformation, original preservation, and correct answers for that one synthetic case. Two pairs do not establish general speed, cost, or developer benefit.

The [full public validation](./research/context-workflow-public-validation-root-1/result.json) scheduled 192 sessions: 24 cases, four repetitions, and two arms. Gateway throttling produced 169 errors; the remaining 23 completions were correct. The evaluator retained the failed slots and left full-population token and latency comparisons unknown. The run was not qualified; those 23 successful completions cannot stand in for the 192-session comparison.

A paced sf-pi follow-up used the controlled 23-factory source setup and had no HTTP 429 responses. Its four final answers were correct and the compressed requests passed the live wire checks, but two sessions also reported extension errors. Only two of four workflows completed without an error, so the run did not qualify. A correct final answer does not override an extension failure. The [next smoke](./research/context-workflow-sf-smoke-root-3/result-projection.json) confirmed corrected acceptance accounting and located both failures in `sf-slack` session startup. The harness omitted `session_shutdown` before disposal, leaving a stale listener; the [lifecycle review](./research/sf-context-session-cleanup-review.md) explains the correction. The original failures remain preserved. This setup does not establish equivalence to an installed sf-pi default session.

The [corrected SF smoke](./research/context-workflow-sf-smoke-root-4/result-projection.json) completed all four workflows correctly, passed its Grok judge, and recorded clean shutdowns with all 23 factories loaded. No extension or rate-limit errors occurred. Prompt tokens fell 12.59%, while aggregate workflow elapsed was 1.75 times baseline. This confirms the lifecycle correction and functional context path, but fails the declared performance gates on this small case.

The subsequent [full SF comparison](./research/context-workflow-sf-validation-root-1/result-projection.json) saved all 192 scheduled sessions with no unrun slots, extension failures or HTTP 429 responses. Baseline completed 96/96 workflows with 88 correct answers; compaction completed 95/96 with 89 correct answers and one completion-length error. All shutdowns were safe, and all 24 context judges passed preservation checks. Across the full recorded population, prompt tokens fell only 0.298%, from 554,728 to 553,075. Output tokens rose from 11,232 to 30,184, and total tokens rose 3.06%, from 565,960 to 583,259. Summed workflow time rose 5.98%, from 3,821.50 to 4,050.17 seconds. These paced timings include the CPU observer and uncontrolled provider-cache effects. Qualified comparison ratios remain null and both functional and performance qualification are false. Repetition compression did not provide the requested 50% reduction on this workload.

### Exact-excerpt answer effectiveness

The [completed quality comparison](./research/context-effectiveness-root-1/RESULTS.md) recorded all **192 scheduled workflows**, using the same Grok 4.6 model, genuine Pi builtin reads and all 23 controlled SF factories. It scored 24 source-blind authored cases and 24 separately frozen long scoped variants against independently recomputed host-only gold, in two counterbalanced repetitions per arm. Full context accepted **84/96 (87.50%)** workflows; excerpts accepted **86/96 (89.58%)**. There were three paired workflow improvements and **one real regression**, on a long exact multiline body-count/position task. One improvement was a raw execution error paired with a correct excerpt answer; two were long Unicode cases whose raw answers failed JSON parsing. Short controls accepted 41/48 in each arm and did not compress; all 48 long excerpt workflows applied compression, accepting 45/48 versus 43/48 raw.

Across all 399 physical task requests, including failures and recovery, prompt tokens fell from **1,593,640 to 625,273 (60.76%)** and total tokens fell 57.14%. Output tokens rose 28.76%, and summed physical task-request time including pacing rose 18.67%. The campaign retained three raw and two excerpt execution errors and exited **1**; this is a completed evaluation with negative results, not an all-green qualification. All 187 completed workflows verified exact originals, wire delivery and cleanup; final runtime credential cleanup completed. The supplementary Grok judge was inconclusive: 24 valid/supporting judgments, 70 failed and two unrun of 96 planned. Its missing usage remains unknown. The strict quality conclusion rests on checked gold, not a blanket judge endorsement. The synthetic comparison does not establish population noninferiority, production developer effectiveness, latency improvement or billing savings.

### Bounded context reduction benchmark

The [first excerpt/retrieval benchmark](./research/context-reduction-smoke-root-1/result-projection.json) met the requested reduction target on a bounded long-output workload. It used actual Pi/Grok execution with all 23 controlled SF factories, three invented 20–40 KiB trace cases, two counterbalanced repetitions and six workflows per arm. All 12 workflows completed with zero errors or unrun slots. Canonical original text remained exact, the provider-wire projection was verified, and cleanup completed. Across every physical request, including recovery requests, prompt tokens fell from **140,766 to 53,955, a 61.67% reduction**. There were 12 raw-arm and 14 compressed-arm requests, with zero summary-model calls.

The [measurement](./research/context-reduction-smoke-root-1/measurement.json) also records total tokens falling from 142,114 to 58,046 (59.16%), while output tokens increased from 1,348 to 4,091. Summed paced workflow elapsed increased from 60.7612 to 85.3400 seconds, or 1.4045 times baseline. Answer effectiveness was deferred: there were no judges or answer-quality acceptance gates, and production improvement remains unqualified. Provider-cache accounting is incomplete, so this is no billing or latency benefit claim. This controlled source setup does not establish the same reduction for normal installed defaults, short context or inputs whose protected content cannot be omitted. The earlier 192-session repetition-codec result and failed routing results remain preserved.

The later [optional caveman comparison](./research/context-reduction-caveman-smoke-root-1/result-projection.json) used the same frozen inputs and source with its own raw comparison. All 12 workflows completed with zero errors or unrun slots, and canonical-original, wire-projection and cleanup checks passed. It **failed the 50% reduction objective**: whole-workflow prompt tokens fell from 141,186 to 120,175, only 14.88%. Task-only reduction was 17.17%, but the objective includes all summary requests. Its 35 physical requests were 12 raw task requests, 15 compressed task requests and eight summary requests; summary input/output usage of 3,226/7,680 tokens is included. Three summary requests completed and five were recorded as incomplete. These execution results do not qualify summary generation or answer quality, and fallback may occur.

The [caveman measurement](./research/context-reduction-caveman-smoke-root-1/measurement.json) records total tokens falling from 142,952 to 132,899 (7.03%), output tokens increasing from 1,766 to 12,724 (7.2050 times baseline), and summed paced workflow elapsed increasing from 61.5746 to 141.9541 seconds (2.3054 times baseline). Its [publication manifest](./research/context-reduction-caveman-smoke-root-1/publication-manifest.json) preserves harness exit code 1 for the unmet reduction objective. Effectiveness remains deferred and production improvement remains unqualified. Excerpts remain the ordinary registration strategy; optional caveman remains opt-in. Neither campaign establishes a universal reduction, cost saving, speed improvement or model-training benefit.

To prepare the same benchmark shape from this repository, use the controlled SF checkout and a new output directory:

```sh
node scripts/context-reduction-smoke.mjs --prepare \
  --output "$PWD/.build/context-reduction-excerpts-sf-round-1" \
  --strategy excerpts --with-sf-pi \
  --sf-pi-path /Users/bsonntag/code/sf-pi-jev-manager
```

Preparation returns `protocolSha256`. Replace `RETURNED_PROTOCOL_SHA` below with that value and the credential-file placeholder with an existing local file, retaining the same output directory, strategy and SF checkout:

```sh
node scripts/context-reduction-smoke.mjs --run \
  --output "$PWD/.build/context-reduction-excerpts-sf-round-1" \
  --strategy excerpts --with-sf-pi \
  --sf-pi-path /Users/bsonntag/code/sf-pi-jev-manager \
  --expected-protocol-sha RETURNED_PROTOCOL_SHA \
  --api-key-file /path/to/existing/local/llmgw-key
```

The frozen protocol uses zero retries, a 300-second workflow limit, at most four task requests and four summary requests per workflow, and shared five-second pacing. The [excerpt protocol](./research/context-reduction-smoke-root-1/protocol.json) records source commit `2860d17b005f3c0d6cca9a25a9e0b0d118113665` and individually pins the executed source and SF setup; [local validation](./research/context-reduction-smoke-root-1/local-validation.json) is separate from answer-quality evidence. To reproduce the optional comparison, use `--strategy caveman` and a fresh output directory, retaining the prepare/run SHA binding and explicit credential-file input. Its [protocol](./research/context-reduction-caveman-smoke-root-1/protocol.json) preserves the separately frozen run.

Counterbalanced order, failed and unrun slots, provider usage and cache counts, original-text preservation, and local transform time remain explicit in evaluator results. These Grok-controlled harness tests are separate from changes to local Gemma training. [EXPERIMENTS.md](./EXPERIMENTS.md) records the runs, remaining failures, and acceptance gates.

The developer workflow evaluator also has a `configuredGateway` lane for the existing Pi `llmgw/gpt-5.6-sol` registration. Set `JEV_REVIEWED_PROVIDER_ORIGIN` to the exact gateway origin pinned in the evaluator, then prepare the frozen review suite:

```sh
node scripts/developer-task-eval.mjs \
  --prepare-only --workflow review \
  --corpus-freeze .build/improvement-experiments/corpus-freeze.json \
  --provider-lane configuredGateway \
  --provider-origin "$JEV_REVIEWED_PROVIDER_ORIGIN" \
  --provider-models-path "$HOME/.pi/agent/models.json"
```

Preparation uses the actual SDK registration with an in-memory model store, credential reads disabled, and catalog refresh disabled. It reports pending upstream verification until a reviewed attribution proof binds the alias, actual model lineage, origin, and registration digest. Inference additionally requires that frozen proof, explicit read-only auth configuration, and run clearance. The local Google Gemma lane remains the default. Both lanes retain the full controlled SF tool set, all review correctness and resource gates, and the four required repair tasks. Repair advice and autonomous Jev tools use the same selected classifier model, file, device, and optional disposable research registry.

Sequential benchmark trials use one restored absolute workspace, with fresh agent state and separate run archives. Completed wrong answers retain their actual judgments and allow later trials after confirmed cleanup. Uncertain cleanup quarantines the workspace and retains every unrun slot as a failure. This controls a prompt-path difference; it does not establish cache reuse or a speed improvement.

## Library

```ts
import { Classifier, configFromEnv } from "simple-jev-ts";
const classifier = new Classifier(configFromEnv());
try {
  const result = await classifier.classify({
    model: classifier.config.modelId,
    state: "The bicycle is red.",
    questions: [{ id: "red", type: "noul", instructions: "Is it red?" }],
    options: { template_version: "v2" },
  });
  console.log(result.answers, result.metadata);
} finally {
  await classifier.dispose();
}
```

Exports include request/prompt/scoring helpers, `InferenceAdapter`, artifact verification, agent lifecycle, quality evaluation, benchmarking, and RFDT. Direct requests use ordered questions; `parseHttpRequest` converts original object-shaped HTTP input. `Classifier.status` and `NativeBackend.status` are getters; `AgentServer.status()` is asynchronous. One adapter belongs to one classifier; do not invoke native compile/evaluate concurrently outside the classifier.

Configuration supports `templateVersion`, `queueTimeoutMs`, `requestTimeoutMs`, `initTimeoutMs`, and `artifactRegistryPath`, in addition to model/device/batching limits. The registry override is for scoped, provenance-checked RFDT candidates; arbitrary models do not become trusted.

## HTTP and browser

```sh
node dist/cli.js demo --host 127.0.0.1 --port 8000 --workspace "$PWD"
```

Open `http://127.0.0.1:8000/` for an editable playground displaying the submitted request, real response, answers, usage, metadata, and errors. `/inspect` lists saved advisory reports and RFDT manifests under the workspace's `.jev` directory. Reads are restricted to validated IDs and owned directories. Raw prompt/training data and arbitrary filesystem paths are not browser endpoints. Reports contain summaries; RFDT intentionally stores prompts in private local run files because training requires them.

Endpoints include `POST /v1/classifier`, alias `/v1/systemone`, `GET /health`, local `/docs/`, `/redoc`, and `/openapi.json`. HTTP retains the original question/candidate object representation and lexical key order. Duplicate JSON keys are rejected. Unknown top-level fields are ignored; questions and options are strict.

```sh
curl http://127.0.0.1:8000/v1/classifier \
  -H 'Content-Type: application/json' \
  -d '{"model":"google/gemma-3-1b-it","state":"The bicycle is red.","questions":{"color":{"type":"choice","instructions":"What color?","criteria":{"red":null,"blue":null}}},"options":{"template_version":"v2"}}'
```

The server binds loopback only and checks Host and same-origin browser requests. Classification requires JSON. UI assets are local, with no CDN fetch. Input is limited to 256 KiB and depth 32 before prompt expansion. Invalid requests return 422, overload returns 429 with `Retry-After: 1`, and deadlines return 504. No request is silently truncated or replayed.

One request runs at a time; 16 may wait. Defaults are 30 seconds in queue, 120 seconds active classification, and 300 seconds shared initialization. Active timing starts after warmup. Aborting one warmup waiter does not cancel other callers' initialization. Active cancellation is checked between forwards. Native generations own their process and temporary files; termination escalates to TERM/KILL within bounds, and disposal awaits cleanup. A later explicit request may recover a failed worker.

Default limits are 16,384 tokens per branch, 100 branches per request, 32 suffix sequences per batch, and a 32,768-token suffix budget. The schema permits 256 questions and 2–50 choice/score entries, subject to branch capacity. CPU and Metal cache/full-forward equivalence are exercised separately.

## Local agent and autonomous pi proof

```sh
npm run agent:build
node dist/cli.js model fetch --model google/gemma-4-31B-it-qat-q4_0
node dist/cli.js agent start --device metal --port 8081
node dist/cli.js agent status
npm run test:live-pi -- --timeout-ms 600000
node dist/cli.js agent stop
```

For the all-sf-pi exercise, replace the live command with `npm run test:live-pi -- --with-sf-pi --sf-pi-path ../sf-pi-jev-manager --timeout-ms 600000`, pointing to the isolated sf-pi checkout with the Manager contract installed.

The owned agent server binds `127.0.0.1`, verifies model/template hashes and native revision, and records an owned state file. The live pi exercise uses a real local provider stream with no fake stream or required tool-choice setting. It separately records requested-classification tool selection and a direct-answer control. The older `scripts/pi-smoke.mjs` is a deterministic orchestration proof: classifier inference is real, but the next tool call is authored by the harness. These establish different evidence lanes.

Loading all sf-pi tools produced a 20,641-token agent prompt on the target M3 Max. Cold Gemma 4 prompt processing exceeded the exercise's default three-minute case deadline before dispatch; the command above explicitly allows ten minutes per case. The actual prompt, provider stream, and automatic tool selection are unchanged by this deadline option.

## Quality evaluation

[fixtures/quality.jsonl](./fixtures/quality.jsonl) was authored and frozen before inference: 300 labeled records in 150 context groups, state/chat pairs, grouped 60/20/20 train/validation/test splits, and 100 records per answer type. Noul has 40 true, 40 false, 20 unknown records. Choice pairs reverse candidate order. Cases cover negation, attribution, conditional plans, quotations, corrections, and uncertainty. Whole-file SHA-256: `cd3de2d07db024aeb0f8d22be394ffa9024307680efbe2967569c325bc7af3c9`.

```sh
npm run eval -- --version v1 --split validation --output .build/quality-v1.json
npm run eval -- --version v2 --split validation --output .build/quality-v2.json
# Only after selecting and freezing the final candidate:
# npm run eval -- --version v2 --split test --output .build/quality-final-test.json
```

Gates: choice accuracy ≥0.90, clear Noul accuracy ≥0.95, Noul Brier ≤0.10, normalized score MAE ≤0.10, zero errors, all marked regressions passing. Reports bind the selected dataset, actual artifact/template metadata, per-record logical prompt hashes, and an aggregate prompt manifest hash. Failed gates exit 1 while preserving the report. Validation selects candidates; held-out labels must not be used for tuning or relabeled to improve metrics. Runtime success alone does not establish quality. See [current evidence](./VERIFICATION.md).

The real 64-step Gemma 3 1B RFDT student passed every validation gate, then failed its single held-out score gate: normalized score MAE was 0.1139 against the 0.10 maximum. Held-out choice accuracy was 0.95 and clear Noul accuracy was 1.00, with zero execution errors. That exported student remains unapproved; the default remains the reviewed official Gemma 3 1B artifact. The official base models also failed the full authored quality gates, so callers should evaluate answer quality for their use case before depending on the classifier's judgments.

The later R7 student completed 512 training steps, changed its adapter, passed adapter reload checks, and exported a native GGUF. Its native validation still failed: legacy routing was 17/20, developer routing 22/26, clear developer Noul judgments 8/20, and diagnosis routing 48/56. All 194 scheduled validation records executed without inference errors. Training loss falling from about 6.70 to 0.0846 demonstrates fitting, not reliable judgments. R7 was rejected, with no promotion or new final-test attempt.

## RFDT

TypeScript owns validation, canonical prompts, native tokenizer/answer-boundary capture, grouped splits, local-teacher labeling/cache, provenance, export, and promotion. A pinned Python/MLX helper performs selected-last-position soft cross-entropy LoRA optimization on Google Gemma 3. It saves/reloads adapters, fuses safetensors, and invokes the pinned llama.cpp converter for F16 GGUF. It does not train on generated prose.

The new routing experiment uses a different training method. It leaves the pinned official Google Gemma 3 1B weights unchanged, extracts 1,152-dimensional last-token decoder features once, and fits a small binary routing head from the cached features on the CPU. The [first fit](./research/routing-head-round-1/evidence-manifest.json) covered all 240 machine-authored training examples and took about 146.8 ms for head fitting, with zero model-feature calls during that fitting phase. Feature extraction and model startup are separate work. This is fitting evidence only; the head is not qualified by its training diagnostics.

Two production-path validation corpora each completed all 180 scheduled decisions, but the completeness checker selected strong for every case before requesting features. Both runs therefore had zero feature calls and zero easy-case fast coverage. They failed the routing usefulness gate and did not measure the head's quality. The [first validation and independent audit](./research/routing-head-validation-round-1-audit.md) preserve that distinction.

The [direct head diagnostic](./research/routing-head-raw-validation-v2/archive-manifest.json) subsequently completed 180 real encoder calls on the unchanged head. It explicitly forced encoder eligibility only for laboratory measurement; production completeness and routing were not bypassed. Each pass selected fast for 19/20 easy cases but also 35/40 strong-required cases, failing the declared safety policy. Warm operational p95 was approximately 260.82 ms, above the 100 ms target. The score distributions overlap enough that even an optimistic scalar cutoff allowing zero unsafe decisions would retain only 2/20 easy cases. No threshold was changed or applied. The head remains unapproved; fitting success has not yielded a useful, safe production classifier.

| Work                          | What changes                                                    | What the result establishes                                                            |
| ----------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Frozen-feature routing head   | Small fast/strong classifier; official Gemma weights stay fixed | A completed CPU fit on cached training features                                        |
| RFDT student                  | LoRA adapter affects classifier answer logits                   | Training, reload, export, and separately scored native quality                         |
| Fixed Grok 4.6 workflow tests | Harness and context representation; task model stays fixed      | Transport, lifecycle, correctness, and resource comparisons for the recorded workflows |

The routing head does not reuse the rejected R7 adapter. Grok test or judge results do not improve Gemma's weights or count as successful RFDT training. [EXPERIMENTS.md](./EXPERIMENTS.md) records these separate evidence lanes and their acceptance gates.

```sh
bash scripts/build-rfdt.sh
node dist/cli.js rfdt doctor
```

The official training checkpoint is gated. Enable access at [Google Gemma 3 on Hugging Face](https://huggingface.co/google/gemma-3-1b-it), then authenticate locally with `.build/rfdt-venv/bin/hf auth login`. Do not put tokens into dataset files, Git, or chat. No other checkpoint is substituted.

Teacher requests use a missing-question JSON schema and validate returned targets before caching them. Cache identity includes the exact instructions and schema; cached targets are validated before use. Supplied labels and provenance are preserved. The real local Gemma 4 trial returned one valid choice estimate, reused it without another request, and skipped the teacher for fully supplied labels. These are training estimates rather than verified facts or calibrated probabilities.

RFDT JSONL uses stable `id`, `group_id`, classifier `request`, and question-keyed `targets`. Supplied targets take priority over teacher estimates. Answers may be choice IDs, score indices, Noul booleans, or Noul `null` for uncertainty. Full label probability distributions are also supported:

```json
{
  "id": "refund-1",
  "group_id": "refund-context-1",
  "split": "train",
  "request": {
    "state": "Please refund the duplicate charge.",
    "questions": [
      {
        "id": "refund",
        "type": "noul",
        "instructions": "Does the customer ask for a refund?"
      }
    ]
  },
  "targets": { "refund": { "answer": true } }
}
```

```sh
node dist/cli.js rfdt doctor --fetch
node dist/cli.js rfdt prepare --input training.jsonl --template v2
# Use the printed run directory:
node dist/cli.js rfdt train --run .jev/rfdt/RUN_ID --steps 8
# Before export this evaluates the MLX adapter:
node dist/cli.js rfdt evaluate --run .jev/rfdt/RUN_ID --split validation
node dist/cli.js rfdt export --run .jev/rfdt/RUN_ID --model jev/gemma-3-1b-rfdt
# After export these evaluate the native GGUF; test is explicit and final:
node dist/cli.js rfdt evaluate --run .jev/rfdt/RUN_ID --split validation
# Continue only after validation passes and this candidate is selected:
node dist/cli.js rfdt evaluate --run .jev/rfdt/RUN_ID --split test
node dist/cli.js rfdt approve --run .jev/rfdt/RUN_ID
```

`rfdt label` accepts an explicit local teacher URL/model and records revision/cache provenance. Training requires native/HF tokenizer and answer-boundary parity. Runs retain data hashes, splits, hyperparameters, dependency/converter identities, adapters, and export manifests. After export, explicit evaluation uses a scoped native candidate registry and the bundled frozen quality corpus, independently of the user's training-data splits. Choose the final candidate after validation, then explicitly evaluate test once. Native evaluations are serialized per run, and claiming the final test permanently reserves that artifact's test attempt. Permanent approval requires passing native validation/test gates bound to the exact run, frozen corpus, prompt manifest, template, and exported artifact. Training loss reduction and MLX fixtures do not establish native quality or promotion readiness.

## Benchmarks and verification

```sh
node dist/cli.js bench --iterations 3 --context-sizes 256,1024 \
  --branch-counts 1,3 --queued-callers 1,4 --output .build/bench.json
npm run check
npm test
npm run build
npm run format:check
node scripts/compatibility-check.mjs
npm run test:package
npm audit
```

Benchmarks measure cold initialization, warm requests, context/branch workloads, queued callers, latency percentiles, native RSS, temporary disk, model/runtime/hardware identity, and computed-token/forward counts. Local inference has no remote API charge; report actual resource use and accepted-answer quality rather than invented billing savings.

Weights-free CI runs checks, tests, build, formatting, and package boundaries on Node 22 and 26. It does not prove GPU execution, autonomous behavior, quality gates, or real RFDT training. Native builds, weights, run data, and proof artifacts stay outside Git. [VERIFICATION.md](./VERIFICATION.md) records exercised lanes and unresolved completion gates.

Canonical JSON sorts keys by Unicode code points and uses ECMAScript number formatting. Arbitrary floating-point byte parity with Python and exact Pydantic coercions/error wording are outside compatibility. Engine arithmetic can differ from Hugging Face. Captured Python fixtures and cache/full-forward comparisons test the declared contract.
