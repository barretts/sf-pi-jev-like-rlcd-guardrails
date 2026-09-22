#!/usr/bin/env node
/** Prospective C9 VALID shadow replay; authored operations are never executed. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  candidate8OperationSha256,
  runCandidate8HostRows,
} from "./guardrail-candidate8-host-core.mjs";
import { verifyC9Q8Artifact } from "./guardrail-candidate9-artifact-provenance.mjs";
import {
  candidate9QualificationEvidence,
  summarizeCandidate9Valid,
} from "./guardrail-candidate9-valid-score.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const reportRoot = "reports/guardrail-risk-2026-09-21";
const seal = Object.freeze({
  source: "d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f",
  manifest: "b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc",
  preflight: "e447ad75c256fbc16f24ab8e192ca0e98b968b853d72017ddaa65c92b78f3884",
  hostCommit: "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a",
  hostBaseline:
    "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421",
  policy: "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
  admission: "ce145449b951d67996a6d6d4348725e0513afd5db8910f479060216ece098131",
  prepared: 116,
});
const files = Object.freeze({
  source: "blind-c9-20260922/valid.json",
  manifest: "blind-c9-20260922/manifest.json",
  schema: "blind-c9-20260922/case.schema.json",
  preflight: `${reportRoot}/candidate-9-evidence/valid/preflight-4f7fae0.json`,
  preflightScript: "scripts/guardrail-candidate9-valid-preflight.mjs",
  rubric: "fixtures/guardrail/RUBRIC.md",
  stub: "scripts/guardrail-v3-research-detect-stub.mjs",
  hostCore: "scripts/guardrail-candidate8-host-core.mjs",
  scorer: "scripts/guardrail-candidate9-valid-score.mjs",
  evaluator: "scripts/guardrail-candidate9-valid-eval.mjs",
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new Error(`C9 VALID replay: ${message}`);
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
const inside = (path, parent) => {
  const rel = relative(parent, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function regularBytes(path, maximum = 16 * 1_048_576) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximum)
    fail(`expected bounded regular file: ${path}`);
  return readFile(path);
}

async function committedBytes(path, expected) {
  const full = resolve(root, path);
  if (!inside(full, root)) fail("committed source escaped Jev checkout");
  const raw = await regularBytes(full);
  const committed = execFileSync("git", ["show", `HEAD:${path}`], {
    cwd: root,
  });
  if (!raw.equals(committed) || (expected && sha(raw) !== expected))
    fail(`committed source or SHA pin changed: ${path}`);
  return raw;
}

/** Shape and exact row join only; callers supply their own sealed bytes. */
export function verifyCandidate9ValidPopulation(source, manifest, preflight) {
  if (
    source?.schema_version !== "c9.1" ||
    source.split !== "valid" ||
    source.cases?.length !== 160 ||
    manifest?.source?.case_count !== 160 ||
    manifest.source.group_count !== 80 ||
    preflight?.version !== 1 ||
    preflight.mode !== "fake-facts-no-model-no-execution" ||
    preflight.source_sha256 !== seal.source ||
    preflight.manifest_sha256 !== seal.manifest ||
    preflight.host_commit !== seal.hostCommit ||
    preflight.host_baseline_sha256 !== seal.hostBaseline ||
    preflight.default_policy_sha256 !== seal.policy ||
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
      !hash(status.policy_sha256) ||
      status.operation_sha256 !== candidate8OperationSha256(row) ||
      (status.routing === "model_prepared") !==
        hash(status.risk_input_sha256) ||
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
      if (status.policy_sha256 !== seal.policy)
        fail(`prepared policy differs from frozen calibration: ${row.id}`);
    }
  }
  if (
    groups.size !== 80 ||
    [...groups.values()].some((size) => size !== 2) ||
    prepared !== seal.prepared ||
    preflight.status.filter((row) => row.routing === "pre_model_fallback")
      .length !== 5
  )
    fail("complete pair or prepared-call inventory changed");
  return byId;
}

