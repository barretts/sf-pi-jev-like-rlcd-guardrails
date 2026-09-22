import { describe, expect, it } from "vitest";
import {
  selectC8Calibration,
  verifyC8Calibration,
  type C8CalibrationInput,
} from "../src/guardrail-calibration.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../src/guardrail.js";

const pin = (character: string) => character.repeat(64);
const model = pin("a");
const binary = pin("b");

function input(): C8CalibrationInput {
  return {
    version: 1,
    purpose: "candidate8_train_calibration_only",
    modelSha256: model,
    nativeBinarySha256: binary,
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    baselineSha256: pin("c"),
    policySha256: pin("d"),
    baselineReceiptSha256: pin("8"),
    admissionSha256: pin("7"),
    fitSha256: pin("e"),
    calibrationCorpusSha256: pin("f"),
    fitGroups: ["fit-one", "fit-two"],
    cases: [
      { id: "safe", groupId: "cal-one", expected: "allow" },
      { id: "risky", groupId: "cal-one", expected: "confirm" },
      { id: "floor", groupId: "cal-two", expected: "block" },
    ],
    records: [
      {
        id: "safe",
        groupId: "cal-one",
        expected: "allow",
        baseline: "allow",
        gate: "prepared",
        modelAnswered: true,
        allowScore: 0.9,
        inputSha256: pin("1"),
        elapsedMs: 24,
      },
      {
        id: "risky",
        groupId: "cal-one",
        expected: "confirm",
        baseline: "allow",
        gate: "prepared",
        modelAnswered: true,
        allowScore: 0.55,
        inputSha256: pin("2"),
        elapsedMs: 25,
      },
      {
        id: "floor",
        groupId: "cal-two",
        expected: "block",
        baseline: "block",
        gate: "policy_floor",
        modelAnswered: false,
      },
    ],
  };
}

describe("TRAIN-only C8 cutoff selection", () => {
  it("selects the lowest buffered safe cutoff and binds identities", () => {
    const selected = selectC8Calibration(input());
    expect(selected.accepted).toBe(true);
    expect(selected.minimumAllowScore).toBeGreaterThan(0.55);
    expect(selected.minimumAllowScore).toBeLessThan(0.9);
    expect(selected.metrics).toMatchObject({
      selectedUnsafeAutomaticAllows: 0,
      selectedBenignInterruptions: 0,
      baselineBenignInterruptions: 0,
    });
    expect(verifyC8Calibration(selected, model, binary)).toEqual(selected);
    const changedPolicy = input();
    changedPolicy.policySha256 = pin("0");
    expect(selectC8Calibration(changedPolicy).scoringProtocolSha256).not.toBe(
      selected.scoringProtocolSha256,
    );
  });

  it("freezes a safety-safe threshold while reporting CAL benign excess for VALID selection", () => {
    const evidence = input();
    evidence.records[0].allowScore = 0.59;
    const selected = selectC8Calibration(evidence);
    expect(selected).toMatchObject({
      accepted: true,
      reason: "selected_with_cal_benign_excess",
      metrics: {
        selectedBenignInterruptions: 1,
        baselineBenignInterruptions: 0,
      },
    });
    expect(verifyC8Calibration(selected, model, binary)).toEqual(selected);
  });

  it("rejects a saturated risky score without a usable threshold", () => {
    const evidence = input();
    evidence.records[1].allowScore = 1;
    expect(selectC8Calibration(evidence)).toMatchObject({
      accepted: false,
      reason: "risk_score_saturated",
      minimumAllowScore: null,
    });
  });

  it("keeps an unverified sf-pi baseline out of cutoff acceptance", () => {
    const evidence = input();
    evidence.records[2].baseline = "unknown";
    expect(selectC8Calibration(evidence)).toMatchObject({
      accepted: false,
      reason: "baseline_unverified",
      minimumAllowScore: null,
      metrics: { baselineBenignInterruptions: null },
    });
  });

  it("rejects incomplete calls, leaked groups, changed gold and hard-block weakening", () => {
    const missing = input();
    missing.records[1].modelAnswered = false;
    expect(() => selectC8Calibration(missing)).toThrow(/every prepared/i);
    const leaked = input();
    leaked.fitGroups.push("cal-one");
    expect(() => selectC8Calibration(leaked)).toThrow(/fit-overlapping/i);
    const edited = input();
    edited.records[1].expected = "allow";
    expect(() => selectC8Calibration(edited)).toThrow(/incomplete/i);
    const weakened = input();
    weakened.records[2].baseline = "confirm";
    expect(() => selectC8Calibration(weakened)).toThrow(/fallback for safety/i);
  });

  it("rejects changed receipt cutoff, score, and model identity", () => {
    const selected = selectC8Calibration(input());
    const cutoffChanged = structuredClone(selected);
    cutoffChanged.minimumAllowScore = 0.5;
    expect(() => verifyC8Calibration(cutoffChanged, model, binary)).toThrow(
      /changed/,
    );
    const scoreChanged = structuredClone(selected);
    scoreChanged.input.records[1].allowScore = 0.1;
    expect(() => verifyC8Calibration(scoreChanged, model, binary)).toThrow(
      /changed/,
    );
    expect(() => verifyC8Calibration(selected, pin("9"), binary)).toThrow(
      /does not match/,
    );
  });
});
