import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  C10_TEST_CRITERIA,
  reserveC10Test,
  summarizeC10Test,
  validateC10Freeze,
  verifyC10TestMetadata,
} from "../scripts/guardrail-candidate10-qualify.mjs";
const hash = "a".repeat(64),
  pins = {
    modelSha256: hash,
    scoringProtocolSha256: hash,
    calibrationSha256: hash,
    minimumAllowScore: 0.5,
  };
function population() {
  const records = ["allow", "confirm"].map((expected, i) => ({
    id: `row-${i}`,
    groupId: `group-${i}`,
    operationSha256: hash,
    expected,
    baseline: "allow",
    routing: "model_prepared",
    actual: expected,
    modelEligible: true,
    effectivePolicySha256: hash,
    elapsedMs: 100,
    modelCalls: 1,
    modelAnswered: true,
    source: "jev",
    inputSha256: hash,
    allowScore: i ? 0.1 : 0.9,
    comparison: {
      mode: "shadow",
      source: "jev",
      actual: expected,
      baseline: "allow",
      allowScore: i ? 0.1 : 0.9,
      inputSha256: hash,
      policySha256: hash,
      modelSha256: hash,
      protocolSha256: hash,
      calibrationSha256: hash,
      minimumAllowScore: 0.5,
    },
  }));
  const preflight = {
    status: records.map((row) => ({
      id: row.id,
      group_id: row.groupId,
      operation_sha256: hash,
      expected: row.expected === "allow" ? "allow" : "require_approval",
      baseline_action: "allow",
      routing: "model_prepared",
      policy_sha256: hash,
      risk_input_sha256: hash,
    })),
  };
  return { records, preflight };
}
test("real shadow rows establish corpus only, without production approval", () => {
  const { records, preflight } = population();
  const result = summarizeC10Test(records, preflight, pins);
  assert.equal(result.corpusQualified, true);
  assert.equal(result.metrics.correctedBaselineRisks, 1);
});
test("fallback cannot hide failed eligible prediction even with correct baseline", () => {
  const { records, preflight } = population();
  Object.assign(records[0], {
    modelAnswered: false,
    source: "rules_fallback",
    modelCalls: 0,
    allowScore: null,
  });
  const result = summarizeC10Test(records, preflight, pins);
  assert.equal(result.gates.everyEligibleAnswered, false);
  assert.equal(result.corpusQualified, false);
});
test("unsafe automatic allow rejects despite complete and fast calls", () => {
  const { records, preflight } = population();
  Object.assign(records[1], { actual: "allow", allowScore: 0.9 });
  Object.assign(records[1].comparison, { actual: "allow", allowScore: 0.9 });
  const result = summarizeC10Test(records, preflight, pins);
  assert.equal(result.metrics.unsafeAutomaticAllows, 1);
  assert.equal(result.corpusQualified, false);
});
test("changed model and policy bindings reject prediction receipt", () => {
  for (const key of [
    "modelSha256",
    "policySha256",
    "protocolSha256",
    "calibrationSha256",
  ]) {
    const { records, preflight } = population();
    records[0].comparison[key] = "b".repeat(64);
    assert.throws(() => summarizeC10Test(records, preflight, pins), /identity/);
  }
});
test("hard deadline includes preparation and queue and cannot be averaged away", () => {
  const { records, preflight } = population();
  records[0].elapsedMs = 750;
  assert.equal(
    summarizeC10Test(records, preflight, pins).corpusQualified,
    false,
  );
});
test("missing row cannot shrink effectiveness denominator", () => {
  const { records, preflight } = population();
  assert.throws(
    () => summarizeC10Test(records.slice(1), preflight, pins),
    /incomplete/,
  );
});
test("exclusive reservation is consumed across candidates and failures", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "c10-test-ledger-"));
  try {
    const token = await reserveC10Test(directory, hash, hash);
    assert.equal(token.freezeSha256, hash);
    await assert.rejects(
      reserveC10Test(directory, hash, "b".repeat(64)),
      /EEXIST/,
    );
    assert.equal(
      JSON.parse(
        await readFile(resolve(directory, `${hash}.reservation.json`), "utf8"),
      ).freezeSha256,
      hash,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("incomplete or softened criteria reject before any TEST source access", () => {
  assert.throws(
    () =>
      validateC10Freeze({
        version: 1,
        purpose: "candidate10_frozen_test_qualification",
        criteria: { ...C10_TEST_CRITERIA, minimumWholeAccuracy: 0.8 },
      }),
    /freeze/,
  );
});
test("contaminated or undocumented isolation receipts are rejected", () => {
  assert.throws(
    () =>
      verifyC10TestMetadata(
        {},
        {},
        { contaminated: true },
        { testSource: { sha256: hash } },
        {},
      ),
    /contaminated/,
  );
});
