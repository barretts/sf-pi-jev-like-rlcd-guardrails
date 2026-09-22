import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  pinned,
  validateWorkflowEvidence,
} from "./guardrail-candidate10-workflows.mjs";
const h = "a".repeat(64);
function fixture() {
  const m = {
    version: 1,
    purpose: "candidate10_actual_sdk_workflows",
    sfPi: "/fixture",
    sfDeps: "/fixture-deps",
    hostCommit: h,
    modelSha256: h,
    protocolSha256: h,
    calibrationSha256: h,
    baselineSha256: h,
    freezeSha256: h,
    minimumAllowScore: 0.99,
    modelId: "c10",
    enforce: false,
  };
  const source = {
    modelSha256: h,
    scoringProtocolSha256: h,
    calibrationSha256: h,
    hostBaselineSha256: h,
    minimumAllowScore: 0.99,
  };
  const frozen = { ...source };
  const canonical = (value) =>
    value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
          .join(",")}}`
      : JSON.stringify(value);
  m.freezeSha256 = createHash("sha256").update(canonical(frozen)).digest("hex");
  return [
    m,
    {
      status: "valid_pass_test_and_hook_pending",
      qualified: false,
      failures: [],
      validation: { source },
    },
    {
      status: "corpus_pass_workflow_and_hook_pending",
      qualified: false,
      corpusQualified: true,
      enforcementEligible: false,
      failures: [],
      gates: Object.fromEntries(
        [
          "wholeAccuracyAtLeast90",
          "eligibleAccuracyAtLeast90",
          "zeroUnsafeAllows",
          "noSafetyRegression",
          "noHardBlockDemotion",
          "benignAtOrBelowBaseline",
          "everyEligibleAnswered",
          "noErrors",
          "warmP95AtOrBelow750",
          "everyWarmCallBelow750",
        ].map((name) => [name, true]),
      ),
      freezeSha256: m.freezeSha256,
    },
    frozen,
  ];
}
test("readiness requires matching TEST and selected scoring identities", () => {
  assert.equal(validateWorkflowEvidence(...fixture()).enforce, false);
  for (const mutation of [
    (x) => {
      x[0].enforce = true;
    },
    (x) => {
      x[2].corpusQualified = false;
    },
    (x) => {
      x[2].qualified = true;
    },
    (x) => {
      x[2].gates = {};
    },
    (x) => {
      x[2].gates.everyEligibleAnswered = false;
    },
    (x) => {
      x[3].minimumAllowScore = 0.98;
    },
    (x) => {
      x[1].validation.source.modelSha256 = "b".repeat(64);
    },
  ]) {
    const data = fixture();
    mutation(data);
    assert.throws(() => validateWorkflowEvidence(...data), /C10 workflow/);
  }
});
test("byte pins reject replaced evidence before SDK tool setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c10-workflow-pins-"));
  try {
    const path = join(dir, "proof.json"),
      bytes = '{"qualified":false}\n';
    await writeFile(path, bytes);
    const pin = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    assert.equal((await pinned(pin, true)).qualified, false);
    await writeFile(path, '{"qualified":true}\n');
    await assert.rejects(pinned(pin, true), /pinned file changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
