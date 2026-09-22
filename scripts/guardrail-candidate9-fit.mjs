#!/usr/bin/env node
/** C9 FIT-only prepare/train/export. Blind VALID seal is read as metadata only. */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configFromEnv } from "../dist/backend.js";
import { canonical } from "../dist/core.js";
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
const build = resolve(root, ".build/guardrail");
const baseWeightsSha256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const baseGgufSha256 =
  "05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5";
const quantizerBinarySha256 =
  "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";
const quantizerSourceRevision = "f072b103714dfa1eee531f80b24512faf38e3dd2";
const c9HostCommit = "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a";
const c9HostBaselineSha256 =
  "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421";
const c9BundledPolicySha256 =
  "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347";
const c9BlindValidManifestSha256 =
  "b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc";
const c9BlindValidSourceSha256 =
  "d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f";
const supersededAdmissionSha256 =
  "e7d79edb8984d3a9604862f9f513cd07cd9085f484006940b3b329c71880508f";
const compilerLimits = Object.freeze({
  maxModelLen: 2048,
  maxBatchSize: 32,
  maxBatchTokens: 2048,
});
const inferenceArtifactFormat = "GGUF_Q8_0";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const pin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new Error(`Candidate 9 FIT: ${message}`);
};
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    controller.abort(new Error(`Candidate 9 FIT cancelled (${signal})`)),
  );

