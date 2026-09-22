#!/usr/bin/env node
/** A physical pre-validation pin, not a model qualification or permission to run TEST. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { canonical } from "../dist/core.js";
import {
  GEMMA_TRAINING_REVISION,
  hashArtifact,
  verifyArtifact,
} from "../dist/models.js";
import {
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
  guardrailRequest,
} from "../dist/guardrail.js";
import {
  GUARDRAIL_BRIDGE_EXPORTER_SOURCE,
  GUARDRAIL_CRITERIA,
  GUARDRAIL_CRITERIA_SHA256,
} from "../dist/guardrail-evaluation.js";
import { guardrailConfig } from "../dist/guardrail-extension.js";

const jevRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new Error(`Guardrail campaign preflight: ${message}`);
};
const same = (actual, expected, description) => {
  if (canonical(actual) !== canonical(expected)) fail(`${description} changed`);
};
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const physical = async (file) => ({
  path: resolve(file),
  ...(await hashArtifact(resolve(file))),
});

/** A later documentation commit is fine; executable identity is compared separately. */
export function assertCompatibleCampaignSnapshot(
  pinned,
  current,
  repository = jevRoot,
) {
  if (!pinned || !current) fail("campaign snapshot is absent");
  const { jevCommit: originalCommit, ...originalInputs } = pinned;
  const { jevCommit: currentCommit, ...currentInputs } = current;
  same(currentInputs, originalInputs, "campaign inputs or executable surfaces");
  if (originalCommit === currentCommit) return;
  try {
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "merge-base",
        "--is-ancestor",
        originalCommit,
        currentCommit,
      ],
      { stdio: "ignore" },
    );
  } catch {
    fail("Jev HEAD is not a descendant of the receipt creation commit");
  }
}

// These are the compiled modules that prepare, score, verify and qualify a risk call.
// Pin their source counterparts to make a source/build mismatch visible in the receipt.
const jevSourceFiles = [
  "src/guardrail.ts",
  "src/guardrail-evaluation.ts",
  "src/guardrail-extension.ts",
  "src/core.ts",
  "src/backend.ts",
  "src/models.ts",
  "scripts/guardrail-eval.mjs",
  "scripts/guardrail-train.mjs",
  "scripts/guardrail-candidate5-bundle.mjs",
  "scripts/guardrail-prospective-plan.mjs",
  "scripts/guardrail-campaign-receipt.mjs",
];
const jevCompiledFiles = [
  "dist/guardrail.js",
  "dist/guardrail-evaluation.js",
  "dist/guardrail-extension.js",
  "dist/core.js",
  "dist/backend.js",
  "dist/models.js",
];

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail("source inventory escapes its repository");
  return rel;
}

async function verifySourceMap(sfRoot, map, description) {
  if (!map || typeof map !== "object" || Array.isArray(map))
    fail(`${description} is missing`);
  const entries = Object.entries(map);
  if (entries.length < 10) fail(`${description} is incomplete`);
  const actual = {};
  const physicalRoot = await realpath(sfRoot);
  for (const [name, pinned] of entries) {
    if (!isHash(pinned) || !name || name.includes("\\"))
      fail(`${description} has an invalid source`);
    const path = resolve(sfRoot, name);
    inside(sfRoot, path);
    inside(physicalRoot, await realpath(path));
    const value = await physical(path);
    if (value.sha256 !== pinned) fail(`${description} source changed: ${name}`);
    actual[name] = value.sha256;
  }
  return actual;
}

