# Context and routing runtime review

This is an independent source and CPU review of the new context-compression and routing work. It does not make gateway requests, access private model configuration or credentials, run a local model, change a session, or establish answer quality or a speed improvement. The concrete local findings below have been resolved in inspected source with the stated CPU evidence. The final real-provider and multi-extension evidence remains a separate root-owned integration step.

## Findings during implementation

### Bounded JSON parser uses an unbounded argument spread

**Status: fixed; independent synthetic reproduction verifies both allowed and over-budget inputs.**

`parseStrictJsonObject` schedules array elements using `pending.push(...item)`. A response containing one array with 200,000 zeroes is only 400,011 bytes, below the default 8 MiB response limit and the declared 1,000,000-node parser limit. It nevertheless throws `RangeError: Maximum call stack size exceeded` because the function call has too many arguments. The transport catches this and replaces it with a safe protocol error, so this reproduction does not leak a credential. Callers of the exported parser receive the raw exception, and valid bounded inputs receive an accidental engine-dependent rejection.

CPU reproduction, using only a synthetic in-memory JSON value:

```sh
node --experimental-strip-types --input-type=module -e 'import {parseStrictJsonObject} from "./src/gateway.ts"; const value=JSON.stringify({extra:Array(200000).fill(0)}); try {parseStrictJsonObject(value); console.log("parsed",value.length)} catch(error) {console.log(error.constructor.name,error.message,value.length)}'
```

Observed output before the fix: `RangeError Maximum call stack size exceeded 400011`. Use iterative scheduling and enforce the remaining node budget before adding children. A regression should cover an allowed large array and an over-budget array with a fixed safe parser error.

The owner replaced argument spreading with bounded iterative scheduling. Independent rerun now accepts the 200,000-element array; a 1,000,001-element array rejects as `GatewayTransportError`, code `invalid_json_object`, message `Gateway JSON object is invalid`. The owner additionally reports 87 CPU gateway tests passing. That reported suite was not independently replayed by this reviewer.

### Eligibility guard does not establish fact completeness

**Status: fail-closed contract change verified in source; full model completeness remains an external quality condition.**

`evaluateRoutingEligibility` rejects an explicit `essentialFactsAvailable: false`, while omitted completeness metadata passes this check. With an independently qualified artifact and a hypothetical `{decision: "fast", confidence: 0.99}`, the wording `What is the value in the document I did not attach?` passed the original lexical exclusions. This is a synthetic guard counterexample, not an observed prediction from a trained router.

The guard owner confirms that patterns are supplemental and cannot prove input completeness or classifier correctness. Following root review, the owner reports that fast eligibility now additionally requires `essentialFactsAvailable === true`; omission returns `essential-facts-unverified`. This flag must reflect actual caller-known facts or a separately justified completeness decision, never the fixture's expected route label. Ties must remain uncertain, and freshly evaluated missing-fact cases must contribute to the unsafe-fast denominator. The owner is also adding a regression for explicit unattached-document wording.

### Descriptive population gates are not full artifact qualification

**Status: separate qualification layer verified in source; outer identity/independence declarations remain caller attestations.**

The routing evaluator preserves missing attempts, errors, missing timings, and unsafe fast decisions even when their downstream calls fail. Its current `gates.passed` nevertheless describes only the supplied population: it does not enforce the declared minimum 20 easy and 40 strong-required independent scenarios or invariant decisions across matched format/order variants. A tiny population or variant-sensitive classifier can therefore pass these narrower gates. Matched-group disagreement is currently descriptive, and `independentCases` counts marked rows rather than deduplicated scenario groups. Production auto mode must not rely on that boolean alone. The owner should expose explicit confirmation/qualification gates or clearly scope this summary so that the complete frozen protocol remains authoritative.

The owner now tags descriptive gates as `frozen-population-gates-not-independent-qualification` and adds `qualificationGates`/`qualificationEligible`. The separate layer requires 20 independent easy groups, 40 independent strong-required groups, full error-free population and operational timing, useful easy coverage, zero unsafe fast decisions, matched-group invariance, predeclared family coverage, and explicit outer real-execution/independence/source/artifact attestations. `independentGroups` deduplicates marked matched variants. Source inspection verifies these checks and the declaration that outer attestations are not self-verified. Model execution and valid qualification artifacts remain necessary before auto-mode activation.

### Later context hooks can invalidate a final-message format boundary

**Status: provider-boundary restoration implemented and focused CPU-tested; final validator ordering remains a trusted-integration condition.**