async function bytes(path, max = 16 * 1_048_576) {
  const file = resolve(path ?? "");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max)
    fail(`expected bounded regular file: ${file}`);
  const value = await readFile(file);
  if (value.length > max) fail(`file grew beyond bound: ${file}`);
  return value;
}
async function pinned(path, digest, max) {
  if (!pin(digest)) fail("missing exact source SHA-256 pin");
  const value = await bytes(path, max);
  if (sha(value) !== digest) fail(`source bytes changed: ${path}`);
  return value;
}
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}
function runPath(path) {
  const full = resolve(path ?? "");
  if (
    !path ||
    dirname(full) !== build ||
    !basename(full).startsWith("candidate-9-rfdt-")
  )
    fail(
      "--run must be a direct candidate-9-rfdt-* path under local .build/guardrail",
    );
  return full;
}
function jsonl(value, split) {
  const raw = value.toString("utf8");
  if (!raw.endsWith("\n") || raw.includes("\r") || raw.includes("\n\n"))
    fail(`${split} must be complete LF JSONL`);
  const rows = raw.trimEnd().split("\n").map(JSON.parse);
  const ids = new Set();
  for (const row of rows) {
    if (
      row.split !== split ||
      row.request?.model !== RFDT_BASE_MODEL ||
      row.request.state?.version !== 2 ||
      typeof row.id !== "string" ||
      ids.has(row.id) ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      !["allow", "confirm"].includes(row.targets?.risk?.answer)
    )
      fail(`${split} admission row changed`);
    ids.add(row.id);
  }
  return rows;
}
async function sourceIdentity(paths) {
  const tracked = [
    "scripts/guardrail-candidate9-fit.mjs",
    "scripts/guardrail-candidate9-select-cutoff.mjs",
    "scripts/guardrail-candidate9-artifact-provenance.mjs",
    "src/rfdt.ts",
    "src/core.ts",
    "src/backend.ts",
    "src/models.ts",
    "src/guardrail.ts",
    "src/guardrail-c9-calibration.ts",
    "rfdt/worker.py",
    "rfdt/requirements.lock",
    "package-lock.json",
  ];
  for (const file of [paths.pairs, paths.families, paths.objective]) {
    const rel = relative(root, resolve(file));
    if (rel === ".." || rel.startsWith(`..${sep}`))
      fail("pair, family and objective manifests must be committed in Jev");
    tracked.push(rel);
  }
  try {
    git(root, ["ls-files", "--error-unmatch", "--", ...tracked]);
    git(root, ["diff", "--quiet", "HEAD"]);
  } catch {
    fail("C9 FIT code and objective sources must be committed and clean");
  }
  const files = {};
  for (const file of tracked)
    files[file] = sha(await bytes(resolve(root, file)));
  for (const file of [
    "backend.js",
    "core.js",
    "guardrail.js",
    "guardrail-c9-calibration.js",
    "models.js",
    "rfdt.js",
  ])
    files[`dist/${file}`] = sha(await bytes(resolve(root, "dist", file)));
  files[".build/jev-native"] = sha(
    await bytes(resolve(root, ".build/jev-native"), 64 * 1_048_576),
  );
  return { gitHead: git(root, ["rev-parse", "HEAD"]), files };
}
async function verifyBase(checkpoint, prior = null) {
  if (
    !checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${RFDT_BASE_REVISION}`,
    )
  )
    fail("only the reviewed original Google Gemma 3 1B checkpoint is allowed");
  const files = {};
  for (const name of ["model.safetensors", "config.json", "tokenizer.json"])
    files[name] = await hashArtifact(resolve(checkpoint, name));
  if (files["model.safetensors"].sha256 !== baseWeightsSha256)
    fail("reviewed Google Gemma base weights changed");
  if (prior && JSON.stringify(files) !== JSON.stringify(prior))
    fail("base checkpoint changed since preparation");
  return files;
}
async function verifyBaseGguf(path) {
  const artifact = await hashArtifact(resolve(path));
  if (artifact.sha256 !== baseGgufSha256)
    fail("reviewed original Google Gemma base GGUF changed");
  return artifact;
}
async function verifyQuantizer(binaryPath, sourceDirectory) {
  const binary = await hashArtifact(resolve(binaryPath));
  if (binary.sha256 !== quantizerBinarySha256)
    fail("C9 Q8 quantizer binary differs from frozen local build");
  const source = resolve(sourceDirectory);
  if (git(source, ["rev-parse", "HEAD"]) !== quantizerSourceRevision)
    fail("C9 Q8 quantizer source revision changed");
  try {
    git(source, ["diff", "--quiet", "HEAD"]);
  } catch {
    fail("C9 Q8 quantizer source is dirty");
  }
  const libraryDirectory = dirname(resolve(binaryPath));
  const entries = (await readdir(libraryDirectory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".dylib"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const runtimeLibraries = {};
  const runtimeLibraryLinks = {};
  for (const entry of entries) {
    const file = resolve(libraryDirectory, entry.name);
    if (entry.isFile())
      runtimeLibraries[entry.name] = (await hashArtifact(file)).sha256;
    else if (entry.isSymbolicLink()) {
      const target = await readlink(file);
      if (target !== basename(target) || !target.endsWith(".dylib"))
        fail("C9 Q8 quantizer library link escapes its adjacent directory");
      runtimeLibraryLinks[entry.name] = target;
    } else fail("C9 Q8 quantizer library inventory changed");
  }
  if (
    Object.keys(runtimeLibraries).length !== 8 ||
    Object.keys(runtimeLibraryLinks).length !== 15 ||
    Object.values(runtimeLibraryLinks).some(
      (target) =>
        !(target in runtimeLibraries) && !(target in runtimeLibraryLinks),
    )
  )
    fail("C9 Q8 quantizer linked-library inventory changed");
  for (const start of Object.keys(runtimeLibraryLinks)) {
    const seen = new Set();
    let current = start;
    while (current in runtimeLibraryLinks) {
      if (seen.has(current)) fail("C9 Q8 quantizer library link cycle");
      seen.add(current);
      current = runtimeLibraryLinks[current];
    }
    if (!(current in runtimeLibraries))
      fail("C9 Q8 quantizer library link lacks a regular payload");
  }
  return { binary, source, runtimeLibraries, runtimeLibraryLinks };
}
async function runQuantizer(binary, source, target) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      binary,
      ["--leave-output-tensor", source, target, "Q8_0"],
      {
        stdio: "inherit",
        signal: controller.signal,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`C9 Q8 quantizer exited ${code ?? signal}`)),
    );
  });
}
async function verifyHost(sfPi, admission) {
  const hostCommit = git(sfPi, ["rev-parse", "HEAD"]);
  try {
    git(sfPi, ["diff", "--quiet", "HEAD"]);
  } catch {
    fail("sf-pi host has uncommitted tracked changes");
  }
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(sfPi, "extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ).href
  );
  if (
    hostCommit !== admission.source.hostCommit ||
    calculateJevRiskBaselineIdentity().sha256 !==
      admission.source.hostRuntimeSha256
  )
    fail("C9 sf-pi host commit or baseline runtime changed");
}
async function verifyInputs(values) {
  if (values["admission-sha256"] === supersededAdmissionSha256)
    fail("superseded C9 FIT admission has a blind-VALID operation overlap");
  const admissionRaw = await pinned(
    values.admission,
    values["admission-sha256"],
  );
  const admission = JSON.parse(admissionRaw);
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate9_fit_calibration_admission" ||
    admission.trainingReady !== true ||
    admission.calibration?.notPassedToFit !== true ||
    admission.source?.baseModel !== RFDT_BASE_MODEL ||
    admission.source?.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    admission.source?.hostCommit !== c9HostCommit ||
    admission.source?.hostRuntimeSha256 !== c9HostBaselineSha256 ||
    ![
      admission.source?.hostRuntimeSha256,
      admission.source?.c9SourceSha256,
      admission.source?.pairsSha256,
      admission.source?.familiesSha256,
      admission.source?.overlapReceiptSha256,
      admission.source?.hostControlsReceiptSha256,
      admission.source?.calibrationBaselineReceiptSha256,
      admission.fit?.sha256,
      admission.calibration?.sha256,
    ].every(pin)
  )
    fail("C9 FIT/CAL admission is incomplete or changed");
  if (values["blind-valid-manifest-sha256"] !== c9BlindValidManifestSha256)
    fail("replacement prospective C9 VALID seal is required before FIT");
  if (
    values["overlap-receipt-sha256"] !== admission.source.overlapReceiptSha256
  )
    fail("independent overlap receipt differs from admitted source");
  const [
    fitRaw,
    calRaw,
    pairRaw,
    familyRaw,
    objectiveRaw,
    blindRaw,
    overlapRaw,
    controlsRaw,
    calBaselineRaw,
  ] = await Promise.all([
    pinned(values.fit, admission.fit.sha256),
    pinned(values.cal, admission.calibration.sha256),
    pinned(values.pairs, admission.source.pairsSha256),
    pinned(values.families, admission.source.familiesSha256),
    bytes(values["objective-plan"]),
    pinned(
      values["blind-valid-manifest"],
      values["blind-valid-manifest-sha256"],
    ),
    pinned(values["overlap-receipt"], values["overlap-receipt-sha256"]),
    pinned(values["host-controls"], admission.source.hostControlsReceiptSha256),
    pinned(
      values["cal-baseline"],
      admission.source.calibrationBaselineReceiptSha256,
    ),
  ]);
  const controls = JSON.parse(controlsRaw);
  if (
    controls.version !== 1 ||
    controls.purpose !== "candidate9_host_controls" ||
    controls.baselineSha256 !== c9HostBaselineSha256 ||
    controls.policySha256 !== c9BundledPolicySha256 ||
    controls.source?.hostCommit !== c9HostCommit ||
    controls.source?.c9SourceSha256 !== admission.source.c9SourceSha256 ||
    !pin(controls.source?.scriptSha256) ||
    controls.modelCalls !== 0 ||
    controls.externalOperationsExecuted !== 0 ||
    controls.qualification !== false ||
    controls.heldOutTestRead !== false ||
    !Array.isArray(controls.records) ||
    controls.counts?.rows !== controls.records?.length ||
    controls.counts?.unchanged !== controls.records?.length ||
    controls.counts?.modelCalls !== 0 ||
    controls.records.some(
      (row) =>
        row.actualAction !== row.baselineAction ||
        row.modelCalls !== 0 ||
        !pin(row.effectivePolicySha256),
    ) ||
    !controls.records.some(
      (row) =>
        row.gate === "exact_policy_floor" &&
        row.baselineAction === "block" &&
        row.actualAction === "block" &&
        row.modelCalls === 0,
    )
  )
    fail("same-host code-owned floor controls are unverified");
  if (
    sha(await bytes(values["host-controls-script"])) !==
    controls.source.scriptSha256
  )
    fail("host-control replay script differs from admitted source");
  const fit = jsonl(fitRaw, "train");
  const cal = jsonl(calRaw, "calibration");
  const fitGroups = new Set(fit.map((row) => row.group_id));
  const calGroups = new Set(cal.map((row) => row.group_id));
  const fitIds = new Set(fit.map((row) => row.id));
  const fitInputs = new Set(
    fit.map((row) => sha(Buffer.from(canonical(row.request.state)))),
  );
  if (
    fit.length !== admission.fit.rows ||
    cal.length !== admission.calibration.rows ||
    fitGroups.size !== admission.fit.groups ||
    calGroups.size !== admission.calibration.groups ||
    [...fitGroups].some((group) => calGroups.has(group)) ||
    cal.some(
      (row) =>
        fitIds.has(row.id) ||
        fitInputs.has(sha(Buffer.from(canonical(row.request.state)))),
    )
  )
    fail("admitted FIT and CAL rows, operations or groups changed");
  const calBaseline = JSON.parse(calBaselineRaw);
  const calIds = new Map(
    cal.map((row) => [row.id, sha(Buffer.from(canonical(row.request.state)))]),
  );
  if (
    calBaseline.version !== 1 ||
    calBaseline.purpose !== "candidate9_train_cal_baseline_replay" ||
    calBaseline.baselineSha256 !== c9HostBaselineSha256 ||
    calBaseline.policySha256 !== c9BundledPolicySha256 ||
    calBaseline.calibrationCorpusSha256 !== admission.calibration.sha256 ||
    calBaseline.source?.hostCommit !== c9HostCommit ||
    calBaseline.source?.c9SourceSha256 !== admission.source.c9SourceSha256 ||
    !pin(calBaseline.source?.scriptSha256) ||
    calBaseline.modelCalls !== 0 ||
    calBaseline.externalOperationsExecuted !== 0 ||
    calBaseline.qualification !== false ||
    calBaseline.heldOutTestRead !== false ||
    !Array.isArray(calBaseline.records) ||
    calBaseline.records.length !== cal.length ||
    calBaseline.records.some(
      (row) =>
        calIds.get(row.id) !== row.inputSha256 ||
        row.gate !== "model_prepared" ||
        !["allow", "confirm", "block"].includes(row.action),
    ) ||
    new Set(calBaseline.records.map((row) => row.id)).size !== cal.length
  )
    fail("same-host CAL rules replay is incomplete or changed");
  if (
    sha(await bytes(values["cal-baseline-script"])) !==
    calBaseline.source.scriptSha256
  )
    fail("CAL baseline replay script differs from admitted source");
  const pair = JSON.parse(pairRaw);
  const family = JSON.parse(familyRaw);
  const objective = JSON.parse(objectiveRaw);
  if (
    pair.version !== 1 ||
    !Array.isArray(pair.pairs) ||
    family.version !== 1 ||
    family.purpose !== "candidate9_fit_families" ||
    !Array.isArray(family.rows) ||
    family.rows.length !== fit.length ||
    objective.version !== 2 ||
    objective.purpose !== "candidate9_train_only" ||
    objective.arm !== values.arm ||
    objective.pair_manifest_sha256 !== admission.source.pairsSha256 ||
    objective.family_manifest_sha256 !== admission.source.familiesSha256 ||
    objective.steps !== 256 ||
    objective.validation_rows_passed_to_training !== 0 ||
    objective.test_rows_passed_to_training !== 0
  )
    fail("C9 arm plan or FIT-only pair/family manifests changed");
  if (
    family.rows.some((row) => !fitIds.has(row.id)) ||
    pair.pairs.some(
      (row) => !fitIds.has(row.safe_id) || !fitIds.has(row.risky_id),
    )
  )
    fail("C9 family or pair manifest includes a non-FIT row");
  const blind = JSON.parse(blindRaw);
  if (
    blind.version !== 1 ||
    blind.purpose !== "candidate9_independent_prospective_valid_seal" ||
    blind.split !== "valid" ||
    blind.model_predictions_present !== false ||
    blind.held_out_test_read !== false ||
    blind.source?.case_count < 140 ||
    blind.source?.group_count < 70 ||
    blind.source?.sha256 !== c9BlindValidSourceSha256 ||
    blind.host?.commit !== admission.source.hostCommit ||
    blind.host?.baseline_identity_sha256 !==
      admission.source.hostRuntimeSha256 ||
    blind.host?.default_policy_sha256 !== c9BundledPolicySha256 ||
    !Array.isArray(blind.inventory?.ids) ||
    blind.inventory.ids.length !== blind.source.case_count ||
    new Set(blind.inventory.ids).size !== blind.source.case_count ||
    !pin(blind.inventory?.ordered_ids_sha256) ||
    typeof blind.inventory?.groups !== "object" ||
    Object.keys(blind.inventory.groups).length !== blind.source.group_count ||
    !pin(blind.inventory?.groups_sha256)
  )
    fail("blind C9 VALID seal is absent or belongs to another host");
  const overlap = JSON.parse(overlapRaw);
  if (
    overlap.version !== 1 ||
    overlap.schemaVersion !== "jev.guardrail.overlap-audit.v1" ||
    overlap.reviewCompleteness !== "exhaustive_adjudication" ||
    overlap.overlapFree !== true ||
    overlap.adjudicatedReplayCount !== 0 ||
    overlap.frozenSources?.c9TrainSourceSha256 !==
      admission.source.c9SourceSha256 ||
    overlap.frozenSources?.c9FitSha256 !== admission.fit.sha256 ||
    overlap.frozenSources?.c9CalibrationSha256 !==
      admission.calibration.sha256 ||
    overlap.frozenSources?.c9BlindValidSha256 !== c9BlindValidSourceSha256 ||
    overlap.sourceCommits?.c9BlindValid !==
      "67cad37ce02aa4932a17016cb4ae2edccd20d9b9" ||
    overlap.caseCounts?.c9Fit !== fit.length ||
    overlap.caseCounts?.c9Calibration !== cal.length ||
    overlap.caseCounts?.c9BlindValid !== blind.source.case_count
  )
    fail("independent C9 TRAIN/VALID split-overlap audit did not pass");
  if (!values["sf-pi"] || !values["sf-pi"].startsWith("/"))
    fail("absolute final sf-pi checkout required");
  await verifyHost(resolve(values["sf-pi"]), admission);
  const code = await sourceIdentity({
    pairs: values.pairs,
    families: values.families,
    objective: values["objective-plan"],
  });
  return {
    admissionSha256: values["admission-sha256"],
    fit: {
      path: resolve(values.fit),
      sha256: admission.fit.sha256,
      preparedDatasetSha256: sha(
        Buffer.from(fit.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      ),
      rows: fit.length,
      groups: fitGroups.size,
    },
    calibration: {
      sha256: admission.calibration.sha256,
      rows: cal.length,
      groups: calGroups.size,
      notPassedToFit: true,
    },
    pairsSha256: admission.source.pairsSha256,
    familiesSha256: admission.source.familiesSha256,
    objectiveSha256: sha(objectiveRaw),
    blindValidManifestSha256: values["blind-valid-manifest-sha256"],
    blindValidSourceSha256: blind.source.sha256,
    overlapReceiptSha256: values["overlap-receipt-sha256"],
    hostCommit: admission.source.hostCommit,
    hostRuntimeSha256: admission.source.hostRuntimeSha256,
    arm: values.arm,
    inferenceArtifactFormat,
    code,
  };
}
async function verifyPrepared(run, source, plan) {
  const manifest = JSON.parse(await bytes(resolve(run, "manifest.json")));
  if (
    manifest.base_model !== RFDT_BASE_MODEL ||
    manifest.base_revision !== RFDT_BASE_REVISION ||
    manifest.template_version !== "v2" ||
    manifest.source?.sha256 !== source.fit.sha256 ||
    manifest.source?.examples !== source.fit.rows ||
    manifest.prepared?.branches?.train !== source.fit.rows ||
    manifest.prepared?.branches?.validation !== 0 ||
    manifest.prepared?.branches?.test !== 0 ||
    manifest.prepared?.dataset_sha256 !== source.fit.preparedDatasetSha256 ||
    manifest.prepared?.sha256 !== plan.rfdtPreparedSha256
  )
    fail("RFDT prepared run changed or includes reserved rows");
  if (
    sha(await bytes(resolve(run, "dataset.jsonl"))) !==
    source.fit.preparedDatasetSha256
  )
    fail("prepared FIT bytes changed");
  for (const split of ["validation", "test"])
    if ((await bytes(resolve(run, `${split}.jsonl`))).length !== 0)
      fail(`RFDT ${split} branch must remain empty`);
}
async function attempt(run, phase, source, action) {
  const file = resolve(run, `candidate9-${phase}-attempt-${randomUUID()}.json`);
  const disk = await statfs(root);
  const began = {
    version: 1,
    purpose: "candidate9_fit_only_attempt",
    phase,
    status: "started",
    startedAt: new Date().toISOString(),
    source,
    qualification: false,
    validationRead: false,
    heldOutTestRead: false,
    diskAvailableBytesAtStart: disk.bavail * disk.bsize,
  };
  await writeFile(file, JSON.stringify(began, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const result = await action();
    await writeFile(
      file,
      JSON.stringify({ ...began, status: "complete", result }, null, 2) + "\n",
      { mode: 0o600 },
    );
    return result;
  } catch (error) {
    await writeFile(
      file,
      JSON.stringify(
        {
          ...began,
          status: controller.signal.aborted ? "aborted" : "failed",
          error: String(error),
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
  options: Object.fromEntries(
    [
      "admission",
      "admission-sha256",
      "fit",
      "cal",
      "pairs",
      "families",
      "objective-plan",
      "blind-valid-manifest",
      "blind-valid-manifest-sha256",
      "overlap-receipt",
      "overlap-receipt-sha256",
      "host-controls",
      "host-controls-script",
      "cal-baseline",
      "cal-baseline-script",
      "sf-pi",
      "checkpoint",
      "base-gguf",
      "run",
      "arm",
      "model-id",
      "quantizer-binary",
      "quantizer-source",
    ].map((name) => [name, { type: "string" }]),
  ),
});
const phase = positionals[0];
if (!["preflight", "prepare", "train", "export", "quantize"].includes(phase))
  fail("use preflight, prepare, train, export, or quantize");
if (!["A", "B"].includes(values.arm)) fail("--arm A or B is required");
for (const name of [
  "admission",
  "fit",
  "cal",
  "pairs",
  "families",
  "objective-plan",
  "blind-valid-manifest",
  "overlap-receipt",
  "host-controls",
  "host-controls-script",
  "cal-baseline",
  "cal-baseline-script",
  "sf-pi",
  "checkpoint",
  "base-gguf",
])
  if (!values[name]) fail(`--${name} is required`);
const source = await verifyInputs(values);
const checkpoint = resolve(values.checkpoint);
const baseFiles = await verifyBase(checkpoint);
const baseGguf = await verifyBaseGguf(values["base-gguf"]);
if (phase === "preflight") {
  const disk = await statfs(root);
  console.log(
    JSON.stringify({
      phase,
      source,
      checkpoint,
      baseFiles,
      baseGguf,
      diskAvailableBytes: disk.bavail * disk.bsize,
      qualification: false,
    }),
  );
  process.exit(0);
}
const run = runPath(values.run);
if (phase === "prepare") {
  await mkdir(build, { recursive: true });
  await mkdir(run, { recursive: false });
  const result = await attempt(run, phase, source, async () => {
    const config = {
      ...configFromEnv({
        JEV_DEVICE: "metal",
        JEV_MODEL_ID: RFDT_BASE_MODEL,
        JEV_MODEL_FILE: resolve(values["base-gguf"]),
        JEV_TEMPLATE_VERSION: "v2",
      }),
      ...compilerLimits,
    };
    const manifest = await prepareRfdt(source.fit.path, {
      outputDir: run,
      templateVersion: "v2",
      config,
      signal: controller.signal,
    });
    const plan = {
      version: 1,
      purpose: "candidate9_fit_only_rfdt",
      qualification: false,
      validationRead: false,
      heldOutTestRead: false,
      source,
      checkpoint,
      baseFiles,
      baseGguf,
      steps: 256,
      inferenceArtifactFormat,
      compilerLimits,
      rfdtPreparedSha256: manifest.prepared.sha256,
      selection: "C9_TRAIN_CAL_hard_veto_before_blind_VALID",
    };
    await verifyPrepared(run, source, plan);
    await writeFile(
      resolve(run, "candidate9-fit-plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return {
      preparedSha256: manifest.prepared.sha256,
      arm: source.arm,
      steps: 256,
    };
  });
  console.log(
    JSON.stringify({ phase: "prepared", run, ...result, qualification: false }),
  );
  process.exit(0);
}
const plan = JSON.parse(await bytes(resolve(run, "candidate9-fit-plan.json")));
if (
  plan.version !== 1 ||
  plan.purpose !== "candidate9_fit_only_rfdt" ||
  plan.qualification !== false ||
  plan.validationRead !== false ||
  plan.heldOutTestRead !== false ||
  plan.steps !== 256 ||
  plan.inferenceArtifactFormat !== inferenceArtifactFormat ||
  plan.selection !== "C9_TRAIN_CAL_hard_veto_before_blind_VALID" ||
  JSON.stringify(plan.source) !== JSON.stringify(source) ||
  plan.checkpoint !== checkpoint ||
  JSON.stringify(plan.baseGguf) !== JSON.stringify(baseGguf) ||
  JSON.stringify(plan.compilerLimits) !== JSON.stringify(compilerLimits)
)
  fail("frozen C9 FIT plan changed");
await verifyBase(plan.checkpoint, plan.baseFiles);
await verifyPrepared(run, source, plan);
if (phase === "train") {
  const result = await attempt(run, phase, source, async () => {
    const manifest = await trainRfdt(run, {
      steps: 256,
      modelPath: plan.checkpoint,
      guardrailPairsPath: resolve(values.pairs),
      guardrailFamiliesPath: resolve(values.families),
      guardrailPlanPath: resolve(values["objective-plan"]),
      signal: controller.signal,
    });
    return { status: manifest.status, training: manifest.training };
  });
  console.log(
    JSON.stringify({
      phase: "trained",
      run,
      arm: source.arm,
      status: result.status,
      qualification: false,
    }),
  );
  process.exit(0);
}
if (phase === "quantize") {
  if (!values["quantizer-binary"] || !values["quantizer-source"])
    fail("quantize requires pinned --quantizer-binary and --quantizer-source");
  const quantizer = await verifyQuantizer(
    values["quantizer-binary"],
    values["quantizer-source"],
  );
  const result = await attempt(run, phase, source, async () => {
    const parent = JSON.parse(await bytes(resolve(run, "artifact.json")));
    const f16 = await verifyTrainedArtifactExport(parent);
    if (f16.id !== parent.id || !f16.file.endsWith("gemma-3-1b-rfdt-f16.gguf"))
      fail("F16 parent artifact is not the frozen RFDT export");
    const q8File = resolve(run, "gemma-3-1b-rfdt-q8_0.gguf");
    try {
      await lstat(q8File);
      fail("Q8 output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await runQuantizer(resolve(values["quantizer-binary"]), f16.file, q8File);
    const afterQuantization = await verifyQuantizer(
      values["quantizer-binary"],
      values["quantizer-source"],
    );
    if (
      canonical(afterQuantization.runtimeLibraries) !==
        canonical(quantizer.runtimeLibraries) ||
      canonical(afterQuantization.runtimeLibraryLinks) !==
        canonical(quantizer.runtimeLibraryLinks)
    )
      fail("C9 Q8 quantizer linked libraries changed during export");
    const q8 = await hashArtifact(q8File);
    const outputFile = await open(q8File, "r");
    try {
      const magic = Buffer.alloc(4);
      await outputFile.read(magic, 0, 4, 0);
      if (magic.toString("ascii") !== "GGUF") fail("Q8 output is not GGUF");
    } finally {
      await outputFile.close();
    }
    const id = `${f16.id}-q8_0`;
    const descriptor = {
      ...f16,
      id,
      file: q8File,
      sha256: q8.sha256,
      size: q8.size,
    };
    const registry = Buffer.from(
      JSON.stringify({ version: 1, artifacts: [descriptor] }, null, 2) + "\n",
    );
    const registryFile = resolve(run, "q8-candidate-registry.json");
    await writeFile(registryFile, registry, { flag: "wx", mode: 0o600 });
    const manifest = {
      version: 1,
      purpose: "candidate9_same_weights_q8_0_calibration_candidate",
      qualification: false,
      sourceWeights: {
        modelId: f16.id,
        file: f16.file,
        sha256: f16.sha256,
        size: f16.size,
      },
      quantizer: {
        sourceDirectory: quantizer.source,
        sourceRevision: quantizerSourceRevision,
        binarySha256: quantizer.binary.sha256,
        runtimeLibraries: quantizer.runtimeLibraries,
        runtimeLibraryLinks: quantizer.runtimeLibraryLinks,
        type: "Q8_0",
        leaveOutputTensorUnquantized: true,
        importanceMatrix: null,
      },
      output: {
        modelId: id,
        file: q8File,
        sha256: q8.sha256,
        size: q8.size,
        registrySha256: sha(registry),
      },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(
      resolve(run, "candidate9-q8-manifest.json"),
      manifestBytes,
      { flag: "wx", mode: 0o600 },
    );
    return {
      inferenceArtifactFormat,
      modelId: id,
      modelSha256: q8.sha256,
      quantizationManifestSha256: sha(manifestBytes),
      registrySha256: sha(registry),
      qualification: false,
    };
  });
  console.log(
    JSON.stringify({ phase: "quantized", run, arm: source.arm, ...result }),
  );
  process.exit(0);
}
if (!/^jev\/[a-zA-Z0-9._-]+$/.test(values["model-id"] ?? ""))
  fail("export requires --model-id jev/ID");
const result = await attempt(run, phase, source, async () => {
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
  return {
    artifact: artifact.file,
    artifactSha256: artifact.sha256,
    parentArtifactFormat: "GGUF_F16",
    candidateArtifactFormat: inferenceArtifactFormat,
  };
});
console.log(
  JSON.stringify({ phase: "exported", run, ...result, qualification: false }),
);
