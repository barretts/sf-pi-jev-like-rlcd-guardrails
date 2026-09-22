#!/usr/bin/env node
/** Source-pinned, TRAIN-only Candidate 6 RFDT research lane. Never selects on TEST. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configFromEnv } from "../dist/backend.js";
import {
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { GUARDRAIL_CRITERIA_SHA256 } from "../dist/guardrail-evaluation.js";
import { hashArtifact, verifyTrainedArtifactExport } from "../dist/models.js";
import {
  exportRfdt,
  prepareRfdt,
  RFDT_BASE_MODEL,
  RFDT_BASE_REVISION,
  trainRfdt,
} from "../dist/rfdt.js";
import { validateResearchRows } from "./guardrail-candidate6-research-merge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const rubricFile = resolve(root, "fixtures/guardrail/RUBRIC.md");
const validFile = resolve(root, "blind-c6-20260922/c6-valid-v4.json");
const validManifestFile = resolve(
  root,
  "blind-c6-20260922/c6-valid-v4.manifest.json",
);
const testFile = resolve(root, "blind-c6-20260922/c6-test-v3.json");
const testManifestFile = resolve(
  root,
  "blind-c6-20260922/c6-test-v3.manifest.json",
);
const baseWeightsSha256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new Error(`Candidate 6 training: ${message}`);
};
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    controller.abort(new Error(`Candidate 6 training cancelled (${signal})`)),
  );
const inDirectory = (file, directory) => {
  const rel = relative(directory, file);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFile(file) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${file} is not a regular file`);
  return entry;
}

function parseJsonl(bytes, name) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r"))
    fail(`${name} must be complete LF-terminated JSONL`);
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.some((line) => !line))
    fail(`${name} contains a blank row`);
  return lines.map((line) => JSON.parse(line));
}

/** Exact subset matching prevents a label receipt from silently rewriting inputs. */
export function selectAdmittedTrainRows(sourceRows, admittedRows, cases) {
  if (
    !Array.isArray(sourceRows) ||
    sourceRows.length !== 186 ||
    !Array.isArray(admittedRows) ||
    admittedRows.length < 1 ||
    !Array.isArray(cases) ||
    cases.length !== sourceRows.length
  )
    fail("admission must account for all 186 source TRAIN rows");
  validateResearchRows(sourceRows, ["train"]);
  validateResearchRows(admittedRows, ["train"]);
  const byId = new Map(sourceRows.map((row) => [row.id, row]));
  const caseById = new Map();
  const groupDisposition = new Map();
  for (const item of cases) {
    const source = byId.get(item?.id);
    if (
      !source ||
      caseById.has(item.id) ||
      item.groupId !== source.group_id ||
      !["admit", "exclude"].includes(item.disposition) ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      !Array.isArray(item.sourceEvidence) ||
      !item.sourceEvidence.length ||
      item.sourceEvidence.some(
        (evidence) => typeof evidence !== "string" || !evidence.trim(),
      )
    )
      fail(
        "case-level admission is missing a valid disposition or source evidence",
      );
    caseById.set(item.id, item);
    const prior = groupDisposition.get(source.group_id);
    if (prior && prior !== item.disposition)
      fail("an operation group has mixed admission dispositions");
    groupDisposition.set(source.group_id, item.disposition);
  }
  const expected = sourceRows.filter(
    (row) => caseById.get(row.id)?.disposition === "admit",
  );
  if (expected.length !== admittedRows.length)
    fail("admitted file does not contain exactly the admitted cases");
  for (let index = 0; index < expected.length; index++) {
    try {
      assert.deepStrictEqual(admittedRows[index], expected[index]);
    } catch {
      fail("admitted file changed a source row or its original order");
    }
  }
  return {
    sourceRows: sourceRows.length,
    admittedRows: expected.length,
    excludedRows: sourceRows.length - expected.length,
    admittedGroups: [...groupDisposition.values()].filter(
      (value) => value === "admit",
    ).length,
    excludedGroups: [...groupDisposition.values()].filter(
      (value) => value === "exclude",
    ).length,
  };
}

