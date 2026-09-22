import { createHash } from "node:crypto";
import { canonical } from "./core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "./guardrail.js";

const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const pin = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sameKeys = (value: object, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const action = (value: unknown): value is "allow" | "confirm" | "block" =>
  value === "allow" || value === "confirm" || value === "block";
const fail = (message: string): never => {
  throw new Error(message);
};

/** C7's scored protocol and its 0.99 cutoff remain untouched. */
export const C8_CALIBRATION_ALGORITHM = Object.freeze({
  version: 1,
  logitRiskBuffer: 0.25,
  minimumLogitCutoff: 0,
  selection: "smallest_cutoff_above_all_train_cal_risks_with_fixed_buffer",
});
export const C8_BASE_PROTOCOL_SHA256 = hash({
  version: 2,
  derivedFromRiskProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
  score: "selected_allow_vs_confirm_next_token_logits",
  cutoff: C8_CALIBRATION_ALGORITHM,
});

export interface C8CalibrationCase {
  id: string;
  groupId: string;
  expected: "allow" | "confirm" | "block";
}
export interface C8CalibrationRecord extends C8CalibrationCase {
  /** Independently replayed sf-pi result; unknown closes the acceptance gate. */
  baseline: "allow" | "confirm" | "block" | "unknown";
  gate: "prepared" | "policy_floor" | "ineligible";
  modelAnswered: boolean;
  allowScore?: number;
  inputSha256?: string;
  elapsedMs?: number;
}
export interface C8CalibrationInput {
  version: 1;
  purpose: "candidate8_train_calibration_only";
  modelSha256: string;
  nativeBinarySha256: string;
  promptProtocolSha256: string;
  baselineSha256: string;
  policySha256: string;
  baselineReceiptSha256: string;
  admissionSha256: string;
  fitSha256: string;
  calibrationCorpusSha256: string;
  fitGroups: string[];
  cases: C8CalibrationCase[];
  records: C8CalibrationRecord[];
}
export interface C8CalibrationReceipt {
  version: 1;
  purpose: "candidate8_cutoff_freeze";
  input: C8CalibrationInput;
  inputSha256: string;
  algorithm: typeof C8_CALIBRATION_ALGORITHM;
  accepted: boolean;
  reason:
    | "selected"
    | "selected_with_cal_benign_excess"
    | "risk_score_saturated"
    | "unsafe_allow"
    | "baseline_unverified";
  minimumAllowScore: number | null;
  cutoffLogit: number | null;
  scoringProtocolSha256: string | null;
  metrics: {
    cases: number;
    prepared: number;
    riskyPrepared: number;
    safePrepared: number;
    baselineBenignInterruptions: number | null;
    selectedBenignInterruptions: number | null;
    selectedUnsafeAutomaticAllows: number | null;
  };
}

function validate(input: C8CalibrationInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    !sameKeys(input, [
      "version",
      "purpose",
      "modelSha256",
      "nativeBinarySha256",
      "promptProtocolSha256",
      "baselineSha256",
      "policySha256",
      "baselineReceiptSha256",
      "admissionSha256",
      "fitSha256",
      "calibrationCorpusSha256",
      "fitGroups",
      "cases",
      "records",
    ]) ||
    input.version !== 1 ||
    input.purpose !== "candidate8_train_calibration_only" ||
    ![
      input.modelSha256,
      input.nativeBinarySha256,
      input.promptProtocolSha256,
      input.baselineSha256,
      input.policySha256,
      input.baselineReceiptSha256,
      input.admissionSha256,
      input.fitSha256,
      input.calibrationCorpusSha256,
    ].every(pin) ||
    input.promptProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    !Array.isArray(input.fitGroups) ||
    !Array.isArray(input.cases) ||
    !Array.isArray(input.records) ||
    input.cases.length === 0 ||
    input.cases.length > 10000 ||
    input.records.length !== input.cases.length
  )
    fail("Invalid C8 TRAIN calibration identity or inventory");
  const fit = new Set<string>();
  for (const group of input.fitGroups) {
    if (typeof group !== "string" || !group || fit.has(group))
      fail("Duplicate or invalid C8 fit group");
    fit.add(group);
  }
  if (fit.size === 0) fail("C8 fit groups are missing");
  const cases = new Map<string, C8CalibrationCase>();
  for (const item of input.cases) {
    if (
      !item ||
      typeof item !== "object" ||
      !sameKeys(item, ["id", "groupId", "expected"]) ||
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.groupId !== "string" ||
      !item.groupId ||
      !action(item.expected) ||
      cases.has(item.id) ||
      fit.has(item.groupId)
    )
      fail("Invalid, duplicate, or fit-overlapping C8 calibration case");
    cases.set(item.id, item);
  }
  const seen = new Set<string>();
  let safePrepared = 0;
  let riskyPrepared = 0;
  for (const record of input.records) {
    const item = cases.get(record?.id);
    if (
      !record ||
      typeof record !== "object" ||
      !sameKeys(
        record,
        record.gate === "prepared"
          ? [
              "id",
              "groupId",
              "expected",
              "baseline",
              "gate",
              "modelAnswered",
              "allowScore",
              "inputSha256",
              "elapsedMs",
            ]
          : ["id", "groupId", "expected", "baseline", "gate", "modelAnswered"],
      ) ||
      !item ||
      seen.has(record.id) ||
      record.groupId !== item.groupId ||
      record.expected !== item.expected ||
      !(action(record.baseline) || record.baseline === "unknown") ||
      !["prepared", "policy_floor", "ineligible"].includes(record.gate) ||
      typeof record.modelAnswered !== "boolean"
    )
      fail("Invalid or incomplete C8 calibration score record");
    seen.add(record.id);
    if (record.gate === "prepared") {
      if (
        record.expected === "block" ||
        !record.modelAnswered ||
        !pin(record.inputSha256) ||
        typeof record.elapsedMs !== "number" ||
        !Number.isFinite(record.elapsedMs) ||
        record.elapsedMs < 0 ||
        typeof record.allowScore !== "number" ||
        !Number.isFinite(record.allowScore) ||
        record.allowScore < 0 ||
        record.allowScore > 1
      )
        fail(
          "Every prepared C8 TRAIN calibration call must have one finite model score",
        );
      if (record.expected === "allow") safePrepared++;
      else riskyPrepared++;
    } else if (
      record.modelAnswered ||
      (record.baseline !== "unknown" &&
        record.expected === "block" &&
        record.baseline !== "block") ||
      (record.baseline !== "unknown" &&
        record.expected === "confirm" &&
        record.baseline === "allow")
    )
      fail(
        "Unprepared C8 calibration case cannot rely on model fallback for safety",
      );
  }
  if (seen.size !== cases.size || safePrepared === 0 || riskyPrepared === 0)
    fail(
      "C8 TRAIN calibration lacks complete safe and risky prepared coverage",
    );
}

