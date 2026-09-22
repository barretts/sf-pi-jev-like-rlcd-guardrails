#!/usr/bin/env node
/** Candidate 8 TRAIN-CAL logits only. No host decisions or reserved splits. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Classifier, NativeBackend, configFromEnv } from "../dist/backend.js";
import { canonical } from "../dist/core.js";
import {
  classifyGuardrailRisk,
  guardrailRequest,
  validateGuardrailInput,
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { verifyArtifact, verifyTrainedArtifactExport } from "../dist/models.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const C8_CAL_ADMISSION_SHA256 =
  "c5203e21a9fdad729e6cddd166f923a671654b0968f89d330992f1ca6558f680";
export const C8_CAL_CORPUS_SHA256 =
  "7371877d67874e8d55c418b678d9d808207bb4e645d1868d4e44ad8d5d57144f";
export const C8_FIT_CORPUS_SHA256 =
  "17f6672fffe913aacdbf44394119bc0b14fbab5db4cc87fccf21c66da449cdc5";
const baseModel = "google/gemma-3-1b-it";
const hex64 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const fail = (message) => {
  throw new Error(`Candidate 8 TRAIN-CAL scorer: ${message}`);
};

async function regularBytes(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail("source must be a regular file");
  return readFile(path);
}
async function fileSha(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail("artifact must be a regular file");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function parseJsonl(bytes, split, expectedRows, expectedGroups) {
  const source = bytes.toString("utf8");
  if (
    !source.endsWith("\n") ||
    source.includes("\r") ||
    source.includes("\n\n")
  )
    fail(`${split} must be complete LF JSONL`);
  const rows = source
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    rows.length !== expectedRows ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    new Set(rows.map((row) => row.group_id)).size !== expectedGroups ||
    rows.some(
      (row) =>
        row.split !== split ||
        typeof row.id !== "string" ||
        !row.id ||
        typeof row.group_id !== "string" ||
        !row.group_id ||
        row.request?.model !== baseModel ||
        !["allow", "confirm"].includes(row.targets?.risk?.answer),
    )
  )
    fail(`${split} identity, partition, or labels changed`);
  return rows;
}

/** Reads only admitted FIT and TRAIN-CAL records, never VALID or TEST. */
export async function loadCandidate8Calibration({
  admissionFile,
  calibrationFile,
  fitFile,
}) {
  if (
    ![admissionFile, calibrationFile, fitFile].every(
      (path) => typeof path === "string" && isAbsolute(path),
    )
  )
    fail("absolute admission, TRAIN-CAL, and FIT paths are required");
  const [admissionBytes, calBytes, fitBytes] = await Promise.all([
    regularBytes(admissionFile),
    regularBytes(calibrationFile),
    regularBytes(fitFile),
  ]);
  if (
    sha(admissionBytes) !== C8_CAL_ADMISSION_SHA256 ||
    sha(calBytes) !== C8_CAL_CORPUS_SHA256 ||
    sha(fitBytes) !== C8_FIT_CORPUS_SHA256
  )
    fail("pinned admission, TRAIN-CAL, or FIT bytes changed");
  const admission = JSON.parse(admissionBytes);
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate8_fit_calibration_admission" ||
    admission.qualification !== false ||
    admission.trainingReady !== true ||
    admission.heldOutTestRead !== false ||
    admission.modelCalls !== 0 ||
    admission.source?.baseModel !== baseModel ||
    admission.source?.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    admission.calibration?.sha256 !== C8_CAL_CORPUS_SHA256 ||
    admission.calibration?.notPassedToFit !== true ||
    admission.calibration?.rows !== 47 ||
    admission.calibration?.groups !== 17 ||
    admission.fit?.sha256 !== C8_FIT_CORPUS_SHA256 ||
    admission.fit?.rows !== 226 ||
    admission.fit?.groups !== 77
  )
    fail("TRAIN-only admission contract changed");
  const calibration = parseJsonl(calBytes, "calibration", 47, 17);
  const fit = parseJsonl(fitBytes, "train", 226, 77);
  const fitGroups = [...new Set(fit.map((row) => row.group_id))].sort(order);
  if (calibration.some((row) => fitGroups.includes(row.group_id)))
    fail("TRAIN-CAL group overlaps FIT");
  let allow = 0,
    confirm = 0;
  for (const row of calibration) {
    const state = validateGuardrailInput(row.request?.state);
    if (
      canonical(state) !== canonical(row.request.state) ||
      canonical(row.request) !== canonical(guardrailRequest(state, baseModel))
    )
      fail("TRAIN-CAL request differs from the admitted direct Jev protocol");
    if (row.targets.risk.answer === "allow") allow++;
    else confirm++;
  }
  if (allow !== 24 || confirm !== 23) fail("TRAIN-CAL label balance changed");
  return {
    admissionSha256: C8_CAL_ADMISSION_SHA256,
    fitSha256: C8_FIT_CORPUS_SHA256,
    calibrationCorpusSha256: C8_CAL_CORPUS_SHA256,
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    fitGroups,
    rows: calibration.sort((a, b) => order(a.id, b.id)),
  };
}