The Pi SDK's `emitContext` executes extension handlers in load order and passes each returned message array to subsequent handlers. Its `convertToLlm` later converts a custom message into an ordinary user message. The compression hook's trusted system instruction authenticates only a final user message carrying its nonce and uses tool-result ordinals to identify compressed blocks. A later extension can append a message, remove a tool result, or reorder results while leaving compressed text present. That can invalidate the final-message condition or redirect ordinal labels, so the provider can receive encoded text without the correct interpretation boundary. The implementation needs a regression with a later context handler and either final-boundary validation that restores original text or a verified integration restriction. The real multi-extension workflow must establish the condition, rather than assume extension ordering.

The hook now validates the actual Chat Completions payload in `before_provider_request`: trusted instructions, final exact nonce manifest, tool-call IDs/order, and transformed tool content must still agree. Otherwise it removes its own exact manifest and restores surviving transformed tool text by protocol ID. The provider format rule now uses only tool-result ordinal to locate the one transformed wire text block; source message/content indexes remain host evidence, including an image-before-text source index. A later `before_provider_request` handler can still alter the payload after this validator. Root must establish/document final validator order among trusted extensions. The SDK event contains only `payload`, not model/API; any dispatcher compatibility must be an explicit host binding, not an invented event field.

### Whole-context cloning precedes the declared resource limits

**Status: preflight and copy-on-write implemented; focused CPU checks pass.**

The initial hook called `structuredClone(event.messages)` before checking `maxContextOriginalBytes` and `maxToolTextBlocks`. These configured limits bounded codec work after the clone, but did not bound the allocation of that extra context copy; large text and image payloads were cloned before rejection. Preflight eligible text limits before a clone, or copy only changed message/content structures and preserve immutable nontext payloads without a duplicate allocation. This is a sequencing finding from source inspection. No large-memory allocation or process action was used to demonstrate it.

The hook now preflights eligible tool text and image data before allocating copied containers, and uses copy-on-write message/content structures rather than another full deep clone. Over-bound whole contexts remain literal with a recorded fallback. The SDK's own initial canonical snapshot allocation is outside this intervention; this finding does not claim a hard process-memory cap.

### Operational routing time stops before authentication and dispatch

**Status: fixed; stream-entry preparation through actual provider dispatch is included and independently CPU-tested.**

The initial dispatcher assigned `routerElapsedMs` before obtaining the registry, awaiting target authentication, preparing target capacity/options, handling failed fast setup and strong fallback, and invoking the selected provider. These operations occur between request availability and actual provider dispatch, so they belong to the declared operational-router measurement. Measuring only the classification/guard phase can falsely pass a latency gate when credential or fallback setup is slow. End the timer at actual successful dispatch and retain all preceding failed setup time; mocked delayed authentication is sufficient to verify the boundary.

The dispatcher now ends `routerElapsedMs` immediately after the actual selected provider call, retaining authentication, setup and failed-fast fallback time. `decisionElapsedMs` separately describes the classification/guard phase. Independent command `node node_modules/vitest/vitest.mjs run tests/routing-extension.test.ts tests/context-extension.test.ts` exits 0 with 57 tests passing across the two files. These are synthetic lifecycle/protocol/cancellation tests, not actual-provider latency measurements.

A final source pass found that the new private request/target/qualification snapshots still preceded the start timestamp. The final source now starts the timer at `streamSimple` entry, before stream creation, snapshots and observer work. Independent rerun of `node node_modules/vitest/vitest.mjs run tests/routing-extension.test.ts` exits 0 with 34 tests passing. Reviewed final dispatcher SHA-256 is `be1ba8f87e94cf4e0c4f8d285666087ddecbe228bcb097d992a7eda80576bceb`; the owner additionally reports full source TypeScript checking, formatting and diff checks passing. The reviewer independently inspected timer placement and reran the focused suite, rather than replaying those other owner checks.

### SDK numeric placeholders do not prove observed provider usage

**Status: fixed in source; explicit raw-provider attestation now required.**

The initial `knownUsage` regarded every finite nonnegative SDK input/output/cache/total field as real observed usage. The provider SDK uses zero placeholders when a raw response omits usage counters. A numeric terminal-message object can therefore receive `usageKnown: true` without authoritative raw-provider accounting. Dispatcher receipts should require explicit transport/provider usage evidence, or leave usage provenance unresolved. In particular, an all-zero default SDK message must not establish known generated work or billing. Genuine zero counters remain possible; the fix must distinguish evidence rather than treating every zero as an error.

