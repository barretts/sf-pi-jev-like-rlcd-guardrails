#!/usr/bin/env node
/** Import a completed supervised checkpoint, fuse locally, export and verify F16. */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareRfdt, importCudaRfdt, exportRfdt } from "../dist/rfdt.js";
import { verifyGuardrailExport } from "./verify-guardrail.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "run",
      "cuda-run",
      "receipt-sha256",
      "base-hf",
      "native-binary",
      "python",
      "model-id",
    ].map((name) => [name, { type: "string" }]),
  ),
});
if (
  [
    "run",
    "cuda-run",
    "receipt-sha256",
    "base-hf",
    "native-binary",
    "model-id",
  ].some((name) => !values[name])
) {
  throw new Error(
    "Required: --run FRESH_LOCAL --cuda-run LOCAL_CHECKPOINT_SNAPSHOT --receipt-sha256 HEX --base-hf PINNED_GOOGLE_SNAPSHOT --native-binary FILE --model-id jev/ID [--python LOCAL_MLX_PYTHON]",
  );
}
const run = resolve(values.run);
await prepareRfdt(join(root, "training", "data", "fit.jsonl"), {
  outputDir: run,
});
await importCudaRfdt(run, {
  cudaRun: values["cuda-run"],
  receiptSha256: values["receipt-sha256"],
  modelPath: values["base-hf"],
  python: values.python,
});
const artifact = await exportRfdt(run, {
  modelId: values["model-id"],
  modelPath: values["base-hf"],
  python: values.python,
});
const result = await verifyGuardrailExport({
  run,
  "model-file": artifact.file,
  "model-id": artifact.id,
  registry: join(run, "registry.json"),
  "native-binary": resolve(values["native-binary"]),
  output: join(run, "precision-f16.json"),
});
console.log(
  JSON.stringify({
    artifact,
    qualified: false,
    enforcementEligible: false,
    fitPrecisionPassed: result.ok,
  }),
);
if (!result.ok) process.exitCode = 1;
