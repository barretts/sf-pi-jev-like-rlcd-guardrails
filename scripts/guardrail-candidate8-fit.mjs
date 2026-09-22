#!/usr/bin/env node
/** Reproducible C8 fit lane. Only the admitted TRAIN fit partition reaches RFDT. */
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
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";
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
const hostCommit = "bc7862b078997d2c60aa908979b5cbf59f83db80";
const hostRuntimeSha256 =
  "6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e";
const compilerLimits = Object.freeze({
  maxModelLen: 2048,
  maxBatchSize: 32,
  maxBatchTokens: 2048,
});
const sourceFiles = Object.freeze([
  "scripts/guardrail-candidate8-fit.mjs",
  "scripts/guardrail-candidate8-train-admission.mjs",
  "fixtures/guardrail/candidate8/train-recovery.json",
  "fixtures/guardrail/candidate8/pairs.json",
  "fixtures/guardrail/candidate8/split-plan.json",
  "fixtures/guardrail/candidate8/objective-plan.json",
  "reports/guardrail-risk-2026-09-21/candidate-7-evidence/train/admitted-train.jsonl",
  "src/rfdt.ts",
  "src/guardrail.ts",
  "rfdt/worker.py",
  "rfdt/requirements.lock",
  "package-lock.json",
  "dist/backend.js",
  "dist/core.js",
  "dist/guardrail.js",
  "dist/models.js",
  "dist/rfdt.js",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const pin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new Error(`Candidate 8 fit: ${message}`);
};
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    controller.abort(new Error(`Candidate 8 fit cancelled (${signal})`)),
  );
