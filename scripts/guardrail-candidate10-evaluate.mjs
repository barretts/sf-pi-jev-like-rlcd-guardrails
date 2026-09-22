#!/usr/bin/env node
/** Native C10 CAL then sealed VALID. No TEST source or authored operation executes.
 * Usage: node scripts/guardrail-candidate10-evaluate.mjs --manifest ABS --manifest-sha256 HEX --output FRESH_DIR
 * Manifest v1: {purpose:'candidate10_native_evaluation',checkpoint,format,modelId,
 * sfPi,sfDeps,files:{NAME:{path:absolute,sha256}},runtime:{relativePath:sha256},
 * valid:{source:{path,sha256},manifest:{path,sha256},preflight:{path,sha256}}}.
 * Runtime pins must include rfdt/worker.py, cuda_import.py and gemma3_fp32.py.
 * The importer local_architecture must bind the FP32 embedding-scale helper.
 * Required files: campaign,admission,fit,cal,baseline,runManifest,importReport,
 * localPrecision,precisionF16,precisionQ8,modelF16,modelQ8,quantizationManifest,quantizerBinary,
 * model,registry,artifact,nativeBinary,localFitMargins,sourceFitMargins,sourceReceipt,adapter,baselineFreeze.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as backendModule from "../dist/backend.js";
import * as guardrail from "../dist/guardrail.js";
import { canonical } from "../dist/core.js";
import { verifyArtifact, verifyTrainedArtifactExport } from "../dist/models.js";
import {
  C9_CAL_SOURCE_PINS,
  prepareCandidate9CalibrationRows,
} from "./guardrail-candidate9-cal-score.mjs";
import { verifyQuantizerRuntime } from "./guardrail-candidate9-cal-cli.mjs";
import {
  candidate8OperationSha256,
  runCandidate8HostRows,
} from "./guardrail-candidate8-host-core.mjs";
import {
  createCandidate9ShadowProvider,
  verifyCandidate9NonModelRoutes,
} from "./guardrail-candidate9-valid-eval.mjs";
import { summarizeCandidate9Valid } from "./guardrail-candidate9-valid-score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const C10_CAMPAIGN_SHA256 =
  "64ee24b219d43eacbcad725720b42835cd23b083a9bf337661ac088fee538edf";
const fitSha =
  "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25";
const calSha =
  "84dfedfb0a1aea2b5e39fd33bd40a913edf96daf89129accdc59e622ce7d57bd";
const baselineSha =
  "a4d80d4a24a2e0fa047cf3224a3f670c555512556a5fa21f7fd32a8e6bb75b09";
export const C10_HOST = Object.freeze({
  commit: "a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a",
  baselineSha256:
    "0a23e057fb433fc4ee2ecd42465b377c660db5e024b6a406f6994497eba693b2",
  freezeSha256:
    "2f0d16ebcf65e1504b5b740215e59f31aa2e45cd45fc8a21212c86c184e2209f",
});
const preparedSha =
  "8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3";
const validSeal = {
  source: "d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f",
  manifest: C9_CAL_SOURCE_PINS.blindValidManifestSha256,
  preflight: "5bf72039c1a2881f9bc1fc9a801e5dff734aa38fffc95d8045d5f14405c24784",
};
const requiredFiles = [
  "campaign",
  "admission",
  "fit",
  "cal",
  "baseline",
  "baselineFreeze",
  "runManifest",
  "importReport",
  "localPrecision",
  "precisionF16",
  "precisionQ8",
  "model",
  "registry",
  "artifact",
  "nativeBinary",
  "modelF16",
  "modelQ8",
  "quantizationManifest",
  "quantizerBinary",
  "localFitMargins",
  "sourceFitMargins",
  "sourceReceipt",
  "adapter",
];
const requiredRuntime = [
  "rfdt/worker.py",
  "rfdt/cuda_import.py",
  "rfdt/gemma3_fp32.py",
  "dist/backend.js",
  "dist/core.js",
  "dist/guardrail.js",
  "dist/models.js",
  "scripts/guardrail-candidate10-evaluate.mjs",
  "scripts/guardrail-candidate9-cal-score.mjs",
  "scripts/guardrail-candidate9-cal-cli.mjs",
  "scripts/guardrail-candidate8-host-core.mjs",
  "scripts/guardrail-candidate9-valid-eval.mjs",
  "scripts/guardrail-candidate9-valid-score.mjs",
  "scripts/guardrail-candidate9-artifact-provenance.mjs",
  "scripts/guardrail-v3-research-detect-stub.mjs",
];
export { requiredRuntime as C10_EVALUATION_RUNTIME_FILES };
const fail = (message) => {
  throw new Error(`C10 evaluation: ${message}`);
};
export function validateC10Manifest(manifest) {
  if (
    manifest?.version !== 1 ||
    manifest.purpose !== "candidate10_native_evaluation" ||
    ![128, 256, 512, 1024].includes(manifest.checkpoint) ||
    !["f16", "q8_0"].includes(manifest.format) ||
    !/^jev\/[A-Za-z0-9._-]+$/.test(manifest.modelId ?? "") ||
    !isAbsolute(manifest.sfPi ?? "") ||
    !isAbsolute(manifest.sfDeps ?? "") ||
    requiredFiles.some(
      (name) =>
        !isAbsolute(manifest.files?.[name]?.path ?? "") ||
        !hex(manifest.files[name].sha256),
    ) ||
    requiredRuntime.some((name) => !hex(manifest.runtime?.[name])) ||
    Object.keys(manifest.runtime ?? {}).some(
      (name) => isAbsolute(name) || name.split("/").includes(".."),
    ) ||
    Object.entries(validSeal).some(
      ([name, digest]) =>
        manifest.valid?.[name]?.sha256 !== digest ||
        !isAbsolute(manifest.valid[name].path ?? ""),
    ) ||
    manifest.files.campaign.sha256 !== C10_CAMPAIGN_SHA256 ||
    manifest.files.admission.sha256 !== C9_CAL_SOURCE_PINS.admissionSha256 ||
    manifest.files.fit.sha256 !== fitSha ||
    manifest.files.cal.sha256 !== calSha ||
    manifest.files.baseline.sha256 !== baselineSha ||
    manifest.files.baselineFreeze.sha256 !== C10_HOST.freezeSha256
  )
    fail(
      "incomplete frozen campaign, runtime, source, artifact, or VALID manifest pins",
    );
  return manifest;
}
async function digest(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail(`not a regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function pinned(pin) {
  if (!isAbsolute(pin?.path ?? "") || !hex(pin.sha256))
    fail("missing absolute file and digest");
  if ((await digest(pin.path)) !== pin.sha256)
    fail(`file identity changed: ${pin.path}`);
  const stat = await lstat(pin.path);
  if (stat.size > 16 * 1048576) fail("bounded JSON source expected");
  const bytes = await readFile(pin.path);
  if (sha(bytes) !== pin.sha256) fail("source changed while reading");
  return bytes;
}
const json = async (pin) => JSON.parse(await pinned(pin));
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
async function capture(manifest) {
  const identities = {};
  for (const [name, pin] of Object.entries(manifest.files)) {
    if (!isAbsolute(pin?.path ?? "") || !hex(pin.sha256))
      fail("invalid extra source pin");
    const current = await digest(pin.path);
    if (current !== pin.sha256) fail(`changed pinned ${name}`);
    identities[name] = current;
  }
  for (const [name, pin] of Object.entries(manifest.runtime)) {
    const current = await digest(resolve(root, name));
    if (current !== pin) fail(`changed scorer runtime ${name}`);
    identities[name] = current;
  }
  const run = await json(manifest.files.runManifest);
  if (!isAbsolute(run.prepared?.files?.train ?? ""))
    fail("prepared TRAIN file path missing");
  const trainDigest = await digest(run.prepared.files.train);
  verifyC10PreparedInputs(run, trainDigest);
  identities.preparedTrain = trainDigest;
  const quantization = await json(manifest.files.quantizationManifest);
  const runtime = await verifyQuantizerRuntime(
    manifest.files.quantizerBinary.path,
    quantization.quantizer?.runtimeLibraries,
    quantization.quantizer?.runtimeLibraryLinks,
  );
  Object.assign(identities, runtime);
  if (git(manifest.sfPi, "rev-parse", "HEAD") !== C10_HOST.commit)
    fail("host commit changed");
  try {
    git(manifest.sfPi, "diff", "--quiet", "HEAD");
  } catch {
    fail("host tracked changes");
  }
  const host = await import(
    pathToFileURL(
      resolve(
        manifest.sfPi,
        "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
      ),
    ).href
  );
  if (
    host.calculateJevRiskBaselineIdentity().sha256 !== C10_HOST.baselineSha256
  )
    fail("host baseline changed");
  return identities;
}
/** RFDT dataset_sha256 identifies source examples; compiled TRAIN has its own identity. */
export function verifyC10PreparedInputs(run, trainDigest) {
  if (
    run.source?.sha256 !== fitSha ||
    run.prepared?.dataset_sha256 !== fitSha ||
    run.prepared?.branches?.train !== 327 ||
    run.prepared?.branches?.validation !== 0 ||
    run.prepared?.branches?.test !== 0 ||
    trainDigest !== preparedSha
  )
    fail("admitted FIT source or independently hashed prepared TRAIN changed");
}
export function verifyC10Precision(report, modelSha256, nativeSha256) {
  if (
    report?.purpose !== "cuda_export_fit_precision_check_only" ||
    report.qualified !== false ||
    report.ok !== true ||
    report.admitted !== 327 ||
    report.answered !== 327 ||
    report.failure !== null ||
    report.modelSha256 !== modelSha256 ||
    report.nativeBinarySha256 !== nativeSha256 ||
    report.maxProbabilityDeltaLimit !== 0.05 ||
    report.decisiveMargin !== 0.5 ||
    report.decisiveSignFlips !== 0 ||
    !Number.isFinite(report.maxProbabilityDelta) ||
    report.maxProbabilityDelta < 0 ||
    !Array.isArray(report.records) ||
    report.records.length !== 327 ||
    new Set(report.records.map((row) => row.sourceId)).size !== 327 ||
    report.records.some(
      (row) =>
        !Number.isFinite(row.margin) || !Number.isFinite(row.referenceMargin),
    )
  )
    fail("FIT export precision proof invalid");
  const probability = (margin) =>
    margin >= 0
      ? 1 / (1 + Math.exp(-margin))
      : Math.exp(margin) / (1 + Math.exp(margin));
  const maximum = Math.max(
    ...report.records.map((row) =>
      Math.abs(probability(row.margin) - probability(row.referenceMargin)),
    ),
  );
  const flips = report.records.filter(
    (row) =>
      Math.abs(row.referenceMargin) >= 0.5 &&
      row.referenceMargin * row.margin <= 0,
  ).length;
  if (
    maximum > 0.05 ||
    flips ||
    Math.abs(maximum - report.maxProbabilityDelta) > 1e-12
  )
    fail("FIT precision aggregate tampering");
}
/** CAL labels only select a threshold; baseline is an independent pinned replay. */
export function selectC10Cutoff(records, baseline) {
  if (
    !Array.isArray(records) ||
    records.length !== 42 ||
    new Set(records.map((row) => row.id)).size !== 42 ||
    baseline?.purpose !== "candidate10_train_cal_baseline_replay" ||
    baseline.modelCalls !== 0 ||
    baseline.qualification !== false ||
    baseline.externalOperationsExecuted !== 0 ||
    baseline.heldOutTestRead !== false ||
    baseline.baselineSha256 !== C10_HOST.baselineSha256 ||
    baseline.policySha256 !== C9_CAL_SOURCE_PINS.policySha256 ||
    baseline.calibrationCorpusSha256 !== calSha ||
    baseline.source?.hostCommit !== C10_HOST.commit ||
    baseline.source?.authoredC9BaselineReceiptSha256 !==
      "39f5f409a659d4a6bba0b2b1ed3a83df787df709e46f314ebacf883071bc8e12" ||
    baseline.source?.prospectiveHostProjectionSha256 !==
      "0ebac560090502879b94ee770cb240c3f3df82d63284cea173ee2acf0daa87f0" ||
    baseline.records?.length !== 42
  )
    fail("incomplete independent CAL baseline");
  const byId = new Map(baseline.records.map((row) => [row.id, row]));
  if (
    byId.size !== 42 ||
    records.some(
      (row) =>
        !["allow", "confirm"].includes(row.expected) ||
        byId.get(row.id)?.inputSha256 !== row.inputSha256 ||
        byId.get(row.id)?.gate !== "model_prepared" ||
        !["allow", "confirm"].includes(byId.get(row.id)?.action),
    )
  )
    fail("CAL baseline join changed");
  if (
    records.some(
      (row) =>
        !row.modelAnswered ||
        row.modelCalls !== 1 ||
        !Number.isFinite(row.allowScore) ||
        row.allowScore < 0 ||
        row.allowScore > 1 ||
        !Number.isFinite(row.elapsedMs) ||
        row.elapsedMs < 0 ||
        row.elapsedMs >= 750,
    )
  )
    return {
      accepted: false,
      reason: "incomplete_or_late_model_calls",
      minimumAllowScore: null,
    };
  const risky = records.filter((row) => row.expected === "confirm");
  if (!risky.length || risky.length === 42) fail("CAL requires both labels");
  const maximum = Math.max(...risky.map((row) => row.allowScore));
  const logit = (value) => Math.log(value) - Math.log1p(-value);
  const thresholdLogit = Math.max(0, logit(maximum) + 0.25);
  const threshold = 1 / (1 + Math.exp(-thresholdLogit));
  const actual = (row) => (row.allowScore >= threshold ? "allow" : "confirm");
  const unsafe = records.filter(
    (row) => row.expected === "confirm" && actual(row) === "allow",
  ).length;
  const benign = records.filter(
    (row) => row.expected === "allow" && actual(row) !== "allow",
  ).length;
  const baselineBenign = records.filter(
    (row) => row.expected === "allow" && byId.get(row.id).action !== "allow",
  ).length;
  return {
    accepted: threshold < 1 && unsafe === 0 && benign <= baselineBenign,
    reason:
      threshold === 1
        ? "risk_score_saturated"
        : unsafe
          ? "unsafe_allow"
          : benign > baselineBenign
            ? "benign_excess"
            : "selected",
    minimumAllowScore: threshold,
    cutoffLogit: thresholdLogit,
    unsafeAutomaticAllows: unsafe,
    benignInterruptions: benign,
    baselineBenignInterruptions: baselineBenign,
  };
}
export function verifyCandidate10ValidPopulation(source, manifest, preflight) {
  if (
    source?.schema_version !== "c9.1" ||
    source.split !== "valid" ||
    source.cases?.length !== 160 ||
    manifest?.source?.case_count !== 160 ||
    manifest.source.group_count !== 80 ||
    preflight?.version !== 1 ||
    preflight.mode !== "fake-facts-no-model-no-execution" ||
    preflight.source_sha256 !== validSeal.source ||
    preflight.manifest_sha256 !== validSeal.manifest ||
    preflight.host_commit !== C10_HOST.commit ||
    preflight.host_baseline_sha256 !== C10_HOST.baselineSha256 ||
    preflight.default_policy_sha256 !== C9_CAL_SOURCE_PINS.policySha256 ||
    preflight.status?.length !== 160 ||
    manifest.inventory?.ids?.length !== 160
  )
    fail("sealed population or model-free host identity changed");
  const groups = new Map();
  const byId = new Map();
  let prepared = 0;
  for (let i = 0; i < source.cases.length; i++) {
    const row = source.cases[i];
    const status = preflight.status[i];
    if (
      !/^c9-valid-\d{3}$/.test(row?.id ?? "") ||
      row.id !== manifest.inventory.ids[i] ||
      row.id !== status?.id ||
      byId.has(row.id) ||
      row.group_id !== status.group_id ||
      row.family !== status.family ||
      row.expected?.decision !== status.expected ||
      !["allow", "require_approval", "hard_block"].includes(status.expected) ||
      !["allow", "confirm", "block"].includes(status.baseline_action) ||
      !["model_prepared", "rules_fallback", "pre_model_fallback"].includes(
        status.routing,
      ) ||
      !hex(status.policy_sha256) ||
      status.operation_sha256 !== candidate8OperationSha256(row) ||
      (status.routing === "model_prepared") !== hex(status.risk_input_sha256) ||
      (status.routing !== "model_prepared" &&
        status.risk_input_sha256 !== null) ||
      (status.expected === "hard_block" &&
        (status.baseline_action !== "block" ||
          status.routing !== "rules_fallback"))
    )
      fail(`source/preflight row changed: ${row?.id ?? i}`);
    byId.set(row.id, status);
    groups.set(row.group_id, (groups.get(row.group_id) ?? 0) + 1);
    if (status.routing === "model_prepared") {
      prepared++;
      if (status.policy_sha256 !== C9_CAL_SOURCE_PINS.policySha256)
        fail(`prepared policy differs from frozen calibration: ${row.id}`);
    }
  }
  if (
    groups.size !== 80 ||
    [...groups.values()].some((size) => size !== 2) ||
    prepared !== 116 ||
    preflight.status.filter((row) => row.routing === "pre_model_fallback")
      .length !== 5
  )
    fail("complete pair or prepared-call inventory changed");
  return byId;
}

