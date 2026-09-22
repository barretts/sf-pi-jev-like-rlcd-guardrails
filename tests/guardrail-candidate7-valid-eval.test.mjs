import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  assertCandidate7Preflight,
  assertPreparedCall,
  compareCandidate7HostPreparation,
  summarizeCandidate7FamilyCoverage,
  verifyCandidate7TrainingPins,
} from "../scripts/guardrail-candidate7-valid-eval.mjs";

const valid = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, "../blind-c7-20260922/valid.json"),
  ),
);
const rows = valid.cases;
const action = {
  allow: "allow",
  require_approval: "confirm",
  hard_block: "block",
};

function records() {
  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    family: row.family,
    expected: action[row.expected.decision],
    baseline: "allow",
    actual: "allow",
    gate: ["read", "write", "edit"].includes(row.operation.tool)
      ? "ineligible"
      : "prepared",
    source: ["read", "write", "edit"].includes(row.operation.tool)
      ? "rules_fallback"
      : "jev",
    comparison: ["read", "write", "edit"].includes(row.operation.tool)
      ? { source: "exact_policy" }
      : { source: "jev" },
    modelCalls: ["read", "write", "edit"].includes(row.operation.tool) ? 0 : 1,
    policyFloor: false,
  }));
}

test("C7 family gate uses actual prepared calls and requires both sides of each model lane", () => {
  const observed = records();
  const full = summarizeCandidate7FamilyCoverage(rows, observed);
  assert.equal(full.strictRequiredFamilyMixedCoverage, true);
  assert.equal(full.laneAwareCoverage, false);
  assert.deepEqual(full.filePolicyFailures, ["c7-valid-007", "c7-valid-008"]);
  assert.ok(full.matrix.herdr.preparedAllow > 0);
  assert.ok(full.matrix.herdr.preparedRisky > 0);
  assert.ok(full.matrix.files.cases > 0);
  for (const id of ["c7-valid-007", "c7-valid-008"]) {
    const record = observed.find((row) => row.id === id);
    record.actual = record.expected;
    record.baseline = record.expected;
  }
  assert.equal(
    summarizeCandidate7FamilyCoverage(rows, observed).laneAwareCoverage,
    true,
  );
  const riskyHerdr = observed.find(
    (row) =>
      row.family === "shell_indirect" &&
      row.expected === "confirm" &&
      rows.find((source) => source.id === row.id)?.operation.tool ===
        "herdr_pane",
  );
  riskyHerdr.gate = "policy_floor";
  riskyHerdr.source = "exact_policy";
  riskyHerdr.modelCalls = 0;
  riskyHerdr.actual = riskyHerdr.expected;
  riskyHerdr.baseline = riskyHerdr.expected;
  assert.equal(
    summarizeCandidate7FamilyCoverage(rows, observed)
      .strictRequiredFamilyMixedCoverage,
    false,
  );
  riskyHerdr.actual = "allow";
  const unsafeFloor = summarizeCandidate7FamilyCoverage(rows, observed);
  assert.deepEqual(unsafeFloor.floorGoldFailures, [riskyHerdr.id]);
  assert.equal(unsafeFloor.laneAwareCoverage, false);
});

test("C7 TRAIN and host pins reject a self-consistent model source switch", () => {
  const expected = {
    admissionSha256: "a".repeat(64),
    hostCommit: "a12f1de85c1919fa2ff94bf9315c522b0ad382da",
    hostRuntimeSha256:
      "b31d600d262be46bb68fc5de6cd581265dad2f29d5ed03b0f1c6920c6e78afba",
  };
  const source = {
    admissionSha256: expected.admissionSha256,
    sfPiCommit: expected.hostCommit,
    sfPiRuntimeSha256: expected.hostRuntimeSha256,
    scorerProtocolSha256:
      "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530",
    trainRows: 227,
    trainGroups: 77,
    admittedDatasetSha256: "d".repeat(64),
    codeIdentity: {
      gitHead: "e".repeat(40),
      files: Object.fromEntries(
        [
          "scripts/guardrail-candidate7-train.mjs",
          "scripts/guardrail-candidate7-train-admission.mjs",
          "src/rfdt.ts",
          "rfdt/worker.py",
          "rfdt/requirements.lock",
          "scripts/build-rfdt.sh",
          "package-lock.json",
          ...[
            "backend.js",
            "core.js",
            "guardrail-evaluation.js",
            "guardrail-extension.js",
            "guardrail.js",
            "models.js",
            "rfdt.js",
          ].map((name) => `dist/${name}`),
        ].map((name) => [name, "0".repeat(64)]),
      ),
      nativeBinarySha256: "f".repeat(64),
    },
  };
  assert.equal(
    verifyCandidate7TrainingPins(source, expected).trainGitHead,
    source.codeIdentity.gitHead,
  );
  assert.throws(
    () => verifyCandidate7TrainingPins({ ...source, trainRows: 226 }, expected),
    /TRAIN, protocol, or host pins changed/,
  );
  assert.throws(
    () =>
      verifyCandidate7TrainingPins(
        { ...source, sfPiRuntimeSha256: "0".repeat(64) },
        expected,
      ),
    /TRAIN, protocol, or host pins changed/,
  );
});

test("real replay cannot silently change fake-host baseline, eligibility, or fallback", () => {
  const source = records();
  const hostPin = { commit: "a".repeat(40), runtimeSha256: "b".repeat(64) };
  const preflight = {
    purpose: "candidate7_valid_bridge_fake_provider_test",
    qualification: false,
    validationOnly: true,
    heldOutTestUsed: false,
    modelProvider: "fake",
    externalOperationsExecuted: 0,
    source: {
      manifestSha256: "c".repeat(64),
      evaluatorScriptSha256: "d".repeat(64),
      sfPiCommit: hostPin.commit,
      sfPiRuntimeSha256: hostPin.runtimeSha256,
    },
    records: source,
  };
  const options = {
    sha256: "e".repeat(64),
    manifestSha256: preflight.source.manifestSha256,
    scriptSha256: preflight.source.evaluatorScriptSha256,
    hostPin,
    rows,
  };
  const indexed = assertCandidate7Preflight(preflight, options);
  assert.deepEqual(compareCandidate7HostPreparation(source, indexed), []);
  const changed = source.map((row) => ({ ...row }));
  changed[0].baseline = "confirm";
  changed[1].gate = "fallback";
  changed[1].fallbackReason = "missing_fact";
  assert.deepEqual(compareCandidate7HostPreparation(changed, indexed), [
    source[0].id,
    source[1].id,
  ]);
  assert.throws(
    () =>
      assertCandidate7Preflight(
        {
          ...preflight,
          source: { ...preflight.source, sfPiCommit: "0".repeat(40) },
        },
        options,
      ),
    /different sealed replay/,
  );
});

test("model-visible call keeps the complete source request and no authored label", () => {
  const row = rows.find((item) => item.operation.tool === "bash");
  const call = {
    input: {
      version: 2,
      toolName: row.operation.tool,
      input: row.operation.input,
      facts: {},
    },
  };
  assert.doesNotThrow(() => assertPreparedCall(row, call, null));
  assert.throws(
    () =>
      assertPreparedCall(
        row,
        {
          input: { ...call.input, expected: row.expected },
        },
        null,
      ),
    /altered or classified request/,
  );
});
