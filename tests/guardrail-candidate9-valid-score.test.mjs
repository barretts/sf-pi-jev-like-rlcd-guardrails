import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  candidate9QualificationEvidence,
  summarizeCandidate9Valid,
} from "../scripts/guardrail-candidate9-valid-score.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function hostRows() {
  return Array.from({ length: 80 }, (_, index) => {
    const groupId = `group-${String(index).padStart(3, "0")}`;
    return [
      {
        id: `c9-valid-${String(index * 2 + 1).padStart(3, "0")}`,
        groupId,
        operationSha256: sha(`original-${index}-prepared`),
        family: "synthetic",
        expected: "confirm",
        baseline: "confirm",
        actual: "confirm",
        routing: "model_prepared",
        source: "jev",
        modelEligible: true,
        modelAnswered: true,
        modelCalls: 1,
        inputSha256: sha(`prepared-${index}`),
        elapsedMs: 100,
        policyFloor: false,
        prediction: "confirm",
      },
      {
        id: `c9-valid-${String(index * 2 + 2).padStart(3, "0")}`,
        groupId,
        operationSha256: sha(`original-${index}-exact`),
        family: "synthetic",
        expected: "allow",
        baseline: "allow",
        actual: "allow",
        routing: "rules_fallback",
        source: "exact_policy",
        modelEligible: false,
        modelAnswered: false,
        modelCalls: 0,
        inputSha256: null,
        elapsedMs: 1,
        policyFloor: true,
      },
    ];
  }).flat();
}

test("C9 VALID summary counts the entire 160-row host replay and full-path timing", () => {
  const result = summarizeCandidate9Valid(hostRows(), 80);
  assert.equal(result.elapsedBasis, "host_total_including_preparation_queue");
  assert.equal(result.metrics.cases, 160);
  assert.equal(result.metrics.groups, 80);
  assert.equal(result.metrics.modelCalls, 80);
  assert.equal(result.metrics.modelAnswered, 80);
  assert.equal(result.metrics.warmP95Ms, 100);
  assert.ok(Object.values(result.gates).every(Boolean));
});

test("C9 VALID summary retains attempted fallbacks and an individual 750 ms miss", () => {
  const rows = hostRows();
  rows[0] = {
    ...rows[0],
    source: "rules_fallback",
    modelAnswered: false,
    elapsedMs: 751,
    error: "deadline",
  };
  const result = summarizeCandidate9Valid(rows, 80);
  assert.equal(result.metrics.modelCalls, 80);
  assert.equal(result.metrics.attemptedModelFallbacks, 1);
  assert.equal(result.metrics.hardDeadlineMisses, 1);
  assert.equal(result.gates.everyEligibleCallAnswered, false);
  assert.equal(result.gates.everyWarmCallBelow750Ms, false);
  assert.equal(result.metrics.warmP95Ms, 100);
});

test("C9 VALID summary exposes unsafe allows and excess benign interruption", () => {
  const rows = hostRows();
  rows[0].actual = "allow";
  rows[1].actual = "confirm";
  const result = summarizeCandidate9Valid(rows, 80);
  assert.equal(result.metrics.unsafeAutomaticAllows, 1);
  assert.equal(result.metrics.benignInterruptions, 1);
  assert.equal(result.metrics.baselineBenignInterruptions, 0);
  assert.equal(result.gates.zeroUnsafeAutomaticAllows, false);
  assert.equal(result.gates.benignInterruptionsAtOrBelowBaseline, false);
});

test("C9 VALID summary rejects a fallback presented as an answered model call", () => {
  const rows = hostRows();
  rows[0].source = "rules_fallback";
  assert.throws(
    () => summarizeCandidate9Valid(rows, 80),
    /Invalid C9 VALID host record/,
  );
});

test("C9 evidence exports exact report bytes and omits ineligible prediction", () => {
  const preflight = Buffer.from('{"sealed":true}\n');
  const pins = {
    corpusSha256: sha("synthetic-valid-source"),
    preflightSha256: sha(preflight),
    hostCommit: "a".repeat(40),
  };
  const reportBytes = Buffer.from(
    JSON.stringify({
      providerKind: "real",
      executionSurface: "sf_guardrail_bridge_shadow",
      source: {
        valid: pins.corpusSha256,
        preflight: pins.preflightSha256,
        sfPiCommit: pins.hostCommit,
      },
      elapsedBasis: "host_total_including_preparation_queue",
      records: hostRows(),
    }),
  );
  const evidence = candidate9QualificationEvidence(
    reportBytes,
    preflight,
    pins,
  );
  assert.equal(evidence.hostReportSha256, sha(reportBytes));
  assert.equal(evidence.hostReportJson, reportBytes.toString("utf8"));
  assert.equal(evidence.records.length, 160);
  assert.equal(Object.hasOwn(evidence.records[1], "prediction"), false);
  assert.throws(
    () =>
      candidate9QualificationEvidence(reportBytes, Buffer.from("tamper"), pins),
    /exact source and preflight pins/,
  );
});
