import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateScriptedSdkReport } from "../scripts/guardrail-candidate6-matched-workflows.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(
  root,
  "scripts/guardrail-candidate6-matched-workflows.mjs",
);
const sf = process.env.C6_SF_PI;
const deps = process.env.C6_SF_DEPS;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("matched-workflow runner rejects an output outside its fresh evidence directory", () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--sf-pi",
      sf ?? root,
      "--sf-deps",
      deps ?? root,
      "--output-dir",
      "../escape",
    ],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Output must be a fresh candidate-6-matched-workflows-/,
  );
});

test(
  "the real Pi SDK produces a pinned, counter-only off/shadow/enforce workflow receipt",
  { skip: !sf || !deps },
  async () => {
    const destination = resolve(
      root,
      `.build/guardrail/candidate-6-matched-workflows-test-${randomUUID()}`,
    );
    try {
      const result = spawnSync(
        process.execPath,
        [script, "--sf-pi", sf, "--sf-deps", deps, "--output-dir", destination],
        { cwd: root, encoding: "utf8", timeout: 90_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), resolve(destination, "receipt.json"));
      const rawBytes = readFileSync(resolve(destination, "sdk-report.json"));
      const raw = JSON.parse(rawBytes.toString("utf8"));
      const receipt = JSON.parse(
        readFileSync(resolve(destination, "receipt.json"), "utf8"),
      );
      assert.equal(receipt.rawSdkReport.sha256, sha(rawBytes));
      assert.equal(receipt.qualification, false);
      assert.equal(receipt.actualLocalModelCalls, 0);
      assert.equal(receipt.externalOperationsExecuted, 0);
      assert.equal(receipt.executionOwner, "sf-guardrail tool_call hook");
      assert.equal(receipt.operations, 10);
      assert.equal(receipt.workflows, 5);
      assert.deepEqual(
        receipt.measurements.map((row) => row.mode),
        ["off", "shadow", "enforce"],
      );
      assert.deepEqual(
        receipt.measurements.map((row) => row.confirmationCount),
        [3, 3, 4],
      );
      assert.deepEqual(
        receipt.measurements.map((row) => row.acceptedOperationCount),
        [9, 9, 9],
      );
      assert.deepEqual(
        receipt.measurements.map((row) => row.retries),
        [0, 0, 0],
      );
      assert.deepEqual(
        receipt.measurements.map((row) => row.coldModelInitializationMs),
        [null, null, null],
      );
      assert.equal(receipt.comparison.shadowMatchesBaseline, true);
      assert.equal(receipt.comparison.enforceAdditionalConfirmations, 1);
      assert.equal(receipt.measurements[1].warmRiskCheckCount, 4);
      assert.equal(receipt.measurements[2].warmRiskCheckCount, 4);
      assert.ok(receipt.measurements.every((row) => row.fallbackCount === 0));
      assert.ok(
        receipt.measurements.every((row) => row.unsafeAutomaticAllows === 0),
      );
      assert.deepEqual(
        validateScriptedSdkReport(raw).comparison,
        receipt.comparison,
      );

      const changedDecision = structuredClone(raw);
      changedDecision.measurements[1].confirmationCount++;
      assert.throws(
        () => validateScriptedSdkReport(changedDecision),
        /Shadow changed baseline confirmationCount|confirmation or workflow totals/,
      );
      const falseAcceptedOutcome = structuredClone(raw);
      falseAcceptedOutcome.measurements[1].acceptedOutcomes[0].executed = false;
      assert.throws(
        () => validateScriptedSdkReport(falseAcceptedOutcome),
        /accepted outcome 0 disagrees with Pi tool events/,
      );
      const missingRisk = structuredClone(raw);
      missingRisk.measurements[2].calls.find(
        (call) => call.riskComparisons[0]?.source === "jev",
      ).riskComparisons = [];
      assert.throws(
        () => validateScriptedSdkReport(missingRisk),
        /risk comparison is missing/,
      );
      const falseSafeComparison = structuredClone(raw);
      const riskyCall = falseSafeComparison.measurements[2].calls.find(
        (call) =>
          call.expected === "confirm" &&
          call.expectedComparisonSource === "jev",
      );
      riskyCall.riskComparisons[0].prediction = "allow";
      riskyCall.riskComparisons[0].actual = "allow";
      const comparisonAudit = riskyCall.customEntries.find(
        (entry) => entry.customType === "sf-guardrail-risk-comparison",
      ).data;
      comparisonAudit.prediction = "allow";
      comparisonAudit.actual = "allow";
      assert.throws(
        () => validateScriptedSdkReport(falseSafeComparison),
        /risk comparison is invalid/,
      );
      const missingApprovalAudit = structuredClone(raw);
      const approvedRisk = missingApprovalAudit.measurements[2].calls.find(
        (call) =>
          call.expected === "confirm" &&
          call.expectedComparisonSource === "jev",
      );
      approvedRisk.customEntries = approvedRisk.customEntries.filter(
        (entry) => entry.customType !== "sf-guardrail-decision",
      );
      assert.throws(
        () => validateScriptedSdkReport(missingApprovalAudit),
        /execution or approval totals disagree with Pi audit/,
      );
      const misattributedConfirmation = structuredClone(raw);
      misattributedConfirmation.measurements[0].confirmations[0].toolCallId =
        misattributedConfirmation.measurements[0].calls[0].toolCallId;
      assert.throws(
        () => validateScriptedSdkReport(misattributedConfirmation),
        /confirmation 0 is not bound to a confirmed operation/,
      );
      const changedBaseline = structuredClone(raw);
      changedBaseline.baselineSourceSha256 = "0".repeat(64);
      assert.throws(
        () => validateScriptedSdkReport(changedBaseline),
        /baseline changed/,
      );
    } finally {
      if (existsSync(destination))
        await rm(destination, { recursive: true, force: true });
    }
  },
);