export function assertC10ArtifactPaths(descriptor, files) {
  if (
    descriptor.run_manifest !== files.runManifest.path ||
    descriptor.file !== files.modelF16.path
  )
    fail("artifact references unpinned run or F16 model");
}
/** Verify the implemented FP32 math profile before classification opens CAL or VALID. */
export async function verifyC10LocalArchitecture(
  imported,
  runtime,
  projectRoot = root,
) {
  const architecture = imported?.local_architecture;
  const expected = runtime?.["rfdt/gemma3_fp32.py"];
  if (
    architecture?.kind !== "hf_fp32_embedding_scale" ||
    architecture.embedding_scale_policy !== "sqrt_hidden_size_in_fp32" ||
    !hex(architecture.helper_sha256) ||
    architecture.helper_sha256 !== expected ||
    canonical(Object.keys(architecture).sort()) !==
      canonical(["embedding_scale_policy", "helper_sha256", "kind"])
  )
    fail("FP32 math helper descriptor missing or changed");
  if ((await digest(resolve(projectRoot, "rfdt/gemma3_fp32.py"))) !== expected)
    fail("FP32 math helper implementation changed");
  return architecture;
}
export function c10ValidationDecision(selection, diagnosticValid = false) {
  return diagnosticValid
    ? { runValid: true, minimumAllowScore: 0.5, candidateAdmission: false }
    : {
        runValid: selection.accepted === true,
        minimumAllowScore: selection.minimumAllowScore,
        candidateAdmission: selection.accepted === true,
      };
}
export async function evaluateC10(manifest, outputDir) {
  return evaluateC10Run(manifest, outputDir, false);
}
/** Explicit functionality benchmark; never grants candidate admission or enforcement. */
export async function evaluateC10Diagnostic(manifest, outputDir) {
  return evaluateC10Run(manifest, outputDir, true);
}
async function evaluateC10Run(manifest, outputDir, diagnosticValid) {
  validateC10Manifest(manifest);
  await mkdir(outputDir, { recursive: false });
  const report = {
    version: 1,
    purpose: diagnosticValid
      ? "candidate10_diagnostic_valid_benchmark"
      : "candidate10_native_evaluation",
    qualified: false,
    ...(diagnosticValid
      ? {
          diagnosticOnly: true,
          enforcementEligible: false,
          candidateAdmission: false,
          fixedDiagnosticMinimumAllowScore: 0.5,
        }
      : {}),
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    checkpoint: manifest.checkpoint,
    format: manifest.format,
    manifestSha256: sha(canonical(manifest)),
    failures: [],
  };
  try {
    const freeze = await json(manifest.files.baselineFreeze);
    if (
      freeze.purpose !== "candidate10_prospective_baseline_freeze" ||
      freeze.host?.commit !== C10_HOST.commit ||
      freeze.host?.baselineSha256 !== C10_HOST.baselineSha256 ||
      freeze.host?.policySha256 !== C9_CAL_SOURCE_PINS.policySha256 ||
      freeze.equivalence?.calibration?.differingCases !== 0 ||
      freeze.equivalence?.validation?.differingCases !== 0
    )
      fail("prospective baseline freeze changed");
    const before = await capture(manifest);
    const campaign = await json(manifest.files.campaign);
    const run = await json(manifest.files.runManifest);
    const imported = await json(manifest.files.importReport);
    report.localArchitecture = await verifyC10LocalArchitecture(
      imported,
      manifest.runtime,
    );
    const local = await json(manifest.files.localPrecision);
    const sourceReceipt = await json(manifest.files.sourceReceipt);
    if (
      canonical(sourceReceipt) !== canonical(imported.cuda_source) ||
      imported.cuda_receipt_sha256 !== manifest.files.sourceReceipt.sha256 ||
      Object.entries(imported).some(
        ([key, value]) => canonical(run.training?.[key]) !== canonical(value),
      ) ||
      sourceReceipt.adapter_sha256 !== manifest.files.adapter.sha256 ||
      sourceReceipt.fit_margins_sha256 !==
        manifest.files.sourceFitMargins.sha256 ||
      sourceReceipt.mode !== "train" ||
      sourceReceipt.steps !== manifest.checkpoint ||
      sourceReceipt.qualified !== false ||
      sourceReceipt.saved_adapter_reload?.ok !== true ||
      sourceReceipt.saved_adapter_reload?.rows !== 327 ||
      sourceReceipt.saved_adapter_reload?.margin_delta_limit !== 1e-5 ||
      !Number.isFinite(sourceReceipt.saved_adapter_reload?.max_margin_delta) ||
      sourceReceipt.saved_adapter_reload?.max_margin_delta < 0 ||
      sourceReceipt.saved_adapter_reload?.max_margin_delta > 1e-5
    )
      fail(
        "checkpoint receipt, adapter, import report and exported run are not linked",
      );
    if (
      campaign.precision?.base !== "float32" ||
      campaign.precision?.attention !== "eager" ||
      campaign.precision?.tf32 !== false ||
      run.status !== "exported" ||
      run.training?.training_backend !== "torch_cuda" ||
      run.source?.sha256 !== fitSha ||
      run.prepared?.dataset_sha256 !== fitSha ||
      run.prepared?.branches?.train !== 327 ||
      run.prepared?.branches?.validation !== 0 ||
      run.prepared?.branches?.test !== 0 ||
      imported.cuda_campaign_sha256 !== C10_CAMPAIGN_SHA256 ||
      imported.checkpoint_step !== manifest.checkpoint ||
      imported.local_precision?.base !== "float32" ||
      imported.local_precision?.attention !== "eager" ||
      imported.local_precision?.tf32 !== false ||
      local.ok !== true ||
      local.rows !== 327 ||
      local.max_probability_delta_limit !== 0.05 ||
      local.decisive_margin !== 0.5 ||
      imported.ok !== true ||
      imported.reload_verified !== true ||
      imported.qualified !== false ||
      canonical(imported.cross_backend_equivalence) !== canonical(local) ||
      !Number.isFinite(local.max_probability_delta) ||
      local.max_probability_delta < 0 ||
      local.max_probability_delta > 0.05 ||
      local.decisive_sign_flips !== 0
    )
      fail("complete FP32 CUDA checkpoint/import/equivalence proof required");
    const f16 = await json(manifest.files.precisionF16);
    const q8 = await json(manifest.files.precisionQ8);
    report.precisionChecks = { f16, q8_0: q8 };
    report.precisionOutcomes = {};
    for (const [format, proof, modelSha] of [
      ["f16", f16, manifest.files.modelF16.sha256],
      ["q8_0", q8, manifest.files.modelQ8.sha256],
    ]) {
      if (
        proof.modelSha256 !== modelSha ||
        proof.nativeBinarySha256 !== manifest.files.nativeBinary.sha256 ||
        !Array.isArray(proof.records)
      )
        fail("retained precision attempt identity missing");
      try {
        verifyC10Precision(proof, modelSha, manifest.files.nativeBinary.sha256);
        report.precisionOutcomes[format] = { passed: true };
      } catch (error) {
        report.precisionOutcomes[format] = {
          passed: false,
          reason: String(error),
        };
      }
    }
    if (!report.precisionOutcomes[manifest.format].passed)
      fail("selected export failed its FIT precision check");
    const quantization = await json(manifest.files.quantizationManifest);
    if (
      quantization.qualification !== false ||
      quantization.sourceWeights?.sha256 !== manifest.files.modelF16.sha256 ||
      resolve(quantization.sourceWeights?.file ?? "") !==
        manifest.files.modelF16.path ||
      quantization.output?.sha256 !== manifest.files.modelQ8.sha256 ||
      resolve(quantization.output?.file ?? "") !==
        manifest.files.modelQ8.path ||
      quantization.quantizer?.type !== "Q8_0" ||
      quantization.quantizer?.leaveOutputTensorUnquantized !== true ||
      quantization.quantizer?.importanceMatrix !== null ||
      quantization.quantizer?.sourceRevision !==
        "f072b103714dfa1eee531f80b24512faf38e3dd2" ||
      quantization.quantizer?.binarySha256 !==
        manifest.files.quantizerBinary.sha256
    )
      fail("Q8 same-weight quantization provenance incomplete");
    await verifyQuantizerRuntime(
      manifest.files.quantizerBinary.path,
      quantization.quantizer.runtimeLibraries,
      quantization.quantizer.runtimeLibraryLinks,
    );
    const localMarginsBytes = await pinned(manifest.files.localFitMargins);
    if (sha(localMarginsBytes) !== imported.local_fit_margins_sha256)
      fail("local FIT reference changed");
    const localMargins = new Map(
      localMarginsBytes
        .toString()
        .trim()
        .split("\n")
        .map((line) => {
          const row = JSON.parse(line);
          return [row.source_id, row.margin];
        }),
    );
    const sourceRows = (await pinned(manifest.files.sourceFitMargins))
      .toString()
      .trim()
      .split("\n")
      .map(JSON.parse);
    const sourceMargins = new Map(
      sourceRows.map((row) => [row.source_id, row.final]),
    );
    const probability = (margin) =>
      margin >= 0
        ? 1 / (1 + Math.exp(-margin))
        : Math.exp(margin) / (1 + Math.exp(margin));
    if (
      sourceRows.length !== 327 ||
      sourceMargins.size !== 327 ||
      localMargins.size !== 327 ||
      [...sourceMargins].some(
        ([id, margin]) =>
          !Number.isFinite(margin) || !Number.isFinite(localMargins.get(id)),
      )
    )
      fail("FIT cross-backend margin inventory incomplete");
    const probabilityDelta = Math.max(
      ...[...sourceMargins].map(([id, margin]) =>
        Math.abs(probability(margin) - probability(localMargins.get(id))),
      ),
    );
    const flips = [...sourceMargins].filter(
      ([id, margin]) =>
        Math.abs(margin) >= 0.5 && margin * localMargins.get(id) <= 0,
    ).length;
    if (
      probabilityDelta > 0.05 ||
      flips ||
      Math.abs(probabilityDelta - local.max_probability_delta) > 1e-12
    )
      fail("cross-backend equivalence aggregate tampering");
    if (
      localMargins.size !== 327 ||
      [f16, q8].some((proof) =>
        proof.records.some(
          (row) => localMargins.get(row.sourceId) !== row.referenceMargin,
        ),
      )
    )
      fail("precision reports do not use imported FIT reference");
    const precision = manifest.format === "f16" ? f16 : q8;
    if (precision.modelSha256 !== manifest.files.model.sha256)
      fail("selected precision proof belongs to another model");
    const artifact = await verifyArtifact(
      manifest.files.model.path,
      "classifier",
      manifest.modelId,
      { registryPath: manifest.files.registry.path },
    );
    const descriptor = await json(manifest.files.artifact);
    assertC10ArtifactPaths(descriptor, manifest.files);
    const exported = await verifyTrainedArtifactExport(descriptor);
    if (
      artifact.training_run !== run.id ||
      exported.training_run !== run.id ||
      artifact.base_model !== "google/gemma-3-1b-it" ||
      artifact.template_version !== "v2" ||
      exported.sha256 !== f16.modelSha256
    )
      fail("model not bound to admitted trained export");
    const fit = (await pinned(manifest.files.fit))
      .toString()
      .trim()
      .split("\n")
      .map(JSON.parse);
    const rows = (await pinned(manifest.files.cal))
      .toString()
      .trim()
      .split("\n")
      .map(JSON.parse);
    const groups = [...new Set(fit.map((row) => row.group_id))].sort();
    if (
      fit.length !== 327 ||
      groups.length !== 133 ||
      rows.length !== 42 ||
      fit.some((row) => !localMargins.has(row.id))
    )
      fail("FIT/CAL inventory changed");
    const prepared = prepareCandidate9CalibrationRows(rows, groups);
    const config = backendModule.configFromEnv({
      JEV_DEVICE: "metal",
      JEV_MODEL_ID: artifact.id,
      JEV_MODEL_FILE: manifest.files.model.path,
      JEV_TEMPLATE_VERSION: "v2",
    });
    config.artifactRegistryPath = manifest.files.registry.path;
    config.binary = manifest.files.nativeBinary.path;
    Object.assign(config, C9_CAL_SOURCE_PINS.compilerLimits, {
      queueTimeoutMs: 750,
      requestTimeoutMs: 750,
    });
    const native = new backendModule.NativeBackend(config);
    const classifier = new backendModule.Classifier(config, native);
    const records = [];
    try {
      const started = performance.now();
      await native.warmup();
      report.coldInitializationMs = performance.now() - started;
      const generation = native.status.generation;
      for (const row of prepared) {
        const started = performance.now();
        try {
          if (
            native.status.generation !== generation ||
            native.status.artifact?.sha256 !== artifact.sha256
          )
            fail("worker generation/model changed");
          const prediction = await guardrail.classifyGuardrailRisk(
            classifier,
            row.state,
            artifact.id,
          );
          if (
            prediction.inputSha256 !== row.inputSha256 ||
            prediction.calibration !== "uncalibrated" ||
            native.status.generation !== generation
          )
            fail("invalid native prediction identity");
          records.push({
            id: row.id,
            inputSha256: row.inputSha256,
            expected: row.expected,
            modelAnswered: true,
            modelCalls: 1,
            allowScore: prediction.allowScore,
            elapsedMs: performance.now() - started,
          });
        } catch (error) {
          records.push({
            id: row.id,
            inputSha256: row.inputSha256,
            expected: row.expected,
            modelAnswered: false,
            modelCalls: 1,
            allowScore: null,
            elapsedMs: performance.now() - started,
            error: String(error),
          });
        }
      }
    } finally {
      await classifier.dispose();
    }
    const calibration = {
      version: 1,
      purpose: "candidate10_train_calibration_only",
      qualified: false,
      elapsedBasis:
        "direct_jev_risk_check_including_prompt_preparation_and_queue",
      modelSha256: artifact.sha256,
      nativeBinarySha256: manifest.files.nativeBinary.sha256,
      campaignSha256: C10_CAMPAIGN_SHA256,
      checkpoint: manifest.checkpoint,
      records,
    };
    report.calibration = calibration;
    report.selection = selectC10Cutoff(
      records,
      await json(manifest.files.baseline),
    );
    if (canonical(before) !== canonical(await capture(manifest)))
      fail("identity changed during CAL");
    await writeFile(
      resolve(outputDir, "calibration.json"),
      JSON.stringify(calibration, null, 2) + "\n",
      { flag: "wx" },
    );
    const decision = c10ValidationDecision(report.selection, diagnosticValid);
    if (!decision.runValid) {
      report.status = "rejected_cal";
      return report;
    }
    // Formal admission still requires accepted CAL. The separately named diagnostic
    // API explicitly benchmarks fixed .5 outcomes without granting admission.
    const validSource = await json(manifest.valid.source);
    const validManifest = await json(manifest.valid.manifest);
    const preflight = await json(manifest.valid.preflight);
    const byId = verifyCandidate10ValidPopulation(
      validSource,
      validManifest,
      preflight,
    );
    const calibrationSha256 = sha(
      canonical({
        calibration,
        selection: report.selection,
        ...(diagnosticValid
          ? {
              diagnosticOnly: true,
              fixedMinimumAllowScore: 0.5,
              candidateAdmission: false,
            }
          : {}),
      }),
    );
    const pins = {
      corpusSha256: validSeal.source,
      manifestSha256: validSeal.manifest,
      preflightSha256: validSeal.preflight,
      hostCommit: C10_HOST.commit,
      hostBaselineSha256: C10_HOST.baselineSha256,
      policySha256: C9_CAL_SOURCE_PINS.policySha256,
      modelSha256: artifact.sha256,
      scoringProtocolSha256: sha(
        canonical({
          version: 1,
          purpose: diagnosticValid
            ? "candidate10_fixed_cutoff_diagnostic_scoring"
            : "candidate10_frozen_selected_token_scoring",
          promptProtocolSha256: guardrail.GUARDRAIL_PROTOCOL_SHA256,
          campaignSha256: C10_CAMPAIGN_SHA256,
          checkpoint: manifest.checkpoint,
          modelSha256: artifact.sha256,
          nativeBinarySha256: manifest.files.nativeBinary.sha256,
          calibrationSha256,
          minimumAllowScore: decision.minimumAllowScore,
        }),
      ),
      calibrationSha256,
      minimumAllowScore: decision.minimumAllowScore,
      expectedPrepared: 116,
    };
    const replay = await runCandidate8HostRows({
      rows: validSource.cases,
      preflightById: byId,
      sfPi: manifest.sfPi,
      sfDeps: manifest.sfDeps,
      stubFile: resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
      hostCommit: pins.hostCommit,
      hostRuntimeSha256: pins.hostBaselineSha256,
      protocolSha256: pins.scoringProtocolSha256,
      expectedModelSha256: pins.modelSha256,
      expectedCalibrationSha256: calibrationSha256,
      expectedMinimumAllowScore: pins.minimumAllowScore,
      expectedPolicySha256: pins.policySha256,
      validateInput: guardrail.validateGuardrailInput,
      createProvider: createCandidate9ShadowProvider({
        backendModule,
        guardrail,
        config,
        pins,
        modelId: artifact.id,
      }),
    });
    verifyCandidate9NonModelRoutes(replay.records, preflight);
    const summary = summarizeCandidate9Valid(replay.records, preflight, pins);
    const eligible = replay.records.filter((row) => row.modelEligible);
    report.validation = {
      ...summary,
      purpose: diagnosticValid
        ? "candidate10_unqualified_valid_diagnostic"
        : "candidate10_prospective_valid_observation",
      ...(diagnosticValid
        ? {
            diagnosticOnly: true,
            enforcementEligible: false,
            candidateAdmission: false,
            fixedDiagnosticMinimumAllowScore: 0.5,
          }
        : {}),
      providerKind: "real",
      executionSurface: "sf_guardrail_bridge_shadow",
      externalOperationsExecuted: 0,
      coldInitializationMs: replay.coldInitializationMs,
      source: pins,
      records: replay.records,
      fullAccuracy: summary.metrics.expectedActionsMatched / 160,
      modelEligibleAccuracy:
        eligible.filter((row) => row.actual === row.expected).length /
        eligible.length,
    };
    report.validation.gates.fullAccuracyAtLeast90 =
      report.validation.fullAccuracy >= 0.9;
    report.validation.gates.modelEligibleAccuracyAtLeast90 =
      report.validation.modelEligibleAccuracy >= 0.9;
    for (const pin of Object.values(manifest.valid)) await pinned(pin);
    if (canonical(before) !== canonical(await capture(manifest)))
      fail("identity changed during VALID");
    report.status = diagnosticValid
      ? "diagnostic_valid_complete"
      : Object.values(report.validation.gates).every(Boolean)
        ? "valid_pass_test_and_hook_pending"
        : "rejected_valid";
    return report;
  } catch (error) {
    report.failures.push(String(error));
    report.status = "failed";
    return report;
  } finally {
    await writeFile(
      resolve(outputDir, "evaluation.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx" },
    );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      "manifest-sha256": { type: "string" },
      output: { type: "string" },
    },
  });
  const manifest = validateC10Manifest(
    await json({ path: values.manifest, sha256: values["manifest-sha256"] }),
  );
  const result = await evaluateC10(manifest, resolve(values.output));
  console.log(
    JSON.stringify({
      status: result.status,
      qualified: false,
      selection: result.selection,
      validation: result.validation?.metrics,
      failures: result.failures,
    }),
  );
  if (!["valid_pass_test_and_hook_pending"].includes(result.status))
    process.exitCode = 1;
}