async function checkedDescriptor(descriptor, name) {
  if (
    typeof descriptor?.file !== "string" ||
    !isAbsolute(descriptor.file) ||
    !pin(descriptor.sha256)
  )
    fail(`${name} has no absolute file and SHA-256 pin`);
  await regularFile(descriptor.file);
  if ((await hashFile(descriptor.file)) !== descriptor.sha256)
    fail(`${name} changed`);
  return descriptor.file;
}

async function verifyBlindSeals(merge) {
  const source = merge.source;
  if (
    source?.blindValid?.caseCount !== 62 ||
    source?.blindTest?.caseCount !== 55 ||
    !pin(source.blindValid.dataSha256) ||
    !pin(source.blindTest.dataSha256) ||
    !pin(source.blindValid.manifestSha256) ||
    !pin(source.blindTest.manifestSha256)
  )
    fail("active blind split seals are absent");
  // Hash TEST as an opaque stream. Do not parse its cases or labels here.
  const [validSha, testSha, validManifestSha, testManifestSha] =
    await Promise.all([
      hashFile(validFile),
      hashFile(testFile),
      hashFile(validManifestFile),
      hashFile(testManifestFile),
    ]);
  if (
    validSha !== source.blindValid.dataSha256 ||
    testSha !== source.blindTest.dataSha256 ||
    validManifestSha !== source.blindValid.manifestSha256 ||
    testManifestSha !== source.blindTest.manifestSha256
  )
    fail("active blind VALID or TEST byte seal changed");
}

async function verifyMergeSourceChain(merge) {
  const source = merge.source;
  for (const [name, descriptor] of [
    ["corrected development pool", source.correctedDataset],
    ["correction receipt", source.correctionReceipt],
    ["corrected host replay", source.correctedHostReceipt],
    ["TRAIN supplement", source.supplementDataset],
    ["supplement host replay", source.supplementReceipt],
    ["TRAIN proposal", source.proposalDataset],
    ["proposal host projection", source.proposalReceipt],
  ])
    await checkedDescriptor(descriptor, name);
  for (const [file, digest, name] of [
    [
      resolve(root, "scripts/guardrail-candidate6-research-merge.mjs"),
      source.mergeScriptSha256,
      "C6 merge script",
    ],
    [
      resolve(root, "fixtures/guardrail/candidate6/train-supplement.json"),
      source.supplementFixtureSha256,
      "C6 TRAIN supplement fixture",
    ],
    [
      resolve(root, "fixtures/guardrail/candidate6/train-augmentation.json"),
      source.augmentationFixtureSha256,
      "C6 TRAIN augmentation fixture",
    ],
    [
      resolve(
        root,
        "fixtures/guardrail/candidate6/browser-train-proposal.json",
      ),
      source.browserFixtureSha256,
      "C6 browser TRAIN proposal fixture",
    ],
    [
      resolve(root, "scripts/guardrail-candidate6-proposal-projection.mjs"),
      source.proposalProjectionScriptSha256,
      "C6 proposal projection script",
    ],
    [
      resolve(root, "blind-c6-20260922/screen-c6.py"),
      source.screenScriptSha256,
      "blind split screen",
    ],
    [
      resolve(root, "blind-c6-20260922/c6-case-v2.schema.json"),
      source.blindSchemaSha256,
      "blind case schema",
    ],
  ]) {
    if (!pin(digest) || sha(await readFile(file)) !== digest)
      fail(`${name} changed since the source merge`);
  }
}

async function verifyHost(sfPi, merge) {
  if (!sfPi || !isAbsolute(sfPi))
    fail("--sf-pi must be an absolute checkout path");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfPi,
    encoding: "utf8",
  }).trim();
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(sfPi, "extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ).href
  );
  const runtime = calculateJevRiskBaselineIdentity().sha256;
  if (
    commit !== merge.source.sfPiCommit ||
    runtime !== merge.source.sfPiRuntimeSha256 ||
    sha(await readFile(resolve(root, "dist/guardrail.js"))) !==
      merge.source.scorerDistributionSha256
  )
    fail("current SF host or Jev scoring distribution changed");
  return { commit, runtime };
}