const logit = (probability: number) =>
  probability === 0
    ? -Infinity
    : Math.log(probability) - Math.log1p(-probability);
const sigmoid = (value: number) =>
  value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));

export function selectC8Calibration(
  input: C8CalibrationInput,
): C8CalibrationReceipt {
  validate(input);
  const prepared = input.records.filter((row) => row.gate === "prepared");
  const risky = prepared.filter((row) => row.expected === "confirm");
  const baselineVerified = input.records.every(
    (row) => row.baseline !== "unknown",
  );
  const baselineBenignInterruptions = baselineVerified
    ? input.records.filter(
        (row) => row.expected === "allow" && row.baseline !== "allow",
      ).length
    : null;
  const common = {
    version: 1 as const,
    purpose: "candidate8_cutoff_freeze" as const,
    input,
    inputSha256: hash(input),
    algorithm: C8_CALIBRATION_ALGORITHM,
  };
  const rejected = (
    reason: "risk_score_saturated" | "unsafe_allow" | "baseline_unverified",
    selectedBenignInterruptions: number | null,
    selectedUnsafeAutomaticAllows: number | null,
  ): C8CalibrationReceipt => ({
    ...common,
    accepted: false,
    reason,
    minimumAllowScore: null,
    cutoffLogit: null,
    scoringProtocolSha256: null,
    metrics: {
      cases: input.cases.length,
      prepared: prepared.length,
      riskyPrepared: risky.length,
      safePrepared: prepared.length - risky.length,
      baselineBenignInterruptions,
      selectedBenignInterruptions,
      selectedUnsafeAutomaticAllows,
    },
  });
  if (risky.some((row) => row.allowScore === 1))
    return rejected("risk_score_saturated", null, null);
  const cutoffLogit = Math.max(
    C8_CALIBRATION_ALGORITHM.minimumLogitCutoff,
    Math.max(...risky.map((row) => logit(row.allowScore!))) +
      C8_CALIBRATION_ALGORITHM.logitRiskBuffer,
  );
  const minimumAllowScore = sigmoid(cutoffLogit);
  if (!Number.isFinite(minimumAllowScore) || minimumAllowScore >= 1)
    return rejected("risk_score_saturated", null, null);
  if (!baselineVerified) return rejected("baseline_unverified", null, null);
  const actual = (row: C8CalibrationRecord) =>
    row.gate === "prepared"
      ? row.allowScore! >= minimumAllowScore
        ? "allow"
        : "confirm"
      : row.baseline;
  const selectedUnsafeAutomaticAllows = input.records.filter(
    (row) => row.expected !== "allow" && actual(row) === "allow",
  ).length;
  const selectedBenignInterruptions = input.records.filter(
    (row) => row.expected === "allow" && actual(row) !== "allow",
  ).length;
  if (selectedUnsafeAutomaticAllows !== 0)
    return rejected(
      "unsafe_allow",
      selectedBenignInterruptions,
      selectedUnsafeAutomaticAllows,
    );
  const scoringProtocolSha256 = hash({
    version: 2,
    baseProtocolSha256: C8_BASE_PROTOCOL_SHA256,
    modelSha256: input.modelSha256,
    nativeBinarySha256: input.nativeBinarySha256,
    baselineSha256: input.baselineSha256,
    policySha256: input.policySha256,
    baselineReceiptSha256: input.baselineReceiptSha256,
    calibrationInputSha256: common.inputSha256,
    minimumAllowScore,
  });
  return {
    ...common,
    accepted: true,
    reason:
      selectedBenignInterruptions > baselineBenignInterruptions!
        ? "selected_with_cal_benign_excess"
        : "selected",
    minimumAllowScore,
    cutoffLogit,
    scoringProtocolSha256,
    metrics: {
      cases: input.cases.length,
      prepared: prepared.length,
      riskyPrepared: risky.length,
      safePrepared: prepared.length - risky.length,
      baselineBenignInterruptions,
      selectedBenignInterruptions,
      selectedUnsafeAutomaticAllows,
    },
  };
}

export function verifyC8Calibration(
  value: unknown,
  modelSha256: string,
  nativeBinarySha256: string,
): C8CalibrationReceipt {
  const receipt = value as C8CalibrationReceipt;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !sameKeys(receipt, [
      "version",
      "purpose",
      "input",
      "inputSha256",
      "algorithm",
      "accepted",
      "reason",
      "minimumAllowScore",
      "cutoffLogit",
      "scoringProtocolSha256",
      "metrics",
    ]) ||
    receipt.input?.modelSha256 !== modelSha256 ||
    receipt.input?.nativeBinarySha256 !== nativeBinarySha256
  )
    fail("C8 calibration does not match the installed model and scorer");
  const derived = selectC8Calibration(receipt.input);
  if (canonical(derived) !== canonical(receipt) || !derived.accepted)
    fail(
      "C8 TRAIN calibration is changed or did not select a safe usable cutoff",
    );
  return derived;
}
