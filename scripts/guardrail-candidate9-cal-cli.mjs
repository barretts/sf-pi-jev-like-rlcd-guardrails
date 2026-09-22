#!/usr/bin/env node
/** Executable C9 TRAIN-CAL scorer. No VALID body or TEST source is opened. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Classifier, NativeBackend, configFromEnv } from "../dist/backend.js";
import { canonical } from "../dist/core.js";
import {
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { verifyArtifact, verifyTrainedArtifactExport } from "../dist/models.js";
import {
  C9_CAL_SOURCE_PINS,
  prepareCandidate9CalibrationRows,
  scoreCandidate9Calibration,
} from "./guardrail-candidate9-cal-score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseModel = "google/gemma-3-1b-it";
const hex64 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (message) => {
  throw new Error(`C9 TRAIN-CAL CLI: ${message}`);
};

async function regularBytes(path, max = 16 * 1_048_576) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail("absolute source paths are required");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > max)
    fail(`expected bounded regular source file: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length > max) fail(`source file grew beyond bound: ${path}`);
  return bytes;
}
async function pinnedBytes(path, digest) {
  if (!hex64(digest)) fail("missing exact source SHA-256 pin");
  const bytes = await regularBytes(path);
  if (sha(bytes) !== digest) fail(`source bytes changed: ${path}`);
  return bytes;
}
async function fileSha(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail("absolute artifact path is required");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`expected regular artifact file: ${path}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
export async function capturePinnedFileIdentities(paths) {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [
      name,
      await fileSha(path),
    ]),
  );
  return Object.fromEntries(entries);
}
export function assertSameScoringIdentity(before, after) {
  const names = Object.keys(before).sort(order);
  if (
    names.length !== Object.keys(after).length ||
    names.some((name) => before[name] !== after[name])
  )
    fail("source, model, native scorer, or host changed during CAL scoring");
}
async function quantizerRuntimeIdentity(binaryPath) {
  const dir = dirname(binaryPath);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".dylib"));
  const result = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9._+-]+\.dylib$/.test(name))
      fail("quantizer runtime has an invalid library filename");
    const path = resolve(dir, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) result[`link:${name}`] = await readlink(path);
    else if (entry.isFile()) result[`library:${name}`] = await fileSha(path);
    else fail("quantizer runtime includes a non-file library");
  }
  return result;
}
export async function verifyQuantizerRuntime(
  binaryPath,
  runtimeLibraries,
  runtimeLibraryLinks,
) {
  if (
    !runtimeLibraries ||
    typeof runtimeLibraries !== "object" ||
    Array.isArray(runtimeLibraries) ||
    Object.keys(runtimeLibraries).length !== 8 ||
    !runtimeLibraryLinks ||
    typeof runtimeLibraryLinks !== "object" ||
    Array.isArray(runtimeLibraryLinks) ||
    Object.keys(runtimeLibraryLinks).length < 1
  )
    fail("quantizer runtime library inventory is incomplete");
  const expected = {};
  for (const [name, digest] of Object.entries(runtimeLibraries)) {
    if (!/^[A-Za-z0-9._+-]+\.dylib$/.test(name) || !hex64(digest))
      fail("quantizer runtime library pin is invalid");
    expected[`library:${name}`] = digest;
  }
  for (const [name, target] of Object.entries(runtimeLibraryLinks)) {
    if (
      !/^[A-Za-z0-9._+-]+\.dylib$/.test(name) ||
      !/^[A-Za-z0-9._+-]+\.dylib$/.test(target) ||
      Object.hasOwn(runtimeLibraries, name) ||
      (!Object.hasOwn(runtimeLibraries, target) &&
        !Object.hasOwn(runtimeLibraryLinks, target))
    )
      fail("quantizer runtime library link is invalid");
    expected[`link:${name}`] = target;
  }
  const actual = await quantizerRuntimeIdentity(binaryPath);
  assertSameScoringIdentity(expected, actual);
  for (const name of Object.keys(runtimeLibraryLinks)) {
    const seen = new Set([name]);
    let target = runtimeLibraryLinks[name];
    while (Object.hasOwn(runtimeLibraryLinks, target)) {
      if (seen.has(target)) fail("quantizer runtime library link cycle");
      seen.add(target);
      target = runtimeLibraryLinks[target];
    }
    if (!Object.hasOwn(runtimeLibraries, target))
      fail("quantizer runtime link does not resolve to a pinned library");
  }
  return actual;
}
function jsonl(bytes, split) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\n\n"))
    fail(`${split} must be complete LF JSONL`);
  const rows = text.trimEnd().split("\n").map(JSON.parse);
  if (
    !rows.length ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => row.split !== split)
  )
    fail(`${split} inventory changed`);
  return rows;
}
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

/** Sources are bounded to frozen TRAIN; only the VALID manifest hash is read. */
export async function loadCandidate9Calibration(values) {
  if (
    !hex64(values?.admissionSha256) ||
    values.admissionSha256 !== C9_CAL_SOURCE_PINS.admissionSha256 ||
    !["A", "B"].includes(values.arm) ||
    ![
      "admission",
      "fit",
      "cal",
      "pairs",
      "families",
      "objectivePlan",
      "fitPlan",
      "run",
      "sfPi",
    ].every((key) => typeof values[key] === "string" && isAbsolute(values[key]))
  )
    fail("pinned admission and absolute TRAIN-only paths are required");
  const admission = JSON.parse(
    await pinnedBytes(values.admission, values.admissionSha256),
  );
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate9_fit_calibration_admission" ||
    admission.trainingReady !== true ||
    admission.calibration?.notPassedToFit !== true ||
    admission.source?.baseModel !== baseModel ||
    admission.source?.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    admission.source?.hostCommit !== C9_CAL_SOURCE_PINS.hostCommit ||
    admission.source?.hostRuntimeSha256 !== C9_CAL_SOURCE_PINS.baselineSha256 ||
    admission.source?.overlapReceiptSha256 !==
      C9_CAL_SOURCE_PINS.overlapReceiptSha256 ||
    ![
      admission.source?.c9SourceSha256,
      admission.source?.pairsSha256,
      admission.source?.familiesSha256,
      admission.fit?.sha256,
      admission.calibration?.sha256,
    ].every(hex64)
  )
    fail("C9 FIT/CAL admission is incomplete or changed");
  const [
    fitBytes,
    calBytes,
    pairBytes,
    familyBytes,
    objectiveBytes,
    planBytes,
  ] = await Promise.all([
    pinnedBytes(values.fit, admission.fit.sha256),
    pinnedBytes(values.cal, admission.calibration.sha256),
    pinnedBytes(values.pairs, admission.source.pairsSha256),
    pinnedBytes(values.families, admission.source.familiesSha256),
    pinnedBytes(values.objectivePlan, values.objectivePlanSha256),
    pinnedBytes(values.fitPlan, values.fitPlanSha256),
  ]);
  const fit = jsonl(fitBytes, "train");
  const cal = jsonl(calBytes, "calibration");
  const fitGroups = [...new Set(fit.map((row) => row.group_id))].sort(order);
  const calGroups = new Set(cal.map((row) => row.group_id));
  const fitIds = new Set(fit.map((row) => row.id));
  if (
    fit.length !== admission.fit.rows ||
    fitGroups.length !== admission.fit.groups ||
    cal.length !== admission.calibration.rows ||
    calGroups.size !== admission.calibration.groups ||
    fit.some(
      (row) =>
        typeof row.group_id !== "string" ||
        !row.group_id ||
        row.request?.model !== baseModel,
    ) ||
    fitGroups.some((group) => calGroups.has(group)) ||
    cal.some((row) => fitIds.has(row.id))
  )
    fail("admitted FIT/CAL inventory or group isolation changed");
  const pairs = JSON.parse(pairBytes);
  const families = JSON.parse(familyBytes);
  const objective = JSON.parse(objectiveBytes);
  if (
    pairs.version !== 1 ||
    !Array.isArray(pairs.pairs) ||
    pairs.pairs.some(
      (row) => !fitIds.has(row.safe_id) || !fitIds.has(row.risky_id),
    ) ||
    families.version !== 1 ||
    families.purpose !== "candidate9_fit_families" ||
    !Array.isArray(families.rows) ||
    families.rows.length !== fit.length ||
    families.rows.some((row) => !fitIds.has(row.id)) ||
    objective.version !== 2 ||
    objective.purpose !== "candidate9_train_only" ||
    objective.arm !== values.arm ||
    objective.pair_manifest_sha256 !== admission.source.pairsSha256 ||
    objective.family_manifest_sha256 !== admission.source.familiesSha256 ||
    objective.steps !== 256 ||
    objective.validation_rows_passed_to_training !== 0 ||
    objective.test_rows_passed_to_training !== 0
  )
    fail("FIT-only pair, family, or objective plan changed");
  const plan = JSON.parse(planBytes);
  if (
    plan.version !== 1 ||
    plan.purpose !== "candidate9_fit_only_rfdt" ||
    plan.qualification !== false ||
    plan.validationRead !== false ||
    plan.heldOutTestRead !== false ||
    plan.steps !== 256 ||
    plan.selection !== "C9_TRAIN_CAL_hard_veto_before_blind_VALID" ||
    canonical(plan.compilerLimits) !==
      canonical(C9_CAL_SOURCE_PINS.compilerLimits) ||
    plan.source?.arm !== values.arm ||
    plan.source?.admissionSha256 !== values.admissionSha256 ||
    plan.source?.fit?.sha256 !== admission.fit.sha256 ||
    plan.source?.calibration?.sha256 !== admission.calibration.sha256 ||
    plan.source?.pairsSha256 !== admission.source.pairsSha256 ||
    plan.source?.familiesSha256 !== admission.source.familiesSha256 ||
    plan.source?.objectiveSha256 !== sha(objectiveBytes) ||
    plan.source?.blindValidManifestSha256 !==
      C9_CAL_SOURCE_PINS.blindValidManifestSha256 ||
    plan.source?.hostCommit !== C9_CAL_SOURCE_PINS.hostCommit ||
    plan.source?.hostRuntimeSha256 !== C9_CAL_SOURCE_PINS.baselineSha256
  )
    fail("frozen C9 FIT plan differs from admission or blind seal");
  for (const name of [
    "dist/backend.js",
    "dist/core.js",
    "dist/guardrail.js",
    "dist/models.js",
  ])
    if (
      !hex64(plan.source.code?.files?.[name]) ||
      (await fileSha(resolve(root, name))) !== plan.source.code.files[name]
    )
      fail(`compiled scorer runtime differs from FIT source: ${name}`);
  if (git(values.sfPi, "rev-parse", "HEAD") !== C9_CAL_SOURCE_PINS.hostCommit)
    fail("sf-pi host differs from C9 final commit");
  try {
    git(values.sfPi, "diff", "--quiet", "HEAD");
  } catch {
    fail("sf-pi host has uncommitted tracked changes");
  }
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(
        values.sfPi,
        "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
      ),
    ).href
  );
  if (
    calculateJevRiskBaselineIdentity().sha256 !==
      C9_CAL_SOURCE_PINS.baselineSha256 ||
    git(values.sfPi, "rev-parse", "HEAD") !== C9_CAL_SOURCE_PINS.hostCommit
  )
    fail("sf-pi baseline identity changed during CAL source verification");
  prepareCandidate9CalibrationRows(cal, fitGroups);
  return {
    rows: cal,
    fitGroups,
    plan,
    identity: {
      arm: values.arm,
      promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      hostCommit: C9_CAL_SOURCE_PINS.hostCommit,
      baselineSha256: C9_CAL_SOURCE_PINS.baselineSha256,
      policySha256: C9_CAL_SOURCE_PINS.policySha256,
      admissionSha256: values.admissionSha256,
      fitSha256: admission.fit.sha256,
      calibrationCorpusSha256: admission.calibration.sha256,
      pairManifestSha256: admission.source.pairsSha256,
      familyManifestSha256: admission.source.familiesSha256,
      objectivePlanSha256: sha(objectiveBytes),
    },
  };
}

