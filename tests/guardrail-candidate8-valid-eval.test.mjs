import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  C8_VALID_SEAL,
  summarizeCandidate8Valid,
  verifyCandidate8CalibratedSelection,
  verifyCandidate8ValidPopulation,
} from "../scripts/guardrail-candidate8-valid-eval.mjs";
import {
  selectC8Calibration,
  verifyC8Calibration,
} from "../dist/guardrail-calibration.js";
import {
  assertCandidate8PreparedCall,
  createCandidate8Recorder,
} from "../scripts/guardrail-candidate8-host-core.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (name) =>
  JSON.parse(await readFile(resolve(root, "blind-c8-20260922", name), "utf8"));

test("VALID wrapper accepts only the corrected host-pinned population", async () => {
  const source = await readJson("valid.json");
  const receipt = await readJson("valid-host-preflight.json");
  const byId = verifyCandidate8ValidPopulation(source, receipt);
  assert.equal(byId.size, C8_VALID_SEAL.cases);
  assert.equal(
    [...byId.values()].filter((row) => row.routing === "model_prepared").length,
    C8_VALID_SEAL.modelPrepared,
  );
  assert.equal(
    [...byId.values()].filter((row) => row.routing === "pre_model_fallback")
      .length,
    C8_VALID_SEAL.preModelFallbacks,
  );
  assert.throws(
    () =>
      verifyCandidate8ValidPopulation(source, {
        ...receipt,
        host_commit: "0".repeat(40),
      }),
    /host identity/,
  );
  assert.throws(
    () =>
      verifyCandidate8ValidPopulation(source, {
        ...receipt,
        status: [...receipt.status].reverse(),
      }),
    /case\/preflight/,
  );
  assert.throws(
    () =>
      verifyCandidate8ValidPopulation({ ...source, split: "train" }, receipt),
    /source, receipt/,
  );
});

test("prepared request must preserve original operation and independent facts", async () => {
  const source = await readJson("valid.json");
  const receipt = await readJson("valid-host-preflight.json");
  const row = source.cases.find((item) => item.id === "c8-valid-001");
  const status = receipt.status.find((item) => item.id === row.id);
  const input = {
    version: 2,
    toolName: row.operation.tool,
    input: row.operation.input,
    facts: {},
  };
  assert.throws(
    () =>
      assertCandidate8PreparedCall(
        row,
        { input, inputSha256: "0".repeat(64) },
        status,
      ),
    /differs/,
  );
  assert.throws(
    () =>
      assertCandidate8PreparedCall(
        row,
        {
          input: { ...input, input: { command: "rm -rf /" } },
          inputSha256: status.risk_input_sha256,
        },
        status,
      ),
    /differs/,
  );
  assert.throws(
    () =>
      assertCandidate8PreparedCall(
        row,
        {
          input: { ...input, classification: "allow" },
          inputSha256: status.risk_input_sha256,
        },
        status,
      ),
    /differs/,
  );
});

test("recorder is an event seam with no tool execution surface", () => {
  const recorder = createCandidate8Recorder();
  const seen = [];
  recorder.events.on("provider", (request) => seen.push(request));
  recorder.events.emit("provider", { id: 1 });
  assert.deepEqual(seen, [{ id: 1 }]);
  assert.equal("registerTool" in recorder, false);
});

test("VALID summary rejects incomplete replay and counts attempted fallback", () => {
  assert.throws(() => summarizeCandidate8Valid([], "fake"), /Incomplete/);
  const rows = Array.from({ length: C8_VALID_SEAL.cases }, (_, index) => ({
    id: `c8-valid-${String(index + 1).padStart(3, "0")}`,
    groupId: `g-${Math.floor(index / 2)}`,
    family: "shell",
    expected: "allow",
    baseline: "allow",
    actual: "allow",
    routing:
      index < C8_VALID_SEAL.modelPrepared ? "model_prepared" : "rules_fallback",
    modelAnswered: index !== 0,
    elapsedMs: 1,
    ...(index === 0 ? { error: "provider failed" } : {}),
  }));
  const result = summarizeCandidate8Valid(rows, "fake");
  assert.equal(result.metrics.attemptedModelFallbacks, 1);
  assert.equal(result.gates.allPreparedModelCallsAnswered, false);
  assert.equal(result.gates.humanLabelReviewComplete, false);
});

