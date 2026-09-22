import { execFile } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  prepareRfdt,
  trainRfdt,
  exportRfdt,
  RFDT_BASE_REVISION,
} from "../dist/rfdt.js";
import {
  guardrailRequest,
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { GUARDRAIL_CRITERIA_SHA256 } from "../dist/guardrail-evaluation.js";
import { configFromEnv } from "../dist/backend.js";
import { verifyTrainedArtifactExport, hashArtifact } from "../dist/models.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bundle: { type: "string" },
    receipt: { type: "string" },
    corpus: { type: "string" },
    baseline: { type: "string" },
    "baseline-sha256": { type: "string" },
    "sf-pi": { type: "string" },
    run: { type: "string" },
    checkpoint: { type: "string" },
    steps: { type: "string", default: "256" },
    id: { type: "string" },
  },
});
const command = positionals[0];
const run = resolve(values.run ?? ".build/guardrail/candidate-1");
const save = (path, value, exclusive = false) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    ...(exclusive ? { flag: "wx" } : {}),
  });
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    controller.abort(new Error(`Guardrail training cancelled (${signal})`)),
  );
async function verifyBase(checkpoint, expected) {
  const files = {};
  for (const name of (await readdir(checkpoint))
    .filter((name) => /\.(json|safetensors|model)$/.test(name))
    .sort())
    files[name] = await hashArtifact(resolve(checkpoint, name));
  if (
    files["model.safetensors"]?.sha256 !==
      "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6" ||
    !files["config.json"] ||
    !files["tokenizer.json"]
  )
    throw new Error(
      "Original Google checkpoint checksum or required files mismatch",
    );
  if (expected && JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error("Training base changed since preparation");
  return files;
}
function admissionFromOptions() {
  if (
    !values.receipt ||
    !values.corpus ||
    !values.baseline ||
    !values["baseline-sha256"] ||
    !values["sf-pi"]
  )
    throw new Error(
      "prepare requires --receipt, --corpus, --baseline, --baseline-sha256, and --sf-pi for candidate-5 admission",
    );
  return {
    bundle: resolve(values.bundle),
    receipt: resolve(values.receipt),
    corpus: resolve(values.corpus),
    baseline: resolve(values.baseline),
    baselineSha256: values["baseline-sha256"],
    sfPi: resolve(values["sf-pi"]),
  };
}
async function verifyCandidate5Admission(bundleBytes, source) {
  if (
    !source ||
    !["bundle", "receipt", "corpus", "baseline", "sfPi"].every(
      (key) => typeof source[key] === "string" && isAbsolute(source[key]),
    ) ||
    typeof source.baselineSha256 !== "string"
  )
    throw new Error("Guardrail training plan has no pinned admission sources");
  const receiptBytes = await readFile(source.receipt);
  const receipt = JSON.parse(receiptBytes);
  const bundleSha256 = sha(bundleBytes);
  if (receipt.outputSha256 !== bundleSha256 || receipt.trainingReady !== true)
    throw new Error(
      "Candidate-5 admission receipt does not match a ready bundle",
    );

  const temp = await mkdtemp(join(tmpdir(), "jev-guardrail-admission-"));
  try {
    const rebuiltBundle = join(temp, "bundle.json");
    const rebuiltReceipt = join(temp, "receipt.json");
    try {
      await execFileAsync(
        process.execPath,
        [
          resolve(root, "scripts/guardrail-candidate5-bundle.mjs"),
          "--corpus",
          source.corpus,
          "--baseline",
          source.baseline,
          "--baseline-sha256",
          source.baselineSha256,
          "--sf-pi",
          source.sfPi,
          "--output",
          rebuiltBundle,
          "--receipt",
          rebuiltReceipt,
        ],
        { cwd: root, signal: controller.signal },
      );
    } catch (error) {
      throw new Error(
        `Candidate-5 admission rebuild failed: ${error.stderr?.trim() || error.message}`,
      );
    }
    if (
      !bundleBytes.equals(await readFile(rebuiltBundle)) ||
      !receiptBytes.equals(await readFile(rebuiltReceipt))
    )
      throw new Error(
        "Candidate-5 bundle or admission receipt differs from the pinned-source rebuild",
      );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return {
    receiptSha256: sha(receiptBytes),
    sfPiCommit: receipt.source.sfPiCommit,
  };
}
async function verifyPlanAdmission(plan) {
  if (
    !plan.admission ||
    typeof plan.admission.bundle !== "string" ||
    !isAbsolute(plan.admission.bundle)
  )
    throw new Error("Guardrail training plan has no pinned admission sources");
  const bundleBytes = await readFile(plan.admission.bundle);
  if (sha(bundleBytes) !== plan.bundleSha256)
    throw new Error("Guardrail admitted bundle changed since preparation");
  const verified = await verifyCandidate5Admission(bundleBytes, plan.admission);
  if (
    verified.receiptSha256 !== plan.admissionReceiptSha256 ||
    verified.sfPiCommit !== plan.sfPiCommit
  )
    throw new Error(
      "Guardrail admission receipt or SF host changed since preparation",
    );
}
async function verifyProspectivePlan(planBytes, plan) {
  const prospective = JSON.parse(
    await readFile(resolve(run, "prospective-plan.json")),
  );
  if (
    prospective.version !== 1 ||
    prospective.purpose !== "guardrail_training_prospective_plan" ||
    prospective.run !== run ||
    prospective.trainingPlanSha256 !== sha(planBytes) ||
    prospective.bundleFile !== plan.admission?.bundle ||
    prospective.bundleSha256 !== plan.bundleSha256 ||
    prospective.admissionReceiptSha256 !== plan.admissionReceiptSha256 ||
    prospective.corpusSha256 !== plan.corpusSha256 ||
    prospective.baselineSourceSha256 !== plan.baselineSourceSha256 ||
    prospective.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    prospective.criteriaSha256 !== GUARDRAIL_CRITERIA_SHA256 ||
    prospective.steps !== plan.steps ||
    prospective.selection !== "validation_only" ||
    prospective.noTeacher !== true ||
    prospective.noForbiddenFallback !== true ||
    prospective.testNotPassedToTraining !== true ||
    prospective.testRowsPassedToTraining !== 0 ||
    prospective.modelCallsBeforeFreeze !== 0 ||
    prospective.testEvaluationsBeforeFreeze !== 0 ||
    prospective.allowCutoff !== GUARDRAIL_LIMITS.minimumAllowScore ||
    prospective.qualification !== false
  )
    throw new Error(
      "Guardrail prospective plan does not match this training run",
    );
  if (typeof prospective.bundleFile !== "string")
    throw new Error("Guardrail prospective plan has no source bundle");
  const [
    bundleBytes,
    authoredBytes,
    datasetBytes,
    trainBytes,
    validationBytes,
    testFile,
    manifestBytes,
  ] = await Promise.all([
    readFile(prospective.bundleFile),
    readFile(resolve(run, "authored-train-validation.jsonl")),
    readFile(resolve(run, "dataset.jsonl")),
    readFile(resolve(run, "train.jsonl")),
    readFile(resolve(run, "validation.jsonl")),
    stat(resolve(run, "test.jsonl")),
    readFile(resolve(run, "manifest.json")),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const preparedSha256 = sha(
    Buffer.concat([
      Buffer.from("train\n"),
      trainBytes,
      Buffer.from("validation\n"),
      validationBytes,
      Buffer.from("test\n"),
    ]),
  );
  if (
    manifest.status !== "prepared" ||
    manifest.training !== undefined ||
    resolve(manifest.directory ?? "") !== run ||
    resolve(manifest.source?.file ?? "") !==
      resolve(run, "authored-train-validation.jsonl") ||
    resolve(manifest.prepared?.dataset_file ?? "") !==
      resolve(run, "dataset.jsonl") ||
    ["train", "validation", "test"].some(
      (split) =>
        resolve(manifest.prepared?.files?.[split] ?? "") !==
        resolve(run, `${split}.jsonl`),
    ) ||
    sha(bundleBytes) !== prospective.bundleSha256 ||
    sha(authoredBytes) !== prospective.authoredTrainValidationSha256 ||
    sha(datasetBytes) !== prospective.preparedDatasetSha256 ||
    !datasetBytes.equals(authoredBytes) ||
    sha(trainBytes) !== prospective.trainSha256 ||
    sha(validationBytes) !== prospective.validationSha256 ||
    testFile.size !== 0 ||
    prospective.emptyTestSha256 !== sha(Buffer.alloc(0)) ||
    preparedSha256 !== prospective.preparedSha256 ||
    preparedSha256 !== manifest.prepared.sha256 ||
    manifest.source.sha256 !== prospective.authoredTrainValidationSha256 ||
    manifest.prepared.dataset_sha256 !== prospective.preparedDatasetSha256 ||
    manifest.prepared.branches?.train !== prospective.trainRows ||
    manifest.prepared.branches?.validation !== prospective.validationRows ||
    manifest.prepared.branches?.test !== 0
  )
    throw new Error(
      "Guardrail prepared TRAIN/VALID files changed since the prospective plan or TEST is nonempty",
    );
}
if (command === "prepare") {
  if (!values.bundle || !values.checkpoint)
    throw new Error(
      "prepare requires --bundle and --checkpoint (original pinned Google HF checkpoint)",
    );
  const bytes = await readFile(resolve(values.bundle));
  const bundle = JSON.parse(bytes);
  if (
    bundle.trainingReady !== true ||
    bundle.diagnosticOnly === true ||
    /^(?:review-only|diagnostic)(?:\b|;|:)/i.test(bundle.status ?? "")
  )
    throw new Error("Guardrail bundle is not explicitly training-ready");
  if (!Array.isArray(bundle.records) || !bundle.records.length)
    throw new Error("Empty baseline bundle");
  if (
    bundle.records.some(
      (record) =>
        !["train", "validation"].includes(record.split) ||
        record.modelEligible !== true,
    )
  )
    throw new Error(
      "Guardrail preparation accepts eligible TRAIN/VALIDATION only",
    );
  const admissionSource = admissionFromOptions();
  const admission = await verifyCandidate5Admission(bytes, admissionSource);
  const examples = bundle.records
    .filter((r) => r.modelEligible && ["train", "validation"].includes(r.split))
    .map((r) => ({
      id: r.id,
      group_id: r.groupId,
      split: r.split,
      request: guardrailRequest(r.riskInput, "google/gemma-3-1b-it"),
      targets: {
        risk: { answer: r.expected === "allow" ? "allow" : "confirm" },
      },
      target_provenance: { risk: { source: "supplied" } },
    }));
  if (
    !examples.some((r) => r.split === "train") ||
    !examples.some((r) => r.split === "validation")
  )
    throw new Error("TRAIN and validation both required");
  const checkpoint = resolve(values.checkpoint);
  if (
    !checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${RFDT_BASE_REVISION}`,
    )
  )
    throw new Error("Use the reviewed original pinned Google HF snapshot");
  // The training base is distinct from historical adapters and fused candidates.
  const baseFiles = await verifyBase(checkpoint);
  const weights = baseFiles["model.safetensors"];
  await mkdir(run, { recursive: true });
  const dataset = resolve(run, "authored-train-validation.jsonl");
  await writeFile(
    dataset,
    examples.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const steps = Number(values.steps);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 100000)
    throw new Error("Invalid steps");
  await save(
    resolve(run, "guardrail-plan.json"),
    {
      version: 1,
      createdAt: new Date().toISOString(),
      purpose:
        "Separate guardrail RFDT candidate; no default classifier promotion",
      protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      bundleSha256: sha(bytes),
      admission: admissionSource,
      admissionReceiptSha256: admission.receiptSha256,
      corpusSha256: bundle.corpusSha256,
      baselineSourceSha256: bundle.baselineSourceSha256,
      sfPiCommit: admission.sfPiCommit,
      checkpoint,
      weights,
      baseFiles,
      steps,
      testPassedToTraining: false,
      forbiddenFallbacks: true,
      selection:
        "Validation only; all guardrail gates must pass before a frozen held-out test",
    },
    true,
  );
  const config = configFromEnv({
    JEV_DEVICE: "metal",
    JEV_MODEL_ID: "google/gemma-3-1b-it",
    JEV_MODEL_FILE: resolve(root, "models/gemma-3-1b-it-f16.gguf"),
    JEV_TEMPLATE_VERSION: "v2",
  });
  const result = await prepareRfdt(dataset, {
    outputDir: run,
    templateVersion: "v2",
    config,
    signal: controller.signal,
  });
  console.log(
    JSON.stringify({
      phase: "prepared",
      run,
      id: result.id,
      branches: result.prepared.branches,
    }),
  );
} else if (command === "train") {
  const planBytes = await readFile(resolve(run, "guardrail-plan.json"));
  const plan = JSON.parse(planBytes);
  if (plan.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256)
    throw new Error("Scoring protocol changed since preparation");
  await verifyProspectivePlan(planBytes, plan);
  await verifyPlanAdmission(plan);
  await verifyBase(plan.checkpoint, plan.baseFiles);
  const result = await trainRfdt(run, {
    steps: plan.steps,
    modelPath: plan.checkpoint,
    signal: controller.signal,
  });
  console.log(
    JSON.stringify({ phase: "trained", run, training: result.training }),
  );
} else if (command === "export") {
  const plan = JSON.parse(await readFile(resolve(run, "guardrail-plan.json")));
  if (plan.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256)
    throw new Error("Scoring protocol changed since preparation");
  await verifyPlanAdmission(plan);
  await verifyBase(plan.checkpoint, plan.baseFiles);
  const artifact = await exportRfdt(run, {
    modelId: values.id ?? "jev/gemma-3-1b-guardrail-candidate-1",
    modelPath: plan.checkpoint,
    signal: controller.signal,
  });
  const descriptor = await verifyTrainedArtifactExport(artifact);
  const registry = resolve(run, "candidate-registry.json");
  await save(registry, { version: 1, artifacts: [descriptor] }, true);
  console.log(
    JSON.stringify({ phase: "exported", artifact, registry, qualified: false }),
  );
} else
  throw new Error(
    "Use prepare --bundle FILE --receipt FILE --corpus FILE --baseline FILE --baseline-sha256 SHA256 --sf-pi DIR --checkpoint DIR [--steps 256], train, or export; --run DIR for every step",
  );
