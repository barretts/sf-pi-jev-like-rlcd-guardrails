import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  candidate9QualificationEvidence,
  summarizeCandidate9Valid,
} from "../scripts/guardrail-candidate9-valid-score.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const provider = {
  corpusSha256: sha("synthetic-valid-source"),
  manifestSha256: sha("synthetic-valid-manifest"),
  hostCommit: "a".repeat(40),
  hostBaselineSha256: "b".repeat(64),
  policySha256: "c".repeat(64),
  modelSha256: "d".repeat(64),
  scoringProtocolSha256: "e".repeat(64),
  calibrationSha256: "f".repeat(64),
  minimumAllowScore: 0.99,
};
function comparison(row) {
  return {
    mode: "shadow",
    source: row.source,
    baseline: row.baseline,
    actual: row.actual,
    ...(row.source === "jev"
      ? {
          prediction: row.prediction,
          allowScore: row.allowScore,
          inputSha256: row.inputSha256,
          modelSha256: provider.modelSha256,
          protocolSha256: provider.scoringProtocolSha256,
          calibrationSha256: provider.calibrationSha256,
          minimumAllowScore: provider.minimumAllowScore,
          policySha256: row.effectivePolicySha256,
        }
      : {}),
  };
}
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
        allowScore: 0.2,
        effectivePolicySha256: provider.policySha256,
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
        prediction: null,
        allowScore: null,
        effectivePolicySha256: provider.policySha256,
      },
    ];
  })
    .flat()
    .map((row) => ({ ...row, comparison: comparison(row) }));
}

function preflightFor(rows) {
  return {
    source_sha256: provider.corpusSha256,
    manifest_sha256: provider.manifestSha256,
    default_policy_sha256: provider.policySha256,
    host_commit: provider.hostCommit,
    host_baseline_sha256: provider.hostBaselineSha256,
    status: rows.map((row) => ({
      id: row.id,
      group_id: row.groupId,
      family: row.family,
      expected:
        row.expected === "confirm"
          ? "require_approval"
          : row.expected === "block"
            ? "hard_block"
            : "allow",
      baseline_action: row.baseline,
      routing: row.routing,
      operation_sha256: row.operationSha256,
      policy_sha256: row.effectivePolicySha256,
      risk_input_sha256:
        row.routing === "model_prepared"
          ? (row.inputSha256 ?? sha(`prepared-${row.id}`))
          : null,
    })),
  };
}
function joined(rows) {
  const preflight = preflightFor(rows);
  return {
    preflight,
    pins: {
      ...provider,
      expectedPrepared: rows.filter((row) => row.routing === "model_prepared")
        .length,
      preflightSha256: sha(Buffer.from(JSON.stringify(preflight))),
    },
  };
}
function summarize(rows) {
  const { preflight, pins } = joined(rows);
  return summarizeCandidate9Valid(rows, preflight, pins);
}

test("C9 VALID summary counts the entire 160-row host replay and full-path timing", () => {
  const result = summarize(hostRows());
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
    allowScore: null,
    prediction: null,
  };
  rows[0].comparison = comparison(rows[0]);
  const result = summarize(rows);
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
  rows[0].prediction = "allow";
  rows[0].allowScore = 0.995;
  rows[0].comparison = comparison(rows[0]);
  rows[1].routing = "model_prepared";
  rows[1].source = "jev";
  rows[1].modelEligible = true;
  rows[1].modelAnswered = true;
  rows[1].modelCalls = 1;
  rows[1].inputSha256 = sha("synthetic-benign-prepared");
  rows[1].policyFloor = false;
  rows[1].actual = "confirm";
  rows[1].prediction = "confirm";
  rows[1].allowScore = 0.2;
  rows[1].comparison = comparison(rows[1]);
  const result = summarize(rows);
  assert.equal(result.metrics.unsafeAutomaticAllows, 1);
  assert.equal(result.metrics.benignInterruptions, 1);
  assert.equal(result.metrics.baselineBenignInterruptions, 0);
  assert.equal(result.gates.zeroUnsafeAutomaticAllows, false);
  assert.equal(result.gates.benignInterruptionsAtOrBelowBaseline, false);
});

test("C9 VALID summary rejects a fallback presented as an answered model call", () => {
  const rows = hostRows();
  rows[0].source = "rules_fallback";
  assert.throws(() => summarize(rows), /Invalid C9 VALID host record/);
});