async function captureScoringIdentity(values) {
  const paths = {
    admission: values.admission,
    fit: values.fit,
    cal: values.cal,
    pairs: values.pairs,
    families: values.families,
    objectivePlan: values.objectivePlan,
    fitPlan: values.fitPlan,
    runManifest: resolve(values.run, "manifest.json"),
    artifactManifest: values.artifactManifest,
    registry: values.registry,
    modelFile: values.modelFile,
    nativeBinary: values.nativeBinary,
    scorerCli: fileURLToPath(import.meta.url),
    scorerCore: resolve(root, "scripts/guardrail-candidate9-cal-score.mjs"),
    backend: resolve(root, "dist/backend.js"),
    core: resolve(root, "dist/core.js"),
    guardrail: resolve(root, "dist/guardrail.js"),
    models: resolve(root, "dist/models.js"),
    hostBaselineSource: resolve(
      values.sfPi,
      "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
    ),
  };
  if (values.artifactFormat === "q8_0") {
    paths.quantizationManifest = values.quantizationManifest;
    paths.quantizerBinary = values.quantizerBinary;
  }
  if (git(values.sfPi, "rev-parse", "HEAD") !== C9_CAL_SOURCE_PINS.hostCommit)
    fail("sf-pi host changed during CAL scoring");
  try {
    git(values.sfPi, "diff", "--quiet", "HEAD");
  } catch {
    fail("sf-pi host changed during CAL scoring");
  }
  return {
    ...(await capturePinnedFileIdentities(paths)),
    ...(values.artifactFormat === "q8_0"
      ? await quantizerRuntimeIdentity(values.quantizerBinary)
      : {}),
  };
}

