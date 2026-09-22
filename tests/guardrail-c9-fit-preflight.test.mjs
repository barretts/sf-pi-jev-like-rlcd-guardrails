import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../scripts/guardrail-candidate9-fit.mjs", import.meta.url),
);

test("C9 fit refuses the overlap-tainted admission before any model or blind source read", () => {
  const stale =
    "e7d79edb8984d3a9604862f9f513cd07cd9085f484006940b3b329c71880508f";
  const result = spawnSync(
    process.execPath,
    [
      script,
      "preflight",
      "--arm",
      "A",
      "--admission",
      "/nonexistent/admission.json",
      "--admission-sha256",
      stale,
      "--fit",
      "/nonexistent/fit.jsonl",
      "--cal",
      "/nonexistent/cal.jsonl",
      "--pairs",
      "/nonexistent/pairs.json",
      "--families",
      "/nonexistent/families.json",
      "--objective-plan",
      "/nonexistent/objective-plan-A.json",
      "--blind-valid-manifest",
      "/nonexistent/valid-manifest.json",
      "--blind-valid-manifest-sha256",
      "b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc",
      "--overlap-receipt",
      "/nonexistent/overlap.json",
      "--overlap-receipt-sha256",
      "d984cd4f1f4178a590d540640e5ecd0579a8ea3fdfca75d0bc0b79aeabc95963",
      "--host-controls",
      "/nonexistent/controls.json",
      "--host-controls-script",
      "/nonexistent/controls-script.mjs",
      "--cal-baseline",
      "/nonexistent/baseline.json",
      "--cal-baseline-script",
      "/nonexistent/baseline-script.mjs",
      "--sf-pi",
      "/nonexistent/sf-pi",
      "--checkpoint",
      "/nonexistent/checkpoint",
      "--base-gguf",
      "/nonexistent/base.gguf",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /superseded C9 FIT admission/);
  assert.doesNotMatch(result.stderr, /ENOENT|Metal|VALID source/);
});
