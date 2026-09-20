# Independent context projection source review

This review covers the new task projection, memory-only original store, and Pi projection hook using source and invented CPU requests. The independent adversarial suite is `tests/context-projection-security.test.ts`. No actual model, network, credential, private configuration, system/provider/session data, corpus, task gold, campaign result, GPU state or Git mutation is used. The reviewer owns only that test file and this note.

The requested target is 50% prompt reduction, with effectiveness evaluated later. The current code computes a UTF-8 byte admission gate over complete serialized requests. Its token estimates are explicitly estimates, and `actualTokenMetrics` remains `null`. This review neither converts byte counts to measured tokens nor adds a semantic answer-quality prerequisite.

## Findings and corrections

### Inherited planner options can override the requested target

The initial planner validates property descriptors but normalizes them with `Object.fromEntries`, retaining `Object.prototype`. Reading omitted `targetReduction` then evaluates an inherited accessor. An invented getter executed once and supplied zero, yielding `targetReached: true` for ordinary `{task, sources}` options. Missing required fields were also inspected using inherited-sensitive descriptor-object indexing.

The owner changed normalized records to null-prototype objects, requires own required fields and own array indexes, and uses `Object.hasOwn` for data-descriptor values. The independent suite verifies that inherited optional target/floor/ceiling getters do not run and cannot change the default 0.5 target. It also rejects a missing own task without reading an inherited accessor.

Reviewed corrected planner release SHA-256: `399d69cffee3380881e59782d9991425dba7ea9868ceff130cf2ef733d084cf5`.

### An inherited descriptor value can admit an accessor argument

The initial originals guard checks `"value" in descriptor`. That includes inherited properties. With an invented `Object.prototype.value` accessor, an own accessor `reference` argument passed validation: its descriptor obtained a valid reference from the inherited getter, and the read succeeded. The actual input getter did not run, but the argument was incorrectly accepted and the inherited getter executed.

The owner changed the predicate to `Object.hasOwn(descriptor, "value")`. The independent suite now verifies a fixed unavailable result and zero getter executions under the same pollution. The original store additionally rejects foreign prototypes, proxies, symbols, accessors, unknown path/SHA/prototype fields and conflicting line/byte modes. Foreign stores and every reset invalidate old handles. References remain host-issued random tokens bound to immutable original text and SHA; model callers do not supply paths or replacement hashes.

Final reviewed originals SHA-256: `1174357a487f428c8f51ce89a3cea9322ce2a9371cff5a4818281f0711fcd6e6`. ROOT's response-text bound wording update supersedes the owner's earlier `33877177...` source release; the independent tests use the final current source.

### The public retrieval wrapper reads arguments before validating them

The initial hook reads `input.reference` before the originals guard. Own or inherited accessors can therefore execute even though the subsequent store read rejects them. The owner now delegates to the guarded store first and checks only the successful result's safe source reference against the current authorized reference set. The independent suite verifies rejection and zero accessor calls through the public registered tool.

### Identity mutations can leave projected text without retrieval

The initial restoration maps only tool-role messages with their original protocol IDs. Renaming a tool ID or changing a projected tool to a user role fails validation but leaves the projection present while stripping its retrieval schema.

The owner now uses the retained literal SDK-converted fallback when identities cannot be safely mapped. Independent renamed-ID, role-change and combined model/ID adversaries restore the original text, remove retrieval advertisement, and leave frozen canonical messages unchanged. Ordinary valid-ID restoration retains unrelated payload fields.

The installed SDK catches provider-hook exceptions and continues with the previous payload. Therefore throwing alone cannot establish safe fallback. The suite additionally invokes the actual installed `ExtensionRunner.emitBeforeProviderRequest` method with invented handlers and malformed payloads, verifying returned literal restoration without creating a session or transport.

### Invalidation can discard the originals needed at the boundary

The initial disable, strategy and scope handlers discard `pending` before an already returned projected context reaches the provider. The no-pending branch then strips retrieval while leaving projected text.

The owner retains the prepared originals through invalidation, changes the generation/scope predicates, and restores at the provider boundary. Independent disable, strategy and session-switch tests verify literal restoration and no achieved target.

### A serialized retrieval schema does not create SDK dispatch availability

The initial guard permits zero retrieval schemas and manufactures one in the payload. Host activation can fail or the tool can be removed from active SDK dispatch, leaving advertised retrieval unavailable.

The owner now requires one exact serialized retrieval schema and active host dispatch availability. The independent suite verifies literal fallback when activation fails or retrieval disappears after serialization. The extension does not create an alternate path-reading operation.

### Repeated guarding consumes provenance too early

The first independent suite run passed 17 of 18 tests. Its remaining failure was a repeated `before_provider_request` call with an already validated projected payload: the prepared record was consumed, so the second guard stripped retrieval while leaving projected text.

The final hook retains exact owned-payload provenance in a WeakMap bound to a saved immutable literal payload. A repeated guard restores that saved literal request, removes the projection annotation and retrieval schema, and clears its achieved-target claim. It does not infer ownership from source text that merely resembles a projection. The independent repeated-guard regression now passes.

Final reviewed hook SHA-256: `89f3d6fd075892fbdcc7812e70777eecac0f665a4d6c004ffe8adbffa98e8d13`.

## Accounting and evidence boundaries

The complete request comparison includes preserved message envelopes, retrieval schema, source reference/line/omission headers, the fixed interpretation annotation, and additional serialized payload fields. The adversarial suite adds substantial invented Unicode metadata and a noncredential header field after planning. That metadata makes the 50% target impossible; the final guard restores literal text, records the complete original UTF-8 serialization size, and reports the target as unachieved. An impossible protected floor also stays literal with zero computed reduction.

The sources are projections with explicit omitted spans, rather than a lossless codec. Original excerpts retain their order and literal text. The memory-only store supplies exact original chunks, including bounded UTF-8 byte continuation for long lines. SHA and reference bindings establish the captured source; they do not establish relevance, completeness of the original authorized read, model interpretation or task effectiveness.

This review does not read arbitrary executable JavaScript proxy objects as model arguments, perform source discovery, resolve model aliases or invoke a summarizer. A caller-injected summarizer remains explicitly host-owned. Existing host model authorization, final provider-handler ordering and actual SDK runtime integration remain separate responsibilities.

## Independent checks

- Initial new adversarial suite: 17/18 pass; the repeated-guard failure above was attributable and corrected.
- Final `node node_modules/vitest/vitest.mjs run tests/context-projection-security.test.ts`: **19/19 pass**, exit 0, including the added actual-SDK exception-swallowing restoration check.
- Final scoped strict ES2023/NodeNext TypeScript check of the security test and its source graph: exit 0, empty output.
- Formatting of the two owned files passes. The independent test SHA-256 is `29a6700123b5f3a551720f82bbe5978fa829c02fe189465441bbc7662bd9bdd5`.

The current bounded source review is closed with no unresolved local finding. The final pins above precede ROOT's separate build, publication and actual-model execution. Final provider-handler ordering and model/target registration remain trusted host integration conditions.

These checks establish source and fake-request boundaries only. They do not establish measured 50% prompt-token reduction, autonomous retrieval effectiveness, model answer quality, faster accepted work, billing savings or training improvement.
