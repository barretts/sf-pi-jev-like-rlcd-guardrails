# Repair state for overlapping requests

`LatestRequest` backs a view whose requested key can change before a previous fetch settles. Repair `src/latest.ts` while keeping its exported snapshot type and public constructor, `read`, and `refresh` signatures.

Each refresh immediately enters `loading`, preserves the previously accepted data, and clears any previous error. Only the most recently started request may publish a success or failure. An older request must not alter loading state, data, or error, whether it resolves or rejects before or after the latest request. Every `refresh` promise settles after its own backend operation; backend rejection is reflected in state only if that request is current and does not reject the `refresh` promise.

For a current success, publish `ready`, its data, and no error. For a current failure, publish `error`, keep the previously accepted data, and use the Error message or `String(reason)` for the error. `read` returns a snapshot object that a caller can modify without changing internal state.

Only `src/latest.ts` may change. Compile with the repository's TypeScript executable using `--project tsconfig.json`, then run `node --test tests/latest.test.mjs`. Request order is controlled by deferred promises; no timers or dependencies are needed.
