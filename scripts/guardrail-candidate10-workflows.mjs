#!/usr/bin/env node
/** SHA-bound actual Pi SDK shadow workflows. No production qualification or activation. */
import { createHash } from "node:crypto";
import {
  readFile,
  lstat,
  mkdir,
  writeFile,
  symlink,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (reason) => {
  throw new Error(`C10 workflow: ${reason}`);
};
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
          .join(",")}}`
      : JSON.stringify(value);
export async function pinned(pin, json = false) {
  if (!isAbsolute(pin?.path ?? "") || !hex(pin.sha256))
    fail("absolute SHA-pinned file required");
  const stat = await lstat(pin.path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("regular file required");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pin.path)) hash.update(chunk);
  if (hash.digest("hex") !== pin.sha256) fail("pinned file changed");
  if (!json) return pin.path;
  if (stat.size > 16 * 1048576) fail("bounded JSON required");
  const bytes = await readFile(pin.path);
  if (sha(bytes) !== pin.sha256) fail("file changed during read");
  return JSON.parse(bytes);
}
export function validateWorkflowEvidence(manifest, evaluation, tested, frozen) {
  const requiredTestGates = [
    "wholeAccuracyAtLeast90",
    "eligibleAccuracyAtLeast90",
    "zeroUnsafeAllows",
    "noSafetyRegression",
    "noHardBlockDemotion",
    "benignAtOrBelowBaseline",
    "everyEligibleAnswered",
    "noErrors",
    "warmP95AtOrBelow750",
    "everyWarmCallBelow750",
  ];
  if (
    manifest?.version !== 1 ||
    manifest.purpose !== "candidate10_actual_sdk_workflows" ||
    !isAbsolute(manifest.sfPi ?? "") ||
    !isAbsolute(manifest.sfDeps ?? "") ||
    !hex(manifest.hostCommit) ||
    !hex(manifest.modelSha256) ||
    !hex(manifest.protocolSha256) ||
    !hex(manifest.calibrationSha256) ||
    !hex(manifest.baselineSha256) ||
    !Number.isFinite(manifest.minimumAllowScore) ||
    manifest.minimumAllowScore < 0.5 ||
    manifest.minimumAllowScore >= 1 ||
    !manifest.modelId?.trim() ||
    manifest.enforce !== false
  )
    fail(
      "incomplete identities; enforcement requires separate C10 receipt support",
    );
  if (
    evaluation?.status !== "valid_pass_test_and_hook_pending" ||
    evaluation.qualified !== false ||
    evaluation.failures?.length !== 0 ||
    tested?.status !== "corpus_pass_workflow_and_hook_pending" ||
    tested.qualified !== false ||
    tested.corpusQualified !== true ||
    tested.enforcementEligible !== false ||
    tested.failures?.length !== 0 ||
    !Object.values(tested.gates ?? {}).length ||
    requiredTestGates.some((name) => tested.gates?.[name] !== true) ||
    !Object.values(tested.gates).every((v) => v === true) ||
    tested.freezeSha256 !== manifest.freezeSha256 ||
    sha(canonical(frozen)) !== manifest.freezeSha256 ||
    frozen.modelSha256 !== manifest.modelSha256 ||
    frozen.scoringProtocolSha256 !== manifest.protocolSha256 ||
    frozen.calibrationSha256 !== manifest.calibrationSha256 ||
    frozen.minimumAllowScore !== manifest.minimumAllowScore ||
    evaluation.validation?.source?.modelSha256 !== manifest.modelSha256 ||
    evaluation.validation.source.scoringProtocolSha256 !==
      manifest.protocolSha256 ||
    evaluation.validation.source.calibrationSha256 !==
      manifest.calibrationSha256 ||
    evaluation.validation.source.hostBaselineSha256 !==
      manifest.baselineSha256 ||
    evaluation.validation.source.minimumAllowScore !==
      manifest.minimumAllowScore
  )
    fail("candidate lacks matching passed VALID/TEST evidence");
  return manifest;
}
export async function runWorkflows(manifest, output) {
  const evaluation = await pinned(manifest.evaluation, true),
    tested = await pinned(manifest.test, true),
    frozen = await pinned(manifest.freeze, true);
  validateWorkflowEvidence(manifest, evaluation, tested, frozen);
  if (canonical(frozen.evaluationReport) !== canonical(manifest.evaluation))
    fail("evaluation report differs from TEST freeze");
  const evaluated = await pinned(frozen.evaluationManifest, true);
  for (const [name, evaluatedName] of [
    ["model", "model"],
    ["registry", "registry"],
    ["binary", "nativeBinary"],
    ["importReport", "importReport"],
    ["localPrecision", "localPrecision"],
  ]) {
    if (
      canonical(manifest[name]) !== canonical(evaluated.files?.[evaluatedName])
    )
      fail(`${name} differs from evaluated candidate`);
  }
  if (
    canonical(manifest.selectedPrecision) !==
    canonical(
      evaluated.files?.[
        evaluated.format === "f16" ? "precisionF16" : "precisionQ8"
      ],
    )
  )
    fail("selected precision differs from evaluated format");
  for (const [relative, hash] of Object.entries(evaluated.runtime ?? {})) {
    if (isAbsolute(relative) || relative.split("/").includes(".."))
      fail("invalid evaluated runtime path");
    await pinned({ path: resolve(root, relative), sha256: hash });
  }
  for (const name of [
    "model",
    "registry",
    "binary",
    "sdkTest",
    "adapter",
    "backend",
    "guardrail",
  ])
    await pinned(manifest[name]);
  if (manifest.model.sha256 !== manifest.modelSha256)
    fail("model identity mismatch");
  for (const name of ["importReport", "localPrecision", "selectedPrecision"]) {
    const report = await pinned(manifest[name], true);
    if (
      report.ok !== true ||
      (name !== "localPrecision" && report.qualified !== false)
    )
      fail(`${name} lacks successful unqualified precision evidence`);
    if (
      name === "selectedPrecision" &&
      (report.modelSha256 !== manifest.modelSha256 ||
        report.nativeBinarySha256 !== manifest.binary.sha256)
    )
      fail("selected export precision identity changed");
  }
  const git = (...args) =>
    execFileSync("git", ["-C", manifest.sfPi, ...args], {
      encoding: "utf8",
    }).trim();
  if (git("rev-parse", "HEAD") !== manifest.hostCommit)
    fail("host commit changed");
  git("diff", "--quiet", "HEAD");
  const lock = await pinned(manifest.dependencyLock, true);
  if (
    sha(
      execFileSync("git", [
        "-C",
        manifest.sfPi,
        "show",
        `${manifest.hostCommit}:package-lock.json`,
      ]),
    ) !== manifest.dependencyLock.sha256
  )
    fail("dependency lock differs from pinned host");
  await pinned({
    path: resolve(manifest.sfDeps, "package-lock.json"),
    sha256: manifest.dependencyLock.sha256,
  });
  const sdkPackages = {};
  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
  ]) {
    const path = resolve(manifest.sfDeps, "node_modules", name, "package.json");
    const raw = await readFile(path),
      installed = JSON.parse(raw);
    if (installed.version !== lock.packages?.[`node_modules/${name}`]?.version)
      fail(`installed ${name} differs from host lock`);
    sdkPackages[name] = { path, sha256: sha(raw), version: installed.version };
  }
  await mkdir(output, { recursive: false });
  const fixture = resolve(output, "sf-pi-fixture");
  await mkdir(fixture);
  const archive = execFileSync(
    "git",
    ["-C", manifest.sfPi, "archive", manifest.hostCommit],
    { maxBuffer: 128 * 1048576 },
  );
  execFileSync("tar", ["-xf", "-", "-C", fixture], { input: archive });
  await symlink(
    resolve(manifest.sfDeps, "node_modules"),
    resolve(fixture, "node_modules"),
  );
  const relativeTest = "extensions/sf-guardrail/tests/jev-risk-sdk.test.ts";
  let source = await readFile(manifest.sdkTest.path, "utf8");
  source = source.replace(
    "import { JEV_RISK_COMPARISON_ENTRY, JEV_RISK_PROVIDER_EVENT }",
    "import { getJevRiskPolicySha256, JEV_RISK_COMPARISON_ENTRY, JEV_RISK_PROVIDER_EVENT }",
  );
  const marker = 'JEV_DEVICE: process.env.JEV_DEVICE ?? "metal",';
  if (!source.includes(marker))
    fail("SDK source fixture injection marker changed");
  source = source.replace(
    marker,
    marker +
      "\n        JEV_C10_FIXTURE_POLICY_SHA256: getJevRiskPolicySha256(state.config!),",
  );
  await writeFile(resolve(fixture, relativeTest), source);
  const manifestPath = resolve(output, "workflow-input.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const env = {
    ...process.env,
    JEV_C10_WORKFLOW_MANIFEST: manifestPath,
    GUARDRAIL_SDK_LOCAL_MODEL: "1",
    GUARDRAIL_SDK_LOCAL_JEV_MODULE: manifest.adapter.path,
    GUARDRAIL_SDK_LOCAL_MODEL_FILE: manifest.model.path,
    GUARDRAIL_SDK_LOCAL_MODEL_ID: manifest.modelId,
    GUARDRAIL_SDK_LOCAL_ARTIFACT_REGISTRY: manifest.registry.path,
    GUARDRAIL_SDK_LOCAL_OUTPUT: resolve(output, "sdk-shadow.json"),
  };
  delete env.GUARDRAIL_SDK_LOCAL_QUALIFICATION;
  const exit = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(fixture, "node_modules/vitest/vitest.mjs"), "run", relativeTest],
      { cwd: fixture, env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  await unlink(resolve(fixture, "node_modules"));
  for (const name of [
    "model",
    "registry",
    "binary",
    "sdkTest",
    "adapter",
    "backend",
    "guardrail",
    "evaluation",
    "test",
    "freeze",
    "importReport",
    "localPrecision",
    "selectedPrecision",
    "dependencyLock",
  ])
    await pinned(manifest[name]);
  for (const pin of Object.values(sdkPackages)) await pinned(pin);
  let observed = null;
  try {
    observed = JSON.parse(
      await readFile(resolve(output, "sdk-shadow.json"), "utf8"),
    );
  } catch {}
  const checks = observed?.measurements?.find((row) => row.mode === "shadow");
  const projectedModelConfirmations = (checks?.comparisons ?? []).filter(
    (row) => row.source === "jev" && row.actual === "confirm",
  ).length;
  const timings = (checks?.comparisons ?? [])
    .filter((row) => row.source === "jev")
    .map((row) => row.elapsedMs)
    .sort((a, b) => a - b);
  const warmP95Ms = timings.length
    ? timings[Math.ceil(timings.length * 0.95) - 1]
    : null;
  const report = {
    version: 1,
    purpose: "candidate10_sdk_workflow_status",
    qualified: false,
    enforcementEligible: false,
    externalOperationsExecuted: 0,
    exit,
    fixtureSourceSha256: sha(source),
    actualNativeMeasured: Boolean(checks),
    sdkPackages,
    projectedModelConfirmations,
    confirmationCountsAreProjected: true,
    warmP95Ms,
    idealWarmP95Below500: warmP95Ms !== null && warmP95Ms < 500,
    everyEligibleAnswered: Boolean(
      checks &&
      checks.completedSemanticRiskChecks === checks.expectedModelAnswerCount &&
      timings.length === checks.expectedModelAnswerCount &&
      checks.fallbackReasons.length === 0,
    ),
    warmHard750Passed:
      timings.length > 0 &&
      timings.every((ms) => Number.isFinite(ms) && ms >= 0 && ms < 750),
    scope:
      "Actual Pi SDK off/shadow dispatch and native inference with counter-only tools. No enforce run or production acceptance.",
    remainingGates: [
      "C10_enforcement_receipt_support",
      "actual_native_enforce_workflow",
      "runtime_surface",
      "production_acceptance",
    ],
  };
  await writeFile(
    resolve(output, "workflow-status.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return report;
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
  const report = await runWorkflows(
    await pinned(
      { path: values.manifest, sha256: values["manifest-sha256"] },
      true,
    ),
    resolve(values.output),
  );
  if (report.exit.code !== 0) process.exitCode = 1;
}