The revised dispatcher defaults to `usageKnown: false` and requires the trusted host's `isUsageObserved` callback plus finite nonnegative fields before marking usage observed. A callback must be based on validated raw-provider accounting; it cannot attest SDK compatibility placeholders. The focused CPU suite above includes this distinction.

### Target authentication can override an approved endpoint

**Status: fixed in source; exact host-approved endpoint retained through authentication.**

The initial `allowedTarget` checked a model ID and caller-provided lineage tag, while accepting arbitrary provider/base URL values. The resolved authentication result could then replace `baseUrl` immediately before dispatch without validating the approved origin/path again. The trusted target contract should bind the explicitly approved configured provider and endpoint, and reject an authentication override outside that binding before dispatching with the credential. Incoming dispatcher headers should use a deliberate safe-header policy; substring-only filtering misses names such as `X-Credential` or `X-Token`. This is an integration-boundary finding, not an observed credential disclosure.

The revised dispatcher captures the host-supplied target descriptor before async work, validates its URL, and requires any authentication `baseUrl` to equal that exact canonical approved endpoint. Incoming headers now have an explicit tracing/request-ID allowlist. Root still owns registration/lineage verification: a trusted host descriptor is an attestation, not an upstream weight identity inferred from a model alias.

### Malformed feature-worker records bypass its lifetime request limit

**Status: fixed; independent fake-only worker test suite passes.**

`MAX_REQUESTS` is checked by `FeatureWorker.handle`, but `serve` handles parse failures and overlong input lines without calling that method. Such records do not consume the declared worker lifetime request budget. Draining an overlong unterminated line also has no total byte/deadline bound inside the worker. Count every input record, including parse failures, and bound resynchronization or terminate safely when the line bound is exceeded. A separately frozen parent process/cancellation policy may supply a deadline, but it must be explicit. No actual model or process action was required for this source finding.

The worker now reserves a request before parsing every JSONL record, including malformed records, and fails closed after a 262,144-byte oversized-line drain bound. Its ready handshake preflights official base/dependency/tokenizer identity while deferring the decoder/Metal forward to root's explicit scheduling. Independent command `python3 -I routing/test_feature_worker.py` exits 0 with 14 tests passing in 0.005 seconds. Those tests use fake backends and temporary synthetic file pins; they do not execute Gemma or prove routing quality.

### Workflow harness findings before inference freeze

**Status: reported issues addressed in source; independent 50-test workflow CPU suite passes.**

The routing runner's initial successful-auth mock omitted the dispatcher's required `ok: true`, which would cause every request to fail during setup before a gateway call. It also used descriptive routing gates rather than the new complete qualification layer. Cleanup failure in a `finally` block can add an error after a successful return value has already been selected; that must invalidate the final result and exit. A read-check-write transition from prepared to running is not an exclusive run claim, so concurrent invocations need an atomic `wx` claim before model or credential work.

The context runner's initial schedule freezes two repetitions while the prospective goal requires at least three. Its SSE observation initially accepts a `[DONE]` marker without an authoritative finish reason, uses ordinary JSON parsing that overwrites duplicate keys, and does not inspect returned model identity. The stream adapter initially aborts its controller on a deadline without racing a transport read that ignores cancellation. Its optional-judge exit condition counts only judge errors, so a completed negative preservation judgment can still yield a success exit. Paired workspaces initially use different paths, introducing path/cache differences into a comparison that requires one shared paired workspace. Finally, per-provider fetch validation does not block import/session-start network from SDK or SF extensions; install a scoped default fetch-deny boundary before those imports and explicitly invoke only the captured approved transport. These are concrete pre-freeze implementation findings, not observed real-model failures.

Source inspection now verifies successful auth shape, a permanent exclusive routing execution claim, the separate routing qualification layer, and terminal failure on classifier cleanup error. Context source now freezes four default counterbalanced repetitions, shares each pair's workspace, checks duplicate keys/returned model/authoritative terminal reason, races aborts, gates all judge booleans/issues, and installs a default fetch-deny boundary before SDK/SF startup. SSE regressions cover multiple choice records, post-terminal deltas, and invalid UTF-8. Session abort/disposal and runtime credential cleanup are explicit and bounded, and unresolved cleanup invalidates joint acceptance. Routing imports/cleanup likewise run under default fetch denial; only its captured approved Grok transport can invoke the configured gateway. Independent command `node --test tests/context-workflow-eval.test.mjs tests/routing-workflow-eval.test.mjs` exits 0 with 50 tests passing. Actual SDK tests use fake transports and synthetic 23-factory startup fixtures; they are labelled injected CPU evidence and do not establish live Grok or real SF extension execution. Full real-model results remain separate evidence.

