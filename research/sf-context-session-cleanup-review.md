# SF context workflow session cleanup review

The alternating sf-pi startup failures are consistent with a missing SDK shutdown
event in the evaluator. Disposing the previous session invalidates its extension
context, while a Slack module listener still retains that context. The next
factory using the same imported module invokes that listener during startup.
This is a harness lifecycle diagnosis; it is not a Grok answer-quality result.

## Observed runs

[SF smoke 2](./context-workflow-sf-smoke-root-2/result-projection.json) and
[SF smoke 3](./context-workflow-sf-smoke-root-3/result-projection.json) each
scheduled four sessions in this order:

| Position | Session                | Workflow outcome |
| -------- | ---------------------- | ---------------- |
| 1        | Repetition 1, baseline | Completed        |
| 2        | Repetition 1, compact  | Error            |
| 3        | Repetition 2, compact  | Completed        |
| 4        | Repetition 2, baseline | Error            |

Smoke 3 retained safe callback coordinates for both failed sessions: extension
`sf-slack`, event `session_start`, exception class `Error`, and code
`extension_callback_error`. All four final Grok answers were correct, no HTTP 429
occurred, and the eligible compressed requests passed their live wire checks.
Those facts do not override the two extension failures: only two of four
workflows completed, and the run was not qualified.

Smoke 2 predates the accepted-answer counting correction and has historical
accepted flags on failed rows. Its workflow status and error denominator remain
the governing outcome. Smoke 3 distinguishes correct final-answer observations
from accepted, completed workflows.

Both protocols retain the controlled 23-factory source setup. The proposed fix
keeps those factories and callback error reporting. It does not establish
equivalence to an installed sf-pi default session.

## Source-derived cause

The controlled sf-pi checkout is
`/Users/bsonntag/code/sf-pi-jev-manager`, revision
`f927d52f57185bb5f2d62e8f0cb6997a6656752c`. Owner discovery followed the root
`AGENTS.md`, the `sf-slack` manifest, and its declared extension rules and guide.
The SDK inspected is Pi `0.85.1`.

The following coordinates refer to the inspected source snapshots. Line numbers
can change in later source revisions.

| Coordinate                                              | Relevant behavior                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluator `scripts/context-workflow-eval.mjs:1659–1671` | Cleanup aborts the session and disposes it, without first emitting `session_shutdown`.                                                            |
| SDK `dist/core/agent-session.js:584–595`                | `dispose()` invalidates the extension runner; it does not emit the shutdown event.                                                                |
| SDK `dist/core/extensions/runner.js:517–518`            | Reading an extension context's `hasUI` checks whether that context is still active.                                                               |
| sf-pi `extensions/sf-slack/index.ts:496–509`            | Startup resets the module's counters before installing the new session's statistics listener.                                                     |
| sf-pi `extensions/sf-slack/lib/stats.ts:42–56`          | The statistics listener is module state; resetting counters invokes the currently retained listener.                                              |
| sf-pi `extensions/sf-slack/index.ts:305–307`            | That listener's widget callback reads its captured session context, including `hasUI`, even before deciding whether headless rendering is needed. |
| sf-pi `extensions/sf-slack/index.ts:596–616`            | The shutdown handler clears the statistics listener and captured widget context.                                                                  |
| SDK `dist/core/extensions/loader.js:409–434`            | A cached factory retains its imported module state; invoking it creates a fresh extension API but does not independently clear module listeners.  |
| SDK `dist/core/extensions/loader.js:123–129`            | Changing the working directory clears the factory-module cache.                                                                                   |

After position 1, disposal makes its context stale while the listener remains.
Position 2 shares the pair's working directory and imported module state. Its
counter reset reaches the old listener before the new listener is installed;
reading the old context can therefore raise the observed exception class.
Position 3 changes pair working directory and imports fresh module state.
Position 4 repeats the same stale-listener sequence. This source path explains
the observed second/fourth-session pattern without requiring a change to
compression, the task model, Slack credentials, or the 23-factory population.