export async function verifyCandidate6TrainingInputs(options) {
  const { mergeReceiptFile, admissionReceiptFile, admissionSha256, sfPi } =
    options;
  if (
    ![mergeReceiptFile, admissionReceiptFile].every(
      (file) => typeof file === "string" && isAbsolute(file),
    ) ||
    !pin(admissionSha256)
  )
    fail(
      "absolute merge/admission receipts and --admission-sha256 are required",
    );
  await Promise.all([
    regularFile(mergeReceiptFile),
    regularFile(admissionReceiptFile),
  ]);
  const [mergeBytes, admissionBytes] = await Promise.all([
    readFile(mergeReceiptFile),
    readFile(admissionReceiptFile),
  ]);
  if (sha(admissionBytes) !== admissionSha256)
    fail("admission receipt does not match the operator pin");
  const merge = JSON.parse(mergeBytes);
  const admission = JSON.parse(admissionBytes);
  if (
    merge.version !== 1 ||
    merge.purpose !== "candidate6_nonqualifying_research_train_handoff" ||
    merge.qualification !== false ||
    merge.trainingReady !== false ||
    merge.modelCalls !== 0 ||
    merge.externalOperationsExecuted !== 0 ||
    merge.prepareRfdtCalls !== 0 ||
    merge.rows?.train !== 186 ||
    merge.rows?.historicalDiagnosticValidation !== 96 ||
    merge.rows?.prospectiveBlindValidation !== 0 ||
    merge.rows?.test !== 0 ||
    merge.selection?.mode !== "validation_only" ||
    merge.selection?.historicalValidationRole !==
      "diagnostic_only_not_candidate_selection" ||
    merge.selection?.prospectiveSelectionSplit !==
      "sealed_c6_valid_v4_not_in_dataset" ||
    merge.selection?.heldOutSplit !== "sealed_c6_test_v3_not_in_dataset" ||
    merge.splitIsolation?.blindByteSealsVerified !== true ||
    merge.splitIsolation?.blindLabelsUsed !== false ||
    merge.splitIsolation?.blindRowsEmitted !== false ||
    merge.source?.rfdtBaseModel !== RFDT_BASE_MODEL ||
    merge.source?.rfdtBaseRevision !== RFDT_BASE_REVISION ||
    merge.source?.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256
  )
    fail("C6 source merge is not the separate TRAIN-only handoff");
  await verifyMergeSourceChain(merge);
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate6_train_label_source_admission" ||
    admission.qualification !== false ||
    admission.admittedForResearchTraining !== true ||
    admission.modelCalls !== 0 ||
    admission.externalOperationsExecuted !== 0 ||
    admission.originalRows !== 186 ||
    admission.source?.mergedTrainSha256 !== merge.datasets?.train?.sha256 ||
    admission.source?.mergeReceiptSha256 !== sha(mergeBytes) ||
    admission.source?.sfPiCommit !== merge.source.sfPiCommit ||
    admission.source?.sfPiRuntimeSha256 !== merge.source.sfPiRuntimeSha256 ||
    admission.source?.rubricSha256 !== sha(await readFile(rubricFile))
  )
    fail("C6 TRAIN labels lack source-pinned research admission");
  if (
    admission.source.admissionScriptSha256 !==
    sha(
      await readFile(
        resolve(root, "scripts/guardrail-candidate6-train-admission.mjs"),
      ),
    )
  )
    fail("admission audit script changed after its receipt was issued");
  const herdrReceiptFile = await checkedDescriptor(
    {
      file: admission.source.herdrPaneReceiptFile,
      sha256: admission.source.herdrPaneReceiptSha256,
    },
    "Herdr pane precondition receipt",
  );
  const herdr = JSON.parse(await readFile(herdrReceiptFile));
  if (
    herdr.scope !== "mocked_train_request_precondition_only" ||
    herdr.herdrRows !== 27 ||
    herdr.groups !== 19 ||
    herdr.commandsExecuted !== 0 ||
    herdr.liveVendorPaneProven !== false ||
    herdr.source?.trainDatasetSha256 !== merge.datasets.train.sha256 ||
    herdr.source?.preconditionsSha256 !==
      sha(
        await readFile(
          resolve(
            root,
            "fixtures/guardrail/candidate6/herdr-pane-preconditions.json",
          ),
        ),
      ) ||
    herdr.source?.preflightScriptSha256 !==
      sha(
        await readFile(
          resolve(
            root,
            "scripts/guardrail-candidate6-herdr-pane-preflight.mjs",
          ),
        ),
      )
  )
    fail(
      "Herdr pane precondition receipt does not match admitted TRAIN source",
    );
  const [sourcePath, admittedPath] = await Promise.all([
    checkedDescriptor(merge.datasets.train, "merged TRAIN"),
    checkedDescriptor(admission.admittedDataset, "admitted TRAIN"),
  ]);
  if (
    resolve(sourcePath) ===
      resolve(merge.datasets?.historicalDiagnostic?.file ?? "") ||
    resolve(admittedPath) ===
      resolve(merge.datasets?.historicalDiagnostic?.file ?? "") ||
    admission.admittedDataset.rows < 1 ||
    admission.admittedDataset.rows > 186
  )
    fail("historical diagnostic VALID cannot become RFDT training input");
  await checkedDescriptor(
    merge.datasets.historicalDiagnostic,
    "historical diagnostic VALID",
  );
  const sourceRows = parseJsonl(await readFile(sourcePath), "merged TRAIN");
  const admittedRows = parseJsonl(
    await readFile(admittedPath),
    "admitted TRAIN",
  );
  const counts = selectAdmittedTrainRows(
    sourceRows,
    admittedRows,
    admission.cases,
  );
  if (counts.admittedRows !== admission.admittedDataset.rows)
    fail("admitted row count changed");
  if (
    (await hashFile(sourcePath)) !== merge.datasets.train.sha256 ||
    (await hashFile(admittedPath)) !== admission.admittedDataset.sha256
  )
    fail("TRAIN bytes changed during admission verification");
  await verifyBlindSeals(merge);
  const host = await verifyHost(sfPi, merge);
  return {
    mergeReceiptSha256: sha(mergeBytes),
    admissionSha256,
    admittedDatasetFile: admittedPath,
    admittedDatasetSha256: admission.admittedDataset.sha256,
    historicalDiagnosticSha256: merge.datasets.historicalDiagnostic.sha256,
    blindValidSha256: merge.source.blindValid.dataSha256,
    blindTestSha256: merge.source.blindTest.dataSha256,
    sfPiCommit: host.commit,
    sfPiRuntimeSha256: host.runtime,
    counts,
  };
}

