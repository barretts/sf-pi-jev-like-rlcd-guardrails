# Repair an abortable single-flight refresh

`RefreshLoader` should share one pending load and become reusable after success, failure, or cancellation. Repair `src/refresh.ts` without changing its public constructor or `load` signature.

The first caller's signal controls the shared operation. While that operation is pending, other callers receive the exact same promise and must not start another backend call. A signal that is already aborted rejects with its reason before calling the backend. An abort during a load rejects promptly with that same reason, including when the backend ignores cancellation. The backend still receives the original signal.

Every settled operation must remove its cancellation listeners and release the pending slot. A later operation must work after any failure or abort. A canceled backend's eventual success or failure must be handled without an unhandled rejection and must not clear a newer operation's pending slot. A synchronously thrown backend error is a rejected load, rather than an exception escaping `load`.

Only `src/refresh.ts` may change. Compile with the repository's TypeScript executable using `--project tsconfig.json`, then run `node --test tests/refresh.test.mjs`. The tests use deterministic deferred promises; do not add timers or dependencies.