/** Keep code-owned C9 routes distinct from unexpected host exceptions. */
export function verifyCandidate9NonModelRoutes(records, preflight) {
  if (
    !Array.isArray(records) ||
    !Array.isArray(preflight?.status) ||
    records.length !== preflight.status.length
  )
    fail("non-model replay inventory differs from sealed preflight");
  const orgFallbacks = new Set([
    "Jev Salesforce org target is ambiguous; using Safety Kernel fallback",
    "Jev org lookup failed; using Safety Kernel fallback",
    "Jev Salesforce org identity unverified; using Safety Kernel fallback",
  ]);
  const browserFallbacks = new Set([
    "Browser reference evidence unavailable before model check",
    "Jev browser click lacks matching recent reference and page observations; using Safety Kernel fallback",
  ]);
  for (let index = 0; index < records.length; index++) {
    const row = records[index];
    const sealed = preflight.status[index];
    if (row?.id !== sealed?.id || row.routing !== sealed.routing)
      fail(
        `non-model replay row differs from preflight: ${sealed?.id ?? index}`,
      );
    if (sealed.routing === "model_prepared") continue;
    const source = row.comparison?.source;
    const reason = row.comparison?.reason;
    const exactPolicy =
      source === "exact_policy" && reason === "exact_policy_constraint";
    let preserved = false;
    if (sealed.routing === "rules_fallback") {
      preserved =
        ["host_policy_floor", "ineligible"].includes(sealed.reason) &&
        exactPolicy;
    } else if (sealed.routing === "pre_model_fallback") {
      if (sealed.reason === "org_fact_unavailable")
        preserved =
          exactPolicy ||
          (source === "rules_fallback" && orgFallbacks.has(reason));
      else if (sealed.reason === "browser_evidence_unavailable")
        preserved =
          exactPolicy ||
          (source === "rules_fallback" && browserFallbacks.has(reason));
      else if (orgFallbacks.has(sealed.reason))
        preserved = source === "rules_fallback" && reason === sealed.reason;
    }
    if (
      !preserved ||
      row.modelCalls !== 0 ||
      row.modelAnswered !== false ||
      row.fallbackReason !==
        (sealed.routing === "pre_model_fallback" ? sealed.reason : undefined) ||
      (sealed.routing === "pre_model_fallback" && row.hostReason !== reason)
    )
      fail(`code-owned fallback route or reason changed: ${row.id}`);
  }
}

async function readSealedMetadata() {
  const bytes = {};
  for (const [name, path] of Object.entries(files))
    if (name !== "source") bytes[name] = await committedBytes(path, seal[name]);
  const manifest = JSON.parse(bytes.manifest);
  const preflight = JSON.parse(bytes.preflight);
  if (
    manifest.source.sha256 !== seal.source ||
    manifest.host?.commit !== seal.hostCommit ||
    manifest.host.baseline_identity_sha256 !== seal.hostBaseline ||
    manifest.host.default_policy_sha256 !== seal.policy ||
    sha(bytes.schema) !== manifest.authoring.schema_sha256 ||
    sha(bytes.rubric) !== manifest.authoring.rubric_sha256 ||
    sha(bytes.preflightScript) !== preflight.preflight_script_sha256 ||
    preflight.model_protocol_sha256 !== preflight.scorer_prompt_sha256 ||
    preflight.operation_sha256_contract !==
      "sha256(jev canonical({toolName,input:originalOperation,cwd}))"
  )
    fail("blind seal, preflight, or protocol bytes changed");
  return { bytes, manifest, preflight };
}

async function readSealedSources(metadata) {
  // The caller must already have independently verified an accepted C9 CAL
  // receipt and exact Q8 lineage before reaching this blind source read.
  const bytes = {
    ...metadata.bytes,
    source: await committedBytes(files.source, seal.source),
  };
  const source = JSON.parse(bytes.source);
  return {
    bytes,
    preflight: metadata.preflight,
    byId: verifyCandidate9ValidPopulation(
      source,
      metadata.manifest,
      metadata.preflight,
    ),
    rows: source.cases,
    hashes: Object.fromEntries(
      Object.entries(bytes).map(([key, value]) => [key, sha(value)]),
    ),
  };
}

