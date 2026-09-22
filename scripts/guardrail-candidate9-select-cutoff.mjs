#!/usr/bin/env node
/** Select an arm only from admitted TRAIN-CAL and independently replayed host controls. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical } from "../dist/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";
import { selectC9Calibration } from "../dist/guardrail-c9-calibration.js";
import { verifyC9Q8Artifact } from "./guardrail-candidate9-artifact-provenance.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const pin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const c9HostCommit = "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a";
const c9HostBaselineSha256 =
  "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421";
const c9BundledPolicySha256 =
  "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347";
const fail = (message) => {
  throw new Error(`Candidate 9 TRAIN-CAL: ${message}`);
};

async function fileBytes(path, max = 16 * 1_048_576) {
  const file = resolve(path ?? "");
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > max)
    fail(`expected bounded regular file: ${file}`);
  const value = await readFile(file);
  if (value.length > max) fail(`file grew beyond bound: ${file}`);
  return value;
}
async function pinnedBytes(path, digest) {
  if (!pin(digest)) fail("missing exact SHA-256 source pin");
  const value = await fileBytes(path);
  if (sha(value) !== digest) fail(`source bytes changed: ${path}`);
  return value;
}
function rows(value, split) {
  const text = value.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\n\n"))
    fail(`${split} must be complete LF JSONL`);
  const result = text.trimEnd().split("\n").map(JSON.parse);
  const ids = new Set();
  for (const row of result) {
    if (
      row.split !== split ||
      !row.id ||
      ids.has(row.id) ||
      !row.group_id ||
      !["allow", "confirm"].includes(row.targets?.risk?.answer) ||
      typeof row.request?.state !== "object"
    )
      fail(`${split} admission rows changed`);
    ids.add(row.id);
  }
  return result;
}
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}
async function hostIdentity(path) {
  const host = resolve(path ?? "");
  const commit = git(host, ["rev-parse", "HEAD"]);
  try {
    git(host, ["diff", "--quiet", "HEAD"]);
  } catch {
    fail("sf-pi host has uncommitted tracked changes");
  }
  const module = await import(
    pathToFileURL(
      resolve(host, "extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ).href
  );
  return {
    commit,
    baselineSha256: module.calculateJevRiskBaselineIdentity().sha256,
  };
}

export async function selectFromPinnedSources(
  paths,
  pins,
  inspectHost = hostIdentity,
) {
  for (const key of [
    "admissionSha256",
    "scoresSha256",
    "baselineReceiptSha256",
    "hostControlsReceiptSha256",
    "modelSha256",
    "nativeBinarySha256",
    "hostBaselineSha256",
    "policySha256",
  ])
    if (!pin(pins[key])) fail(`missing ${key}`);
  const admission = JSON.parse(
    await pinnedBytes(paths.admission, pins.admissionSha256),
  );
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate9_fit_calibration_admission" ||
    admission.trainingReady !== true ||
    admission.calibration?.notPassedToFit !== true ||
    admission.source?.hostCommit !== c9HostCommit ||
    pins.hostBaselineSha256 !== c9HostBaselineSha256 ||
    pins.policySha256 !== c9BundledPolicySha256 ||
    admission.source?.hostControlsReceiptSha256 !==
      pins.hostControlsReceiptSha256 ||
    admission.source?.calibrationBaselineReceiptSha256 !==
      pins.baselineReceiptSha256 ||
    admission.source?.hostRuntimeSha256 !== pins.hostBaselineSha256 ||
    !pin(admission.source?.c9SourceSha256) ||
    !pin(admission.source?.pairsSha256) ||
    !pin(admission.source?.familiesSha256)
  )
    fail("admission is not a frozen C9 FIT/CAL split");
  const [
    fitBytes,
    calBytes,
    pairBytes,
    familyBytes,
    planBytes,
    scoreBytes,
    baselineBytes,
    controlsBytes,
    baselineScriptBytes,
    controlsScriptBytes,
  ] = await Promise.all([
    pinnedBytes(paths.fit, admission.fit?.sha256),
    pinnedBytes(paths.cal, admission.calibration?.sha256),
    pinnedBytes(paths.pairs, admission.source.pairsSha256),
    pinnedBytes(paths.families, admission.source.familiesSha256),
    fileBytes(paths.objectivePlan),
    pinnedBytes(paths.scores, pins.scoresSha256),
    pinnedBytes(paths.baseline, pins.baselineReceiptSha256),
    pinnedBytes(paths.hostControls, pins.hostControlsReceiptSha256),
    fileBytes(paths.baselineScript),
    fileBytes(paths.hostControlsScript),
  ]);
  const fit = rows(fitBytes, "train");
  const cal = rows(calBytes, "calibration");
  const fitGroups = [...new Set(fit.map((row) => row.group_id))].sort();
  const calGroups = new Set(cal.map((row) => row.group_id));
  const fitIds = new Set(fit.map((row) => row.id));
  const fitInputs = new Set(
    fit.map((row) => sha(Buffer.from(canonical(row.request.state)))),
  );
  if (
    fit.length !== admission.fit.rows ||
    fitGroups.length !== admission.fit.groups ||
    cal.length !== admission.calibration.rows ||
    calGroups.size !== admission.calibration.groups ||
    fitGroups.some((group) => calGroups.has(group)) ||
    cal.some(
      (row) =>
        fitIds.has(row.id) ||
        fitInputs.has(sha(Buffer.from(canonical(row.request.state)))),
    )
  )
    fail("FIT/CAL inventory or group isolation changed");
  const pairs = JSON.parse(pairBytes);
  const families = JSON.parse(familyBytes);
  const plan = JSON.parse(planBytes);
  if (
    pairs.version !== 1 ||
    !Array.isArray(pairs.pairs) ||
    families.version !== 1 ||
    families.purpose !== "candidate9_fit_families" ||
    !Array.isArray(families.rows) ||
    families.rows.length !== fit.length ||
    pairs.pairs.some(
      (row) => !fitIds.has(row.safe_id) || !fitIds.has(row.risky_id),
    ) ||
    families.rows.some((row) => !fitIds.has(row.id)) ||
    plan.version !== 2 ||
    plan.purpose !== "candidate9_train_only" ||
    plan.pair_manifest_sha256 !== admission.source.pairsSha256 ||
    plan.family_manifest_sha256 !== admission.source.familiesSha256 ||
    plan.steps !== 256 ||
    plan.validation_rows_passed_to_training !== 0 ||
    plan.test_rows_passed_to_training !== 0
  )
    fail("FIT-only pair, family or objective manifest changed");
  const scores = JSON.parse(scoreBytes);
  const cases = cal
    .map((row) => ({
      id: row.id,
      groupId: row.group_id,
      expected: row.targets.risk.answer,
      gate: "prepared",
      inputSha256: sha(Buffer.from(canonical(row.request.state))),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    scores.version !== 1 ||
    scores.purpose !== "candidate9_train_calibration_only" ||
    scores.arm !== plan.arm ||
    scores.modelSha256 !== pins.modelSha256 ||
    scores.nativeBinarySha256 !== pins.nativeBinarySha256 ||
    scores.promptProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    scores.hostCommit !== admission.source.hostCommit ||
    scores.baselineSha256 !== pins.hostBaselineSha256 ||
    scores.policySha256 !== pins.policySha256 ||
    scores.admissionSha256 !== pins.admissionSha256 ||
    scores.fitSha256 !== admission.fit.sha256 ||
    scores.calibrationCorpusSha256 !== admission.calibration.sha256 ||
    scores.pairManifestSha256 !== admission.source.pairsSha256 ||
    scores.familyManifestSha256 !== admission.source.familiesSha256 ||
    scores.objectivePlanSha256 !== sha(planBytes) ||
    canonical(scores.fitGroups) !== canonical(fitGroups) ||
    canonical(scores.cases) !== canonical(cases) ||
    !Array.isArray(scores.records) ||
    scores.records.length !== cases.length ||
    scores.records.some(
      (row, index) =>
        row.id !== cases[index].id ||
        row.inputSha256 !== cases[index].inputSha256 ||
        row.gate !== "prepared",
    )
  )
    fail("model scores differ from admitted CAL operations or identities");
  await verifyC9Q8Artifact({
    paths: {
      runDirectory: paths.runDirectory,
      objectivePlan: paths.objectivePlan,
      f16Model: paths.f16Model,
      q8Model: paths.q8Model,
      calScorerCli: paths.calScorerCli,
      calScorerCore: paths.calScorerCore,
      nativeBinary: paths.nativeBinary,
      selectorCli: fileURLToPath(import.meta.url),
      calibrationRuntime: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../dist/guardrail-c9-calibration.js",
      ),
    },
    expected: scores,
    admission,
    objectivePlanSha256: sha(planBytes),
    modelSha256: pins.modelSha256,
    arm: plan.arm,
  });
  const baseline = JSON.parse(baselineBytes);
  const controls = JSON.parse(controlsBytes);
  const host = await inspectHost(paths.sfPi);
  if (
    host.commit !== admission.source.hostCommit ||
    host.baselineSha256 !== pins.hostBaselineSha256 ||
    baseline.source?.hostCommit !== host.commit ||
    baseline.source?.scriptSha256 !== sha(baselineScriptBytes) ||
    controls.source?.hostCommit !== host.commit ||
    controls.source?.scriptSha256 !== sha(controlsScriptBytes) ||
    controls.source?.c9SourceSha256 !== admission.source.c9SourceSha256
  )
    fail("same-host baseline or control replay provenance changed");
  const input = {
    version: 1,
    purpose: "candidate9_train_calibration_only",
    arm: scores.arm,
    modelSha256: scores.modelSha256,
    nativeBinarySha256: scores.nativeBinarySha256,
    artifactFormat: scores.artifactFormat,
    artifactManifestSha256: scores.artifactManifestSha256,
    registrySha256: scores.registrySha256,
    runManifestSha256: scores.runManifestSha256,
    fitPlanSha256: scores.fitPlanSha256,
    quantizationManifestSha256: scores.quantizationManifestSha256,
    calScorerCliSha256: scores.calScorerCliSha256,
    calScorerCoreSha256: scores.calScorerCoreSha256,
    coldInitializationMs: scores.coldInitializationMs,
    coldInitializationBasis: scores.coldInitializationBasis,
    preScoreVerificationMs: scores.preScoreVerificationMs,
    elapsedBasis: scores.elapsedBasis,
    promptProtocolSha256: scores.promptProtocolSha256,
    hostCommit: scores.hostCommit,
    baselineSha256: pins.hostBaselineSha256,
    policySha256: pins.policySha256,
    baselineReceiptSha256: pins.baselineReceiptSha256,
    baselineReceiptJson: baselineBytes.toString("utf8"),
    hostControlsReceiptSha256: pins.hostControlsReceiptSha256,
    hostControlsReceiptJson: controlsBytes.toString("utf8"),
    c9SourceSha256: admission.source.c9SourceSha256,
    admissionSha256: pins.admissionSha256,
    fitSha256: admission.fit.sha256,
    calibrationCorpusSha256: admission.calibration.sha256,
    pairManifestSha256: admission.source.pairsSha256,
    familyManifestSha256: admission.source.familiesSha256,
    objectivePlanSha256: sha(planBytes),
    fitGroups,
    cases,
    records: scores.records,
  };
  const receipt = selectC9Calibration(input);
  const output = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  await writeFile(resolve(paths.output), output, { flag: "wx", mode: 0o600 });
  return {
    accepted: receipt.accepted,
    reason: receipt.reason,
    minimumAllowScore: receipt.minimumAllowScore,
    scoringProtocolSha256: receipt.scoringProtocolSha256,
    receiptSha256: sha(output),
  };
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
    "run",
    "f16-model",
    "q8-model",
    "cal-scorer-cli",
    "cal-scorer-core",
    "native-binary",
    "scores",
    "scores-sha256",
    "baseline",
    "baseline-receipt-sha256",
    "host-controls",
    "host-controls-receipt-sha256",
    "baseline-script",
    "host-controls-script",
    "sf-pi",
    "model-sha256",
    "native-binary-sha256",
    "host-baseline-sha256",
    "policy-sha256",
    "output",
  ];
  const { values } = parseArgs({
    options: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
  });
  const paths = {
    admission: values.admission,
    fit: values.fit,
    cal: values.cal,
    pairs: values.pairs,
    families: values.families,
    objectivePlan: values["objective-plan"],
    runDirectory: values.run,
    f16Model: values["f16-model"],
    q8Model: values["q8-model"],
    calScorerCli: values["cal-scorer-cli"],
    calScorerCore: values["cal-scorer-core"],
    nativeBinary: values["native-binary"],
    scores: values.scores,
    baseline: values.baseline,
    hostControls: values["host-controls"],
    baselineScript: values["baseline-script"],
    hostControlsScript: values["host-controls-script"],
    sfPi: values["sf-pi"],
    output: values.output,
  };
  const pins = {
    admissionSha256: values["admission-sha256"],
    scoresSha256: values["scores-sha256"],
    baselineReceiptSha256: values["baseline-receipt-sha256"],
    hostControlsReceiptSha256: values["host-controls-receipt-sha256"],
    modelSha256: values["model-sha256"],
    nativeBinarySha256: values["native-binary-sha256"],
    hostBaselineSha256: values["host-baseline-sha256"],
    policySha256: values["policy-sha256"],
  };
  try {
    console.log(JSON.stringify(await selectFromPinnedSources(paths, pins)));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
