import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
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
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { configFromEnv } from "../dist/backend.js";
import { verifyTrainedArtifactExport, hashArtifact } from "../dist/models.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bundle: { type: "string" },
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
if (command === "prepare") {
  if (!values.bundle || !values.checkpoint)
    throw new Error(
      "prepare requires --bundle and --checkpoint (original pinned Google HF checkpoint)",
    );
  const bytes = await readFile(resolve(values.bundle));
  const bundle = JSON.parse(bytes);
  if (
    bundle.trainingReady === false ||
    bundle.diagnosticOnly === true ||
    /^(?:review-only|diagnostic)(?:\b|;|:)/i.test(bundle.status ?? "")
  )
    throw new Error(
      "Guardrail bundle is diagnostic or review-only; training is not ready",
    );
  if (!Array.isArray(bundle.records) || !bundle.records.length)
    throw new Error("Empty baseline bundle");
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
      bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      corpusSha256: bundle.corpusSha256,
      baselineSourceSha256: bundle.baselineSourceSha256,
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
  const plan = JSON.parse(await readFile(resolve(run, "guardrail-plan.json")));
  if (plan.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256)
    throw new Error("Scoring protocol changed since preparation");
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
    "Use prepare --bundle FILE --checkpoint DIR [--steps 256], train, or export; --run DIR for every step",
  );