async function loadSelection(
  values,
  preflight,
  modelSha256,
  nativeBinarySha256,
) {
  const cutoffFile = resolve(values["cutoff-file"] ?? "");
  if (
    !values["cutoff-file"] ||
    !isAbsolute(values["cutoff-file"]) ||
    !inside(cutoffFile, root) ||
    !hash(values["cutoff-sha256"])
  )
    fail("a committed C9 cutoff file and external SHA-256 pin are required");
  const rel = relative(root, cutoffFile);
  const cutoffRaw = await committedBytes(rel, values["cutoff-sha256"]);
  const { verifyC9Calibration } = await import(
    pathToFileURL(resolve(root, "dist/guardrail-c9-calibration.js")).href
  );
  const selected = verifyC9Calibration(
    JSON.parse(cutoffRaw),
    modelSha256,
    nativeBinarySha256,
  );
  if (
    selected.accepted !== true ||
    selected.reason !== "selected" ||
    selected.input?.artifactFormat !== "q8_0" ||
    selected.input.admissionSha256 !== seal.admission ||
    selected.input.hostCommit !== seal.hostCommit ||
    selected.input.baselineSha256 !== seal.hostBaseline ||
    selected.input.policySha256 !== seal.policy ||
    selected.input.promptProtocolSha256 !== preflight.model_protocol_sha256 ||
    !hash(selected.scoringProtocolSha256) ||
    !Number.isFinite(selected.minimumAllowScore) ||
    selected.minimumAllowScore < 0.5 ||
    selected.minimumAllowScore >= 1
  )
    fail("C9 TRAIN-CAL veto did not select this exact host, model, and cutoff");
  const admissionRaw = await committedBytes(
    `${reportRoot}/candidate-9-evidence/train/admission.json`,
    seal.admission,
  );
  const arm = selected.input.arm;
  if (!["A", "B"].includes(arm)) fail("unknown frozen C9 arm");
  const objectivePath = `fixtures/guardrail/candidate9/objective-plan-${arm}.json`;
  const objectiveRaw = await committedBytes(
    objectivePath,
    selected.input.objectivePlanSha256,
  );
  const runDirectory = resolve(values.run ?? "");
  const lineage = await verifyC9Q8Artifact({
    paths: {
      runDirectory,
      objectivePlan: resolve(root, objectivePath),
      f16Model: resolve(values["f16-model"] ?? ""),
      q8Model: resolve(values["model-file"] ?? ""),
      calScorerCli: resolve(root, "scripts/guardrail-candidate9-cal-cli.mjs"),
      calScorerCore: resolve(
        root,
        "scripts/guardrail-candidate9-cal-score.mjs",
      ),
      nativeBinary: resolve(values["native-binary"] ?? ""),
      selectorCli: resolve(
        root,
        "scripts/guardrail-candidate9-select-cutoff.mjs",
      ),
      calibrationRuntime: resolve(root, "dist/guardrail-c9-calibration.js"),
    },
    expected: selected.input,
    admission: JSON.parse(admissionRaw),
    objectivePlanSha256: sha(objectiveRaw),
    modelSha256,
    arm,
  });
  if (
    lineage.modelId !== values["model-id"] ||
    lineage.modelSha256 !== modelSha256
  )
    fail("chosen Q8 registry and model differ from C9 CAL");
  return { selected, cutoffSha256: sha(cutoffRaw), lineage };
}

async function runtimeHashes() {
  const names = [
    "backend.js",
    "core.js",
    "guardrail.js",
    "models.js",
    "guardrail-c9-calibration.js",
  ];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        sha(await regularBytes(resolve(root, "dist", name))),
      ]),
    ),
  );
}

/** A shadow-only C9 provider with the exact CAL-selected scoring identity. */
export function createCandidate9ShadowProvider({
  backendModule,
  guardrail,
  config,
  pins,
  modelId,
}) {
  return async (pi, event) => {
    const native = new backendModule.NativeBackend(config);
    const classifier = new backendModule.Classifier(config, native);
    let generation = null;
    const provider = {
      version: 2,
      id: "jev",
      protocolSha256: pins.scoringProtocolSha256,
      modelSha256: pins.modelSha256,
      qualified: false,
      minimumAllowScore: pins.minimumAllowScore,
      calibrationSha256: pins.calibrationSha256,
      calibrationPolicySha256: pins.policySha256,
      calibrationBaselineSha256: pins.hostBaselineSha256,
      async evaluate(input, signal) {
        if (
          native.status.generation !== generation ||
          native.status.artifact?.sha256 !== pins.modelSha256
        )
          throw new Error(
            "C9 native worker or model changed before evaluation",
          );
        const prediction = await guardrail.classifyGuardrailRisk(
          classifier,
          input,
          modelId,
          signal,
          pins.minimumAllowScore,
        );
        if (
          native.status.generation !== generation ||
          native.status.artifact?.sha256 !== pins.modelSha256
        )
          throw new Error(
            "C9 native worker or model changed during evaluation",
          );
        return prediction;
      },
    };
    pi.events.on(event, (request) => request.providers.push(provider));
    return {
      async warmup() {
        await native.warmup();
        generation = native.status.generation;
        if (
          !native.status.ready ||
          generation === null ||
          native.status.artifact?.sha256 !== pins.modelSha256
        )
          fail("C9 native warmup loaded another artifact");
      },
      status: () => ({
        protocolSha256: provider.protocolSha256,
        modelSha256: provider.modelSha256,
        calibrationSha256: provider.calibrationSha256,
        minimumAllowScore: provider.minimumAllowScore,
      }),
      dispose: () => classifier.dispose(),
    };
  };
}