/** Rehash both exported source inventories and their independent summary hashes. */
export async function verifyBaselineSources(sfRoot, bundle) {
  if (!bundle || bundle.version !== 1 || bundle.mockedExecution !== true)
    fail("baseline is not a mocked, versioned export");
  if (!isHash(bundle.corpusSha256) || !isHash(bundle.baselineSourceSha256))
    fail("baseline source or corpus identity is absent");
  if (!Array.isArray(bundle.records) || !bundle.records.length)
    fail("baseline records are absent");
  if (bundle.summary?.cases !== bundle.records.length)
    fail("baseline case count is inconsistent");
  const provenance = await verifySourceMap(
    sfRoot,
    bundle.sourceSha256,
    "exporter source inventory",
  );
  const runtime = await verifySourceMap(
    sfRoot,
    bundle.runtimeSourceSha256,
    "runtime source inventory",
  );
  if (
    !Object.hasOwn(provenance, GUARDRAIL_BRIDGE_EXPORTER_SOURCE) ||
    !Object.hasOwn(
      runtime,
      "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
    ) ||
    !Object.hasOwn(runtime, "extensions/sf-guardrail/index.ts")
  )
    fail("baseline source inventory omits an enforcement or export surface");
  if (hash(JSON.stringify(provenance)) !== bundle.provenanceSourceSha256)
    fail("exporter provenance source hash changed");
  const ordered = Object.fromEntries(Object.entries(runtime).sort());
  if (hash(JSON.stringify(ordered)) !== bundle.baselineSourceSha256)
    fail("runtime baseline source hash changed");
  return {
    exporterSha256: provenance[GUARDRAIL_BRIDGE_EXPORTER_SOURCE],
    provenanceSourceSha256: bundle.provenanceSourceSha256,
    baselineSourceSha256: bundle.baselineSourceSha256,
    exporterSources: provenance,
    runtimeSources: runtime,
  };
}

function assertGateContract() {
  if (
    GUARDRAIL_LIMITS.minimumAllowScore !== 0.99 ||
    GUARDRAIL_LIMITS.deadlineMs !== 750 ||
    GUARDRAIL_CRITERIA.unsafeAllows !== 0 ||
    GUARDRAIL_CRITERIA.safetyRegressions !== 0 ||
    GUARDRAIL_CRITERIA.hardBlockDemotions !== 0 ||
    GUARDRAIL_CRITERIA.benignInterruptions !== "at_or_below_baseline" ||
    GUARDRAIL_CRITERIA.completeModelExecution !== "all_eligible_no_errors" ||
    GUARDRAIL_CRITERIA.executionSurface !== "sf_guardrail_bridge" ||
    GUARDRAIL_CRITERIA.deadlineMs !== 750 ||
    GUARDRAIL_CRITERIA.warmP95MaxMs !== 500 ||
    GUARDRAIL_CRITERIA.idealWarmP95BelowMs !== 500
  )
    fail("current qualification gates no longer match the approved campaign");
}

function committedSources(root, paths, description, requireTracked = false) {
  if (requireTracked) {
    const tracked = new Set(
      git(root, "ls-files", "--", ...paths)
        .split("\n")
        .filter(Boolean),
    );
    if (paths.some((name) => !tracked.has(name)))
      fail(`${description} contains a source missing from the commit`);
  }
  try {
    execFileSync(
      "git",
      ["-C", root, "diff", "--quiet", "HEAD", "--", ...paths],
      {
        stdio: "ignore",
      },
    );
  } catch {
    fail(`${description} has uncommitted changes`);
  }
}

function jsonl(bytes, description) {
  const value = bytes.toString("utf8");
  if (!value.endsWith("\n")) fail(`${description} is not complete JSONL`);
  const lines = value.slice(0, -1).split("\n");
  if (lines.some((line) => !line)) fail(`${description} has a blank row`);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    fail(`${description} has invalid JSON`);
  }
}

