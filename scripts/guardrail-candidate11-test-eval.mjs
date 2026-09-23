#!/usr/bin/env node
/** C11 admitted independent TEST diagnostic; real native/host replay, no operations. */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  candidate8OperationSha256,
  runCandidate8HostRows,
} from "./guardrail-candidate8-host-core.mjs";
import { createCandidate9ShadowProvider } from "./guardrail-candidate9-valid-eval.mjs";
import {
  TEST_INPUT_SPEC,
  isSha256,
  sha256,
  verifyC11TestSelection,
  verifyC11TestMetadata,
  normalizeC11TestSentinel,
  verifyC11TestAdmission,
  verifyC11TestSource,
  scoreC11IndependentTest,
} from "./guardrail-candidate11-test-score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
const runtimeFiles = Object.freeze([
  "dist/core.js",
  "dist/backend.js",
  "dist/models.js",
  "dist/guardrail.js",
  "dist/guardrail-c9-baseline-seal.js",
  "scripts/guardrail-c9-test-baseline.mjs",
  "scripts/guardrail-candidate8-host-core.mjs",
  "scripts/guardrail-candidate9-valid-eval.mjs",
  "scripts/guardrail-candidate9-valid-score.mjs",
  "scripts/guardrail-candidate9-artifact-provenance.mjs",
  "scripts/guardrail-v3-research-detect-stub.mjs",
  "scripts/guardrail-candidate11-test-score.mjs",
  "scripts/guardrail-candidate11-test-eval.mjs",
  "package-lock.json",
]);
function fail(message) {
  throw new Error(`C11 independent TEST replay: ${message}`);
}
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
function required(values, names) {
  for (const name of names)
    if (!values[name] || !isAbsolute(values[name]))
      fail(`required absolute path: --${name}`);
}
async function regularBytes(path, maximum = 32 * 1_048_576) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    fail(`expected bounded regular file: ${path}`);
  return readFile(path);
}
async function pinnedBytes(path, pin) {
  if (!isAbsolute(path ?? "") || !isSha256(pin))
    fail("absolute evidence path and independent SHA256 required");
  const bytes = await regularBytes(path);
  if (sha256(bytes) !== pin)
    fail(`evidence differs from independent SHA256: ${path}`);
  return bytes;
}
async function runtimeHashes(selection) {
  const files = [
    ...new Set([...runtimeFiles, ...Object.keys(selection.protocol.files)]),
  ].sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (path) => [
        path,
        sha256(await regularBytes(resolve(root, path))),
      ]),
    ),
  );
}
async function modules() {
  const [models, guardrail, backend, baselineSeal] = await Promise.all(
    ["models", "guardrail", "backend", "guardrail-c9-baseline-seal"].map(
      (name) => import(pathToFileURL(resolve(root, `dist/${name}.js`)).href),
    ),
  );
  return { models, guardrail, backend, baselineSeal };
}
async function identity(selection, api, registry, sfDeps) {
  for (const [path, pin] of Object.entries(selection.protocol.files))
    await pinnedBytes(resolve(root, path), pin);
  if (
    api.guardrail.GUARDRAIL_PROTOCOL_SHA256 !==
      selection.protocol.promptProtocolSha256 ||
    api.guardrail.GUARDRAIL_LIMITS.deadlineMs !== 750
  )
    fail("prompt protocol or deadline changed from selection");
  git(root, "diff", "--quiet", "HEAD");
  git(selection.host.path, "diff", "--quiet", "HEAD");
  if (git(selection.host.path, "rev-parse", "HEAD") !== selection.host.commit)
    fail("host checkout changed from selection");
  const artifact = await api.models.verifyArtifact(
    selection.model.file,
    "classifier",
    selection.model.id,
    { registryPath: registry },
  );
  if (
    artifact.sha256 !== selection.model.sha256 ||
    artifact.base_model !== selection.model.base ||
    artifact.revision !== selection.model.baseRevision ||
    artifact.template_version !== "v2"
  )
    fail("selected artifact lineage or template changed");
  const nativeSha256 = (
    await api.models.hashArtifact(selection.protocol.nativeBinary.path)
  ).sha256;
  if (nativeSha256 !== selection.protocol.nativeBinary.sha256)
    fail("native binary changed from selection");
  const nodeExecutable = await realpath(process.execPath);
  return {
    runtime: await runtimeHashes(selection),
    modelSha256: artifact.sha256,
    nativeSha256,
    registrySha256: sha256(await regularBytes(registry)),
    hostCommit: selection.host.commit,
    node: {
      version: process.version,
      executable: nodeExecutable,
      sha256: (await api.models.hashArtifact(nodeExecutable)).sha256,
    },
    dependencyLockSha256: sha256(
      await regularBytes(resolve(sfDeps, "node_modules/.package-lock.json")),
    ),
  };
}