### Completeness proof admits ambient console properties

**Status: fixed; independent counterexamples reject and focused CPU tests pass.**

The limited code-source proof initially admits `console` as a value and permits arbitrary property reads after a dot. Both `What does this code print: const a = console.runtimeValue; console.log(a);` and `What does this code print: const a = console; console.log(a.runtimeValue);` return `{verified: true, reason: "self-contained-routine", evidenceKind: "prompt-literal"}` in an independent CPU reproduction. The supplied code does not define `console.runtimeValue`; its value depends on ambient runtime state. Restrict the admitted console identifier to a direct standard `console.log` call, rejecting aliases and arbitrary console properties.

The proof also initially limits prompt length but has no equivalent previous-source, tool-source, tool-ID/count, or aggregate-source bound. A 65,537-character previous source passed as `observed-previous-source`; arbitrarily large sources can cause synchronous normalization/parsing that cannot be interrupted by an event-loop timer. Bound every actual-source field before work and reject malformed Unicode. Supported routine syntax establishes source availability only; it remains insufficient to prove task difficulty, classifier quality, or accepted-answer correctness.

The owner restricts console to direct `console.log` use and introduces explicit prompt/prior/tool/ID/count/aggregate-source limits before normalization/parsing, with malformed UTF-16 and prohibited raw controls rejected. Independent rerun now rejects both ambient console reads as `unsupported-or-unverified-routine` and the overlong prior source as `source-capacity-exceeded`. Independent command `node node_modules/vitest/vitest.mjs run tests/routing-completeness.test.ts tests/context-extension.test.ts` exits 0 with 97 tests passing. These checks prove the limited syntactic source boundary; classifier/guard qualification and downstream acceptance still determine whether fast execution is appropriate.

### Active routing context can drift during async setup

**Status: fixed; private same-request snapshot verified in source and independently CPU-tested.**

Targets and artifact are captured at stream entry, but the initial dispatcher passes separate clones of the caller's live context to classification and eligibility, then passes the original context to the provider after awaiting authentication. A caller mutation while auth is pending can therefore change content or tool schemas after the fast decision was verified. Capture one private context snapshot for the entire active request, give separate copies to callbacks that may mutate, and dispatch that captured snapshot. A delayed-auth synthetic mutation regression establishes the same-prompt invariant without any real model call. Input capability validation must also use per-target setup fallback so an unsupported fast target can reach an image-capable strong target.

Final source inspection verifies one private snapshot at stream entry, separate copies of that snapshot for classifier/guard callbacks, and the private snapshot for actual provider dispatch. Caller changes to messages, tool definitions, or image content therefore affect future calls rather than this active call. The owner added delayed-auth and pending-classification mutation regressions and removed the redundant pre-loop capability check; each actual target setup retains its own fallback check.

Independent command `node node_modules/vitest/vitest.mjs run tests/routing-extension.test.ts` exits 0 with 34 tests passing, including these mutation regressions. This remains fake-provider evidence rather than a live model decision or provider-latency result.

### Provider terminal errors bypass the fixed dispatcher error message

**Status: fixed; terminal and mutable-partial error boundaries verified in source and independently CPU-tested.**

The catch path uses a fixed routing error, but a normal underlying provider terminal `error` event is forwarded unchanged. Its SDK `errorMessage` can be derived from an upstream HTTP/APIError body, bypassing the dispatcher's safe-error boundary. Sanitize terminal error text and retain only supported attribution/content/observed-usage fields; a synthetic credential-like upstream body verifies redaction without reading a real credential. Workflow-only provider sanitization does not fix the public dispatcher used with ordinary registered providers.

The dispatcher now forwards a fixed error message and a supported-field projection rather than the raw terminal error object. It also projects earlier mutable SDK partials into a separate public helper, so a later upstream-body mutation of the original SDK object cannot add an error body or cause to already emitted start/update references. Usage provenance is checked against the original raw-attested terminal object before projection. Deferred SDK terminals remain valid protocol observations while keeping `completed: false`.

The independent 34-test dispatcher run above includes synthetic terminal-body and same-object partial-mutation redaction regressions; it reads no real credential or private upstream response.

### Correct answers do not prove that an eligible live hook applied

**Status: fixed; independent focused context-workflow CPU suite passes.**

The hook intentionally skips unsupported layouts and tool-call IDs. Successful answers, exact canonical originals, and a direct codec-preservation judge can therefore coexist with no actual compressed provider request. For each predeclared codec-eligible compact arm, require an actual validated provider request containing the expected encoded tool text and trusted manifest. Incompressible controls should remain literal. Merely loading the hook cannot satisfy its runtime integration gate; conservative skips must remain explicit observations rather than be counted as successful application.