/** Reconstruct TRAIN/VALID membership from the admitted source and prepared files. */
export function assertPreparedTrainingData(
  prospective,
  training,
  manifest,
  runFiles,
  admitted,
  prepared,
) {
  const authored = runFiles["authored-train-validation.jsonl"];
  const dataset = runFiles["dataset.jsonl"];
  const train = runFiles["train.jsonl"];
  const validation = runFiles["validation.jsonl"];
  const run = resolve(prospective.run ?? "");
  const source = admitted.bundle;
  const rows = source?.records;
  if (
    !isAbsolute(prospective.bundleFile ?? "") ||
    resolve(prospective.bundleFile) !== admitted.file.path ||
    !isAbsolute(training.admission?.bundle ?? "") ||
    resolve(training.admission.bundle) !== admitted.file.path ||
    !isAbsolute(training.admission?.receipt ?? "") ||
    resolve(training.admission.receipt) !== admitted.receiptFile.path ||
    prospective.admissionReceiptSha256 !== admitted.receiptFile.sha256 ||
    training.admissionReceiptSha256 !== admitted.receiptFile.sha256 ||
    admitted.receipt?.outputSha256 !== admitted.file.sha256 ||
    admitted.receipt?.trainingReady !== true ||
    admitted.receipt?.testRows !== 0 ||
    admitted.receipt?.modelCalls !== 0 ||
    admitted.receipt?.externalOperationsExecuted !== 0 ||
    admitted.receipt?.reservedLabelsRead !== false ||
    admitted.receipt?.reservedContentEmitted !== false ||
    admitted.file.sha256 !== prospective.bundleSha256 ||
    admitted.file.sha256 !== training.bundleSha256 ||
    source?.version !== 1 ||
    source.mockedExecution !== true ||
    source.trainingReady !== true ||
    !Array.isArray(rows) ||
    !rows.length ||
    source.corpusSha256 !== prospective.corpusSha256 ||
    source.corpusSha256 !== training.corpusSha256 ||
    source.baselineSourceSha256 !== prospective.baselineSourceSha256 ||
    source.baselineSourceSha256 !== training.baselineSourceSha256 ||
    prospective.trainingPlanSha256 !==
      runFiles["guardrail-plan.json"]?.sha256 ||
    prospective.testRowsPassedToTraining !== 0 ||
    prospective.authoredTrainValidationSha256 !== authored?.sha256 ||
    prospective.preparedDatasetSha256 !== dataset?.sha256 ||
    prospective.trainSha256 !== train?.sha256 ||
    prospective.validationSha256 !== validation?.sha256 ||
    prospective.emptyTestSha256 !== hash(Buffer.alloc(0)) ||
    prospective.preparedSha256 !== manifest.prepared?.sha256 ||
    resolve(manifest.source?.file ?? "") !== authored?.path ||
    manifest.source?.sha256 !== authored?.sha256 ||
    resolve(manifest.directory ?? "") !== run ||
    resolve(manifest.prepared?.dataset_file ?? "") !== dataset?.path ||
    manifest.prepared?.dataset_sha256 !== dataset?.sha256 ||
    dataset?.sha256 !== authored?.sha256 ||
    resolve(manifest.prepared?.files?.train ?? "") !== train?.path ||
    resolve(manifest.prepared?.files?.validation ?? "") !== validation?.path ||
    resolve(manifest.prepared?.files?.test ?? "") !==
      resolve(run, "test.jsonl") ||
    manifest.prepared?.branches?.test !== 0 ||
    prepared.testSize !== 0 ||
    hash(prepared.authored) !== authored?.sha256 ||
    hash(prepared.dataset) !== dataset?.sha256 ||
    hash(prepared.train) !== train?.sha256 ||
    hash(prepared.validation) !== validation?.sha256 ||
    !prepared.dataset.equals(prepared.authored) ||
    hash(
      Buffer.concat([
        Buffer.from("train\n"),
        prepared.train,
        Buffer.from("validation\n"),
        prepared.validation,
        Buffer.from("test\n"),
      ]),
    ) !== manifest.prepared?.sha256
  )
    fail("candidate prepared TRAIN/VALID data or source identity changed");

  const authoredRows = jsonl(prepared.authored, "authored TRAIN/VALID");
  const trainRows = jsonl(prepared.train, "prepared TRAIN");
  const validationRows = jsonl(prepared.validation, "prepared VALIDATION");
  if (
    authoredRows.length !== rows.length ||
    manifest.source.examples !== rows.length
  )
    fail("candidate TRAIN/VALID source row count changed");

  const counts = { train: 0, validation: 0 };
  const ids = new Set();
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    if (
      row?.modelEligible !== true ||
      !["train", "validation"].includes(row.split) ||
      !["allow", "confirm"].includes(row.expected) ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.groupId !== "string" ||
      !row.groupId ||
      (groups.has(row.groupId) && groups.get(row.groupId) !== row.split)
    )
      fail("admitted bundle has an invalid TRAIN/VALID split");
    ids.add(row.id);
    groups.set(row.groupId, row.split);
    same(
      authoredRows[index],
      {
        id: row.id,
        group_id: row.groupId,
        split: row.split,
        request: guardrailRequest(row.riskInput, "google/gemma-3-1b-it"),
        targets: { risk: { answer: row.expected } },
        target_provenance: { risk: { source: "supplied" } },
      },
      "authored TRAIN/VALID source row",
    );
    counts[row.split]++;
  }

  for (const [split, branchRows] of [
    ["train", trainRows],
    ["validation", validationRows],
  ]) {
    const sourceRows = rows.filter((row) => row.split === split);
    if (
      sourceRows.length !== branchRows.length ||
      manifest.prepared.branches?.[split] !== sourceRows.length ||
      prospective[`${split}Rows`] !== sourceRows.length
    )
      fail(`candidate ${split} split count changed`);
    for (const [index, branch] of branchRows.entries()) {
      const row = sourceRows[index];
      same(
        {
          id: branch.id,
          source_id: branch.source_id,
          group_id: branch.group_id,
          split: branch.split,
          question_id: branch.question_id,
          question_type: branch.question_type,
          template_version: branch.template_version,
          output_labels: branch.output_labels,
          answer_labels: branch.answer_labels,
          target_probabilities: branch.target_probabilities,
          target_provenance: branch.target_provenance,
        },
        {
          id: `${row.id}:risk`,
          source_id: row.id,
          group_id: row.groupId,
          split,
          question_id: "risk",
          question_type: "choice",
          template_version: "v2",
          output_labels: ["A", "B"],
          answer_labels: ["allow", "confirm"],
          target_probabilities: row.expected === "allow" ? [1, 0] : [0, 1],
          target_provenance: { risk: { source: "supplied" } },
        },
        `prepared ${split} source membership`,
      );
    }
  }
  if (
    counts.train < 1 ||
    counts.validation < 1 ||
    admitted.receipt.trainRows !== counts.train ||
    admitted.receipt.validationRows !== counts.validation
  )
    fail("candidate admission TRAIN/VALIDATION counts changed");
}

