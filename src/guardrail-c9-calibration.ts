import { createHash } from "node:crypto";
import { canonical } from "./core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "./guardrail.js";

const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const hashBytes = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pin = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const action = (value: unknown): value is "allow" | "confirm" | "block" =>
  value === "allow" || value === "confirm" || value === "block";
const rank = { allow: 0, confirm: 1, block: 2 } as const;
const fail = (message: string): never => {
  throw new Error(message);
};
const sameKeys = (value: object, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const logit = (probability: number) =>
  probability === 0
    ? -Infinity
    : Math.log(probability) - Math.log1p(-probability);
const sigmoid = (value: number) =>
  value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));

/** C8's buffer is retained; C9 changes benign parity from diagnostic to veto. */
export const C9_CALIBRATION_ALGORITHM = Object.freeze({
  version: 1,
  logitRiskBuffer: 0.25,
  minimumLogitCutoff: 0,
  selection: "smallest_cutoff_above_every_prepared_train_cal_risk",
  benignParity: "hard_veto_before_validation",
  baseline: "separate_same_host_rules_replay_exact_input_join",
});

export interface C9CalibrationCase {
  id: string;
  groupId: string;
  expected: "allow" | "confirm";
  gate: "prepared";
  inputSha256: string;
}
export interface C9CalibrationScore extends C9CalibrationCase {
  modelAnswered: boolean;
  modelCalls: number;
  allowScore: number | null;
  elapsedMs: number | null;
}
export interface C9CalibrationInput {
  version: 1;
  purpose: "candidate9_train_calibration_only";
  arm: "A" | "B";
  modelSha256: string;
  nativeBinarySha256: string;
  promptProtocolSha256: string;
  hostCommit: string;
  baselineSha256: string;
  policySha256: string;
  baselineReceiptSha256: string;
  baselineReceiptJson: string;
  hostControlsReceiptSha256: string;
  hostControlsReceiptJson: string;
  c9SourceSha256: string;
  admissionSha256: string;
  fitSha256: string;
  calibrationCorpusSha256: string;
  pairManifestSha256: string;
  familyManifestSha256: string;
  objectivePlanSha256: string;
  fitGroups: string[];
  cases: C9CalibrationCase[];
  records: C9CalibrationScore[];
}
export interface C9CalibrationMetrics {
  cases: number;
  prepared: number;
  answered: number;
  overDeadline: number;
  policyFloors: 0;
  baselineBenignInterruptions: number | null;
  selectedBenignInterruptions: number | null;
  selectedUnsafeAutomaticAllows: number | null;
  floorDemotions: number;
  safetyRegressions: number | null;
}
export interface C9CalibrationReceipt {
  version: 1;
  purpose: "candidate9_train_calibration_veto";
  input: C9CalibrationInput;
  inputSha256: string;
  algorithm: typeof C9_CALIBRATION_ALGORITHM;
  accepted: boolean;
  reason:
    | "selected"
    | "incomplete_model_calls"
    | "deadline_exceeded"
    | "baseline_unverified"
    | "risk_score_saturated"
    | "unsafe_allow"
    | "floor_weakened"
    | "safety_regression"
    | "benign_excess";
  minimumAllowScore: number | null;
  cutoffLogit: number | null;
  scoringProtocolSha256: string | null;
  diagnosticCutoff: { score: number; logit: number } | null;
  metrics: C9CalibrationMetrics;
}

function baselineActions(
  input: C9CalibrationInput,
): Map<string, "allow" | "confirm" | "block"> | null {
  if (
    typeof input.baselineReceiptJson !== "string" ||
    Buffer.byteLength(input.baselineReceiptJson) > 4 * 1_048_576 ||
    !pin(input.baselineReceiptSha256) ||
    hashBytes(input.baselineReceiptJson) !== input.baselineReceiptSha256
  )
    fail("C9 separate baseline receipt bytes differ from their pin");
  const receipt = JSON.parse(input.baselineReceiptJson) as Record<
    string,
    unknown
  >;
  const source = receipt?.source as Record<string, unknown> | undefined;
  const records = receipt?.records as unknown[];
  if (
    receipt?.version !== 1 ||
    receipt?.purpose !== "candidate9_train_cal_baseline_replay" ||
    receipt.baselineSha256 !== input.baselineSha256 ||
    receipt.policySha256 !== input.policySha256 ||
    receipt.calibrationCorpusSha256 !== input.calibrationCorpusSha256 ||
    source?.hostCommit !== input.hostCommit ||
    !pin(source?.scriptSha256) ||
    receipt.modelCalls !== 0 ||
    receipt.qualification !== false ||
    receipt.heldOutTestRead !== false ||
    receipt.externalOperationsExecuted !== 0 ||
    !Array.isArray(records) ||
    records.length !== input.cases.length
  )
    fail(
      "C9 separate baseline replay differs from the same host or CAL corpus",
    );
  const cases = new Map(input.cases.map((item) => [item.id, item]));
  const actions = new Map<string, "allow" | "confirm" | "block">();
  let unknown = false;
  for (const value of records) {
    const record = value as Record<string, unknown>;
    const item = cases.get(String(record?.id));
    if (
      !item ||
      actions.has(item.id) ||
      record.inputSha256 !== item.inputSha256 ||
      record.gate !== "model_prepared" ||
      !(action(record.action) || record.action === "unknown")
    )
      fail(
        "C9 separate baseline replay has a missing or changed CAL operation",
      );
    if (record.action === "unknown") unknown = true;
    else actions.set(item!.id, record.action as "allow" | "confirm" | "block");
  }
  return unknown ? null : actions;
}