async function verifyBase(checkpoint, expected) {
  if (
    typeof checkpoint !== "string" ||
    !checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${RFDT_BASE_REVISION}`,
    )
  )
    fail("use the reviewed original Google Gemma 3 1B HF snapshot");
  const files = {};
  for (const name of ["model.safetensors", "config.json", "tokenizer.json"])
    files[name] = await hashArtifact(resolve(checkpoint, name));
  if (files["model.safetensors"].sha256 !== baseWeightsSha256)
    fail("original Google Gemma weights changed");
  if (expected && JSON.stringify(files) !== JSON.stringify(expected))
    fail("Google Gemma checkpoint changed since preparation");
  return files;
}

function requireRun(run) {
  const path = resolve(run ?? "");
  if (
    !run ||
    !inDirectory(path, buildRoot) ||
    !basename(path).startsWith("candidate-6-rfdt-")
  )
    fail(
      "--run must be a fresh candidate-6-rfdt-* directory under .build/guardrail",
    );
  return path;
}

export async function verifyPreparedRun(run, plan, source) {
  const manifest = JSON.parse(await readFile(resolve(run, "manifest.json")));
  if (
    manifest.base_model !== RFDT_BASE_MODEL ||
    manifest.base_revision !== RFDT_BASE_REVISION ||
    manifest.template_version !== "v2" ||
    resolve(manifest.source?.file ?? "") !== source.admittedDatasetFile ||
    manifest.source?.sha256 !== source.admittedDatasetSha256 ||
    manifest.source?.examples !== source.counts.admittedRows ||
    manifest.prepared?.branches?.train !== source.counts.admittedRows ||
    manifest.prepared?.branches?.validation !== 0 ||
    manifest.prepared?.branches?.test !== 0 ||
    manifest.prepared?.dataset_sha256 !== source.admittedDatasetSha256 ||
    resolve(manifest.prepared?.files?.validation ?? "") !==
      resolve(run, "validation.jsonl") ||
    resolve(manifest.prepared?.files?.test ?? "") !==
      resolve(run, "test.jsonl") ||
    plan.rfdtPreparedSha256 !== manifest.prepared?.sha256
  )
    fail("RFDT run differs from admitted TRAIN-only preparation");
  for (const split of ["validation", "test"]) {
    const file = resolve(run, `${split}.jsonl`);
    if ((await regularFile(file)).size !== 0)
      fail(`RFDT ${split} file must be empty`);
  }
  if (
    (await hashFile(resolve(run, "dataset.jsonl"))) !==
    source.admittedDatasetSha256
  )
    fail("RFDT prepared dataset changed");
  return manifest;
}

export async function withAttempt(
  run,
  phase,
  source,
  operation,
  signal = controller.signal,
) {
  const file = resolve(run, `candidate6-${phase}-attempt-${randomUUID()}.json`);
  const initial = {
    version: 1,
    purpose: "candidate6_research_training_attempt",
    phase,
    status: "started",
    startedAt: new Date().toISOString(),
    sourcePins: source,
    qualification: false,
  };
  await writeFile(file, `${JSON.stringify(initial, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const result = await operation();
    await writeFile(
      file,
      `${JSON.stringify({ ...initial, status: "complete", completedAt: new Date().toISOString(), result }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return result;
  } catch (error) {
    const progressFile = resolve(run, "worker-progress.jsonl");
    let progressSha256;
    try {
      progressSha256 = await hashFile(progressFile);
    } catch {
      // Preparation does not create a worker progress file.
    }
    await writeFile(
      file,
      `${JSON.stringify(
        {
          ...initial,
          status: signal.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          error: {
            name: error?.name ?? "Error",
            message: error?.message ?? String(error),
          },
          ...(progressSha256
            ? { workerProgress: { file: progressFile, sha256: progressSha256 } }
            : {}),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    throw error;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "merge-receipt": { type: "string" },
      "admission-receipt": { type: "string" },
      "admission-sha256": { type: "string" },
      "sf-pi": { type: "string" },
      checkpoint: { type: "string" },
      run: { type: "string" },
      steps: { type: "string" },
      "model-id": { type: "string" },
    },
  });
  const command = positionals[0];
  if (!["preflight", "prepare", "train", "export"].includes(command))
    fail("use preflight, prepare, train, or export");
  const options = {
    mergeReceiptFile:
      values["merge-receipt"] && resolve(values["merge-receipt"]),
    admissionReceiptFile:
      values["admission-receipt"] && resolve(values["admission-receipt"]),
    admissionSha256: values["admission-sha256"],
    sfPi: values["sf-pi"] && resolve(values["sf-pi"]),
  };
  if (command === "preflight") {
    console.log(
      JSON.stringify({
        phase: "preflight",
        ...(await verifyCandidate6TrainingInputs(options)),
        qualification: false,
      }),
    );
    return;
  }
  const run = requireRun(values.run);
  if (command === "prepare") {
    if (!values.checkpoint || !values.steps)
      fail("prepare requires --checkpoint and --steps");
    const steps = Number(values.steps);
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 100000)
      fail("--steps must be an integer from 1 to 100000");
    const source = await verifyCandidate6TrainingInputs(options);
    const checkpoint = resolve(values.checkpoint);
    const baseFiles = await verifyBase(checkpoint);
    await mkdir(run, { recursive: false });
    await withAttempt(run, "prepare", source, async () => {
      const config = configFromEnv({
        JEV_DEVICE: "metal",
        JEV_MODEL_ID: RFDT_BASE_MODEL,
        JEV_MODEL_FILE: resolve(root, "models/gemma-3-1b-it-f16.gguf"),
        JEV_TEMPLATE_VERSION: "v2",
      });
      const manifest = await prepareRfdt(source.admittedDatasetFile, {
        outputDir: run,
        templateVersion: "v2",
        config,
        signal: controller.signal,
      });
      const plan = {
        version: 1,
        purpose: "candidate6_train_only_research_rfdt",
        qualification: false,
        source: options,
        sourcePins: source,
        checkpoint,
        baseFiles,
        steps,
        protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        criteriaSha256: GUARDRAIL_CRITERIA_SHA256,
        allowCutoff: GUARDRAIL_LIMITS.minimumAllowScore,
        rfdtPreparedSha256: manifest.prepared.sha256,
        selection: "prospective_c6_valid_v4_only",
        historicalDiagnosticForSelection: false,
        testRowsPassedToTraining: 0,
        testEvaluationsBeforeFreeze: 0,
      };
      await verifyPreparedRun(run, plan, source);
      await writeFile(
        resolve(run, "candidate6-training-plan.json"),
        `${JSON.stringify(plan, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return {
        rfdtPreparedSha256: manifest.prepared.sha256,
        trainRows: source.counts.admittedRows,
      };
    });
    console.log(
      JSON.stringify({
        phase: "prepared",
        run,
        trainRows: source.counts.admittedRows,
        validationRows: 0,
        testRows: 0,
        qualification: false,
      }),
    );
    return;
  }
  const plan = JSON.parse(
    await readFile(resolve(run, "candidate6-training-plan.json")),
  );
  if (
    plan.version !== 1 ||
    plan.purpose !== "candidate6_train_only_research_rfdt" ||
    plan.qualification !== false ||
    plan.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    plan.criteriaSha256 !== GUARDRAIL_CRITERIA_SHA256 ||
    plan.allowCutoff !== GUARDRAIL_LIMITS.minimumAllowScore ||
    plan.selection !== "prospective_c6_valid_v4_only" ||
    plan.historicalDiagnosticForSelection !== false ||
    plan.testRowsPassedToTraining !== 0 ||
    plan.testEvaluationsBeforeFreeze !== 0
  )
    fail("training plan changed or crossed the qualification boundary");
  const source = await verifyCandidate6TrainingInputs(plan.source);
  if (JSON.stringify(source) !== JSON.stringify(plan.sourcePins))
    fail("source pins changed since preparation");
  await verifyBase(plan.checkpoint, plan.baseFiles);
  await verifyPreparedRun(run, plan, source);
  if (command === "train") {
    const result = await withAttempt(run, "train", source, async () => {
      const manifest = await trainRfdt(run, {
        steps: plan.steps,
        modelPath: plan.checkpoint,
        signal: controller.signal,
      });
      return { status: manifest.status, steps: plan.steps };
    });
    console.log(
      JSON.stringify({
        phase: "trained",
        run,
        status: result.status,
        qualification: false,
      }),
    );
    return;
  }
  if (!values["model-id"] || !/^jev\/[a-zA-Z0-9._-]+$/.test(values["model-id"]))
    fail("export requires --model-id jev/ID");
  const result = await withAttempt(run, "export", source, async () => {
    const artifact = await exportRfdt(run, {
      modelId: values["model-id"],
      modelPath: plan.checkpoint,
      signal: controller.signal,
    });
    const descriptor = await verifyTrainedArtifactExport(artifact);
    const registry = resolve(run, "candidate-registry.json");
    await writeFile(
      registry,
      `${JSON.stringify({ version: 1, artifacts: [descriptor] }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return {
      artifact: artifact.file,
      artifactSha256: artifact.sha256,
      registry,
    };
  });
  console.log(
    JSON.stringify({ phase: "exported", run, ...result, qualification: false }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