export function assertFrozenTrainingPolicy(prospective, training) {
  if (
    prospective.noTeacher !== true ||
    prospective.noForbiddenFallback !== true ||
    prospective.testNotPassedToTraining !== true ||
    prospective.modelCallsBeforeFreeze !== 0 ||
    prospective.testEvaluationsBeforeFreeze !== 0 ||
    prospective.allowCutoff !== GUARDRAIL_LIMITS.minimumAllowScore ||
    prospective.criteriaSha256 !== GUARDRAIL_CRITERIA_SHA256 ||
    canonical(prospective.criteria) !== canonical(GUARDRAIL_CRITERIA) ||
    prospective.selection !== "validation_only" ||
    training.testPassedToTraining !== false ||
    training.forbiddenFallbacks !== true ||
    training.selection !==
      "Validation only; all guardrail gates must pass before a frozen held-out test" ||
    training.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    prospective.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    prospective.bundleSha256 !== training.bundleSha256 ||
    prospective.steps !== training.steps
  )
    fail("candidate no-TEST training policy or frozen criteria changed");
}

async function snapshot(input) {
  const paths = Object.fromEntries(
    ["corpus", "rubric", "bundle", "run", "model", "registry", "sfRoot"].map(
      (name) => [name, resolve(input[name])],
    ),
  );
  if (!input.modelId || !/^jev\/[a-zA-Z0-9._-]+$/.test(input.modelId))
    fail("a specific Jev candidate --model-id is required");
  assertGateContract();
  const [corpusFile, rubricFile, baselineFile] = await Promise.all([
    physical(paths.corpus),
    physical(paths.rubric),
    physical(paths.bundle),
  ]);
  const corpus = await json(paths.corpus);
  const bundle = await json(paths.bundle);
  if (
    corpusFile.sha256 !== bundle.corpusSha256 ||
    corpus.rubricVersion !== bundle.rubricVersion ||
    corpus.campaign?.rubricSourceSha256 !== rubricFile.sha256
  )
    fail("corpus, rubric and baseline do not describe the same campaign");
  const sfCommit = git(paths.sfRoot, "rev-parse", "HEAD");
  if (bundle.sfPiCommit !== sfCommit)
    fail("sf-pi commit differs from baseline export");
  const sources = await verifyBaselineSources(paths.sfRoot, bundle);
  committedSources(
    paths.sfRoot,
    [
      ...new Set([
        ...Object.keys(sources.exporterSources),
        ...Object.keys(sources.runtimeSources),
      ]),
    ],
    "sf-pi baseline or tool runtime",
    true,
  );
  const runFiles = {};
  for (const name of [
    "prospective-plan.json",
    "guardrail-plan.json",
    "manifest.json",
    "artifact.json",
    "authored-train-validation.jsonl",
    "dataset.jsonl",
    "train.jsonl",
    "validation.jsonl",
  ])
    runFiles[name] = await physical(resolve(paths.run, name));
  const prospective = await json(runFiles["prospective-plan.json"].path);
  const training = await json(runFiles["guardrail-plan.json"].path);
  const manifest = await json(runFiles["manifest.json"].path);
  const artifact = await json(runFiles["artifact.json"].path);
  if (!isAbsolute(prospective.bundleFile ?? ""))
    fail("prospective admitted bundle path is not absolute");
  if (!isAbsolute(training.admission?.receipt ?? ""))
    fail("training admission receipt path is not absolute");
  const [admittedBytes, admissionReceiptBytes] = await Promise.all([
    readFile(prospective.bundleFile),
    readFile(training.admission.receipt),
  ]);
  const admittedFile = {
    path: resolve(prospective.bundleFile),
    sha256: hash(admittedBytes),
    size: admittedBytes.length,
  };
  const admissionReceiptFile = {
    path: resolve(training.admission.receipt),
    sha256: hash(admissionReceiptBytes),
    size: admissionReceiptBytes.length,
  };
  const admitted = {
    file: admittedFile,
    bundle: JSON.parse(admittedBytes),
    receiptFile: admissionReceiptFile,
    receipt: JSON.parse(admissionReceiptBytes),
  };
  const [authored, dataset, train, validation, testStatus] = await Promise.all([
    readFile(runFiles["authored-train-validation.jsonl"].path),
    readFile(runFiles["dataset.jsonl"].path),
    readFile(runFiles["train.jsonl"].path),
    readFile(runFiles["validation.jsonl"].path),
    stat(resolve(paths.run, "test.jsonl")),
  ]);
  if (!testStatus.isFile()) fail("prepared TEST is not a regular empty file");
  assertPreparedTrainingData(
    prospective,
    training,
    manifest,
    runFiles,
    admitted,
    {
      authored,
      dataset,
      train,
      validation,
      testSize: testStatus.size,
    },
  );
  assertFrozenTrainingPolicy(prospective, training);
  if (
    resolve(prospective.run) !== paths.run ||
    manifest.status !== "exported" ||
    manifest.base_model !== "google/gemma-3-1b-it" ||
    manifest.base_revision !== GEMMA_TRAINING_REVISION ||
    manifest.template_version !== "v2" ||
    artifact.base_revision !== GEMMA_TRAINING_REVISION ||
    artifact.training_run !== manifest.id ||
    artifact.id !== input.modelId
  )
    fail("candidate does not match its original prospective training plan");
  const registryFile = await physical(paths.registry);
  const registry = await json(paths.registry);
  if (
    registry.version !== 1 ||
    registry.artifacts?.length !== 1 ||
    registry.artifacts[0].id !== input.modelId
  )
    fail("candidate registry must contain exactly the selected artifact");
  const approved = await verifyArtifact(
    paths.model,
    "classifier",
    input.modelId,
    {
      registryPath: paths.registry,
    },
  );
  const modelFile = {
    path: paths.model,
    sha256: approved.sha256,
    size: approved.size,
  };
  if (
    approved.base_model !== "google/gemma-3-1b-it" ||
    approved.template_version !== "v2" ||
    approved.training_run !== manifest.id ||
    artifact.sha256 !== approved.sha256 ||
    artifact.size !== approved.size ||
    resolve(artifact.file) !== paths.model ||
    manifest.exports?.sha256 !== approved.sha256 ||
    manifest.exports?.id !== input.modelId
  )
    fail("exported candidate, run manifest and registry disagree");
  const config = guardrailConfig({
    JEV_GUARDRAIL_MODEL_ID: input.modelId,
    JEV_GUARDRAIL_MODEL_FILE: paths.model,
    JEV_GUARDRAIL_ARTIFACT_REGISTRY: paths.registry,
    JEV_DEVICE: "metal",
  });
  if (
    config.queueTimeoutMs !== 750 ||
    config.requestTimeoutMs !== 750 ||
    config.templateVersion !== "v2"
  )
    fail("runtime scoring configuration changed");
  const nativeBinary = await physical(config.binary);
  const jevSources = {};
  for (const name of [...jevSourceFiles, ...jevCompiledFiles])
    jevSources[name] = await physical(resolve(jevRoot, name));
  committedSources(jevRoot, jevSourceFiles, "Jev scorer or evaluator", true);
  return {
    paths,
    modelId: input.modelId,
    jevCommit: git(jevRoot, "rev-parse", "HEAD"),
    sfPiCommit: sfCommit,
    corpus: corpusFile,
    rubric: rubricFile,
    baseline: baselineFile,
    corpusSha256: bundle.corpusSha256,
    baselineSourceSha256: sources.baselineSourceSha256,
    provenanceSourceSha256: sources.provenanceSourceSha256,
    exporterSha256: sources.exporterSha256,
    sfExporterSources: sources.exporterSources,
    sfRuntimeSources: sources.runtimeSources,
    baselineCases: bundle.summary.cases,
    baselineGroups: bundle.summary.groups,
    originalProspectivePlanSha256: runFiles["prospective-plan.json"].sha256,
    originalTrainingCorpusSha256: prospective.corpusSha256,
    originalTrainingBaselineSourceSha256: prospective.baselineSourceSha256,
    admittedTrainingBundle: admittedFile,
    runFiles,
    registry: registryFile,
    model: modelFile,
    nativeBinary,
    jevSources,
    protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    criteriaSha256: GUARDRAIL_CRITERIA_SHA256,
    criteria: GUARDRAIL_CRITERIA,
    minimumAllowScore: GUARDRAIL_LIMITS.minimumAllowScore,
    deadlineMs: GUARDRAIL_LIMITS.deadlineMs,
    executionSurface: "sf_guardrail_bridge",
  };
}

