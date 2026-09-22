#!/usr/bin/env node
/** Assemble an executable native C10 evaluation manifest; never opens VALID or TEST bodies.
 * --handoff LOCAL_CHECKPOINT_HANDOFF --cuda-run SOURCE_SNAPSHOT_ROOT
 * --q8-manifest QUANTIZATION_MANIFEST --q8-registry REGISTRY --precision-q8 REPORT
 * --quantizer-binary FILE --native-binary FILE --sf-deps DIR
 * --format f16|q8_0 --output FRESH_MANIFEST
 * Optional: --sf-pi DIR (defaults to the frozen prospective host).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  C10_HOST,
  C10_EVALUATION_RUNTIME_FILES,
  validateC10Manifest,
} from "./guardrail-candidate10-evaluate.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRoot = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-10-evidence/baseline",
);
const trainRoot = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-9-evidence/train",
);
async function pin(path) {
  if (!isAbsolute(path ?? ""))
    throw new Error("Manifest assembly requires absolute source paths");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Expected a regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, sha256: hash.digest("hex") };
}
async function document(path) {
  const identity = await pin(path);
  const stat = await lstat(path);
  if (stat.size > 16 * 1048576)
    throw new Error(`Expected bounded metadata: ${path}`);
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== identity.sha256)
    throw new Error(`Metadata changed: ${path}`);
  return JSON.parse(bytes);
}
export async function assembleC10Manifest(options) {
  for (const name of [
    "handoff",
    "cudaRun",
    "q8Manifest",
    "q8Registry",
    "precisionQ8",
    "quantizerBinary",
    "nativeBinary",
    "sfDeps",
  ])
    if (!isAbsolute(options?.[name] ?? ""))
      throw new Error(
        `Required absolute --${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`,
      );
  if (!["f16", "q8_0"].includes(options.format))
    throw new Error("Required --format f16|q8_0");
  const handoff = await document(options.handoff);
  const quantization = await document(options.q8Manifest);
  const freezePin = await pin(resolve(baselineRoot, "manifest.json"));
  if (freezePin.sha256 !== C10_HOST.freezeSha256)
    throw new Error("Prospective baseline manifest changed");
  const freeze = await document(freezePin.path);
  if (
    handoff.purpose !== "candidate10_local_checkpoint_handoff" ||
    handoff.qualified !== false ||
    ![128, 256, 512, 1024].includes(handoff.checkpoint) ||
    !isAbsolute(handoff.run ?? "")
  )
    throw new Error("Completed C10 local checkpoint handoff required");
  const artifact = await document(handoff.artifact);
  const imported = await document(
    resolve(handoff.run, "adapter/cuda-import-report.json"),
  );
  const source = await document(resolve(options.cudaRun, "run/receipt.json"));
  if (
    imported.checkpoint_step !== handoff.checkpoint ||
    source.steps !== handoff.checkpoint ||
    source.mode !== "train" ||
    source.qualified !== false ||
    artifact.file !== handoff.model ||
    artifact.run_manifest !== resolve(handoff.run, "manifest.json") ||
    quantization.sourceWeights?.sha256 !== artifact.sha256 ||
    quantization.sourceWeights?.file !== handoff.model
  )
    throw new Error("Local checkpoint, CUDA source and Q8 export do not match");
  const q8Registry = await document(options.q8Registry);
  const q8Artifact = q8Registry.artifacts?.find(
    (candidate) =>
      candidate.id ===
      (quantization.output?.modelId ?? quantization.output?.id),
  );
  if (
    !q8Artifact ||
    q8Artifact.file !== quantization.output?.file ||
    q8Artifact.sha256 !== quantization.output?.sha256 ||
    q8Artifact.training_run !== artifact.training_run
  )
    throw new Error("Q8 registry is not bound to this checkpoint");
  const selected = options.format === "f16" ? artifact : q8Artifact;
  const files = {};
  const sources = {
    campaign: resolve(
      root,
      "fixtures/guardrail/candidate10/cuda-campaign.json",
    ),
    admission: resolve(trainRoot, "admission.json"),
    fit: resolve(trainRoot, "fit.jsonl"),
    cal: resolve(trainRoot, "calibration.jsonl"),
    baseline: resolve(baselineRoot, "calibration-baseline.json"),
    baselineFreeze: freezePin.path,
    runManifest: resolve(handoff.run, "manifest.json"),
    importReport: resolve(handoff.run, "adapter/cuda-import-report.json"),
    localPrecision: resolve(
      handoff.run,
      "adapter/cuda-import-equivalence.json",
    ),
    precisionF16: handoff.precision,
    precisionQ8: options.precisionQ8,
    model: selected.file,
    registry: options.format === "f16" ? handoff.registry : options.q8Registry,
    artifact: handoff.artifact,
    nativeBinary: options.nativeBinary,
    modelF16: handoff.model,
    modelQ8: q8Artifact.file,
    quantizationManifest: options.q8Manifest,
    quantizerBinary: options.quantizerBinary,
    localFitMargins: resolve(handoff.run, "adapter/local-fit-margins.jsonl"),
    sourceFitMargins: resolve(options.cudaRun, "run/fit-margins.jsonl"),
    sourceReceipt: resolve(options.cudaRun, "run/receipt.json"),
    adapter: resolve(handoff.run, "adapter/adapters.safetensors"),
  };
  for (const [name, path] of Object.entries(sources))
    files[name] = await pin(path);
  if (files.sourceReceipt.sha256 !== imported.cuda_receipt_sha256)
    throw new Error("Source receipt does not match imported receipt pin");
  const runtime = {};
  for (const name of C10_EVALUATION_RUNTIME_FILES)
    runtime[name] = (await pin(resolve(root, name))).sha256;
  // Identity is copied from the reviewed freeze. Source and manifest bodies remain unopened.
  const manifest = {
    version: 1,
    purpose: "candidate10_native_evaluation",
    checkpoint: handoff.checkpoint,
    format: options.format,
    modelId: selected.id,
    sfPi: options.sfPi ?? freeze.host.path,
    sfDeps: options.sfDeps,
    files,
    runtime,
    valid: {
      source: {
        path: resolve(root, "blind-c9-20260922/valid.json"),
        sha256: freeze.authoredC9.validSourceSha256,
      },
      manifest: {
        path: resolve(root, "blind-c9-20260922/manifest.json"),
        sha256: freeze.authoredC9.validManifestSha256,
      },
      preflight: await pin(resolve(baselineRoot, "valid-preflight.json")),
    },
  };
  validateC10Manifest(manifest);
  return manifest;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = [
    "handoff",
    "cuda-run",
    "q8-manifest",
    "q8-registry",
    "precision-q8",
    "quantizer-binary",
    "native-binary",
    "sf-deps",
    "sf-pi",
    "format",
    "output",
  ];
  const { values } = parseArgs({
    options: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
  });
  if (!isAbsolute(values.output ?? ""))
    throw new Error("Required absolute --output FRESH_MANIFEST");
  const options = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
      value,
    ]),
  );
  const manifest = await assembleC10Manifest(options);
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(values.output, bytes, { flag: "wx" });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(
    JSON.stringify({
      manifest: values.output,
      sha256,
      checkpoint: manifest.checkpoint,
      format: manifest.format,
      qualified: false,
      invocation: [
        process.execPath,
        resolve(root, "scripts/guardrail-candidate10-evaluate.mjs"),
        "--manifest",
        values.output,
        "--manifest-sha256",
        sha256,
        "--output",
        `${values.output}.results`,
      ],
    }),
  );
}