/** A fake classifier can exercise this exact native scoring path without a model. */
export async function scoreCandidate8Calibration(
  source,
  {
    classifier,
    modelId,
    modelSha256,
    nativeBinarySha256,
    baselineSha256,
    policySha256,
    classify = classifyGuardrailRisk,
  },
) {
  if (
    !classifier ||
    typeof classifier.classify !== "function" ||
    !/^jev\/[A-Za-z0-9._-]+$/.test(modelId ?? "") ||
    ![
      modelSha256,
      nativeBinarySha256,
      baselineSha256,
      policySha256,
      source?.admissionSha256,
      source?.fitSha256,
      source?.calibrationCorpusSha256,
      source?.promptProtocolSha256,
    ].every(hex64) ||
    source.promptProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    !Array.isArray(source.rows) ||
    source.rows.length !== 47 ||
    !Array.isArray(source.fitGroups) ||
    source.fitGroups.length !== 77
  )
    fail("scoring identity or admitted TRAIN-CAL source is incomplete");
  const cases = source.rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    expected: row.targets.risk.answer,
  }));
  const records = [];
  for (const row of source.rows) {
    const input = validateGuardrailInput(row.request.state);
    const inputSha256 = sha(canonical(input));
    const started = performance.now();
    try {
      const prediction = await classify(classifier, input, modelId);
      if (
        prediction.inputSha256 !== inputSha256 ||
        !Number.isFinite(prediction.allowScore) ||
        prediction.allowScore < 0 ||
        prediction.allowScore > 1 ||
        prediction.calibration !== "uncalibrated"
      )
        fail("native prediction does not match the admitted input");
      records.push({
        id: row.id,
        groupId: row.group_id,
        expected: row.targets.risk.answer,
        gate: "prepared",
        modelAnswered: true,
        inputSha256,
        allowScore: prediction.allowScore,
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      records.push({
        id: row.id,
        groupId: row.group_id,
        expected: row.targets.risk.answer,
        gate: "prepared",
        modelAnswered: false,
        inputSha256,
        allowScore: null,
        elapsedMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const complete = records.every((row) => row.modelAnswered);
  return {
    version: 1,
    purpose: complete
      ? "candidate8_train_calibration_only"
      : "candidate8_train_calibration_attempt",
    modelSha256,
    nativeBinarySha256,
    promptProtocolSha256: source.promptProtocolSha256,
    baselineSha256,
    policySha256,
    fitSha256: source.fitSha256,
    calibrationCorpusSha256: source.calibrationCorpusSha256,
    admissionSha256: source.admissionSha256,
    fitGroups: source.fitGroups,
    cases,
    records,
  };
}

async function nativeScorer(values) {
  const required = [
    "admission",
    "model-file",
    "model-id",
    "registry",
    "artifact-manifest",
    "native-binary",
    "fit-plan",
    "baseline-sha256",
    "policy-sha256",
    "output",
  ];
  if (required.some((key) => !values[key]))
    fail(`required: ${required.map((key) => `--${key}`).join(" ")}`);
  for (const key of [
    "admission",
    "model-file",
    "registry",
    "artifact-manifest",
    "native-binary",
    "fit-plan",
    "output",
  ])
    if (!isAbsolute(values[key])) fail(`--${key} must be an absolute path`);
  if (!hex64(values["baseline-sha256"]) || !hex64(values["policy-sha256"]))
    fail("host baseline and policy SHA-256 pins are required");
  const source = await loadCandidate8Calibration({
    admissionFile: values.admission,
    calibrationFile: resolve(
      root,
      "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/calibration.jsonl",
    ),
    fitFile: resolve(
      root,
      "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/fit.jsonl",
    ),
  });
  const plan = JSON.parse(await regularBytes(values["fit-plan"]));
  if (
    plan.version !== 1 ||
    plan.purpose !== "candidate8_fit_only_rfdt" ||
    plan.qualification !== false ||
    plan.heldOutTestRead !== false ||
    plan.source?.code?.gitHead !== "af98a60101844f8994c764037e4c98edc19bf479" ||
    plan.source?.admissionSha256 !== source.admissionSha256 ||
    plan.source?.fit?.sha256 !== source.fitSha256 ||
    plan.source?.calibration?.sha256 !== source.calibrationCorpusSha256 ||
    plan.source?.promptProtocolSha256 !== source.promptProtocolSha256 ||
    plan.validationRowsPassedToTraining !== 0 ||
    plan.testRowsPassedToTraining !== 0 ||
    plan.selection !== "train_cal_cutoff_then_fresh_c8_VALID_only" ||
    ![256, 512].includes(plan.steps) ||
    canonical(plan.compilerLimits) !==
      canonical({
        maxModelLen: 2048,
        maxBatchSize: 32,
        maxBatchTokens: 2048,
      }) ||
    !basename(dirname(values["fit-plan"])).startsWith("candidate-8-rfdt-") ||
    basename(dirname(dirname(values["fit-plan"]))) !== "guardrail" ||
    basename(values["fit-plan"]) !== "candidate8-fit-plan.json"
  )
    fail("candidate model FIT plan does not match admitted TRAIN-only source");
  for (const name of [
    "dist/backend.js",
    "dist/core.js",
    "dist/guardrail.js",
    "dist/models.js",
  ]) {
    if (
      !hex64(plan.source.code.files?.[name]) ||
      (await fileSha(resolve(root, name))) !== plan.source.code.files[name]
    )
      fail(`scorer runtime differs from C8 FIT source: ${name}`);
  }
  const artifact = await verifyArtifact(
    values["model-file"],
    "classifier",
    values["model-id"],
    {
      registryPath: values.registry,
    },
  );
  const exported = await verifyTrainedArtifactExport(
    JSON.parse(await regularBytes(values["artifact-manifest"])),
  );
  if (
    artifact.base_model !== baseModel ||
    artifact.template_version !== "v2" ||
    exported.id !== artifact.id ||
    exported.sha256 !== artifact.sha256 ||
    exported.training_run !== artifact.training_run ||
    resolve(exported.file) !== resolve(artifact.file) ||
    resolve(dirname(values["artifact-manifest"])) !==
      resolve(dirname(values["fit-plan"]))
  )
    fail("model descriptor does not come from this C8 FIT run");
  const run = JSON.parse(
    await regularBytes(resolve(dirname(values["fit-plan"]), "manifest.json")),
  );
  if (
    run.status !== "exported" ||
    run.id !== artifact.training_run ||
    run.prepared?.branches?.train !== 226 ||
    run.prepared?.branches?.validation !== 0 ||
    run.prepared?.branches?.test !== 0 ||
    run.prepared?.dataset_sha256 !== source.fitSha256
  )
    fail("RFDT export includes non-FIT records or changed preparation");
  const nativeBinarySha256 = await fileSha(values["native-binary"]);
  if (nativeBinarySha256 !== plan.source?.code?.nativeSha256)
    fail("native scorer differs from the C8 FIT plan compiler");
  const config = configFromEnv({
    JEV_DEVICE: values.device ?? "metal",
    JEV_MODEL_ID: artifact.id,
    JEV_MODEL_FILE: artifact.file,
    JEV_TEMPLATE_VERSION: "v2",
  });
  config.artifactRegistryPath = values.registry;
  config.binary = values["native-binary"];
  config.maxModelLen = plan.compilerLimits?.maxModelLen;
  config.maxBatchSize = plan.compilerLimits?.maxBatchSize;
  config.maxBatchTokens = plan.compilerLimits?.maxBatchTokens;
  config.queueTimeoutMs = GUARDRAIL_LIMITS.deadlineMs;
  config.requestTimeoutMs = GUARDRAIL_LIMITS.deadlineMs;
  const backend = new NativeBackend(config);
  const classifier = new Classifier(config, backend);
  let result;
  const cold = performance.now();
  let coldInitializationMs;
  let runtimeError;
  try {
    try {
      await backend.warmup();
      coldInitializationMs = performance.now() - cold;
    } catch (error) {
      coldInitializationMs = performance.now() - cold;
      runtimeError = error instanceof Error ? error.message : String(error);
    }
    result = await scoreCandidate8Calibration(source, {
      classifier: runtimeError
        ? {
            classify: async () => {
              throw new Error(`native warmup failed: ${runtimeError}`);
            },
          }
        : classifier,
      modelId: artifact.id,
      modelSha256: artifact.sha256,
      nativeBinarySha256,
      baselineSha256: values["baseline-sha256"],
      policySha256: values["policy-sha256"],
    });
  } finally {
    try {
      await backend.dispose();
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
    }
  }
  if (runtimeError)
    result = {
      ...result,
      purpose: "candidate8_train_calibration_attempt",
      error: runtimeError,
    };
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      phase: "TRAIN-CAL scored",
      coldInitializationMs,
      answered: result.records.filter((row) => row.modelAnswered).length,
      rows: result.records.length,
      selectable: result.purpose === "candidate8_train_calibration_only",
    }),
  );
  if (result.purpose !== "candidate8_train_calibration_only")
    fail(
      "one or more TRAIN-CAL calls did not answer; non-selectable attempt saved",
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      admission: { type: "string" },
      "model-file": { type: "string" },
      "model-id": { type: "string" },
      registry: { type: "string" },
      "artifact-manifest": { type: "string" },
      "native-binary": { type: "string" },
      "fit-plan": { type: "string" },
      "baseline-sha256": { type: "string" },
      "policy-sha256": { type: "string" },
      output: { type: "string" },
      device: { type: "string" },
    },
  });
  await nativeScorer(values);
}