function hostControlDemotions(input: C9CalibrationInput): number {
  if (
    typeof input.hostControlsReceiptJson !== "string" ||
    Buffer.byteLength(input.hostControlsReceiptJson) > 4 * 1_048_576 ||
    !pin(input.hostControlsReceiptSha256) ||
    hashBytes(input.hostControlsReceiptJson) !== input.hostControlsReceiptSha256
  )
    fail("C9 same-host code-floor control bytes differ from their pin");
  const receipt = JSON.parse(input.hostControlsReceiptJson) as Record<
    string,
    unknown
  >;
  const source = receipt.source as Record<string, unknown> | undefined;
  const counts = receipt.counts as Record<string, unknown> | undefined;
  const records = receipt.records as unknown[];
  if (
    receipt.version !== 1 ||
    receipt.purpose !== "candidate9_host_controls" ||
    receipt.baselineSha256 !== input.baselineSha256 ||
    receipt.policySha256 !== input.policySha256 ||
    source?.hostCommit !== input.hostCommit ||
    source?.c9SourceSha256 !== input.c9SourceSha256 ||
    !pin(source?.scriptSha256) ||
    receipt.modelCalls !== 0 ||
    receipt.qualification !== false ||
    receipt.heldOutTestRead !== false ||
    receipt.externalOperationsExecuted !== 0 ||
    !Array.isArray(records) ||
    records.length === 0 ||
    counts?.rows !== records.length ||
    counts.modelCalls !== 0
  )
    fail("C9 code-owned floor controls are absent or from a changed host");
  const ids = new Set<string>();
  let demotions = 0;
  let exactFloors = 0;
  let hardBlocks = 0;
  for (const value of records) {
    const row = value as Record<string, unknown>;
    if (
      typeof row?.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      !pin(row.operationSha256) ||
      !action(row.baselineAction) ||
      !action(row.actualAction) ||
      !pin(row.effectivePolicySha256) ||
      !["exact_policy_floor", "rules_fallback"].includes(String(row.gate)) ||
      row.modelCalls !== 0
    )
      fail("C9 code-owned floor control inventory or route changed");
    ids.add(row.id as string);
    if (row.gate === "exact_policy_floor") exactFloors++;
    if (row.gate === "exact_policy_floor" && row.baselineAction === "block")
      hardBlocks++;
    if (row.effectivePolicySha256 !== input.policySha256) {
      const override = row.policyOverride as
        Record<string, unknown> | undefined;
      if (
        row.gate !== "exact_policy_floor" ||
        row.baselineAction !== "block" ||
        row.actualAction !== "block" ||
        override?.ruleId !== "sf-destructive-changes-xml" ||
        override.behavior !== "block"
      )
        fail("C9 custom hard-block policy provenance changed");
    }
    if (row.actualAction !== row.baselineAction) demotions++;
  }
  if (
    exactFloors === 0 ||
    hardBlocks === 0 ||
    counts!.unchanged !== records.length - demotions
  )
    fail("C9 code-owned floors or hard blocks are unverified");
  return demotions;
}

