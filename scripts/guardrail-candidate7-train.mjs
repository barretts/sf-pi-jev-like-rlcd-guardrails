#!/usr/bin/env node
/** Source-pinned Candidate 7 RFDT lane. Only admitted TRAIN reaches RFDT. */
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const baseWeightsSha256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const compilerLimits = Object.freeze({
  maxModelLen: 2048,
  maxBatchSize: 32,
  maxBatchTokens: 2048,
});
const sourceFiles = Object.freeze([
  "scripts/guardrail-candidate7-train.mjs",
  "scripts/guardrail-candidate7-train-admission.mjs",
  "src/rfdt.ts",
  "rfdt/worker.py",
  "rfdt/requirements.lock",
  "scripts/build-rfdt.sh",
  "package-lock.json",
  "dist/backend.js",
  "dist/core.js",
  "dist/guardrail-evaluation.js",
  "dist/guardrail-extension.js",
  "dist/guardrail.js",
  "dist/models.js",
  "dist/rfdt.js",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const pin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new Error(`Candidate 7 training: ${message}`);
};
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    controller.abort(new Error(`Candidate 7 training cancelled (${signal})`)),
  );
const inBuild = (file) => {
  const rel = relative(buildRoot, file);
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
async function currentCodeIdentity() {
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const trackedSourceFiles = sourceFiles.filter(
    (file) => !file.startsWith("dist/"),
  );
  try {
    execFileSync(
      "git",
      ["ls-files", "--error-unmatch", "--", ...trackedSourceFiles],
      { cwd: root, stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["diff", "--quiet", "HEAD", "--", ...trackedSourceFiles],
      { cwd: root, stdio: "ignore" },
    );
  } catch {
    fail("training source must be committed and match the pinned Jev HEAD");
  }
  const files = {};
  for (const relativePath of sourceFiles) {
    const path = resolve(root, relativePath);
    await regularFile(path);
    files[relativePath] = await hashFile(path);
  }
  // The worktree may use a symlink to the reviewed native binary. Pin the
  // actual bytes and resolved path, not the mutable symlink text alone.
  const nativeBinary = resolve(root, ".build/jev-native");
  return {
    gitHead,
    files,
    nativeBinary,
    nativeBinarySha256: await hashFile(nativeBinary),
  };
}
function parseTrain(bytes, expectedRows, expectedGroups) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\n\n"))
    fail("TRAIN must be complete LF JSONL");
  const rows = text.trimEnd().split("\n").map(JSON.parse);
  if (
    rows.length !== expectedRows ||
    new Set(rows.map((row) => row.group_id)).size !== expectedGroups ||
    rows.some(
      (row) =>
        row.split !== "train" ||
        row.request?.model !== RFDT_BASE_MODEL ||
        row.request.state?.version !== 2 ||
        !["allow", "confirm"].includes(row.targets?.risk?.answer),
    )
  )
    fail("admitted C7 TRAIN contract or group count changed");
  return rows;
}

async function verifyInputs(options) {
  if (
    !options.admissionReceiptFile ||
    !isAbsolute(options.admissionReceiptFile) ||
    !inBuild(options.admissionReceiptFile) ||
    !pin(options.admissionSha256) ||
    !options.sfPi ||
    !isAbsolute(options.sfPi)
  )
    fail(
      "absolute admission receipt, its SHA-256, and absolute sf-pi checkout are required",
    );
  await regularFile(options.admissionReceiptFile);
  const bytes = await readFile(options.admissionReceiptFile);
  if (sha(bytes) !== options.admissionSha256) fail("admission receipt changed");
  const admission = JSON.parse(bytes);
  const dataset = admission.admittedDataset;
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate7_train_only_admission" ||
    admission.qualification !== false ||
    admission.admittedForResearchTraining !== true ||
    admission.heldOutTestRead !== false ||
    admission.modelCalls !== 0 ||
    admission.externalOperationsExecuted !== 0 ||
    admission.source?.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    dataset?.baseModel !== RFDT_BASE_MODEL ||
    dataset?.requestVersion !== 2 ||
    !Number.isSafeInteger(dataset?.rows) ||
    dataset.rows < 1 ||
    !Number.isSafeInteger(dataset?.groups) ||
    dataset.groups < 1 ||
    !isAbsolute(dataset.file) ||
    !inBuild(dataset.file) ||
    !pin(dataset.sha256)
  )
    fail("admission is not the separate C7 TRAIN-only handoff");
  await regularFile(dataset.file);
  const trainBytes = await readFile(dataset.file);
  if (sha(trainBytes) !== dataset.sha256) fail("admitted TRAIN changed");
  parseTrain(trainBytes, dataset.rows, dataset.groups);
  for (const key of [
    "baseTrain",
    "candidate7Source",
    "sourceScreen",
    "hostReceipt",
  ]) {
    const item = admission.source[key];
    if (item?.file) await regularFile(item.file);
    if (
      !item ||
      !isAbsolute(item.file) ||
      !pin(item.sha256) ||
      sha(await readFile(item.file)) !== item.sha256
    )
      fail(`${key} source pin changed`);
  }
  const hostReceipt = JSON.parse(
    await readFile(admission.source.hostReceipt.file),
  );
  const projected = hostReceipt.projectedTrain;
  if (
    !projected?.file ||
    !isAbsolute(projected.file) ||
    !inBuild(projected.file) ||
    !pin(projected.sha256)
  )
    fail("host-projected TRAIN descriptor is missing");
  await regularFile(projected.file);
  if ((await hashFile(projected.file)) !== projected.sha256)
    fail("host-projected TRAIN bytes changed");
  const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: options.sfPi,
    encoding: "utf8",
  }).trim();
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(
        options.sfPi,
        "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
      ),
    ).href
  );
  const sfRuntime = calculateJevRiskBaselineIdentity().sha256;
  if (
    sfCommit !== admission.source.hostCommit ||
    sfRuntime !== admission.source.hostRuntimeSha256
  )
    fail("sf-pi host commit or risk runtime changed");
  return {
    admissionSha256: options.admissionSha256,
    admittedDatasetFile: dataset.file,
    admittedDatasetSha256: dataset.sha256,
    trainRows: dataset.rows,
    trainGroups: dataset.groups,
    sfPiCommit: sfCommit,
    sfPiRuntimeSha256: sfRuntime,
    scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    codeIdentity: await currentCodeIdentity(),
  };
}

