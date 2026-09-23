#!/usr/bin/env node
/** Native precision on immutable FIT only; no held-out scoring or enforcement. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configFromEnv, NativeBackend } from "../dist/backend.js";
import { hashArtifact, verifyArtifact } from "../dist/models.js";
import {
  verifyTrainingInputs,
  readImportedFitReference,
} from "../dist/rfdt.js";
import { readC11Selection } from "../dist/guardrail-selection.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function verifyCurrentMetadata() {
  const current = join(root, "models", "current");
  const entries = (await readFile(join(current, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  if (entries.length !== 9)
    throw new Error("Expected nine current model evidence files");
  for (const entry of entries) {
    const parsed = /^([a-f0-9]{64})  ([\w.-]+)$/.exec(entry);
    if (!parsed) throw new Error("Invalid current metadata checksum entry");
    const bytes = await readFile(join(current, parsed[2]));
    if (createHash("sha256").update(bytes).digest("hex") !== parsed[1])
      throw new Error(`Current metadata changed: ${parsed[2]}`);
  }
  return readC11Selection();
}
export async function verifyGuardrailExport(values) {
  await verifyTrainingInputs();
  const run = resolve(values.run);
  const { manifest, rows, reference } = await readImportedFitReference(run);
  const config = configFromEnv({
    JEV_MODEL_FILE: resolve(values["model-file"]),
    JEV_MODEL_ID: values["model-id"],
    JEV_DEVICE: "metal",
    JEV_TEMPLATE_VERSION: "v2",
  });
  config.artifactRegistryPath = resolve(values.registry);
  config.binary = resolve(values["native-binary"]);
  const backend = new NativeBackend(config);
  const artifact = await verifyArtifact(
    config.modelFile,
    "classifier",
    config.modelId,
    {
      registryPath: config.artifactRegistryPath,
    },
  );
  if (artifact.training_run !== manifest.id)
    throw new Error("Exported artifact belongs to another training run");
  const binaryBefore = await hashArtifact(config.binary);
  const probability = (margin) =>
    margin >= 0
      ? 1 / (1 + Math.exp(-margin))
      : Math.exp(margin) / (1 + Math.exp(margin));
  const records = [];
  let failure;
  try {
    await backend.warmup();
    for (const row of rows) {
      const token_ids = Object.fromEntries(
        row.output_labels.map((label, index) => [
          label,
          row.allowed_token_ids[index],
        ]),
      );
      const result = await backend.evaluate([
        {
          branch_id: row.id,
          rendered: row.prompt,
          tokens: row.prompt_token_ids,
          token_ids,
        },
      ]);
      const logits = result.logits[row.id];
      const margin =
        logits[row.output_labels[0]] - logits[row.output_labels[1]];
      if (!Number.isFinite(margin))
        throw new Error("Nonfinite exported margin");
      records.push({
        sourceId: row.source_id,
        referenceMargin: reference.get(row.source_id),
        margin,
      });
    }
  } catch (error) {
    failure = String(error);
  } finally {
    await backend.dispose();
  }
  if (
    (await hashArtifact(config.modelFile)).sha256 !== artifact.sha256 ||
    (await hashArtifact(config.binary)).sha256 !== binaryBefore.sha256
  )
    failure = "Model or native scorer changed during precision checking";
  const maxProbabilityDelta = records.length
    ? Math.max(
        ...records.map((row) =>
          Math.abs(probability(row.margin) - probability(row.referenceMargin)),
        ),
      )
    : null;
  const decisiveSignFlips = records.filter(
    (row) =>
      Math.abs(row.referenceMargin) >= 0.5 &&
      row.referenceMargin * row.margin <= 0,
  ).length;
  const result = {
    purpose: "cuda_export_fit_precision_check_only",
    qualified: false,
    modelId: values["model-id"],
    modelSha256: artifact.sha256,
    nativeBinarySha256: binaryBefore.sha256,
    admitted: 327,
    answered: records.length,
    failure: failure ?? null,
    maxProbabilityDelta,
    maxProbabilityDeltaLimit: 0.05,
    decisiveMargin: 0.5,
    decisiveSignFlips,
    ok:
      !failure &&
      records.length === 327 &&
      maxProbabilityDelta <= 0.05 &&
      decisiveSignFlips === 0,
    records,
  };
  await writeFile(
    resolve(values.output),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" },
      ...Object.fromEntries(
        [
          "run",
          "model-file",
          "model-id",
          "registry",
          "native-binary",
          "output",
        ].map((name) => [name, { type: "string" }]),
      ),
    },
  });
  if (values.check || Object.keys(values).length === 0) {
    if (Object.keys(values).length > 1)
      throw new Error(
        "--check verifies frozen training inputs and accepts no precision-run options",
      );
    const training = await verifyTrainingInputs(),
      selection = await verifyCurrentMetadata();
    console.log(
      JSON.stringify({
        training,
        currentModelMetadataVerified: true,
        scoringIdentity: selection,
        inferenceStarted: false,
        qualified: false,
        enforcementEligible: false,
      }),
    );
  } else {
    if (Object.keys(values).length !== 6)
      throw new Error(
        "Required: --run --model-file --model-id --registry --native-binary --output; use --check for input integrity only",
      );
    const result = await verifyGuardrailExport(values);
    console.log(JSON.stringify({ ...result, records: undefined }));
    if (!result.ok) process.exitCode = 1;
  }
}