The workflow now requires both a positive live-validator count and an actual completed provider receipt matching the encoded tool digest/byte count, final exact nonce manifest, trusted system nonce, observed live context, and source/content/provider-ordinal/tool-ID bindings. A runtime skip on an otherwise codec-eligible case yields `integration_failed` and fails joint acceptance even when every answer and usage check passes. Independent command `node --test tests/context-workflow-eval.test.mjs` exits 0 with 22 tests passing, including actual Pi SDK fake-transport skip and altered-wire regressions. This verifies the measurement boundary without making a live model request.

## Checks already inspected

The v2 compact codec keeps integrity hashes and byte counts host-side and exposes only ordered `[repeat, text]` tuples. Its default decoder checks the independently retained original digest, encoded bytes, expanded bytes, line counts, segment counts, repeat counts, valid Unicode, line terminators, canonical JSON, and the final reconstructed digest. It validates expansion limits before allocating repeated text. Source inspection found no truncation or interpretation of format-looking input as an existing encoding. This proves structural reconstruction safeguards, not a model's ability to interpret the compressed representation.

The gateway transport captures its credential in a private closure, uses an HTTPS endpoint, refuses credential-bearing URLs and redirects, bounds response bytes while reading, validates bare JSON without duplicate keys, and uses fixed transport errors rather than response excerpts. Missing usage counters remain `null`; incomplete completions carry numeric usage when available. These observations do not establish upstream model identity or paid-token savings. Exact gateway and model selection must be enforced by the caller before resolving an existing credential.

### Subsequent request-pacing and stratum-metrics review

A bounded source review of the new pacing/metrics release found no concrete new defect. Reviewed script SHA-256 is `e674242cb67b659a1cb1247aeb486ab442fb63798c8c838d76e653d6f6c063d5`; reviewed test SHA-256 is `9d91fdfa6004cf35a72d43fd870b4ae5b718d006be64d65b754d0289d8f5270a`. This follow-up did not inspect actual campaign outputs, private configuration, corpus/gold files, credentials or model execution.

One captured paced transport is shared by SDK task requests and optional judges. Frozen parameters bound intervals/cooldowns to 120 seconds and the consecutive-429 threshold; zero explicitly disables its corresponding setting. Only the selected HTTPS Chat Completions destination may dispatch. A 429 is a retained physical failed attempt with unknown usage and no automatic retry. Its one whitelisted `Retry-After` header becomes bounded numeric metadata, with invalid values using the declared fallback and excessive values explicitly marked capped. No header text or error body is retained. Queued cancellation preserves reservation order, removes the active timer/listeners, and cannot release a later caller ahead of an earlier reservation. An open circuit rejects pending reservations and leaves subsequent scheduled task/judge cells unrun in their full denominators. Already dispatched requests remain physical observations.

Stratum summaries distinguish scheduled, observed, completed, accepted and latency-sample pairs. A paired workflow ratio requires accepted completed arms with finite positive timing; all-error strata have no median. Partial sample coverage remains visible, while the full-suite median requires the complete accepted population. The concise console projection retains aggregate counts and unknown accounting without row texts, host gold or judge issue text. Pacing wait remains included in complete workflow elapsed time and is separately recorded; this mechanism does not establish faster provider inference.

Independent command `node --test --test-name-pattern 'pacer|Retry|429|pacing|queued reservations|stratum|console projection' tests/context-workflow-eval.test.mjs` exits 0 with 10 focused tests passing. These include fake-clock concurrent scheduling/cooldown/cancellation/circuit cases and actual Pi SDK execution against an invented 429 transport, yielding one physical failed call, three scheduled task cells unrun and one scheduled judge unrun. The owner reports 33 total CPU tests passing; the unchanged broader suite was not independently replayed for this bounded follow-up.

## Remaining evidence and integration conditions

The final local review is closed for the concrete findings above and is limited to source and explicitly labelled CPU/fake-transport evidence. Root owns actual Grok workflows, actual Gemma execution, the combined routing/context hook and real 23-extension SF integration, target registration/upstream-lineage attestations, and independent qualification artifacts. The trusted final provider validator must run after any payload mutation relevant to its manifest. Later trusted handlers remain outside its guarantee. A clean local review does not promote rejected R7 training or establish better answer quality, faster accepted work, paid-token savings, or improved developer experience; those require the frozen real execution results and their full failed/unrun denominators.
