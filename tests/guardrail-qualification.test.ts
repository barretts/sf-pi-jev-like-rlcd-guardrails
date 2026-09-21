import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonical } from "../src/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../src/guardrail.js";
import {
  GUARDRAIL_REQUIRED_FAMILIES,
  qualifyGuardrail,
  freezeGuardrailCandidate,
  verifyGuardrailQualification,
  type GuardrailEvaluationRecord,
  type GuardrailInventoryRecord,
} from "../src/guardrail-evaluation.js";
const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const identity = {
  modelSha256: "a".repeat(64),
  corpusSha256: "b".repeat(64),
  baselineSourceSha256: "c".repeat(64),
  executionSurface: "sf_guardrail_bridge" as const,
  nativeBinarySha256: "d".repeat(64),
};
const rows = (split: "validation" | "test"): GuardrailEvaluationRecord[] =>
  GUARDRAIL_REQUIRED_FAMILIES.flatMap((family) =>
    [false, true].map((risky) => ({
      id: `${split}-${family}-${risky}`,
      groupId: `${split}-${family}-${risky}`,
      family,
      expected: risky ? (family === "files" ? "block" : "confirm") : "allow",
      baseline: risky ? (family === "files" ? "block" : "confirm") : "allow",
      actual: risky ? (family === "files" ? "block" : "confirm") : "allow",
      modelEligible: family !== "files",
      modelAnswered: family !== "files",
      policyFloor: family === "files",
      elapsedMs: 120,
      inputSha256: sha(`${split}-${family}-${risky}`),
      evidence: {
        source: family === "files" ? "exact_policy" : "jev",
        actual: risky ? (family === "files" ? "block" : "confirm") : "allow",
        prediction: risky ? "confirm" : "allow",
        inputSha256: sha(`${split}-${family}-${risky}`),
        modelSha256: identity.modelSha256,
        protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        allowScore: risky ? 0.01 : 0.999,
        elapsedMs: 120,
      },
    })),
  );
const inventory = (): GuardrailInventoryRecord[] => [
  {
    id: "train-original",
    groupId: "train-original",
    family: "shell",
    split: "train",
    expected: "allow",
    baseline: "allow",
    policyFloor: false,
    modelEligible: true,
    inputSha256: sha("train-original"),
  },
  ...(["validation", "test"] as const).flatMap((split) =>
    rows(split).map(
      ({ actual, modelAnswered, elapsedMs, evidence, ...row }) => ({
        ...row,
        split,
        inputSha256: row.inputSha256!,
      }),
    ),
  ),
];
const passing = () => {
  const validation = qualifyGuardrail(rows("validation"), {
    ...identity,
    split: "validation",
  });
  const freeze = freezeGuardrailCandidate(validation, inventory());
  return qualifyGuardrail(rows("test"), { ...identity, split: "test", freeze });
};
describe("frozen guardrail selection", () => {
  it("requires real bridge evidence, complete coverage and a frozen validation-selected candidate", () => {
    const test = qualifyGuardrail(rows("test"), { ...identity, split: "test" });
    expect(test.qualified).toBe(false);
    expect(passing().qualified).toBe(true);
    const direct = qualifyGuardrail(rows("validation"), {
      ...identity,
      split: "validation",
      executionSurface: "direct_classifier",
    });
    expect(() => freezeGuardrailCandidate(direct, inventory())).toThrow(
      "failed validation",
    );
    const missingFamily = qualifyGuardrail(
      rows("validation").filter((r) => r.family !== "browser"),
      { ...identity, split: "validation" },
    );
    expect(() =>
      freezeGuardrailCandidate(missingFamily, inventory()),
    ).toThrow();
  });
  it("rejects unsafe allows, concealed fallback, extra interruptions, changed exact blocks and late completion", () => {
    for (const change of [
      (r: GuardrailEvaluationRecord) =>
        r.expected === "confirm" ? { ...r, actual: "allow" as const } : r,
      (r: GuardrailEvaluationRecord) =>
        r.expected === "allow" ? { ...r, actual: "confirm" as const } : r,
      (r: GuardrailEvaluationRecord) =>
        r.expected === "block" ? { ...r, actual: "confirm" as const } : r,
      (r: GuardrailEvaluationRecord) =>
        r.modelEligible ? { ...r, modelAnswered: false } : r,
      (r: GuardrailEvaluationRecord) =>
        r.modelEligible ? { ...r, error: "rules fallback", elapsedMs: 501 } : r,
    ]) {
      const report = passing();
      report.records = report.records.map(change);
      report.qualified = true;
      expect(() =>
        verifyGuardrailQualification(
          report,
          identity.modelSha256,
          identity.nativeBinarySha256,
        ),
      ).toThrow();
    }
  });
  it("detects report tampering, missing cases, edited gold, modified cutoffs and stale identities", () => {
    const original = passing();
    expect(
      verifyGuardrailQualification(
        original,
        identity.modelSha256,
        identity.nativeBinarySha256,
      ).protocolSha256,
    ).toBe(GUARDRAIL_PROTOCOL_SHA256);
    for (const report of [
      { ...original, records: original.records.slice(1) },
      {
        ...original,
        records: original.records.map((r, i) =>
          i === 0 ? { ...r, inputSha256: "d".repeat(64) } : r,
        ),
      },
      { ...original, freeze: { ...original.freeze!, minimumAllowScore: 0.5 } },
      { ...original, protocolSha256: "d".repeat(64) },
      { ...original, executionSurface: "direct_classifier" },
    ])
      expect(() =>
        verifyGuardrailQualification(
          report,
          identity.modelSha256,
          identity.nativeBinarySha256,
        ),
      ).toThrow();
    expect(() =>
      verifyGuardrailQualification(
        original,
        "e".repeat(64),
        identity.nativeBinarySha256,
      ),
    ).toThrow();
  });
  it("rejects related groups and exact request contexts crossing splits", () => {
    const validation = qualifyGuardrail(rows("validation"), {
      ...identity,
      split: "validation",
    });
    for (const field of ["groupId", "inputSha256"] as const) {
      const inv = inventory();
      inv[21] = { ...inv[21], [field]: inv[1][field] };
      expect(() => freezeGuardrailCandidate(validation, inv)).toThrow(
        "overlapping",
      );
    }
  });
});
