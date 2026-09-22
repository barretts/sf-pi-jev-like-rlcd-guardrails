import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../src/guardrail.js";
import {
  selectC9Calibration,
  verifyC9Calibration,
  type C9CalibrationInput,
} from "../src/guardrail-c9-calibration.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pin = (digit: string) => digit.repeat(64);
const hostCommit = "a".repeat(40);

function input(
  safeScores: number[] = [0.9, 0.91],
  riskyScore = 0.1,
): C9CalibrationInput {
  const cases = [
    ...safeScores.map((_, i) => ({
      id: `safe-${i}`,
      groupId: `cal-${i}`,
      expected: "allow" as const,
      gate: "prepared" as const,
      inputSha256: sha(`safe-${i}`),
    })),
    {
      id: "risky",
      groupId: "cal-risky",
      expected: "confirm" as const,
      gate: "prepared" as const,
      inputSha256: sha("risky"),
    },
  ];
  const records = cases.map((item, i) => ({
    ...item,
    modelAnswered: true,
    modelCalls: 1,
    allowScore: i < safeScores.length ? safeScores[i] : riskyScore,
    elapsedMs: 25,
  }));
  const baselineReceiptJson = JSON.stringify({
    version: 1,
    purpose: "candidate9_train_cal_baseline_replay",
    baselineSha256: pin("b"),
    policySha256: pin("c"),
    calibrationCorpusSha256: pin("d"),
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    source: { hostCommit, scriptSha256: pin("e") },
    records: cases.map((item) => ({
      id: item.id,
      inputSha256: item.inputSha256,
      action: "allow",
      gate: "model_prepared",
    })),
  });
  const hostControlsReceiptJson = JSON.stringify({
    version: 1,
    purpose: "candidate9_host_controls",
    baselineSha256: pin("b"),
    policySha256: pin("c"),
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    source: { hostCommit, scriptSha256: pin("f"), c9SourceSha256: pin("1") },
    records: [
      {
        id: "floor-one",
        operationSha256: sha("floor-one"),
        baselineAction: "block",
        actualAction: "block",
        effectivePolicySha256: pin("c"),
        gate: "exact_policy_floor",
        modelCalls: 0,
      },
    ],
    counts: { rows: 1, unchanged: 1, modelCalls: 0 },
  });
  return {
    version: 1,
    purpose: "candidate9_train_calibration_only",
    arm: "B",
    modelSha256: pin("2"),
    nativeBinarySha256: pin("3"),
    artifactFormat: "q8_0",
    artifactManifestSha256: pin("a"),
    registrySha256: pin("b"),
    runManifestSha256: pin("f"),
    fitPlanSha256: pin("1"),
    quantizationManifestSha256: pin("c"),
    calScorerCliSha256: pin("d"),
    calScorerCoreSha256: pin("e"),
    coldInitializationMs: 100,
    coldInitializationBasis:
      "backend_warmup_after_source_and_artifact_verification",
    preScoreVerificationMs: 15,
    elapsedBasis:
      "direct_jev_risk_check_including_prompt_preparation_and_queue",
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    hostCommit,
    baselineSha256: pin("b"),
    policySha256: pin("c"),
    baselineReceiptSha256: sha(baselineReceiptJson),
    baselineReceiptJson,
    hostControlsReceiptSha256: sha(hostControlsReceiptJson),
    hostControlsReceiptJson,
    c9SourceSha256: pin("1"),
    admissionSha256: pin("4"),
    fitSha256: pin("5"),
    calibrationCorpusSha256: pin("d"),
    pairManifestSha256: pin("6"),
    familyManifestSha256: pin("7"),
    objectivePlanSha256: pin("8"),
    fitGroups: ["fit-a", "fit-b"],
    cases,
    records,
  };
}

function rebindBaseline(
  value: C9CalibrationInput,
  mutate: (receipt: any) => void,
) {
  const receipt = JSON.parse(value.baselineReceiptJson);
  mutate(receipt);
  value.baselineReceiptJson = JSON.stringify(receipt);
  value.baselineReceiptSha256 = sha(value.baselineReceiptJson);
}

function rebindControls(
  value: C9CalibrationInput,
  mutate: (receipt: any) => void,
) {
  const receipt = JSON.parse(value.hostControlsReceiptJson);
  mutate(receipt);
  value.hostControlsReceiptJson = JSON.stringify(receipt);
  value.hostControlsReceiptSha256 = sha(value.hostControlsReceiptJson);
}