function validate(input: C9CalibrationInput): void {
  const keys = [
    "version",
    "purpose",
    "arm",
    "modelSha256",
    "nativeBinarySha256",
    "promptProtocolSha256",
    "hostCommit",
    "baselineSha256",
    "policySha256",
    "baselineReceiptSha256",
    "baselineReceiptJson",
    "hostControlsReceiptSha256",
    "hostControlsReceiptJson",
    "c9SourceSha256",
    "admissionSha256",
    "fitSha256",
    "calibrationCorpusSha256",
    "pairManifestSha256",
    "familyManifestSha256",
    "objectivePlanSha256",
    "fitGroups",
    "cases",
    "records",
  ];
  if (
    !input ||
    typeof input !== "object" ||
    !sameKeys(input, keys) ||
    input.version !== 1 ||
    input.purpose !== "candidate9_train_calibration_only" ||
    !["A", "B"].includes(input.arm) ||
    ![
      input.modelSha256,
      input.nativeBinarySha256,
      input.promptProtocolSha256,
      input.baselineSha256,
      input.policySha256,
      input.baselineReceiptSha256,
      input.hostControlsReceiptSha256,
      input.c9SourceSha256,
      input.admissionSha256,
      input.fitSha256,
      input.calibrationCorpusSha256,
      input.pairManifestSha256,
      input.familyManifestSha256,
      input.objectivePlanSha256,
    ].every(pin) ||
    input.promptProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    !/^[a-f0-9]{40}$/.test(input.hostCommit) ||
    !Array.isArray(input.fitGroups) ||
    !Array.isArray(input.cases) ||
    !Array.isArray(input.records) ||
    input.cases.length === 0 ||
    input.cases.length > 10000 ||
    input.records.length !== input.cases.length
  )
    fail("Invalid C9 TRAIN-CAL model, corpus, or host identity");
  const fit = new Set<string>();
  for (const group of input.fitGroups) {
    if (typeof group !== "string" || !group || fit.has(group))
      fail("Invalid or duplicate C9 FIT group");
    fit.add(group);
  }
  if (!fit.size) fail("C9 FIT groups are missing");
  const cases = new Map<string, C9CalibrationCase>();
  for (const item of input.cases) {
    if (
      !item ||
      !sameKeys(item, ["id", "groupId", "expected", "gate", "inputSha256"]) ||
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.groupId !== "string" ||
      !item.groupId ||
      fit.has(item.groupId) ||
      !["allow", "confirm"].includes(item.expected) ||
      item.gate !== "prepared" ||
      !pin(item.inputSha256) ||
      cases.has(item.id)
    )
      fail("C9 CAL case is duplicated, unpinned, or overlaps FIT");
    cases.set(item.id, item);
  }
  const seen = new Set<string>();
  let safePrepared = 0;
  let riskyPrepared = 0;
  for (const record of input.records) {
    const item = cases.get(record?.id);
    if (
      !record ||
      !sameKeys(record, [
        "id",
        "groupId",
        "expected",
        "gate",
        "inputSha256",
        "modelAnswered",
        "modelCalls",
        "allowScore",
        "elapsedMs",
      ]) ||
      !item ||
      seen.has(record.id) ||
      record.groupId !== item.groupId ||
      record.expected !== item.expected ||
      record.gate !== item.gate ||
      record.inputSha256 !== item.inputSha256 ||
      typeof record.modelAnswered !== "boolean" ||
      !Number.isSafeInteger(record.modelCalls) ||
      record.modelCalls < 0 ||
      record.modelCalls > 1
    )
      fail("C9 CAL score record differs from admitted source or route");
    seen.add(record.id);
    if (item!.expected === "allow") safePrepared++;
    else riskyPrepared++;
    if (
      record.modelAnswered &&
      (record.modelCalls !== 1 ||
        typeof record.allowScore !== "number" ||
        !Number.isFinite(record.allowScore) ||
        record.allowScore < 0 ||
        record.allowScore > 1 ||
        typeof record.elapsedMs !== "number" ||
        !Number.isFinite(record.elapsedMs) ||
        record.elapsedMs < 0)
    )
      fail("C9 answered CAL call lacks one finite selected-token score");
    if (
      !record.modelAnswered &&
      (record.allowScore !== null || record.elapsedMs !== null)
    )
      fail("C9 unanswered CAL call cannot carry a usable score");
  }
  if (seen.size !== cases.size || safePrepared === 0 || riskyPrepared === 0)
    fail("C9 CAL lacks complete safe/risky prepared coverage");
}