/** Pin effective evaluator and the input contract without reading any TEST file. */
export async function sealC11TestRuntime(values) {
  required(values, ["selection-freeze", "registry", "sf-deps", "output"]);
  const raw = await pinnedBytes(
    values["selection-freeze"],
    values["selection-freeze-sha256"],
  );
  const selection = verifyC11TestSelection(
    raw,
    values["selection-freeze-sha256"],
  );
  await pinnedBytes(
    selection.selection.source,
    selection.selection.sourceSha256,
  );
  const api = await modules();
  const captured = await identity(
    selection,
    api,
    values.registry,
    values["sf-deps"],
  );
  const freeze = {
    version: 1,
    purpose: "candidate11_independent_test_runtime_freeze",
    frozenAt: new Date().toISOString(),
    selectionFreezeSha256: sha256(raw),
    inputSpec: TEST_INPUT_SPEC,
    diagnosticOnly: true,
    qualified: false,
    enforcementEligible: false,
    testBodyRead: false,
    modelScoringStarted: false,
    externalOperationsExecuted: 0,
    registry: values.registry,
    sfDeps: values["sf-deps"],
    identity: captured,
  };
  const bytes = Buffer.from(`${JSON.stringify(freeze, null, 2)}\n`);
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, bytes, { flag: "wx", mode: 0o600 });
  return {
    runtimeFreeze: values.output,
    runtimeFreezeSha256: sha256(bytes),
    selectionFreezeSha256: sha256(raw),
    modelScoringStarted: false,
  };
}

