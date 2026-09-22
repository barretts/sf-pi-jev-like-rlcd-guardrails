#!/usr/bin/env node
/** Freeze a prepared TRAIN/VALID guardrail run before any optimizer or model call. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import {
  GUARDRAIL_CRITERIA,
  GUARDRAIL_CRITERIA_SHA256,
} from "../dist/guardrail-evaluation.js";
import { GEMMA_TRAINING_REVISION } from "../dist/models.js";

const BASE_MODEL = "google/gemma-3-1b-it";
const BASE_WEIGHTS_SHA256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(`Guardrail prospective plan: ${message}`);
};
const withinRun = (path, run, name) => {
  if (resolve(path ?? "") !== resolve(run, name))
    fail(`${name} is not in the prepared run`);
};
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const regular = async (path) => {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail("a prepared input is not a regular file");
  return entry;
};
const readLines = (bytes, name) => {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) fail(`${name} is not a complete JSONL file`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => !line)) fail(`${name} contains a blank row`);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    fail(`${name} contains invalid JSON`);
  }
};

export async function prepareGuardrailProspectivePlan(
  runDirectory,
  bundleFile,
) {
  if (!runDirectory || !bundleFile) fail("--run and --bundle are required");
  const run = resolve(runDirectory);
  const bundlePath = resolve(bundleFile);
  const planPath = resolve(run, "guardrail-plan.json");
  const authoredPath = resolve(run, "authored-train-validation.jsonl");
  const output = resolve(run, "prospective-plan.json");

  const runEntry = await lstat(run);
  if (!runEntry.isDirectory() || runEntry.isSymbolicLink())
    fail("run is not a physical directory");
  await Promise.all(
    [planPath, bundlePath, authoredPath, resolve(run, "manifest.json")].map(
      regular,
    ),
  );

  const [planBytes, bundleBytes, authoredBytes, manifest] = await Promise.all([
    readFile(planPath),
    readFile(bundlePath),
    readFile(authoredPath),
    readJson(resolve(run, "manifest.json")),
  ]);
  const plan = JSON.parse(planBytes);
  if (plan.version !== 1 || plan.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256)
    fail("training plan protocol differs from the current scorer");
  if (
    GUARDRAIL_LIMITS.deadlineMs !== 750 ||
    GUARDRAIL_LIMITS.minimumAllowScore !== 0.99 ||
    GUARDRAIL_CRITERIA.deadlineMs !== 750 ||
    GUARDRAIL_CRITERIA.warmP95MaxMs !== 500 ||
    GUARDRAIL_CRITERIA.idealWarmP95BelowMs !== 500 ||
    GUARDRAIL_CRITERIA.completeModelExecution !== "all_eligible_no_errors" ||
    GUARDRAIL_CRITERIA.executionSurface !== "sf_guardrail_bridge"
  )
    fail("current 750 ms call deadline or 500 ms warm p95 gate changed");
  if (
    plan.testPassedToTraining !== false ||
    plan.forbiddenFallbacks !== true ||
    plan.selection !==
      "Validation only; all guardrail gates must pass before a frozen held-out test" ||
    !Number.isSafeInteger(plan.steps) ||
    plan.steps < 1 ||
    plan.steps > 100000
  )
    fail("training plan does not enforce validation-only selection");
  if (
    !isAbsolute(plan.checkpoint ?? "") ||
    !plan.checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${GEMMA_TRAINING_REVISION}`,
    ) ||
    plan.weights?.sha256 !== BASE_WEIGHTS_SHA256 ||
    plan.baseFiles?.["model.safetensors"]?.sha256 !== BASE_WEIGHTS_SHA256 ||
    !plan.baseFiles?.["config.json"] ||
    !plan.baseFiles?.["tokenizer.json"]
  )
    fail("training plan does not pin the original Google Gemma 3 1B base");
  if (plan.bundleSha256 !== hash(bundleBytes))
    fail("source bundle changed since training preparation");

  if (
    resolve(plan.admission?.bundle ?? "") !== bundlePath ||
    typeof plan.admission?.receipt !== "string" ||
    !isAbsolute(plan.admission.receipt)
  )
    fail("training plan does not bind the admitted bundle and receipt paths");
  await regular(plan.admission.receipt);
  const receiptBytes = await readFile(plan.admission.receipt);
  const receipt = JSON.parse(receiptBytes);
  if (
    hash(receiptBytes) !== plan.admissionReceiptSha256 ||
    receipt.outputSha256 !== plan.bundleSha256 ||
    receipt.trainingReady !== true ||
    receipt.testRows !== 0 ||
    receipt.modelCalls !== 0 ||
    receipt.externalOperationsExecuted !== 0 ||
    receipt.reservedLabelsRead !== false ||
    receipt.reservedContentEmitted !== false
  )
    fail("candidate-5 admission receipt changed or crossed the TEST boundary");

  const bundle = JSON.parse(bundleBytes);
  if (
    bundle.version !== 1 ||
    bundle.mockedExecution !== true ||
    bundle.trainingReady !== true ||
    bundle.diagnosticOnly === true ||
    !Array.isArray(bundle.records) ||
    !bundle.records.length ||
    plan.corpusSha256 !== bundle.corpusSha256 ||
    plan.baselineSourceSha256 !== bundle.baselineSourceSha256 ||
    hash(JSON.stringify(bundle.sourceSha256)) !== bundle.corpusSha256 ||
    JSON.stringify(receipt.source) !== JSON.stringify(bundle.sourceSha256) ||
    receipt.trainRows !==
      bundle.records.filter((row) => row.split === "train").length ||
    receipt.validationRows !==
      bundle.records.filter((row) => row.split === "validation").length ||
    plan.sfPiCommit !== receipt.source.sfPiCommit
  )
    fail("source bundle is not the admitted TRAIN/VALID bundle");
  if (
    manifest.version !== 1 ||
    manifest.status !== "prepared" ||
    manifest.training !== undefined ||
    manifest.evaluation !== undefined ||
    manifest.exports !== undefined ||
    resolve(manifest.directory ?? "") !== run ||
    manifest.base_model !== BASE_MODEL ||
    manifest.base_revision !== GEMMA_TRAINING_REVISION ||
    manifest.template_version !== "v2"
  )
    fail("run is not an untrained original Google Gemma 3 1B preparation");
  withinRun(manifest.source?.file, run, "authored-train-validation.jsonl");
  withinRun(manifest.prepared?.dataset_file, run, "dataset.jsonl");
  for (const split of ["train", "validation", "test"])
    withinRun(manifest.prepared?.files?.[split], run, `${split}.jsonl`);

  await Promise.all(
    ["dataset.jsonl", "train.jsonl", "validation.jsonl", "test.jsonl"].map(
      (name) => regular(resolve(run, name)),
    ),
  );

  const [datasetBytes, trainBytes, validationBytes, testStat] =
    await Promise.all([
      readFile(resolve(run, "dataset.jsonl")),
      readFile(resolve(run, "train.jsonl")),
      readFile(resolve(run, "validation.jsonl")),
      lstat(resolve(run, "test.jsonl")),
    ]);
  if (
    testStat.size !== 0 ||
    manifest.prepared.branches?.test !== 0 ||
    manifest.source.sha256 !== hash(authoredBytes) ||
    manifest.prepared.dataset_sha256 !== hash(datasetBytes) ||
    !datasetBytes.equals(authoredBytes) ||
    manifest.prepared.sha256 !==
      hash(`train\n${trainBytes}validation\n${validationBytes}test\n`)
  )
    fail("prepared dataset or split identity changed, or TEST is nonempty");

  const authored = readLines(authoredBytes, "authored TRAIN/VALID");
  const dataset = readLines(datasetBytes, "prepared dataset");
  const train = readLines(trainBytes, "prepared TRAIN");
  const validation = readLines(validationBytes, "prepared VALIDATION");
  const counts = { train: 0, validation: 0 };
  const sourceIds = new Set();
  const groupSplits = new Map();
  if (
    authored.length !== bundle.records.length ||
    authored.length !== manifest.source.examples
  )
    fail("source bundle and authored row counts disagree");
  for (let i = 0; i < authored.length; i++) {
    const source = bundle.records[i];
    if (
      source?.modelEligible !== true ||
      !["train", "validation"].includes(source.split) ||
      !["allow", "confirm"].includes(source.expected) ||
      typeof source.id !== "string" ||
      !source.id ||
      sourceIds.has(source.id) ||
      typeof source.groupId !== "string" ||
      !source.groupId ||
      (groupSplits.has(source.groupId) &&
        groupSplits.get(source.groupId) !== source.split)
    )
      fail("source bundle contains an ineligible or non-TRAIN/VALID row");
    sourceIds.add(source.id);
    groupSplits.set(source.groupId, source.split);
    const expected = JSON.parse(
      JSON.stringify({
        id: source.id,
        group_id: source.groupId,
        split: source.split,
        request: guardrailRequest(source.riskInput, BASE_MODEL),
        targets: {
          risk: { answer: source.expected },
        },
        target_provenance: { risk: { source: "supplied" } },
      }),
    );
    try {
      assert.deepStrictEqual(authored[i], expected);
      assert.deepStrictEqual(dataset[i], expected);
    } catch {
      fail("authored TRAIN/VALID row differs from its source bundle");
    }
    counts[source.split]++;
  }
  for (const [split, branches] of [
    ["train", train],
    ["validation", validation],
  ]) {
    const sourceRows = bundle.records.filter((row) => row.split === split);
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];
      const source = sourceRows[i];
      if (
        branch.source_id !== source.id ||
        branch.group_id !== source.groupId ||
        branch.split !== split ||
        branch.question_id !== "risk" ||
        branch.question_type !== "choice" ||
        branch.template_version !== "v2" ||
        JSON.stringify(branch.output_labels) !== JSON.stringify(["A", "B"]) ||
        JSON.stringify(branch.answer_labels) !==
          JSON.stringify(["allow", "confirm"]) ||
        JSON.stringify(branch.target_probabilities) !==
          JSON.stringify(source.expected === "allow" ? [1, 0] : [0, 1]) ||
        JSON.stringify(branch.target_provenance) !==
          JSON.stringify({ risk: { source: "supplied" } })
      )
        fail("prepared branch differs from authored TRAIN/VALID target");
    }
  }
  if (
    counts.train < 1 ||
    counts.validation < 1 ||
    train.length !== counts.train ||
    validation.length !== counts.validation ||
    manifest.prepared.branches?.train !== counts.train ||
    manifest.prepared.branches?.validation !== counts.validation
  )
    fail("prepared TRAIN/VALID branch counts disagree with source rows");

  const prospective = {
    version: 1,
    purpose: "guardrail_training_prospective_plan",
    createdAt: new Date().toISOString(),
    run,
    trainingPlanSha256: hash(planBytes),
    bundleFile: bundlePath,
    bundleSha256: hash(bundleBytes),
    admissionReceiptSha256: hash(receiptBytes),
    corpusSha256: bundle.corpusSha256,
    baselineSourceSha256: bundle.baselineSourceSha256,
    protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    criteriaSha256: GUARDRAIL_CRITERIA_SHA256,
    authoredTrainValidationSha256: hash(authoredBytes),
    preparedDatasetSha256: hash(datasetBytes),
    preparedSha256: manifest.prepared.sha256,
    trainSha256: hash(trainBytes),
    validationSha256: hash(validationBytes),
    emptyTestSha256: hash(Buffer.alloc(0)),
    trainRows: counts.train,
    validationRows: counts.validation,
    testRowsPassedToTraining: 0,
    noTeacher: true,
    noForbiddenFallback: true,
    testNotPassedToTraining: true,
    modelCallsBeforeFreeze: 0,
    testEvaluationsBeforeFreeze: 0,
    allowCutoff: GUARDRAIL_LIMITS.minimumAllowScore,
    criteria: GUARDRAIL_CRITERIA,
    steps: plan.steps,
    selection: "validation_only",
    qualification: false,
  };
  await writeFile(output, JSON.stringify(prospective, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return { path: output, sha256: hash(await readFile(output)), ...counts };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { run: { type: "string" }, bundle: { type: "string" } },
  });
  console.log(
    JSON.stringify(
      await prepareGuardrailProspectivePlan(values.run, values.bundle),
    ),
  );
}