function inBuild(file) {
  const rel = relative(buildRoot, file);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
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
async function codeIdentity() {
  const tracked = sourceFiles.filter((file) => !file.startsWith("dist/"));
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ...tracked], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...tracked], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    fail("fit source must be committed and match HEAD");
  }
  const files = {};
  for (const file of sourceFiles) {
    await regularFile(resolve(root, file));
    files[file] = await hashFile(resolve(root, file));
  }
  const native = resolve(root, ".build/jev-native");
  return {
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    files,
    nativeSha256: await hashFile(native),
  };
}
function parseRows(bytes, split) {
  const input = bytes.toString("utf8");
  if (!input.endsWith("\n") || input.includes("\r") || input.includes("\n\n"))
    fail(`${split} must be complete LF JSONL`);
  const rows = input.trimEnd().split("\n").map(JSON.parse);
  if (
    rows.some(
      (row) =>
        row.split !== split ||
        row.request?.model !== RFDT_BASE_MODEL ||
        row.request.state?.version !== 2 ||
        !["allow", "confirm"].includes(row.targets?.risk?.answer),
    )
  )
    fail(`${split} rows changed`);
  return rows;
}
async function verifyAdmission(file, expectedSha256, sfPi) {
  if (!isAbsolute(file) || !inBuild(file) || !pin(expectedSha256))
    fail("absolute local admission receipt and SHA-256 required");
  await regularFile(file);
  const bytes = await readFile(file);
  if (sha(bytes) !== expectedSha256) fail("admission receipt changed");
  const admission = JSON.parse(bytes);
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate8_fit_calibration_admission" ||
    admission.trainingReady !== true ||
    admission.qualification !== false ||
    admission.heldOutTestRead !== false ||
    admission.modelCalls !== 0 ||
    admission.source?.baseModel !== RFDT_BASE_MODEL ||
    admission.source?.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    admission.source?.hostCommit !== hostCommit ||
    admission.source?.hostRuntimeSha256 !== hostRuntimeSha256 ||
    admission.calibration?.notPassedToFit !== true ||
    admission.fit?.rows !== 226 ||
    admission.fit?.groups !== 77 ||
    admission.calibration?.rows !== 47 ||
    admission.calibration?.groups !== 17
  )
    fail("admission contract changed");
  const fit = admission.fit,
    cal = admission.calibration;
  for (const item of [fit, cal]) {
    if (!isAbsolute(item.file) || !inBuild(item.file) || !pin(item.sha256))
      fail("admitted partitions must be hash-pinned local files");
    await regularFile(item.file);
    if ((await hashFile(item.file)) !== item.sha256)
      fail("admitted partition bytes changed");
  }
  const fitRows = parseRows(await readFile(fit.file), "train");
  const calRows = parseRows(await readFile(cal.file), "calibration");
  if (
    fitRows.length !== fit.rows ||
    calRows.length !== cal.rows ||
    new Set(fitRows.map((row) => row.group_id)).size !== fit.groups ||
    new Set(calRows.map((row) => row.group_id)).size !== cal.groups ||
    fitRows.some((row) => calRows.some((c) => c.group_id === row.group_id))
  )
    fail("fit/calibration disjointness changed");
  const expectedSourceHashes = {
    "fixtures/guardrail/candidate8/train-recovery.json":
      admission.source.candidate8SourceSha256,
    "fixtures/guardrail/candidate8/pairs.json": admission.source.pairsSha256,
    "fixtures/guardrail/candidate8/split-plan.json":
      admission.source.splitPlanSha256,
    "reports/guardrail-risk-2026-09-21/candidate-7-evidence/train/admitted-train.jsonl":
      admission.source.inheritedTrainSha256,
    "scripts/guardrail-candidate8-train-admission.mjs":
      admission.source.admissionScriptSha256,
  };
  for (const [path, expected] of Object.entries(expectedSourceHashes))
    if (!pin(expected) || (await hashFile(resolve(root, path))) !== expected)
      fail(`admission source changed: ${path}`);
  if (!isAbsolute(sfPi)) fail("absolute sf-pi host checkout required");
  const actualHost = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfPi,
    encoding: "utf8",
  }).trim();
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(sfPi, "extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ).href
  );
  if (
    actualHost !== hostCommit ||
    calculateJevRiskBaselineIdentity().sha256 !== hostRuntimeSha256
  )
    fail("sf-pi host identity changed");
  return {
    admissionSha256: expectedSha256,
    fit: {
      file: fit.file,
      sha256: fit.sha256,
      rows: fit.rows,
      groups: fit.groups,
    },
    calibration: {
      file: cal.file,
      sha256: cal.sha256,
      rows: cal.rows,
      groups: cal.groups,
    },
    hostCommit,
    hostRuntimeSha256,
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    code: await codeIdentity(),
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
    fail("original checkpoint changed since preparation");
  return files;
}
function runPath(value) {
  const run = resolve(value ?? "");
  if (!value || !inBuild(run) || !basename(run).startsWith("candidate-8-rfdt-"))
    fail(
      "--run must be a candidate-8-rfdt-* path under local .build/guardrail",
    );
  return run;
}
async function verifyPrepared(run, source, plan) {
  const manifest = JSON.parse(await readFile(resolve(run, "manifest.json")));
  if (
    manifest.base_model !== RFDT_BASE_MODEL ||
    manifest.base_revision !== RFDT_BASE_REVISION ||
    manifest.template_version !== "v2" ||
    manifest.source?.sha256 !== source.fit.sha256 ||
    manifest.source?.examples !== source.fit.rows ||
    manifest.prepared?.branches?.train !== source.fit.rows ||
    manifest.prepared?.branches?.validation !== 0 ||
    manifest.prepared?.branches?.test !== 0 ||
    manifest.prepared?.dataset_sha256 !== source.fit.sha256 ||
    manifest.prepared?.sha256 !== plan.rfdtPreparedSha256
  )
    fail("RFDT prepared run changed or contains reserved rows");
  if ((await hashFile(resolve(run, "dataset.jsonl"))) !== source.fit.sha256)
    fail("RFDT fit dataset changed");
  for (const split of ["validation", "test"])
    if ((await regularFile(resolve(run, `${split}.jsonl`))).size !== 0)
      fail(`RFDT ${split} branch must remain empty`);
  return manifest;
}
async function attempt(run, phase, source, action) {
  const file = resolve(run, `candidate8-${phase}-attempt-${randomUUID()}.json`);
  const receipt = {
    version: 1,
    purpose: "candidate8_fit_only_attempt",
    phase,
    status: "started",
    startedAt: new Date().toISOString(),
    source,
    qualification: false,
    heldOutTestRead: false,
  };
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const result = await action();
    await writeFile(
      file,
      JSON.stringify(
        {
          ...receipt,
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
    await writeFile(
      file,
      JSON.stringify(
        {
          ...receipt,
          status: controller.signal.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          error: {
            name: error?.name ?? "Error",
            message: error?.message ?? String(error),
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    throw error;
  }
}

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
const admissionFile =
  values["admission-receipt"] && resolve(values["admission-receipt"]);
const sfPi = values["sf-pi"] && resolve(values["sf-pi"]);
if (!admissionFile || !sfPi)
  fail("absolute admission receipt and sf-pi host required");
const source = await verifyAdmission(
  admissionFile,
  values["admission-sha256"],
  sfPi,
);
if (phase === "preflight") {
  console.log(JSON.stringify({ phase, source, qualification: false }));
  process.exit(0);
}
const run = runPath(values.run);
if (phase === "prepare") {
  const steps = Number(values.steps);
  if (!values.checkpoint || ![256, 512].includes(steps))
    fail("prepare requires original --checkpoint and frozen 256 or 512 steps");
  const checkpoint = resolve(values.checkpoint);
  const baseFiles = await verifyBase(checkpoint);
  const pairsFile = resolve(root, "fixtures/guardrail/candidate8/pairs.json");
  const objectiveFile = resolve(
    root,
    "fixtures/guardrail/candidate8/objective-plan.json",
  );
  const pairSha256 = await hashFile(pairsFile);
  const objective = JSON.parse(await readFile(objectiveFile));
  if (
    pairSha256 !==
      source.code.files["fixtures/guardrail/candidate8/pairs.json"] ||
    objective.pair_manifest_sha256 !== pairSha256 ||
    objective.cutoff_status !== "unset_requires_train_calibration_before_VALID"
  )
    fail("TRAIN-only objective and pairs changed");
  await mkdir(run, { recursive: false });
  const result = await attempt(run, "prepare", source, async () => {
    const config = {
      ...configFromEnv({
        JEV_DEVICE: "metal",
        JEV_MODEL_ID: RFDT_BASE_MODEL,
        JEV_MODEL_FILE: resolve(root, "models/gemma-3-1b-it-f16.gguf"),
        JEV_TEMPLATE_VERSION: "v2",
      }),
      ...compilerLimits,
    };
    const manifest = await prepareRfdt(source.fit.file, {
      outputDir: run,
      templateVersion: "v2",
      config,
      signal: controller.signal,
    });
    const plan = {
      version: 1,
      purpose: "candidate8_fit_only_rfdt",
      qualification: false,
      heldOutTestRead: false,
      source,
      checkpoint,
      baseFiles,
      steps,
      compilerLimits,
      pairSha256,
      objectiveSha256: await hashFile(objectiveFile),
      rfdtPreparedSha256: manifest.prepared.sha256,
      selection: "train_cal_cutoff_then_fresh_c8_VALID_only",
      validationRowsPassedToTraining: 0,
      testRowsPassedToTraining: 0,
    };
    await verifyPrepared(run, source, plan);
    await writeFile(
      resolve(run, "candidate8-fit-plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return { rfdtPreparedSha256: manifest.prepared.sha256, steps };
  });
  console.log(
    JSON.stringify({ phase: "prepared", run, ...result, qualification: false }),
  );
  process.exit(0);
}
const plan = JSON.parse(
  await readFile(resolve(run, "candidate8-fit-plan.json")),
);
if (
  plan.version !== 1 ||
  plan.purpose !== "candidate8_fit_only_rfdt" ||
  plan.qualification !== false ||
  plan.heldOutTestRead !== false ||
  ![256, 512].includes(plan.steps) ||
  plan.selection !== "train_cal_cutoff_then_fresh_c8_VALID_only" ||
  plan.validationRowsPassedToTraining !== 0 ||
  plan.testRowsPassedToTraining !== 0 ||
  JSON.stringify(plan.source) !== JSON.stringify(source) ||
  JSON.stringify(plan.compilerLimits) !== JSON.stringify(compilerLimits) ||
  plan.pairSha256 !==
    source.code.files["fixtures/guardrail/candidate8/pairs.json"] ||
  plan.objectiveSha256 !==
    source.code.files["fixtures/guardrail/candidate8/objective-plan.json"]
)
  fail("frozen fit plan changed");
await verifyBase(plan.checkpoint, plan.baseFiles);
await verifyPrepared(run, source, plan);
if (phase === "train") {
  const result = await attempt(run, "train", source, async () => {
    const manifest = await trainRfdt(run, {
      steps: plan.steps,
      modelPath: plan.checkpoint,
      guardrailPairsPath: resolve(
        root,
        "fixtures/guardrail/candidate8/pairs.json",
      ),
      guardrailPlanPath: resolve(
        root,
        "fixtures/guardrail/candidate8/objective-plan.json",
      ),
      signal: controller.signal,
    });
    return {
      status: manifest.status,
      steps: plan.steps,
      training: manifest.training,
    };
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
  process.exit(0);
}
if (!values["model-id"] || !/^jev\/[a-zA-Z0-9._-]+$/.test(values["model-id"]))
  fail("export requires --model-id jev/ID");
const result = await attempt(run, "export", source, async () => {
  const artifact = await exportRfdt(run, {
    modelId: values["model-id"],
    modelPath: plan.checkpoint,
    signal: controller.signal,
  });
  const descriptor = await verifyTrainedArtifactExport(artifact);
  await writeFile(
    resolve(run, "candidate-registry.json"),
    JSON.stringify({ version: 1, artifacts: [descriptor] }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { artifact: artifact.file, artifactSha256: artifact.sha256 };
});
console.log(
  JSON.stringify({ phase: "exported", run, ...result, qualification: false }),
);