The retained safe error coordinates do not expose a raw stack or private error
message. The initial stale-listener explanation was therefore a source-derived
diagnosis. The separate CPU and subsequent live evidence below test its mechanism
and the corrected lifecycle without disclosing those private details.

## Minimal evaluator correction and proof

Use the public `session.extensionRunner.emit({ type: "session_shutdown" })`
before `session.dispose()`, after the owned abort has completed. Bound the
shutdown wait and retain its outcome in cleanup evidence. Dispose must still
run if shutdown fails or times out. Keep callback errors in the existing
`onError` path, and require clean shutdown, abort, and disposal for affirmative
workflow cleanup.

The SDK's internal shutdown helper at
`dist/core/extensions/runner.js:50–59` delegates to the same runner emission,
but that helper is not exported by the top-level package. The public runner
method avoids an internal import. No fresh-import workaround or sf-pi source
edit is needed if the intended lifecycle clears the listener.

A bounded CPU regression can use an independently authored extension with a
module listener and a context getter that becomes invalid after disposal.
Run consecutive fresh SDK sessions against the same working directory. The
control omits shutdown and retains the old listener; the corrected path emits
shutdown and clears it before invalidation. Preserve all callback failures and
confirm the corrected path stays clean across four sessions. An actual SDK
fixture is stronger than a pure listener toy because it also checks public
event dispatch and invalidation ordering. Inject task execution and deny
network/credential resolution; this proof does not measure inference accuracy
or provider latency.

## Evidence after the correction

The evaluator owner implemented bounded public shutdown emission before
disposal. Callback errors make shutdown nonaffirmative even when the SDK's
event-emission promise resolves. Disposal still runs when shutdown fails or
times out. The released source pins, checked against the local files, are:

| File                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `scripts/context-workflow-eval.mjs`    | `5a2aaf1af575a39002355e058720059ce25eb45a6e21ed99d820589020f9b058` |
| `tests/context-workflow-eval.test.mjs` | `414bfcce7c5698b8055048567993e8bd6dd8204ac681caa6d78f439b904c28f8` |

The owner's actual SDK CPU regression ran four counterbalanced sessions with
23 invented factories. One independently authored factory held a module
listener. Each startup found that listener cleared; each shutdown accessed the
still-active real SDK context and cleared the listener before disposal. The
four retired context getter closures subsequently raised the SDK's stale-context
error, demonstrating the failure mechanism that a retained listener would reach.
A separate throwing-shutdown lane produced correct final answers but retained
errors and rejected all four workflows, while still disposing the sessions.
The owner reported 38/38 tests passing with exit 0, followed by a formatted
lifecycle-focused 3/3 pass with exit 0. These are invented CPU lifecycle proofs,
not actual sf-pi startup or inference-accuracy evidence.

ROOT then executed [SF smoke 4](./context-workflow-sf-smoke-root-4/result-projection.json)
against the unchanged controlled 23-factory setup with the actual Grok task
model. Its protocol SHA-256 is
`dee350c29704d395c32a930fed35375b018209feb622e5b69c5308ed2fe41502`.
All four workflows completed with correct, accepted answers; the separate Grok
judge passed. Every session attempted and completed shutdown before disposal,
with zero shutdown callback errors, zero extension errors, and no HTTP 429.
Eligible compressed requests passed their live wire checks. This supplies
bounded live functional evidence for the lifecycle correction and preserves
the full factory population.

The same live run does not establish a performance win. Across two paired
repetitions, baseline prompt tokens totaled 9,738 versus 8,512 with compression,
a 12.58985% reduction. Summed workflow times were 16,703.307459 ms versus
29,230.481042 ms: compression took about 1.74998 times as long. The performance
gates failed, and production improvement remained unqualified. This is one
synthetic case and two pairs; it does not establish general answer quality,
billing savings, developer benefit, or installed-default sf-pi equivalence.

The source diagnosis, invented SDK CPU proof, and ROOT's actual live run remain
distinct evidence lanes. The previous SF smoke 2/3 failures are preserved and
are not reclassified as successful by the new result.
