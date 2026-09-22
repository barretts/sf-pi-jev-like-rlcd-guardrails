#!/usr/bin/env node
/** Rejected-weight FIT precision diagnostic only; never candidate admission. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { configFromEnv, NativeBackend } from "../dist/backend.js";
import { hashArtifact, verifyArtifact } from "../dist/models.js";

const { values } = parseArgs({
  options: {
    purpose: { type: "string" },
    ...Object.fromEntries(
      [
        "fit-file",
        "fit-sha256",
        "reference-file",
        "reference-sha256",
        "model-sha256",
        "model-file",
        "model-id",
        "registry",
        "native-binary",
        "output",
      ].map((name) => [name, { type: "string" }]),
    ),
  },
});
const purpose =
  values.purpose ?? "rejected_c9B_fp32_fusion_fit_precision_diagnostic_only";
if (
  ![
    "rejected_c9B_fp32_fusion_fit_precision_diagnostic_only",
    "candidate10_one_step_probe_fit_precision_diagnostic_only",
  ].includes(purpose)
)
  throw new Error("Unsupported diagnostic purpose");
if (Object.values(values).length !== (values.purpose ? 11 : 10))
  throw new Error(
    "Required: --fit-file --fit-sha256 --reference-file --reference-sha256 --model-file --model-sha256 --model-id --registry --native-binary --output",
  );
const FIT_SHA256 =
  "8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3";
const fitBytes = await readFile(resolve(values["fit-file"]));
const bytes = await readFile(resolve(values["reference-file"]));
const sha = (value) => createHash("sha256").update(value).digest("hex");
if (values["fit-sha256"] !== FIT_SHA256 || sha(fitBytes) !== FIT_SHA256)
  throw new Error("Pinned FIT bytes changed");
if (
  !/^[a-f0-9]{64}$/.test(values["reference-sha256"]) ||
  sha(bytes) !== values["reference-sha256"]
)
  throw new Error("Reference bytes changed");
const referenceRows = bytes.toString().trim().split("\n").map(JSON.parse);
const reference = new Map(
  referenceRows.map((row) => [row.source_id, row.margin]),
);
const rows = fitBytes.toString().trim().split("\n").map(JSON.parse);
if (
  rows.length !== 327 ||
  referenceRows.length !== 327 ||
  reference.size !== 327 ||
  new Set(rows.map((row) => row.source_id)).size !== 327 ||
  rows.some(
    (row) =>
      row.split !== "train" ||
      !reference.has(row.source_id) ||
      !Number.isFinite(reference.get(row.source_id)),
  )
)
  throw new Error("FIT diagnostic inventory changed");
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
if (
  artifact.sha256 !== values["model-sha256"] ||
  !artifact.training_run.startsWith("diagnostic-")
)
  throw new Error("A hash-bound diagnostic artifact identity is required");
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
    const margin = logits[row.output_labels[0]] - logits[row.output_labels[1]];
    if (!Number.isFinite(margin)) throw new Error("Nonfinite exported margin");
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
  purpose,
  candidateAdmitted: false,
  fitSha256: FIT_SHA256,
  referenceSha256: sha(bytes),
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
console.log(JSON.stringify({ ...result, records: undefined }));
if (!result.ok) process.exitCode = 1;