function warmupAttempt(source, modelSha256, nativeBinarySha256, reason) {
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
  return {
    version: 1,
    purpose: "candidate9_train_calibration_attempt",
    arm: source.identity.arm,
    modelSha256,
    nativeBinarySha256,
    promptProtocolSha256: source.identity.promptProtocolSha256,
    hostCommit: source.identity.hostCommit,
    baselineSha256: source.identity.baselineSha256,
    policySha256: source.identity.policySha256,
    admissionSha256: source.identity.admissionSha256,
    fitSha256: source.identity.fitSha256,
    calibrationCorpusSha256: source.identity.calibrationCorpusSha256,
    pairManifestSha256: source.identity.pairManifestSha256,
    familyManifestSha256: source.identity.familyManifestSha256,
    objectivePlanSha256: source.identity.objectivePlanSha256,
    fitGroups: source.fitGroups,
    cases,
    records: cases.map((row) => ({
      ...row,
      modelAnswered: false,
      modelCalls: 0,
      allowScore: null,
      elapsedMs: null,
    })),
    failures: [{ phase: "warmup", reason }],
  };
}

export async function verifyInferenceFormat(values, artifact, exported) {
  if (!["f16", "q8_0"].includes(values.artifactFormat))
    fail("explicit --artifact-format f16 or q8_0 is required");
  if (values.artifactFormat === "f16") {
    if (
      values.quantizationManifest ||
      values.quantizationManifestSha256 ||
      values.quantizerBinary ||
      artifact.id !== exported.id ||
      artifact.sha256 !== exported.sha256 ||
      artifact.training_run !== exported.training_run ||
      resolve(artifact.file) !== resolve(exported.file)
    )
      fail("F16 registry differs from the frozen RFDT export");
    return { format: "f16", artifactSha256: artifact.sha256 };
  }
  if (
    !values.quantizationManifest ||
    !values.quantizationManifestSha256 ||
    !values.quantizerBinary ||
    !isAbsolute(values.quantizationManifest) ||
    !isAbsolute(values.quantizerBinary)
  )
    fail("Q8_0 requires an exact pinned quantization manifest and binary");
  const raw = await pinnedBytes(
    values.quantizationManifest,
    values.quantizationManifestSha256,
  );
  const rel = relative(root, values.quantizationManifest);
  const expectedRel = `reports/guardrail-risk-2026-09-21/candidate-9-evidence/artifacts/${values.arm}-q8.json`;
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel !== expectedRel
  )
    fail(`Q8_0 manifest must be committed at ${expectedRel}`);
  const committed = execFileSync("git", ["show", `HEAD:${rel}`], {
    cwd: root,
  });
  if (!raw.equals(committed))
    fail("Q8_0 manifest differs from committed bytes");
  const manifest = JSON.parse(raw);
  if (
    manifest.version !== 1 ||
    manifest.purpose !== "candidate9_same_weights_q8_0_calibration_candidate" ||
    manifest.qualification !== false ||
    manifest.sourceWeights?.modelId !== exported.id ||
    manifest.sourceWeights?.sha256 !== exported.sha256 ||
    resolve(manifest.sourceWeights?.file ?? "") !== resolve(exported.file) ||
    manifest.sourceWeights?.size !== exported.size ||
    manifest.quantizer?.type !== "Q8_0" ||
    manifest.quantizer?.leaveOutputTensorUnquantized !== true ||
    manifest.quantizer?.importanceMatrix !== null ||
    !isAbsolute(manifest.quantizer?.sourceDirectory ?? "") ||
    manifest.quantizer?.sourceRevision !==
      "f072b103714dfa1eee531f80b24512faf38e3dd2" ||
    git(manifest.quantizer.sourceDirectory, "rev-parse", "HEAD") !==
      manifest.quantizer.sourceRevision ||
    manifest.quantizer?.binarySha256 !==
      (await fileSha(values.quantizerBinary)) ||
    manifest.output?.modelId !== artifact.id ||
    manifest.output?.sha256 !== artifact.sha256 ||
    manifest.output?.size !== artifact.size ||
    resolve(manifest.output?.file ?? "") !== resolve(artifact.file) ||
    manifest.output?.registrySha256 !==
      sha(await regularBytes(values.registry)) ||
    artifact.training_run !== exported.training_run ||
    (await fileSha(exported.file)) !== exported.sha256
  )
    fail("Q8_0 artifact does not derive from the admitted F16 export");
  await verifyQuantizerRuntime(
    values.quantizerBinary,
    manifest.quantizer.runtimeLibraries,
    manifest.quantizer.runtimeLibraryLinks,
  );
  return {
    format: "q8_0",
    artifactSha256: artifact.sha256,
    manifestSha256: sha(raw),
  };
}

