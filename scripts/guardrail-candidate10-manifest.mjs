#!/usr/bin/env node
/** Assemble an executable native C10 evaluation manifest; never opens VALID or TEST bodies.
 * --handoff LOCAL_CHECKPOINT_HANDOFF --cuda-run SOURCE_SNAPSHOT_ROOT
 * --q8-manifest QUANTIZATION_MANIFEST --q8-registry REGISTRY --precision-q8 REPORT
 * --quantizer-binary FILE --native-binary FILE --sf-deps DIR
 * --format f16|q8_0 --output FRESH_MANIFEST
 * Optional: --sf-pi DIR (defaults to the frozen prospective host).
 * C11 selected F16 permits all four Q8 inputs to be absent; supplied Q8 must be complete.
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
  C11_EVALUATION_RUNTIME_FILES,
  validateC11Manifest,
  verifyC11Checkpoint,
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
  return assembleManifest(options, false);
}
export async function assembleC11Manifest(options, dependencies) {
  return assembleManifest(options, true, dependencies);
}
async function assembleManifest(options, candidate11, dependencies) {
  const candidate = candidate11 ? "candidate11" : "candidate10";
  const api = { pin, document, bytes: readFile, ...dependencies };
  const q8Inputs = [
    "q8Manifest",
    "q8Registry",
    "precisionQ8",
    "quantizerBinary",
  ];
  const hasQ8 =
    !candidate11 ||
    options?.format !== "f16" ||
    q8Inputs.some((name) => Object.hasOwn(options ?? {}, name));
  for (const name of [
    "handoff",
    "cudaRun",
    ...(hasQ8 ? q8Inputs : []),
    "nativeBinary",
    "sfDeps",
  ])
    if (!isAbsolute(options?.[name] ?? ""))
      throw new Error(
        `Required absolute --${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`,
      );
  if (!["f16", "q8_0"].includes(options.format))
    throw new Error("Required --format f16|q8_0");
  const handoff = await api.document(options.handoff);
  const quantization = hasQ8
    ? await api.document(options.q8Manifest)
    : undefined;
  const freezePin = await api.pin(resolve(baselineRoot, "manifest.json"));
  if (freezePin.sha256 !== C10_HOST.freezeSha256)
    throw new Error("Prospective baseline manifest changed");
  const freeze = await api.document(freezePin.path);
  if (
    handoff.purpose !== `${candidate}_local_checkpoint_handoff` ||
    handoff.qualified !== false ||
    ![128, 256, 512, 1024].includes(handoff.checkpoint) ||
    !isAbsolute(handoff.run ?? "")
  )
    throw new Error(`Completed ${candidate} local checkpoint handoff required`);
  const artifact = await api.document(handoff.artifact);
  const imported = await api.document(
    resolve(handoff.run, "adapter/cuda-import-report.json"),
  );
  const source = await api.document(
    resolve(options.cudaRun, "run/receipt.json"),
  );
  if (
    imported.checkpoint_step !== handoff.checkpoint ||
    source.steps !== handoff.checkpoint ||
    source.mode !== "train" ||
    source.qualified !== false ||
    artifact.file !== handoff.model ||
    artifact.run_manifest !== resolve(handoff.run, "manifest.json") ||
    (hasQ8 &&
      (quantization.sourceWeights?.sha256 !== artifact.sha256 ||
        quantization.sourceWeights?.file !== handoff.model))
  )
    throw new Error("Local checkpoint, CUDA source and Q8 export do not match");
  const q8Registry = hasQ8 ? await api.document(options.q8Registry) : undefined;
  const q8Artifact = q8Registry?.artifacts?.find(
    (candidate) =>
      candidate.id ===
      (quantization.output?.modelId ?? quantization.output?.id),
  );
  if (
    hasQ8 &&
    (!q8Artifact ||
      q8Artifact.file !== quantization.output?.file ||
      q8Artifact.sha256 !== quantization.output?.sha256 ||
      q8Artifact.training_run !== artifact.training_run)
  )
    throw new Error("Q8 registry is not bound to this checkpoint");
  const memory = candidate11
    ? await api.document(resolve(options.cudaRun, "memory.summary.json"))
    : undefined;
  if (
    candidate11 &&
    !["checkpoint_snapshot", "worker_exit"].includes(memory?.reason)
  )
    throw new Error(
      "C11 source memory requires strict snapshot or genuine final worker_exit",
    );
  const finalC11 = candidate11 && memory.reason === "worker_exit";
  if (finalC11 && handoff.checkpoint !== 1024)
    throw new Error("C11 worker_exit requires final1024 checkpoint");
  const selected = options.format === "f16" ? artifact : q8Artifact;
  const files = {};
  const sources = {
    campaign: resolve(
      root,
      candidate11
        ? "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json"
        : "fixtures/guardrail/candidate10/cuda-campaign.json",
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
    model: selected.file,
    registry: options.format === "f16" ? handoff.registry : options.q8Registry,
    artifact: handoff.artifact,
    nativeBinary: options.nativeBinary,
    modelF16: handoff.model,
    ...(hasQ8
      ? {
          precisionQ8: options.precisionQ8,
          modelQ8: q8Artifact.file,
          quantizationManifest: options.q8Manifest,
          quantizerBinary: options.quantizerBinary,
        }
      : {}),
    localFitMargins: resolve(handoff.run, "adapter/local-fit-margins.jsonl"),
    sourceFitMargins: resolve(options.cudaRun, "run/fit-margins.jsonl"),
    sourceReceipt: resolve(options.cudaRun, "run/receipt.json"),
    adapter: resolve(handoff.run, "adapter/adapters.safetensors"),
    ...(candidate11
      ? {
          sourceLaunch: resolve(options.cudaRun, "launch.json"),
          ...(finalC11
            ? {
                sourceGuardian: resolve(options.cudaRun, "root-guardian.jsonl"),
                sourceMemory: resolve(options.cudaRun, "memory.summary.json"),
                sourceMemoryJournal: resolve(options.cudaRun, "memory.jsonl"),
                sourceExit: resolve(options.cudaRun, "run/exit.json"),
                sourceCheckpointExit: resolve(
                  options.cudaRun,
                  "run/checkpoints/step-1024/exit.json",
                ),
              }
            : {
                sourceSnapshot: resolve(
                  options.cudaRun,
                  "memory.snapshot.json",
                ),
              }),
          ...(hasQ8 ? { registryQ8: options.q8Registry } : {}),
        }
      : {}),
  };
  for (const [name, path] of Object.entries(sources))
    files[name] = await api.pin(path);
  if (files.sourceReceipt.sha256 !== imported.cuda_receipt_sha256)
    throw new Error("Source receipt does not match imported receipt pin");
  const runtime = {};
  for (const name of candidate11
    ? C11_EVALUATION_RUNTIME_FILES
    : C10_EVALUATION_RUNTIME_FILES)
    runtime[name] = (await api.pin(resolve(root, name))).sha256;
  if (candidate11) {
    if (
      hasQ8 &&
      (quantization.purpose !== "candidate11_fit_only_q8_derivation" ||
        quantization.output?.registrySha256 !== files.registryQ8.sha256 ||
        quantization.output?.id !== artifact.id + "-q8" ||
        quantization.output?.training_run !== artifact.training_run)
    )
      throw new Error(
        "C11 retained Q8 registry or checkpoint provenance changed",
      );
    const run = await api.document(files.runManifest.path);
    verifyC11Checkpoint({
      campaign: await api.document(files.campaign.path),
      run,
      imported,
      receipt: source,
      runtime,
      checkpoint: handoff.checkpoint,
      originalObjective: await api.document(
        resolve(root, "fixtures/guardrail/candidate9/objective-plan-B.json"),
      ),
      launch: await api.document(files.sourceLaunch.path),
      snapshot: finalC11
        ? undefined
        : await api.document(files.sourceSnapshot.path),
      finalEnvelope: finalC11
        ? {
            memory,
            exit: await api.document(files.sourceExit.path),
            checkpointExit: await api.document(files.sourceCheckpointExit.path),
            journal: await api.bytes(files.sourceMemoryJournal.path),
            guardian: await api.bytes(files.sourceGuardian.path),
            files,
          }
        : undefined,
      receiptSha256: files.sourceReceipt.sha256,
      requireSourceProvenance: true,
    });
  }
  // Identity is copied from the reviewed freeze. Source and manifest bodies remain unopened.
  const manifest = {
    version: 1,
    purpose: `${candidate}_native_evaluation`,
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
      preflight: await api.pin(resolve(baselineRoot, "valid-preflight.json")),
    },
  };
  (candidate11 ? validateC11Manifest : validateC10Manifest)(manifest);
  return manifest;
}
export async function runC11ManifestCli(args = process.argv.slice(2)) {
  return runManifestCli(args, true);
}
async function runManifestCli(args, candidate11) {
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
    args,
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
  const manifest = await (
    candidate11 ? assembleC11Manifest : assembleC10Manifest
  )(options);
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
        resolve(
          root,
          candidate11
            ? "scripts/guardrail-candidate11-evaluate.mjs"
            : "scripts/guardrail-candidate10-evaluate.mjs",
        ),
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runManifestCli(process.argv.slice(2), false);
}
