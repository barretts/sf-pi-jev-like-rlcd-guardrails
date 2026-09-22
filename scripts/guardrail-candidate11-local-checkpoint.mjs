#!/usr/bin/env node
/** Local C11 FIT preparation/import/F16 export; root owns explicit execution. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseCandidate11CheckpointArgs(args) {
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      [
        "run",
        "fit",
        "cuda-run",
        "receipt-sha256",
        "base-hf",
        "base-gguf",
        "native-binary",
        "python",
        "checkpoint",
        "model-id",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  if (
    Object.keys(values).length !== 10 ||
    ![128, 256, 512, 1024].includes(Number(values.checkpoint)) ||
    !/^[a-f0-9]{64}$/.test(values["receipt-sha256"] ?? "") ||
    !/^jev\/[\w.-]+$/.test(values["model-id"] ?? "")
  ) {
    throw new Error(
      "Required: --run FRESH --fit ADMITTED_FIT --cuda-run SNAPSHOT_ROOT --receipt-sha256 HEX --base-hf DIR --base-gguf FILE --native-binary FILE --python FILE --checkpoint 128|256|512|1024 --model-id jev/ID",
    );
  }
  return values;
}

export async function validateCandidate11CheckpointInputs(values) {
  const run = resolve(values.run);
  try {
    await access(run);
    throw new Error(
      "Output run directory already exists; preserve previous attempts",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    sha(await readFile(resolve(values.fit))) !==
    "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25"
  ) {
    throw new Error("Admitted FIT source changed");
  }
  const bytes = await readFile(resolve(values["cuda-run"], "run/receipt.json"));
  if (sha(bytes) !== values["receipt-sha256"])
    throw new Error("Pinned C11 source receipt changed");
  const receipt = JSON.parse(bytes);
  const campaignBytes = await readFile(
    resolve(root, "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json"),
  );
  const campaign = JSON.parse(campaignBytes);
  if (
    receipt.steps !== Number(values.checkpoint) ||
    receipt.checkpoint_step !== receipt.steps ||
    receipt.mode !== "train" ||
    receipt.qualified !== false ||
    receipt.source?.experiment !== "candidate11" ||
    receipt.source?.steps !== receipt.steps ||
    receipt.source?.campaign_steps !== 1024 ||
    receipt.source?.campaign_sha256 !== sha(campaignBytes) ||
    JSON.stringify(receipt.source?.campaign) !== JSON.stringify(campaign)
  ) {
    throw new Error(
      "Source checkpoint is not the selected completed C11 training checkpoint",
    );
  }
  return { run, receipt };
}

async function precisionCheck(args) {
  await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", no);
    child.on("exit", (code) =>
      code === 0 ? yes() : no(new Error(`F16 precision stage exited ${code}`)),
    );
  });
}

export async function runCandidate11LocalCheckpoint(args, dependencies) {
  const values = parseCandidate11CheckpointArgs(args);
  const { run } = await validateCandidate11CheckpointInputs(values);
  const api = dependencies ?? {
    ...(await import("../dist/backend.js")),
    ...(await import("../dist/rfdt.js")),
    ...(await import("../dist/models.js")),
    precisionCheck,
  };
  const config = api.configFromEnv({
    JEV_MODEL_FILE: resolve(values["base-gguf"]),
    JEV_MODEL_ID: "google/gemma-3-1b-it",
    JEV_TEMPLATE_VERSION: "v2",
  });
  Object.assign(config, {
    binary: resolve(values["native-binary"]),
    maxModelLen: 2048,
    maxBatchSize: 32,
    maxBatchTokens: 2048,
  });
  await api.prepareRfdt(resolve(values.fit), {
    outputDir: run,
    templateVersion: "v2",
    config,
  });
  await api.importCudaRfdt(run, {
    cudaRun: resolve(values["cuda-run"]),
    receiptSha256: values["receipt-sha256"],
    modelPath: resolve(values["base-hf"]),
    python: resolve(values.python),
  });
  const artifact = await api.exportRfdt(run, {
    modelId: values["model-id"],
    outputFile: resolve(run, "model-f16.gguf"),
    modelPath: resolve(values["base-hf"]),
    python: resolve(values.python),
  });
  const descriptor = await api.verifyTrainedArtifactExport(artifact);
  const registry = resolve(run, "f16-registry.json");
  await writeFile(
    registry,
    JSON.stringify({ version: 1, artifacts: [descriptor] }, null, 2) + "\n",
    { flag: "wx" },
  );
  await api.precisionCheck([
    resolve(root, "scripts/guardrail-cuda-export-check.mjs"),
    "--run",
    run,
    "--model-file",
    artifact.file,
    "--model-id",
    artifact.id,
    "--registry",
    registry,
    "--native-binary",
    config.binary,
    "--output",
    resolve(run, "precision-f16.json"),
  ]);
  const handoff = {
    version: 1,
    purpose: "candidate11_local_checkpoint_handoff",
    qualified: false,
    checkpoint: Number(values.checkpoint),
    run,
    artifact: resolve(run, "artifact.json"),
    registry,
    model: artifact.file,
    precision: resolve(run, "precision-f16.json"),
    next: "Native Q8 quantization and both-format manifest pinning, then guarded CAL-to-VALID evaluation",
  };
  await writeFile(
    resolve(run, "local-checkpoint-handoff.json"),
    JSON.stringify(handoff, null, 2) + "\n",
    { flag: "wx" },
  );
  return {
    qualified: false,
    run,
    handoff: resolve(run, "local-checkpoint-handoff.json"),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(await runCandidate11LocalCheckpoint(process.argv.slice(2))),
  );
}