async function main() {
  const names = [
    "sf-pi",
    "sf-deps",
    "output-dir",
    "cutoff-file",
    "cutoff-sha256",
    "run",
    "f16-model",
    "model-file",
    "model-id",
    "model-sha256",
    "native-binary",
  ];
  const { values } = parseArgs({
    options: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
  });
  const outputDir = resolve(values["output-dir"] ?? "");
  if (
    names.some((name) => !values[name]) ||
    ![
      "sf-pi",
      "sf-deps",
      "output-dir",
      "cutoff-file",
      "run",
      "f16-model",
      "model-file",
      "native-binary",
    ].every((name) => isAbsolute(values[name])) ||
    !inside(outputDir, buildRoot) ||
    !/^candidate-9-valid-eval-[A-Za-z0-9._-]+$/.test(basename(outputDir)) ||
    !/^jev\/[A-Za-z0-9._-]+$/.test(values["model-id"]) ||
    !hash(values["model-sha256"])
  )
    fail(
      `required absolute paths and pins: ${names.join(", ")}; output must be a new .build/guardrail/candidate-9-valid-eval-* directory`,
    );
  const sfPi = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  if (git(sfPi, "rev-parse", "HEAD") !== seal.hostCommit)
    fail("sf-pi host differs from sealed C9 preflight");
  git(sfPi, "diff", "--quiet", "HEAD");
  const evalHead = git(root, "rev-parse", "HEAD");
  git(root, "diff", "--quiet", "HEAD");
  const metadata = await readSealedMetadata();
  const runtime = await runtimeHashes();
  if (
    runtime["core.js"] !== metadata.preflight.jev_runtime_core_js_sha256 ||
    runtime["guardrail.js"] !==
      metadata.preflight.jev_runtime_guardrail_js_sha256
  )
    fail("compiled Jev request or prompt differs from sealed preflight");
  const [guardrail, backendModule, models] = await Promise.all([
    import(pathToFileURL(resolve(root, "dist/guardrail.js")).href),
    import(pathToFileURL(resolve(root, "dist/backend.js")).href),
    import(pathToFileURL(resolve(root, "dist/models.js")).href),
  ]);
  if (
    guardrail.GUARDRAIL_PROTOCOL_SHA256 !==
      metadata.preflight.model_protocol_sha256 ||
    guardrail.GUARDRAIL_LIMITS.deadlineMs !== 750
  )
    fail("frozen prompt or 750 ms deadline changed");
  const artifact = await models.verifyArtifact(
    values["model-file"],
    "classifier",
    values["model-id"],
    { registryPath: resolve(values.run, "q8-candidate-registry.json") },
  );
  if (
    artifact.sha256 !== values["model-sha256"] ||
    artifact.base_model !== "google/gemma-3-1b-it" ||
    artifact.template_version !== "v2"
  )
    fail("Q8 model and registry differ from chosen Gemma candidate");
  const nativeBinarySha256 = (
    await models.hashArtifact(values["native-binary"])
  ).sha256;
  const selection = await loadSelection(
    values,
    metadata.preflight,
    artifact.sha256,
    nativeBinarySha256,
  );
  const fitPlan = JSON.parse(
    await regularBytes(resolve(values.run, "candidate9-fit-plan.json")),
  );
  for (const [name, actual] of Object.entries(runtime))
    if (fitPlan.source?.code?.files?.[`dist/${name}`] !== actual)
      fail(`compiled ${name} differs from the frozen C9 FIT runtime`);
  const sources = await readSealedSources(metadata);
  const pins = {
    corpusSha256: seal.source,
    manifestSha256: seal.manifest,
    preflightSha256: seal.preflight,
    hostCommit: seal.hostCommit,
    hostBaselineSha256: seal.hostBaseline,
    policySha256: seal.policy,
    modelSha256: artifact.sha256,
    scoringProtocolSha256: selection.selected.scoringProtocolSha256,
    calibrationSha256: selection.cutoffSha256,
    minimumAllowScore: selection.selected.minimumAllowScore,
    expectedPrepared: seal.prepared,
  };
  const config = backendModule.configFromEnv({
    JEV_DEVICE: "metal",
    JEV_TEMPLATE_VERSION: "v2",
    JEV_MODEL_ID: artifact.id,
    JEV_MODEL_FILE: values["model-file"],
  });
  config.artifactRegistryPath = resolve(
    values.run,
    "q8-candidate-registry.json",
  );
  config.binary = values["native-binary"];
  Object.assign(config, {
    maxModelLen: 2048,
    maxBatchSize: 32,
    maxBatchTokens: 2048,
  });
  config.queueTimeoutMs = 750;
  config.requestTimeoutMs = 750;
  await mkdir(buildRoot, { recursive: true });
  await mkdir(outputDir, { recursive: false });
  try {
    const result = await runCandidate8HostRows({
      rows: sources.rows,
      preflightById: sources.byId,
      sfPi,
      sfDeps,
      stubFile: resolve(root, files.stub),
      hostCommit: seal.hostCommit,
      hostRuntimeSha256: seal.hostBaseline,
      protocolSha256: pins.scoringProtocolSha256,
      expectedModelSha256: pins.modelSha256,
      expectedCalibrationSha256: pins.calibrationSha256,
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
    const afterSources = await readSealedSources(await readSealedMetadata());
    const afterRuntime = await runtimeHashes();
    const afterModel = await models.hashArtifact(values["model-file"]);
    const afterNative = await models.hashArtifact(values["native-binary"]);
    if (
      JSON.stringify(sources.hashes) !== JSON.stringify(afterSources.hashes) ||
      JSON.stringify(runtime) !== JSON.stringify(afterRuntime) ||
      afterModel.sha256 !== pins.modelSha256 ||
      afterNative.sha256 !== nativeBinarySha256 ||
      git(root, "rev-parse", "HEAD") !== evalHead ||
      git(sfPi, "rev-parse", "HEAD") !== seal.hostCommit
    )
      fail("source, host, scorer, or model changed during VALID replay");
    verifyCandidate9NonModelRoutes(result.records, sources.preflight);
    const summary = summarizeCandidate9Valid(
      result.records,
      sources.preflight,
      pins,
    );
    const report = {
      ...summary,
      providerKind: "real",
      prospectiveGatesPassed: Object.values(summary.gates).every(Boolean),
      humanLabelReviewComplete: false,
      executionSurface: "sf_guardrail_bridge_shadow",
      externalOperationsExecuted: 0,
      mockedHostFacts: true,
      coldInitializationMs: result.coldInitializationMs,
      source: {
        valid: seal.source,
        manifest: seal.manifest,
        preflight: seal.preflight,
        sfPiCommit: seal.hostCommit,
        sfPiRuntimeSha256: seal.hostBaseline,
        evalHead,
        runtime,
        model: {
          modelId: artifact.id,
          modelSha256: pins.modelSha256,
          nativeBinarySha256,
          scoringProtocolSha256: pins.scoringProtocolSha256,
          calibrationSha256: pins.calibrationSha256,
          minimumAllowScore: pins.minimumAllowScore,
          policySha256: pins.policySha256,
          arm: selection.selected.input.arm,
          lineage: selection.lineage,
        },
      },
      records: result.records,
      proofLimits: [
        "Prospective VALID shadow observation only; TEST remains sealed.",
        "Machine-authored labels await independent human review.",
        "Host facts are fixtures and no authored operation is executed.",
        "Cold initialization is separate from warm full-host timing.",
      ],
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await writeFile(resolve(outputDir, "report.json"), reportBytes, {
      flag: "wx",
      mode: 0o600,
    });
    const evidence = candidate9QualificationEvidence(
      reportBytes,
      sources.bytes.preflight,
      { ...pins, hostReportSha256: sha(reportBytes) },
    );
    await writeFile(
      resolve(outputDir, "qualification-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        output: resolve(outputDir, "report.json"),
        hostReportSha256: sha(reportBytes),
        metrics: report.metrics,
        gates: report.gates,
        prospectiveGatesPassed: report.prospectiveGatesPassed,
      }),
    );
    if (!report.prospectiveGatesPassed) process.exitCode = 1;
  } catch (error) {
    await writeFile(
      resolve(outputDir, "failure.json"),
      `${JSON.stringify(
        {
          version: 1,
          purpose: "candidate9_valid_failed_attempt",
          qualification: false,
          heldOutTestUsed: false,
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
