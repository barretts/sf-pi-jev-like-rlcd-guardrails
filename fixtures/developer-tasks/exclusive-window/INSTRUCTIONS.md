# Repair exclusive pagination windows

`pageWindow` exposes a half-open interval `[start, endExclusive)` over an existing readonly row array. Repair `src/window.ts` without changing the exported types or function signature.

The requested `start` must be a nonnegative integer and `size` a positive integer; reject other values with `RangeError`. Clamp a valid start beyond the row count to that count. Return up to `size` rows beginning at the clamped start. `endExclusive` identifies the position immediately after the last returned row. `hasMore` is true exactly when rows remain after that endpoint. Empty input and exhausted input both produce an empty window with equal endpoints and `hasMore: false`.

Do not mutate the input array. The returned items array is a new array containing the original row references, rather than cloned row objects. Consecutive windows must neither duplicate nor omit a boundary row.

Only `src/window.ts` may change. Compile with the repository's TypeScript executable using `--project tsconfig.json`, then run `node --test tests/window.test.mjs`.