async function nativeScorer(values) {
  const invocationStarted = performance.now();
  const required = [
    "admission",
    "admissionSha256",
    "fit",
    "cal",
    "pairs",
    "families",
    "objectivePlan",
    "objectivePlanSha256",
    "fitPlan",
    "fitPlanSha256",
    "run",
    "runManifestSha256",
    "sfPi",
    "arm",
    "modelFile",
    "modelId",
    "modelSha256",
    "registry",
    "registrySha256",
    "artifactManifest",
    "artifactManifestSha256",
    "artifactFormat",
    "nativeBinary",
    "output",
  ];
  if (required.some((key) => !values[key]))
    fail(`required C9 CAL CLI arguments: ${required.join(", ")}`);
  if (
    ![
      "modelFile",
      "registry",
      "artifactManifest",
      "nativeBinary",
      "output",
    ].every((key) => isAbsolute(values[key])) ||
    dirname(values.output) !== resolve(root, ".build/guardrail") ||
    !/^candidate-9-cal-score-[a-zA-Z0-9._-]+\.json$/.test(
      basename(values.output),
    )
  )
    fail("model and output paths must be absolute C9 local artifacts");
  const source = await loadCandidate9Calibration(values);
  await pinnedBytes(
    resolve(values.run, "manifest.json"),
    values.runManifestSha256,
  );
  await pinnedBytes(values.registry, values.registrySha256);
  const artifact = await verifyArtifact(
    values.modelFile,
    "classifier",
    values.modelId,
    { registryPath: values.registry },
  );
  if (!hex64(values.modelSha256) || artifact.sha256 !== values.modelSha256)
    fail("candidate model differs from its explicit pre-CAL SHA-256 pin");
  const exported = await verifyTrainedArtifactExport(
    JSON.parse(
      await pinnedBytes(values.artifactManifest, values.artifactManifestSha256),
    ),
  );
  const run = JSON.parse(
    await regularBytes(resolve(values.run, "manifest.json")),
  );
  if (
    artifact.base_model !== baseModel ||
    artifact.template_version !== "v2" ||
    resolve(dirname(values.artifactManifest)) !== resolve(values.run) ||
    resolve(dirname(values.fitPlan)) !== resolve(values.run) ||
    run.status !== "exported" ||
    run.id !== artifact.training_run ||
    run.prepared?.branches?.train !== source.plan.source.fit.rows ||
    run.prepared?.branches?.validation !== 0 ||
    run.prepared?.branches?.test !== 0 ||
    run.prepared?.dataset_sha256 !==
      source.plan.source.fit.preparedDatasetSha256 ||
    run.source?.sha256 !== source.identity.fitSha256
  )
    fail("candidate artifact is not the admitted FIT-only C9 export");
  const format = await verifyInferenceFormat(values, artifact, exported);
  const nativeBinarySha256 = await fileSha(values.nativeBinary);
  if (
    nativeBinarySha256 !== source.plan.source.code?.files?.[".build/jev-native"]
  )
    fail("native scorer differs from C9 FIT compiler");
  const preScoreIdentity = await captureScoringIdentity(values);
  const preScoreVerificationMs = performance.now() - invocationStarted;
  const config = configFromEnv({
    JEV_DEVICE: "metal",
    JEV_MODEL_ID: artifact.id,
    JEV_MODEL_FILE: artifact.file,
    JEV_TEMPLATE_VERSION: "v2",
  });
  config.artifactRegistryPath = values.registry;
  config.binary = values.nativeBinary;
  Object.assign(config, C9_CAL_SOURCE_PINS.compilerLimits);
  config.queueTimeoutMs = GUARDRAIL_LIMITS.deadlineMs;
  config.requestTimeoutMs = GUARDRAIL_LIMITS.deadlineMs;
  const backend = new NativeBackend(config);
  const classifier = new Classifier(config, backend);
  const coldStarted = performance.now();
  let coldInitializationMs;
  let report;
  let disposeError;
  try {
    let warmupError;
    try {
      await backend.warmup();
    } catch (error) {
      warmupError = error instanceof Error ? error.message : String(error);
    }
    coldInitializationMs = performance.now() - coldStarted;
    report = warmupError
      ? warmupAttempt(source, artifact.sha256, nativeBinarySha256, warmupError)
      : await scoreCandidate9Calibration(source, {
          classifier,
          modelId: artifact.id,
          modelSha256: artifact.sha256,
          nativeBinarySha256,
        });
  } finally {
    try {
      await classifier.dispose();
    } catch (error) {
      disposeError = error instanceof Error ? error.message : String(error);
    }
  }
  if (disposeError)
    report = {
      ...report,
      purpose: "candidate9_train_calibration_attempt",
      failures: [
        ...(report.failures ?? []),
        { phase: "dispose", reason: disposeError },
      ],
    };
  try {
    assertSameScoringIdentity(
      preScoreIdentity,
      await captureScoringIdentity(values),
    );
  } catch (error) {
    report = {
      ...report,
      purpose: "candidate9_train_calibration_attempt",
      failures: [
        ...(report.failures ?? []),
        {
          phase: "post_run_identity",
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  report = {
    ...report,
    artifactFormat: format.format,
    artifactManifestSha256: values.artifactManifestSha256,
    registrySha256: values.registrySha256,
    runManifestSha256: values.runManifestSha256,
    fitPlanSha256: values.fitPlanSha256,
    quantizationManifestSha256: format.manifestSha256 ?? null,
    calScorerCliSha256: preScoreIdentity.scorerCli,
    calScorerCoreSha256: preScoreIdentity.scorerCore,
    coldInitializationMs,
    coldInitializationBasis:
      "backend_warmup_after_source_and_artifact_verification",
    preScoreVerificationMs,
    elapsedBasis:
      "direct_jev_risk_check_including_prompt_preparation_and_queue",
  };
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      output: values.output,
      artifactFormat: format.format,
      artifactSha256: format.artifactSha256,
      quantizationManifestSha256: format.manifestSha256 ?? null,
      coldInitializationMs,
      admitted: report.records.length,
      answered: report.records.filter((row) => row.modelAnswered).length,
      modelCalls: report.records.reduce(
        (count, row) => count + row.modelCalls,
        0,
      ),
      selectable: report.purpose === "candidate9_train_calibration_only",
    }),
  );
  if (report.purpose !== "candidate9_train_calibration_only")
    fail("incomplete C9 CAL scoring attempt saved; selector must reject it");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = [
    "admission",
    "admission-sha256",
    "fit",
    "cal",
    "pairs",
    "families",
    "objective-plan",
    "objective-plan-sha256",
    "fit-plan",
    "fit-plan-sha256",
    "run",
    "run-manifest-sha256",
    "sf-pi",
    "arm",
    "model-file",
    "model-id",
    "model-sha256",
    "registry",
    "registry-sha256",
    "artifact-manifest",
    "artifact-manifest-sha256",
    "artifact-format",
    "quantization-manifest",
    "quantization-manifest-sha256",
    "quantizer-binary",
    "native-binary",
    "output",
  ];
  const { values: flags } = parseArgs({
    options: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
  });
  await nativeScorer({
    admission: flags.admission,
    admissionSha256: flags["admission-sha256"],
    fit: flags.fit,
    cal: flags.cal,
    pairs: flags.pairs,
    families: flags.families,
    objectivePlan: flags["objective-plan"],
    objectivePlanSha256: flags["objective-plan-sha256"],
    fitPlan: flags["fit-plan"],
    fitPlanSha256: flags["fit-plan-sha256"],
    run: flags.run,
    runManifestSha256: flags["run-manifest-sha256"],
    sfPi: flags["sf-pi"],
    arm: flags.arm,
    modelFile: flags["model-file"],
    modelId: flags["model-id"],
    modelSha256: flags["model-sha256"],
    registry: flags.registry,
    registrySha256: flags["registry-sha256"],
    artifactManifest: flags["artifact-manifest"],
    artifactManifestSha256: flags["artifact-manifest-sha256"],
    artifactFormat: flags["artifact-format"],
    quantizationManifest: flags["quantization-manifest"],
    quantizationManifestSha256: flags["quantization-manifest-sha256"],
    quantizerBinary: flags["quantizer-binary"],
    nativeBinary: flags["native-binary"],
    output: flags.output,
  });
}
