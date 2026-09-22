#!/usr/bin/env node
/** Local-only C10 FIT preparation/import/F16 export. Never activates enforcement.
 * The separate native precision stage produces Q8 and evaluation handoff pins.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configFromEnv } from "../dist/backend.js";
import { prepareRfdt, importCudaRfdt, exportRfdt } from "../dist/rfdt.js";
import { verifyTrainedArtifactExport } from "../dist/models.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
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
const run = resolve(values.run);
try {
  await access(run);
  throw new Error(
    "Output run directory already exists; preserve previous attempts",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const fit = await readFile(resolve(values.fit));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  sha(fit) !==
  "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25"
)
  throw new Error("Admitted FIT source changed");
const source = JSON.parse(
  await readFile(resolve(values["cuda-run"], "run/receipt.json"), "utf8"),
);
if (
  source.steps !== Number(values.checkpoint) ||
  source.mode !== "train" ||
  source.qualified !== false
)
  throw new Error(
    "Source checkpoint is not the selected completed training checkpoint",
  );
const config = configFromEnv({
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
await prepareRfdt(resolve(values.fit), {
  outputDir: run,
  templateVersion: "v2",
  config,
});
await importCudaRfdt(run, {
  cudaRun: resolve(values["cuda-run"]),
  receiptSha256: values["receipt-sha256"],
  modelPath: resolve(values["base-hf"]),
  python: resolve(values.python),
});
const artifact = await exportRfdt(run, {
  modelId: values["model-id"],
  outputFile: resolve(run, "model-f16.gguf"),
  modelPath: resolve(values["base-hf"]),
  python: resolve(values.python),
});
const descriptor = await verifyTrainedArtifactExport(artifact);
const registry = resolve(run, "f16-registry.json");
await writeFile(
  registry,
  JSON.stringify({ version: 1, artifacts: [descriptor] }, null, 2) + "\n",
  { flag: "wx" },
);
const args = [
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
];
await new Promise((yes, no) => {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.on("error", no);
  child.on("exit", (code) =>
    code === 0 ? yes() : no(new Error(`F16 precision stage exited ${code}`)),
  );
});
await writeFile(
  resolve(run, "local-checkpoint-handoff.json"),
  JSON.stringify(
    {
      version: 1,
      purpose: "candidate10_local_checkpoint_handoff",
      qualified: false,
      checkpoint: Number(values.checkpoint),
      run,
      artifact: resolve(run, "artifact.json"),
      registry,
      model: artifact.file,
      precision: resolve(run, "precision-f16.json"),
      next: "Native Q8 quantization and both-format manifest pinning, then guarded CAL-to-VALID evaluation",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    qualified: false,
    run,
    handoff: resolve(run, "local-checkpoint-handoff.json"),
  }),
);