describe("C9 TRAIN-CAL hard veto", () => {
  it("accepts only a same-host, complete, benign-parity threshold and binds the arm", () => {
    const evidence = input();
    const selected = selectC9Calibration(evidence);
    expect(selected).toMatchObject({
      accepted: true,
      reason: "selected",
      metrics: {
        selectedUnsafeAutomaticAllows: 0,
        selectedBenignInterruptions: 0,
        baselineBenignInterruptions: 0,
        floorDemotions: 0,
      },
    });
    expect(selected.minimumAllowScore).toBeGreaterThan(0.1);
    expect(selected.scoringProtocolSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyC9Calibration(selected, pin("2"), pin("3"))).toEqual(selected);
    const otherArm = input();
    otherArm.arm = "A";
    expect(selectC9Calibration(otherArm).scoringProtocolSha256).not.toBe(
      selected.scoringProtocolSha256,
    );
  });

  it("rejects C8's 14 benign interruptions against zero baseline before VALID", () => {
    const evidence = input(
      [...Array(14).fill(0.6), ...Array(10).fill(0.999)],
      0.995,
    );
    const selected = selectC9Calibration(evidence);
    expect(selected).toMatchObject({
      accepted: false,
      reason: "benign_excess",
      minimumAllowScore: null,
      scoringProtocolSha256: null,
      metrics: {
        selectedBenignInterruptions: 14,
        baselineBenignInterruptions: 0,
        selectedUnsafeAutomaticAllows: 0,
      },
    });
    expect(selected.diagnosticCutoff?.score).toBeGreaterThan(0.995);
  });

  it("rejects incomplete eligible calls and saturated risky scores", () => {
    const missing = input();
    missing.records[0].modelAnswered = false;
    missing.records[0].modelCalls = 1;
    missing.records[0].allowScore = null;
    missing.records[0].elapsedMs = null;
    expect(selectC9Calibration(missing)).toMatchObject({
      accepted: false,
      reason: "incomplete_model_calls",
      minimumAllowScore: null,
    });
    expect(selectC9Calibration(input([0.9], 1))).toMatchObject({
      accepted: false,
      reason: "risk_score_saturated",
    });
    const late = input();
    late.records[0].elapsedMs = 751;
    expect(selectC9Calibration(late)).toMatchObject({
      accepted: false,
      reason: "deadline_exceeded",
      metrics: { overDeadline: 1 },
    });
  });

  it("requires separate baseline bytes, same host and operation, with no CAL/FIT overlap", () => {
    const changed = input();
    changed.baselineReceiptJson += " ";
    expect(() => selectC9Calibration(changed)).toThrow(
      /baseline receipt bytes/,
    );
    const otherHost = input();
    rebindBaseline(otherHost, (receipt) => {
      receipt.source.hostCommit = "f".repeat(40);
    });
    expect(() => selectC9Calibration(otherHost)).toThrow(/same host/);
    const otherOperation = input();
    rebindBaseline(otherOperation, (receipt) => {
      receipt.records[0].inputSha256 = pin("0");
    });
    expect(() => selectC9Calibration(otherOperation)).toThrow(
      /changed CAL operation/,
    );
    const leaked = input();
    leaked.fitGroups.push(leaked.cases[0].groupId);
    expect(() => selectC9Calibration(leaked)).toThrow(/overlaps FIT/);
  });

  it("rejects floor demotion and model-call or gate spoofing", () => {
    const demoted = input();
    rebindControls(demoted, (receipt) => {
      receipt.records[0].actualAction = "allow";
      receipt.counts.unchanged = 0;
    });
    expect(selectC9Calibration(demoted)).toMatchObject({
      accepted: false,
      reason: "floor_weakened",
      metrics: { floorDemotions: 1 },
    });
    const called = input();
    rebindControls(called, (receipt) => {
      receipt.records[0].modelCalls = 1;
    });
    expect(() => selectC9Calibration(called)).toThrow(
      /floor control inventory/,
    );
    const spoof = input();
    spoof.records.at(-1)!.gate = "policy_floor";
    expect(() => selectC9Calibration(spoof)).toThrow(/route/);
  });

  it("recomputes changed scores, cutoff, and model pins on verification", () => {
    const selected = selectC9Calibration(input());
    const altered = structuredClone(selected);
    altered.minimumAllowScore = 0.1;
    expect(() => verifyC9Calibration(altered, pin("2"), pin("3"))).toThrow(
      /changed/,
    );
    const scoreChanged = structuredClone(selected);
    scoreChanged.input.records[0].allowScore = 0.2;
    expect(() => verifyC9Calibration(scoreChanged, pin("2"), pin("3"))).toThrow(
      /changed/,
    );
    expect(() => verifyC9Calibration(selected, pin("9"), pin("3"))).toThrow(
      /changed/,
    );
    const formatSwapped = structuredClone(selected);
    formatSwapped.input.artifactFormat = "f16" as "q8_0";
    expect(() =>
      verifyC9Calibration(formatSwapped, pin("2"), pin("3")),
    ).toThrow(/Invalid|changed/);
    const q8ManifestChanged = structuredClone(selected);
    q8ManifestChanged.input.quantizationManifestSha256 = pin("f");
    expect(() =>
      verifyC9Calibration(q8ManifestChanged, pin("2"), pin("3")),
    ).toThrow(/changed/);
  });
});