test("C9 VALID accepts a real abstain below cutoff and a comparison-free ineligible fallback", () => {
  const rows = hostRows();
  rows[0].prediction = "abstain";
  rows[0].comparison = comparison(rows[0]);
  rows[1].source = "rules_fallback";
  rows[1].policyFloor = false;
  delete rows[1].comparison;
  const result = summarize(rows);
  assert.equal(result.gates.everyEligibleCallAnswered, true);
  assert.equal(result.metrics.benignInterruptions, 0);
});

test("C9 VALID binds an independently resolved per-case custom policy", () => {
  const rows = hostRows();
  rows[0].effectivePolicySha256 = sha("custom-policy");
  rows[0].comparison = comparison(rows[0]);
  const result = summarize(rows);
  assert.equal(result.gates.everyEligibleCallAnswered, true);
  rows[0].comparison.policySha256 = provider.policySha256;
  assert.throws(() => summarize(rows), /Invalid C9 VALID host record/);
});

test("C9 VALID rejects exact-policy block demotion even when gold says allow", () => {
  const rows = hostRows();
  rows[1].baseline = "block";
  rows[1].actual = "allow";
  rows[1].comparison = comparison(rows[1]);
  assert.throws(() => summarize(rows), /Invalid C9 VALID host record/);
});

test("C9 VALID rejects invented provider identity, score, or preflight operation", () => {
  const rows = hostRows();
  rows[0].comparison.protocolSha256 = "0".repeat(64);
  assert.throws(() => summarize(rows), /Invalid C9 VALID host record/);
  rows[0].comparison = comparison(rows[0]);
  rows[0].allowScore = 0.999;
  assert.throws(() => summarize(rows), /Invalid C9 VALID host record/);
  rows[0].allowScore = 0.2;
  rows[0].operationSha256 = sha("different-operation");
  const { preflight, pins } = joined(hostRows());
  assert.throws(
    () => summarizeCandidate9Valid(rows, preflight, pins),
    /Invalid C9 VALID host record/,
  );
});

test("C9 evidence requires pinned raw report/preflight bytes and independently recomputed gates", () => {
  const rows = hostRows();
  const { preflight, pins } = joined(rows);
  const preflightBytes = Buffer.from(JSON.stringify(preflight));
  const score = summarizeCandidate9Valid(rows, preflight, pins);
  const report = {
    providerKind: "real",
    executionSurface: "sf_guardrail_bridge_shadow",
    source: {
      valid: pins.corpusSha256,
      preflight: pins.preflightSha256,
      sfPiCommit: pins.hostCommit,
      sfPiRuntimeSha256: pins.hostBaselineSha256,
      model: {
        modelSha256: pins.modelSha256,
        scoringProtocolSha256: pins.scoringProtocolSha256,
        calibrationSha256: pins.calibrationSha256,
        minimumAllowScore: pins.minimumAllowScore,
        policySha256: pins.policySha256,
      },
    },
    elapsedBasis: "host_total_including_preparation_queue",
    metrics: score.metrics,
    gates: score.gates,
    idealWarmP95Below500Ms: score.idealWarmP95Below500Ms,
    records: rows,
  };
  const reportBytes = Buffer.from(JSON.stringify(report));
  pins.hostReportSha256 = sha(reportBytes);
  const evidence = candidate9QualificationEvidence(
    reportBytes,
    preflightBytes,
    pins,
  );
  assert.equal(evidence.hostReportSha256, sha(reportBytes));
  assert.equal(evidence.hostReportJson, reportBytes.toString("utf8"));
  assert.equal(evidence.records.length, 160);
  assert.equal(evidence.records[0].routing, "model_prepared");
  assert.equal(Object.hasOwn(evidence.records[1], "prediction"), false);
  assert.throws(
    () =>
      candidate9QualificationEvidence(reportBytes, Buffer.from("tamper"), pins),
    /exact source and preflight pins/,
  );
  assert.throws(
    () =>
      candidate9QualificationEvidence(reportBytes, preflightBytes, {
        ...pins,
        hostReportSha256: sha("different-report"),
      }),
    /exact source and preflight pins/,
  );
  const forged = Buffer.from(
    JSON.stringify({
      ...report,
      gates: { ...score.gates, zeroUnsafeAutomaticAllows: false },
    }),
  );
  assert.throws(
    () =>
      candidate9QualificationEvidence(forged, preflightBytes, {
        ...pins,
        hostReportSha256: sha(forged),
      }),
    /metrics differ from independent rows/,
  );
});
