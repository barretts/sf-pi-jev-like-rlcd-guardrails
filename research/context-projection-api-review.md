# Context projection API review

Independent, bounded source review on 2026-09-20. Scope: `context-projection.ts`,
`context-originals.ts`, `context-projection-extension.ts`, `context-extension.ts`,
`extension.ts`, `index.ts`, and the public README/API packaging declarations.
No model calls, network, credentials, private configuration, validation corpus,
prediction results, or Git mutations were used. This review makes no runtime,
answer-quality, token-saving, or performance qualification claim.

The new modules have no runtime circular dependency: the projection extension's
reverse reference to `context-extension.ts` is type-only. The package root exposes
the standalone planner, originals store and compression registration APIs.
Ordinary Pi registration selects excerpts, disabled by default; standalone
registration retains the existing lossless default. Caveman inference is an
explicit injected callback, and its absence falls back to excerpts. Mode commands
change session state and do not discover credentials or choose an assistant model.

Material findings were sent to ROOT and the source owners before measurement.
The final source/public-document re-read confirms the reported fixes:

- **Fallback converter packaging:** the projection extension initially imported a converter
  from `../node_modules/@earendil-works/pi-coding-agent/node_modules/` directly.
  That relative path assumes this checkout's nested layout. In a normal consumer
  installation, the peer can be outside the Jev package or its AI dependency can
  be hoisted. The caught failure left `fallbackMessages` unavailable; the
  malformed-payload fallback could then substitute an empty message list. **Layout
  assumption fixed:** the owner now resolves from the selected SDK's dependency
  search paths. **Converter-unavailable condition fixed in the final release:**
  a conversion failure now clears applied projection evidence, records the visible
  `converter-unavailable` fallback, and returns before publishing pending state
  or transformed messages. The caller's original context therefore remains the
  input instead of relying on an empty-conversation restoration. No
  consumer-install experiment was performed in this review.
- **Prepared-request lifecycle:** the initially reviewed controller discarded
  restoration evidence when off/strategy/lifecycle changes happened between the
  context transform and the provider hook. The no-preparation path removed the
  retrieval schema without restoring projected text. During this review the owner
  changed off/strategy handling to preserve pending evidence and invalidate its
  generation. **Fixed in source:** final integration should retain the owner's
  regression showing restoration during delayed authentication.
- **Net-byte terminology:** the final provider hook compares complete serialized
  projected/literal JSON payloads, including retrieval schema and annotation.
  Those candidate fields support a whole-request byte figure. Inherited
  `receipt.bytesSaved` remains raw tool-text savings, and `instructionBytes` covers
  the annotation alone. Their difference omits retrieval schema and JSON escaping;
  it must not be described as exact net request savings. **Public wording fixed:**
  README distinguishes tool-text savings from serialized request reduction. ROOT
  reports Manager now uses the candidate's complete-payload byte difference; that
  Manager source was outside this review's file scope.
- **Retrieval bound terminology:** the store bounds retrieved `text` to 16 KiB.
  The actual tool result serializes text, reference metadata and continuation
  fields as JSON, which can exceed 16 KiB through metadata and escaping. README
  and tool description should say “retrieved text” rather than bound the entire
  response. **Fixed:** both now state the retrieved-text bound and JSON metadata /
  escaping overhead; complete workflow accounting remains ROOT's responsibility.

Token figures are named estimates, actual token metrics are null, and the README
does not equate the 0.5 requested reduction with measured whole-workflow token
savings. Quality remains explicitly unqualified. These are appropriate limits.

The initial public-access note is also **fixed**: `registerExtension` is now a
named package-root export and README documents importing it from `simple-jev-ts`.
The export map can retain only `.` for this documented composition path. ROOT
reports consumer-import coverage for the new public functions; this source review
did not execute that separate package check.

ROOT owns final combined source checks, provider-hook ordering and real workflow
measurement. A live 50% whole-workflow prompt-token reduction remains pending,
and no result is inferred from options, byte estimates or source checks. The
reported source/API findings are closed in the inspected final release; that
does not qualify the complete integration or its live token-reduction target.