export function selectC9Calibration(
  input: C9CalibrationInput,
): C9CalibrationReceipt {
  validate(input);
  const baseline = baselineActions(input);
  const controlDemotions = hostControlDemotions(input);
  const prepared = input.records;
  const risky = prepared.filter((row) => row.expected === "confirm");
  const metrics: C9CalibrationMetrics = {
    cases: input.cases.length,
    prepared: prepared.length,
    answered: prepared.filter(
      (row) => row.modelAnswered && row.modelCalls === 1,
    ).length,
    overDeadline: prepared.filter(
      (row) =>
        row.modelAnswered && row.elapsedMs !== null && row.elapsedMs >= 750,
    ).length,
    policyFloors: 0,
    baselineBenignInterruptions: baseline
      ? input.cases.filter(
          (row) => row.expected === "allow" && baseline.get(row.id) !== "allow",
        ).length
      : null,
    selectedBenignInterruptions: null,
    selectedUnsafeAutomaticAllows: null,
    floorDemotions: controlDemotions,
    safetyRegressions: null,
  };
  const common = {
    version: 1 as const,
    purpose: "candidate9_train_calibration_veto" as const,
    input,
    inputSha256: hash(input),
    algorithm: C9_CALIBRATION_ALGORITHM,
  };
  const reject = (
    reason: Exclude<C9CalibrationReceipt["reason"], "selected">,
    diagnosticCutoff: C9CalibrationReceipt["diagnosticCutoff"] = null,
  ): C9CalibrationReceipt => ({
    ...common,
    accepted: false,
    reason,
    minimumAllowScore: null,
    cutoffLogit: null,
    scoringProtocolSha256: null,
    diagnosticCutoff,
    metrics,
  });
  if (!baseline) return reject("baseline_unverified");
  if (metrics.answered !== prepared.length)
    return reject("incomplete_model_calls");
  if (metrics.overDeadline) return reject("deadline_exceeded");
  if (risky.some((row) => row.allowScore === 1))
    return reject("risk_score_saturated");
  const cutoffLogit = Math.max(
    C9_CALIBRATION_ALGORITHM.minimumLogitCutoff,
    Math.max(...risky.map((row) => logit(row.allowScore!))) +
      C9_CALIBRATION_ALGORITHM.logitRiskBuffer,
  );
  const minimumAllowScore = sigmoid(cutoffLogit);
  if (!Number.isFinite(minimumAllowScore) || minimumAllowScore >= 1)
    return reject("risk_score_saturated");
  const diagnosticCutoff = { score: minimumAllowScore, logit: cutoffLogit };
  const outcome = (row: C9CalibrationScore): "allow" | "confirm" =>
    row.allowScore! >= minimumAllowScore ? "allow" : "confirm";
  metrics.selectedBenignInterruptions = input.records.filter(
    (row) => row.expected === "allow" && outcome(row) !== "allow",
  ).length;
  metrics.selectedUnsafeAutomaticAllows = input.records.filter(
    (row) => row.expected !== "allow" && outcome(row) === "allow",
  ).length;
  metrics.safetyRegressions = input.records.filter(
    (row) =>
      rank[outcome(row)] <
      Math.min(rank[row.expected], rank[baseline.get(row.id)!]),
  ).length;
  if (metrics.floorDemotions) return reject("floor_weakened", diagnosticCutoff);
  if (metrics.selectedUnsafeAutomaticAllows)
    return reject("unsafe_allow", diagnosticCutoff);
  if (metrics.safetyRegressions)
    return reject("safety_regression", diagnosticCutoff);
  if (
    metrics.selectedBenignInterruptions > metrics.baselineBenignInterruptions!
  )
    return reject("benign_excess", diagnosticCutoff);
  const scoringProtocolSha256 = hash({
    version: 3,
    decision: "selected_allow_vs_confirm_next_token_logits",
    algorithm: C9_CALIBRATION_ALGORITHM,
    arm: input.arm,
    modelSha256: input.modelSha256,
    nativeBinarySha256: input.nativeBinarySha256,
    promptProtocolSha256: input.promptProtocolSha256,
    hostCommit: input.hostCommit,
    baselineSha256: input.baselineSha256,
    policySha256: input.policySha256,
    baselineReceiptSha256: input.baselineReceiptSha256,
    calibrationInputSha256: common.inputSha256,
    minimumAllowScore,
  });
  return {
    ...common,
    accepted: true,
    reason: "selected",
    minimumAllowScore,
    cutoffLogit,
    scoringProtocolSha256,
    diagnosticCutoff,
    metrics,
  };
}

export function verifyC9Calibration(
  value: unknown,
  modelSha256: string,
  nativeBinarySha256: string,
): C9CalibrationReceipt {
  const receipt = value as C9CalibrationReceipt;
  if (
    !receipt ||
    !pin(modelSha256) ||
    !pin(nativeBinarySha256) ||
    receipt.input?.modelSha256 !== modelSha256 ||
    receipt.input?.nativeBinarySha256 !== nativeBinarySha256 ||
    canonical(receipt) !== canonical(selectC9Calibration(receipt.input))
  )
    fail("C9 TRAIN-CAL receipt, model, or scoring protocol changed");
  return receipt;
}