test("real VALID path accepts only the admitted dynamic TRAIN-CAL selection", () => {
  const modelSha256 = "a".repeat(64);
  const nativeBinarySha256 = "b".repeat(64);
  const input = {
    version: 1,
    purpose: "candidate8_train_calibration_only",
    modelSha256,
    nativeBinarySha256,
    promptProtocolSha256: C8_VALID_SEAL.promptProtocolSha256,
    baselineSha256: C8_VALID_SEAL.hostRuntimeSha256,
    policySha256: C8_VALID_SEAL.policySha256,
    baselineReceiptSha256: C8_VALID_SEAL.calBaselineReceiptSha256,
    admissionSha256: C8_VALID_SEAL.calAdmissionSha256,
    fitSha256: C8_VALID_SEAL.calFitSha256,
    calibrationCorpusSha256: C8_VALID_SEAL.calCorpusSha256,
    fitGroups: Array.from({ length: 77 }, (_, index) => `fit-${index}`),
    cases: Array.from({ length: 47 }, (_, index) => ({
      id: `cal-${index}`,
      groupId: `cal-group-${index % 17}`,
      expected: index < 24 ? "allow" : "confirm",
    })),
    records: Array.from({ length: 47 }, (_, index) => ({
      id: `cal-${index}`,
      groupId: `cal-group-${index % 17}`,
      expected: index < 24 ? "allow" : "confirm",
      baseline: index < 24 ? "allow" : "confirm",
      gate: "prepared",
      modelAnswered: true,
      inputSha256: String(index % 10).repeat(64),
      allowScore: index < 24 ? 0.9 : 0.55,
      elapsedMs: 4,
    })),
  };
  const selected = selectC8Calibration(input);
  const accepted = verifyCandidate8CalibratedSelection(
    selected,
    modelSha256,
    nativeBinarySha256,
    verifyC8Calibration,
  );
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.minimumAllowScore > 0.55);
  assert.ok(accepted.minimumAllowScore < 0.99);
  assert.equal(accepted.scoringProtocolSha256, selected.scoringProtocolSha256);

  const changedCutoff = { ...selected, minimumAllowScore: 0.99 };
  assert.throws(
    () =>
      verifyCandidate8CalibratedSelection(
        changedCutoff,
        modelSha256,
        nativeBinarySha256,
        verifyC8Calibration,
      ),
    /changed or did not select/,
  );
  const changedPolicy = selectC8Calibration({
    ...input,
    policySha256: "c".repeat(64),
  });
  assert.throws(
    () =>
      verifyCandidate8CalibratedSelection(
        changedPolicy,
        modelSha256,
        nativeBinarySha256,
        verifyC8Calibration,
      ),
    /final host pins/,
  );
  assert.throws(
    () =>
      verifyCandidate8CalibratedSelection(
        selected,
        "d".repeat(64),
        nativeBinarySha256,
        verifyC8Calibration,
      ),
    /installed model and scorer/,
  );
  assert.throws(
    () =>
      verifyCandidate8CalibratedSelection(
        selected,
        modelSha256,
        nativeBinarySha256,
        undefined,
      ),
    /verifier is unavailable/,
  );
});

test("VALID agent label audit covers the sealed inventory without human signoff", async () => {
  const source = await readJson("valid.json");
  const bytes = await readFile(
    resolve(
      root,
      "reports/guardrail-risk-2026-09-21/candidate-8-valid-agent-label-review.json",
    ),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "f73a764a993ce029bb2fc7215f4cbcce0106da368af462756ce2be41416275fa",
  );
  const audit = JSON.parse(bytes);
  assert.equal(audit.purpose, "candidate8_valid_agent_label_audit");
  assert.equal(audit.validCorpusSha256, C8_VALID_SEAL.sourceSha256);
  assert.equal(audit.rubricSha256, C8_VALID_SEAL.rubricSha256);
  assert.equal(audit.humanSignoff, false);
  assert.equal(audit.unresolvedSuspectedMislabels, 1);
  assert.equal(audit.reviewedCases, C8_VALID_SEAL.cases);
  assert.equal(audit.reviewedGroups, C8_VALID_SEAL.groups);
  assert.equal(audit.records.length, source.cases.length);
  assert.deepEqual(
    audit.records.map(({ id, groupId }) => [id, groupId]),
    source.cases.map(({ id, group_id }) => [id, group_id]),
  );
  assert.equal(
    audit.records.filter((row) => row.disposition === "limit").length,
    audit.limitsRequireHumanAdjudication,
  );
  assert.deepEqual(
    audit.records
      .filter((row) => row.disposition === "suspected_mislabel")
      .map((row) => row.id),
    ["c8-valid-085"],
  );
  assert.ok(
    audit.records.every((row) =>
      ["agree", "limit", "suspected_mislabel"].includes(row.disposition),
    ),
  );
});

test("real VALID CLI remains locked before any corpus or model scoring", () => {
  const run = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/guardrail-candidate8-valid-eval.mjs"),
      "--sf-pi",
      "/private/tmp/host-not-opened",
      "--sf-deps",
      "/private/tmp/deps-not-opened",
      "--output-dir",
      resolve(root, ".build/guardrail/candidate-8-valid-eval-locked-test"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Real C8 VALID scoring is disabled/);
});