export async function runC11IndependentTest(values) {
  required(values, [
    "selection-freeze",
    "runtime-freeze",
    "source",
    "manifest",
    "preflight",
    "baseline-seal",
    "admission",
    "output",
  ]);
  const selectionRaw = await pinnedBytes(
    values["selection-freeze"],
    values["selection-freeze-sha256"],
  );
  const selection = verifyC11TestSelection(
    selectionRaw,
    values["selection-freeze-sha256"],
  );
  const runtimeRaw = await pinnedBytes(
    values["runtime-freeze"],
    values["runtime-freeze-sha256"],
  );
  const runtimeFreeze = JSON.parse(runtimeRaw);
  if (
    runtimeFreeze?.version !== 1 ||
    runtimeFreeze.purpose !== "candidate11_independent_test_runtime_freeze" ||
    runtimeFreeze.selectionFreezeSha256 !== sha256(selectionRaw) ||
    !isDeepStrictEqual(runtimeFreeze.inputSpec, TEST_INPUT_SPEC) ||
    runtimeFreeze.diagnosticOnly !== true ||
    runtimeFreeze.qualified !== false ||
    runtimeFreeze.enforcementEligible !== false ||
    runtimeFreeze.testBodyRead !== false ||
    runtimeFreeze.modelScoringStarted !== false ||
    runtimeFreeze.externalOperationsExecuted !== 0 ||
    !isAbsolute(runtimeFreeze.registry ?? "") ||
    !isAbsolute(runtimeFreeze.sfDeps ?? "")
  )
    fail("runtime freeze lacks prospectively sealed selection and input spec");
  const pins = {
    selectionFreezeSha256: sha256(selectionRaw),
    sourceSha256: values["source-sha256"],
    manifestSha256: values["manifest-sha256"],
    preflightSha256: values["preflight-sha256"],
    baselineSealSha256: values["baseline-seal-sha256"],
  };
  // Independent admission must be verified before any TEST body access.
  const admissionRaw = await pinnedBytes(
    values.admission,
    values["admission-sha256"],
  );
  verifyC11TestAdmission(JSON.parse(admissionRaw), pins);
  const [manifestRaw, preflightRaw, baselineSealRaw] = await Promise.all([
    pinnedBytes(values.manifest, pins.manifestSha256),
    pinnedBytes(values.preflight, pins.preflightSha256),
    pinnedBytes(values["baseline-seal"], pins.baselineSealSha256),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const sentinel = JSON.parse(preflightRaw);
  const preflight = normalizeC11TestSentinel(sentinel, pins.manifestSha256);
  const baselineSeal = JSON.parse(baselineSealRaw);
  if (
    baselineSeal?.version !== 1 ||
    baselineSeal.purpose !== "candidate9_pre_model_test_baseline_seal" ||
    baselineSeal.modelScoringStarted !== false ||
    baselineSeal.qualification !== false ||
    baselineSeal.sourceSha256 !== pins.sourceSha256 ||
    baselineSeal.preflightSha256 !== pins.preflightSha256 ||
    baselineSeal.selectionFreezeSha256 !== pins.selectionFreezeSha256 ||
    baselineSeal.hostCommit !== selection.host.commit ||
    baselineSeal.hostRuntimeSha256 !== selection.host.baselineSha256 ||
    baselineSeal.policySha256 !== selection.host.policySha256 ||
    baselineSeal.scorerProtocolSha256 !==
      selection.protocol.promptProtocolSha256 ||
    baselineSeal.cases !== manifest.source?.case_count ||
    baselineSeal.groups !== manifest.source?.group_count ||
    baselineSeal.runnerSha256 !==
      sha256(
        await regularBytes(
          resolve(root, "scripts/guardrail-c9-test-baseline.mjs"),
        ),
      ) ||
    baselineSeal.stubSha256 !==
      sha256(
        await regularBytes(
          resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
        ),
      )
  )
    fail(
      "model-free baseline seal differs from selected host, prompt, source, or actual runner/stub",
    );
  const population = verifyC11TestMetadata(
    manifest,
    preflight,
    pins,
    selection,
  );
  const api = await modules();
  const before = await identity(
    selection,
    api,
    runtimeFreeze.registry,
    runtimeFreeze.sfDeps,
  );
  if (!isDeepStrictEqual(before, runtimeFreeze.identity))
    fail("effective runtime changed after pre-TEST seal");
  await pinnedBytes(
    selection.selection.source,
    selection.selection.sourceSha256,
  );
  const sourceRaw = await pinnedBytes(values.source, pins.sourceSha256);
  api.baselineSeal.verifyC9PreModelBaselineSeal(
    sourceRaw.toString("utf8"),
    preflightRaw.toString("utf8"),
    baselineSealRaw.toString("utf8"),
    pins.baselineSealSha256,
    pins.selectionFreezeSha256,
  );
  const source = JSON.parse(sourceRaw);
  const byId = verifyC11TestSource(
    source,
    manifest,
    preflight,
    candidate8OperationSha256,
  );
  const config = api.backend.configFromEnv({
    JEV_DEVICE: "metal",
    JEV_TEMPLATE_VERSION: "v2",
    JEV_MODEL_ID: selection.model.id,
    JEV_MODEL_FILE: selection.model.file,
  });
  Object.assign(config, {
    artifactRegistryPath: runtimeFreeze.registry,
    binary: selection.protocol.nativeBinary.path,
    maxModelLen: 2048,
    maxBatchSize: 32,
    maxBatchTokens: 2048,
    queueTimeoutMs: 750,
    requestTimeoutMs: 750,
  });
  const calibrationSha256 = selection.selection.sourceSha256;
  const scoringProtocolSha256 = sha256(
    JSON.stringify({
      version: 1,
      purpose: "candidate11_independent_test_diagnostic_scoring",
      selectionFreezeSha256: sha256(selectionRaw),
      runtimeFreezeSha256: sha256(runtimeRaw),
      promptProtocolSha256: selection.protocol.promptProtocolSha256,
      modelSha256: selection.model.sha256,
      nativeBinarySha256: selection.protocol.nativeBinary.sha256,
      calibrationSha256,
      minimumAllowScore: selection.minimumAllowScore,
    }),
  );
  const providerPins = {
    hostBaselineSha256: selection.host.baselineSha256,
    policySha256: selection.host.policySha256,
    modelSha256: selection.model.sha256,
    scoringProtocolSha256,
    calibrationSha256,
    minimumAllowScore: selection.minimumAllowScore,
  };
  await mkdir(values.output, { recursive: false });
  try {
    const replay = await runCandidate8HostRows({
      rows: source.cases,
      preflightById: byId,
      sfPi: selection.host.path,
      sfDeps: runtimeFreeze.sfDeps,
      stubFile: resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
      hostCommit: selection.host.commit,
      hostRuntimeSha256: selection.host.baselineSha256,
      protocolSha256: scoringProtocolSha256,
      expectedModelSha256: selection.model.sha256,
      expectedCalibrationSha256: calibrationSha256,
      expectedMinimumAllowScore: selection.minimumAllowScore,
      expectedPolicySha256: selection.host.policySha256,
      validateInput: api.guardrail.validateGuardrailInput,
      createProvider: createCandidate9ShadowProvider({
        backendModule: api.backend,
        guardrail: api.guardrail,
        config,
        pins: providerPins,
        modelId: selection.model.id,
      }),
    });
    const summary = scoreC11IndependentTest(
      replay.records,
      preflight,
      population,
      providerPins,
      selection,
    );
    const after = await identity(
      selection,
      api,
      runtimeFreeze.registry,
      runtimeFreeze.sfDeps,
    );
    if (!isDeepStrictEqual(before, after))
      fail(
        "model, native, host, dependencies, or evaluator changed during TEST replay",
      );
    for (const [path, pin] of [
      [values.source, pins.sourceSha256],
      [values.manifest, pins.manifestSha256],
      [values.preflight, pins.preflightSha256],
      [values["baseline-seal"], pins.baselineSealSha256],
      [values.admission, sha256(admissionRaw)],
      [values["selection-freeze"], sha256(selectionRaw)],
      [values["runtime-freeze"], sha256(runtimeRaw)],
      [selection.selection.source, selection.selection.sourceSha256],
    ])
      await pinnedBytes(path, pin);
    const report = {
      ...summary,
      providerKind: "real_jev_native",
      executionSurface: "sf_guardrail_bridge_shadow",
      mode: "shadow",
      externalOperationsExecuted: 0,
      mockedHostFacts: true,
      coldInitializationMs: replay.coldInitializationMs,
      source: {
        ...pins,
        admissionSha256: sha256(admissionRaw),
        runtimeFreezeSha256: sha256(runtimeRaw),
        jevCommit: git(root, "rev-parse", "HEAD"),
        hostCommit: selection.host.commit,
        hostBaselineSha256: selection.host.baselineSha256,
        ...providerPins,
        identity: before,
      },
      independentTestCriteria: selection.independentTestSuccess,
      guardrailQualificationCriteria: selection.guardrailQualification,
      records: replay.records,
      proofLimits: [
        "Independent diagnostic accuracy does not grant guardrail qualification or enforcement admission.",
        "Original CAL safety selector and prior diagnostic VALID failures are retained in the selected evidence; no qualifying CAL receipt is synthesized.",
        "Host facts are fixtures; no authored tool operation was executed.",
        "Independent author/reviewer and overlap assertions are supplied by the admitted audit receipt.",
        "Installed dependency provenance is bound by its installed lockfile; package contents are not exhaustively hashed.",
        "Cold initialization is separate from warm full-host preparation and queue timing.",
      ],
    };
    const reportRaw = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    const reportPath = resolve(values.output, "report.json");
    await writeFile(reportPath, reportRaw, { flag: "wx", mode: 0o600 });
    return {
      report: reportPath,
      reportSha256: sha256(reportRaw),
      metrics: summary.metrics,
      diagnosticComplete: summary.diagnosticComplete,
      independentAccuracyTargetPassed: summary.independentAccuracyTargetPassed,
      guardrailGates: summary.guardrailGates,
      qualified: false,
      enforcementEligible: false,
    };
  } catch (error) {
    await writeFile(
      resolve(values.output, "failure.json"),
      `${JSON.stringify(
        {
          version: 1,
          purpose: "candidate11_independent_test_failed_attempt",
          diagnosticOnly: true,
          qualified: false,
          enforcementEligible: false,
          selectionFreezeSha256: sha256(selectionRaw),
          runtimeFreezeSha256: sha256(runtimeRaw),
          sourceSha256: pins.sourceSha256,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    throw error;
  }
}

async function main() {
  const options = [
    "selection-freeze",
    "selection-freeze-sha256",
    "runtime-freeze",
    "runtime-freeze-sha256",
    "registry",
    "sf-deps",
    "source",
    "source-sha256",
    "manifest",
    "manifest-sha256",
    "preflight",
    "preflight-sha256",
    "baseline-seal",
    "baseline-seal-sha256",
    "admission",
    "admission-sha256",
    "output",
  ];
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      options.map((name) => [name, { type: "string" }]),
    ),
  });
  if (
    positionals.length !== 1 ||
    !["seal-runtime", "score"].includes(positionals[0])
  )
    fail("choose one stage: seal-runtime or score");
  const result = await (positionals[0] === "seal-runtime"
    ? sealC11TestRuntime(values)
    : runC11IndependentTest(values));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (
    result.diagnosticComplete === false ||
    result.independentAccuracyTargetPassed === false
  )
    process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === script) await main();
