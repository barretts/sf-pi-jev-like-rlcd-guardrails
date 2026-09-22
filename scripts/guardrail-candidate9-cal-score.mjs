#!/usr/bin/env node
/** C9 TRAIN-CAL scorer core. It opens no corpus file. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonical } from "../dist/core.js";
import {
  classifyGuardrailRisk,
  guardrailRequest,
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
  validateGuardrailInput,
} from "../dist/guardrail.js";

const baseModel = "google/gemma-3-1b-it";
export const C9_CAL_SOURCE_PINS = Object.freeze({
  // Frozen after the independent TRAIN overlap acceptance and final admission.
  admissionSha256:
    "ce145449b951d67996a6d6d4348725e0513afd5db8910f479060216ece098131",
  overlapReceiptSha256:
    "0adf75b23578459ce5886c151c88f84b623d7382645605c006385b3eb09bada7",
  hostCommit: "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a",
  baselineSha256:
    "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421",
  policySha256:
    "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
  blindValidManifestSha256:
    "b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc",
  compilerLimits: Object.freeze({
    maxModelLen: 2048,
    maxBatchSize: 32,
    maxBatchTokens: 2048,
  }),
});
const hex64 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (message) => {
  throw new Error(`C9 TRAIN-CAL scorer: ${message}`);
};

/**
 * Validate caller-supplied, already SHA-pinned TRAIN-CAL rows. This core opens
 * no corpus, VALID, or TEST file; a final source seal must be wired in before
 * the executable runner can call it with a native model.
 */
export function prepareCandidate9CalibrationRows(rows, fitGroups) {
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    rows.length > 10_000 ||
    !Array.isArray(fitGroups) ||
    fitGroups.length === 0 ||
    fitGroups.some((group) => typeof group !== "string" || !group) ||
    new Set(fitGroups).size !== fitGroups.length ||
    canonical(fitGroups) !== canonical([...fitGroups].sort(order))
  )
    fail("missing or unordered admitted FIT/CAL inventory");
  const fit = new Set(fitGroups);
  const ids = new Set();
  const prepared = [];
  for (const row of rows) {
    if (
      !row ||
      row.split !== "calibration" ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      fit.has(row.group_id) ||
      row.request?.model !== baseModel ||
      !["allow", "confirm"].includes(row.targets?.risk?.answer)
    )
      fail("CAL case is duplicated, unlabelled, or overlaps FIT");
    const state = validateGuardrailInput(row.request.state);
    if (
      canonical(state) !== canonical(row.request.state) ||
      canonical(row.request) !== canonical(guardrailRequest(state, baseModel))
    )
      fail("CAL request differs from the admitted direct Jev protocol");
    ids.add(row.id);
    prepared.push({
      id: row.id,
      groupId: row.group_id,
      expected: row.targets.risk.answer,
      gate: "prepared",
      inputSha256: sha(canonical(state)),
      state,
    });
  }
  prepared.sort((a, b) => order(a.id, b.id));
  if (
    !prepared.some((row) => row.expected === "allow") ||
    !prepared.some((row) => row.expected === "confirm")
  )
    fail("CAL lacks both safe and risky prepared cases");
  return prepared;
}

/**
 * The output's successful shape matches the C9 selector exactly. Every row is
 * attempted once, including after a timeout; failed attempts remain visible
 * and cannot be selected. The 750 ms bound includes prompt preparation and
 * classifier queueing, but only VALID can measure the complete sf-pi host path.
 */
export async function scoreCandidate9Calibration(
  source,
  {
    classifier,
    modelId,
    modelSha256,
    nativeBinarySha256,
    classify = classifyGuardrailRisk,
    now = performance.now.bind(performance),
  },
) {
  const identity = source?.identity;
  if (
    !classifier ||
    typeof classifier.classify !== "function" ||
    !/^jev\/[A-Za-z0-9._-]+$/.test(modelId ?? "") ||
    !["A", "B"].includes(identity?.arm) ||
    !/^[a-f0-9]{40}$/.test(identity?.hostCommit ?? "") ||
    ![
      modelSha256,
      nativeBinarySha256,
      identity?.promptProtocolSha256,
      identity?.baselineSha256,
      identity?.policySha256,
      identity?.admissionSha256,
      identity?.fitSha256,
      identity?.calibrationCorpusSha256,
      identity?.pairManifestSha256,
      identity?.familyManifestSha256,
      identity?.objectivePlanSha256,
    ].every(hex64) ||
    identity.promptProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    typeof now !== "function"
  )
    fail("scoring identity or admitted source is incomplete");
  const prepared = prepareCandidate9CalibrationRows(
    source.rows,
    source.fitGroups,
  );
  const cases = prepared.map(
    ({ id, groupId, expected, gate, inputSha256 }) => ({
      id,
      groupId,
      expected,
      gate,
      inputSha256,
    }),
  );
  const records = [];
  const failures = [];
  for (const row of prepared) {
    const { id, groupId, expected, gate, inputSha256, state } = row;
    const started = now();
    try {
      const prediction = await classify(classifier, state, modelId);
      const elapsedMs = now() - started;
      if (
        prediction?.inputSha256 !== inputSha256 ||
        prediction.calibration !== "uncalibrated" ||
        !Number.isFinite(prediction.allowScore) ||
        prediction.allowScore < 0 ||
        prediction.allowScore > 1 ||
        !Number.isFinite(elapsedMs) ||
        elapsedMs < 0 ||
        elapsedMs >= GUARDRAIL_LIMITS.deadlineMs
      )
        fail("invalid, mismatched, or late selected-token prediction");
      records.push({
        id,
        groupId,
        expected,
        gate,
        inputSha256,
        modelAnswered: true,
        modelCalls: 1,
        allowScore: prediction.allowScore,
        elapsedMs,
      });
    } catch (error) {
      records.push({
        id,
        groupId,
        expected,
        gate,
        inputSha256,
        modelAnswered: false,
        modelCalls: 1,
        allowScore: null,
        elapsedMs: null,
      });
      failures.push({
        id,
        elapsedMs: now() - started,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const complete = failures.length === 0;
  return {
    version: 1,
    purpose: complete
      ? "candidate9_train_calibration_only"
      : "candidate9_train_calibration_attempt",
    arm: identity.arm,
    modelSha256,
    nativeBinarySha256,
    promptProtocolSha256: identity.promptProtocolSha256,
    hostCommit: identity.hostCommit,
    baselineSha256: identity.baselineSha256,
    policySha256: identity.policySha256,
    admissionSha256: identity.admissionSha256,
    fitSha256: identity.fitSha256,
    calibrationCorpusSha256: identity.calibrationCorpusSha256,
    pairManifestSha256: identity.pairManifestSha256,
    familyManifestSha256: identity.familyManifestSha256,
    objectivePlanSha256: identity.objectivePlanSha256,
    fitGroups: source.fitGroups,
    cases,
    records,
    ...(complete ? {} : { failures }),
  };
}