async function verifyBase(checkpoint, expected) {
  if (
    !checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${RFDT_BASE_REVISION}`,
    )
  )
    fail("use the reviewed original Google Gemma 3 1B snapshot");
  const files = {};
  for (const name of ["model.safetensors", "config.json", "tokenizer.json"])
    files[name] = await hashArtifact(resolve(checkpoint, name));
  if (files["model.safetensors"].sha256 !== baseWeightsSha256)
    fail("original Google Gemma weights changed");
  if (expected && JSON.stringify(files) !== JSON.stringify(expected))
    fail("original Google checkpoint changed since preparation");
  return files;
}
function requireRun(value) {
  const run = resolve(value ?? "");
  if (!value || !inBuild(run) || !basename(run).startsWith("candidate-7-rfdt-"))
    fail(
      "--run must be a fresh candidate-7-rfdt-* path under .build/guardrail",
    );
  return run;
}
async function verifyPreparedRun(run, plan, source) {
  const manifest = JSON.parse(await readFile(resolve(run, "manifest.json")));
  if (
    manifest.base_model !== RFDT_BASE_MODEL ||
    manifest.base_revision !== RFDT_BASE_REVISION ||
    manifest.template_version !== "v2" ||
    resolve(manifest.source?.file ?? "") !== source.admittedDatasetFile ||
    manifest.source?.sha256 !== source.admittedDatasetSha256 ||
    manifest.source?.examples !== source.trainRows ||
    manifest.prepared?.branches?.train !== source.trainRows ||
    manifest.prepared?.branches?.validation !== 0 ||
    manifest.prepared?.branches?.test !== 0 ||
    manifest.prepared?.dataset_sha256 !== source.admittedDatasetSha256 ||
    plan.rfdtPreparedSha256 !== manifest.prepared?.sha256
  )
    fail("RFDT prepared manifest differs from admitted TRAIN-only plan");
  for (const split of ["validation", "test"])
    if ((await regularFile(resolve(run, `${split}.jsonl`))).size !== 0)
      fail(`RFDT internal ${split} file must remain empty`);
  if (
    (await hashFile(resolve(run, "dataset.jsonl"))) !==
    source.admittedDatasetSha256
  )
    fail("RFDT prepared TRAIN bytes changed");
  return manifest;
}
async function withAttempt(run, phase, source, operation) {
  const file = resolve(run, `candidate7-${phase}-attempt-${randomUUID()}.json`);
  const initial = {
    version: 1,
    purpose: "candidate7_train_only_rfdt_attempt",
    phase,
    status: "started",
    startedAt: new Date().toISOString(),
    sourcePins: source,
    qualification: false,
    heldOutTestRead: false,
  };
  await writeFile(file, JSON.stringify(initial, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const result = await operation();
    await writeFile(
      file,
      JSON.stringify(
        {
          ...initial,
          status: "complete",
          completedAt: new Date().toISOString(),
          result,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    return result;
  } catch (error) {
    let progressSha256;
    try {
      progressSha256 = await hashFile(resolve(run, "worker-progress.jsonl"));
    } catch {
      /* no worker */
    }
    await writeFile(
      file,
      JSON.stringify(
        {
          ...initial,
          status: controller.signal.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          error: {
            name: error?.name ?? "Error",
            message: error?.message ?? String(error),
          },
          ...(progressSha256 ? { workerProgressSha256: progressSha256 } : {}),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    throw error;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "admission-receipt": { type: "string" },
      "admission-sha256": { type: "string" },
      "sf-pi": { type: "string" },
      checkpoint: { type: "string" },
      run: { type: "string" },
      steps: { type: "string" },
      "model-id": { type: "string" },
    },
  });
  const phase = positionals[0];
  if (!["preflight", "prepare", "train", "export"].includes(phase))
    fail("use preflight, prepare, train, or export");
  const options = {
    admissionReceiptFile:
      values["admission-receipt"] && resolve(values["admission-receipt"]),
    admissionSha256: values["admission-sha256"],
    sfPi: values["sf-pi"] && resolve(values["sf-pi"]),
  };
  if (phase === "preflight") {
    console.log(
      JSON.stringify({
        phase,
        ...(await verifyInputs(options)),
        qualification: false,
      }),
    );
    return;
  }
  const run = requireRun(values.run);
  if (phase === "prepare") {
    const steps = Number(values.steps);
    if (
      !values.checkpoint ||
      !Number.isSafeInteger(steps) ||
      steps < 1 ||
      steps > 100000
    )
      fail("prepare requires original --checkpoint and integer --steps");
    const source = await verifyInputs(options);
    const checkpoint = resolve(values.checkpoint);
    const baseFiles = await verifyBase(checkpoint);
    await mkdir(run, { recursive: false });
    await withAttempt(
      run,
      "prepare",
      { ...source, compilerLimits },
      async () => {
        const config = {
          ...configFromEnv({
            JEV_DEVICE: "metal",
            JEV_MODEL_ID: RFDT_BASE_MODEL,
            JEV_MODEL_FILE: resolve(root, "models/gemma-3-1b-it-f16.gguf"),
            JEV_TEMPLATE_VERSION: "v2",
          }),
          ...compilerLimits,
        };
        const manifest = await prepareRfdt(source.admittedDatasetFile, {
          outputDir: run,
          templateVersion: "v2",
          config,
          signal: controller.signal,
        });
        const plan = {
          version: 1,
          purpose: "candidate7_train_only_rfdt",
          qualification: false,
          heldOutTestRead: false,
          source: options,
          sourcePins: source,
          checkpoint,
          baseFiles,
          steps,
          protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
          criteriaSha256: GUARDRAIL_CRITERIA_SHA256,
          allowCutoff: GUARDRAIL_LIMITS.minimumAllowScore,
          compilerLimits,
          rfdtPreparedSha256: manifest.prepared.sha256,
          selection: "fresh_c7_VALID_only_after_two_fixed_fits",
          validationRowsPassedToTraining: 0,
          testRowsPassedToTraining: 0,
        };
        await verifyPreparedRun(run, plan, source);
        await writeFile(
          resolve(run, "candidate7-training-plan.json"),
          JSON.stringify(plan, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        return {
          rfdtPreparedSha256: manifest.prepared.sha256,
          trainRows: source.trainRows,
          steps,
        };
      },
    );
    console.log(
      JSON.stringify({
        phase: "prepared",
        run,
        steps,
        trainRows: source.trainRows,
        validationRows: 0,
        testRows: 0,
        qualification: false,
      }),
    );
    return;
  }
  const plan = JSON.parse(
    await readFile(resolve(run, "candidate7-training-plan.json")),
  );
  if (
    plan.version !== 1 ||
    plan.purpose !== "candidate7_train_only_rfdt" ||
    plan.qualification !== false ||
    plan.heldOutTestRead !== false ||
    !Number.isSafeInteger(plan.steps) ||
    plan.steps < 1 ||
    plan.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    plan.criteriaSha256 !== GUARDRAIL_CRITERIA_SHA256 ||
    plan.allowCutoff !== GUARDRAIL_LIMITS.minimumAllowScore ||
    JSON.stringify(plan.compilerLimits) !== JSON.stringify(compilerLimits) ||
    plan.selection !== "fresh_c7_VALID_only_after_two_fixed_fits" ||
    plan.validationRowsPassedToTraining !== 0 ||
    plan.testRowsPassedToTraining !== 0
  )
    fail("training plan changed or crossed selection boundary");
  const source = await verifyInputs(plan.source);
  if (JSON.stringify(source) !== JSON.stringify(plan.sourcePins))
    fail("source pins changed since preparation");
  await verifyBase(plan.checkpoint, plan.baseFiles);
  await verifyPreparedRun(run, plan, source);
  if (phase === "train") {
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
        steps: plan.steps,
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
      JSON.stringify({ version: 1, artifacts: [descriptor] }, null, 2) + "\n",
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