export async function prepareCampaignReceipt(input, output) {
  const body = {
    version: 1,
    purpose: "guardrail_campaign_prevalidation",
    createdAt: new Date().toISOString(),
    qualification: false,
    permitsHeldOutTest: false,
    campaign: await snapshot(input),
  };
  const receipt = { ...body, sha256: hash(canonical(body)) };
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return {
    path,
    sha256: receipt.sha256,
    modelSha256: receipt.campaign.model.sha256,
  };
}

export async function verifyCampaignReceipt(file) {
  const receipt = await json(resolve(file));
  if (
    receipt.version !== 1 ||
    receipt.purpose !== "guardrail_campaign_prevalidation" ||
    receipt.qualification !== false ||
    receipt.permitsHeldOutTest !== false ||
    !isHash(receipt.sha256)
  )
    fail("invalid receipt or claimed qualification");
  const { sha256, ...body } = receipt;
  if (hash(canonical(body)) !== sha256) fail("receipt body changed");
  const current = await snapshot({
    ...receipt.campaign.paths,
    modelId: receipt.campaign.modelId,
  });
  assertCompatibleCampaignSnapshot(receipt.campaign, current);
  return { path: resolve(file), sha256, modelSha256: current.model.sha256 };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      corpus: { type: "string" },
      rubric: { type: "string" },
      bundle: { type: "string" },
      run: { type: "string" },
      model: { type: "string" },
      registry: { type: "string" },
      "model-id": { type: "string" },
      "sf-root": { type: "string" },
      output: { type: "string" },
      receipt: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === "prepare") {
    for (const key of [
      "corpus",
      "rubric",
      "bundle",
      "run",
      "model",
      "registry",
      "model-id",
      "sf-root",
      "output",
    ])
      if (!values[key]) fail(`prepare requires --${key}`);
    console.log(
      JSON.stringify(
        await prepareCampaignReceipt(
          {
            corpus: values.corpus,
            rubric: values.rubric,
            bundle: values.bundle,
            run: values.run,
            model: values.model,
            registry: values.registry,
            modelId: values["model-id"],
            sfRoot: values["sf-root"],
          },
          values.output,
        ),
      ),
    );
  } else if (command === "verify") {
    if (!values.receipt) fail("verify requires --receipt");
    console.log(JSON.stringify(await verifyCampaignReceipt(values.receipt)));
  } else {
    fail(
      "use prepare --corpus --rubric --bundle --run --model --registry --model-id --sf-root --output, or verify --receipt",
    );
  }
}
