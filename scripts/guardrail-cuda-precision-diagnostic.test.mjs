import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("./guardrail-cuda-precision-diagnostic.mjs", import.meta.url),
);
for (const purpose of ["qualified", "candidate10_test_qualified", ""]) {
  test(`rejects unsupported purpose ${JSON.stringify(purpose)}`, () => {
    const result = spawnSync(process.execPath, [script, "--purpose", purpose], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported diagnostic purpose/);
  });
}
for (const purpose of [
  "rejected_c9B_fp32_fusion_fit_precision_diagnostic_only",
  "candidate10_one_step_probe_fit_precision_diagnostic_only",
]) {
  test(`supported purpose still requires all hash-bound inputs: ${purpose}`, () => {
    const result = spawnSync(process.execPath, [script, "--purpose", purpose], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required: --fit-file/);
  });
}
