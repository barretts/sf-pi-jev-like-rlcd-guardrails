#!/usr/bin/env node
/** Local-only derivative export + FIT precision. Does not qualify a candidate. */
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashArtifact, verifyTrainedArtifactExport } from "../dist/models.js";
import { inspectQuantizerLibraries } from "./guardrail-candidate9-quantizer-libraries.mjs";
const { values } = parseArgs({
  options: Object.fromEntries(
    ["run", "native-binary", "quantizer-binary", "quantizer-source"].map(
      (name) => [name, { type: "string" }],
    ),
  ),
});
if (Object.keys(values).length !== 4)
  throw Error(
    "Required: --run --native-binary --quantizer-binary --quantizer-source",
  );
const run = resolve(values.run),
  binary = resolve(values["quantizer-binary"]),
  source = resolve(values["quantizer-source"]);
const f16 = await verifyTrainedArtifactExport(
  JSON.parse(await readFile(resolve(run, "artifact.json"), "utf8")),
);
const prior = JSON.parse(
  await readFile(resolve(run, "precision-f16.json"), "utf8"),
);
if (
  prior.ok !== true ||
  prior.modelSha256 !== f16.sha256 ||
  prior.answered !== 327 ||
  prior.qualified !== false
)
  throw Error("Passing matching F16 FIT precision is required");
const model = resolve(run, "model-q8.gguf"),
  registry = resolve(run, "q8-registry.json"),
  report = resolve(run, "precision-q8.json"),
  manifest = resolve(run, "candidate10-q8-manifest.json");
for (const file of [model, registry, report, manifest]) {
  try {
    await access(file);
    throw Error("Preserve existing Q8 attempt: " + file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const binaryPin =
  "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";
const revision = "f072b103714dfa1eee531f80b24512faf38e3dd2";
async function inspect() {
  const identity = await hashArtifact(binary);
  if (identity.sha256 !== binaryPin) throw Error("Quantizer binary changed");
  if (
    execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim() !== revision
  )
    throw Error("Quantizer source revision changed");
  execFileSync("git", ["-C", source, "diff", "--quiet", "HEAD"]);
  return { identity, ...(await inspectQuantizerLibraries(dirname(binary))) };
}
const before = await inspect();
async function child(command, args) {
  await new Promise((yes, no) => {
    const proc = spawn(command, args, { stdio: "inherit" });
    proc.on("error", no);
    proc.on("exit", (code, signal) =>
      code === 0 ? yes() : no(Error(`Child failed ${code ?? signal}`)),
    );
  });
}
await child(binary, ["--leave-output-tensor", f16.file, model, "Q8_0"]);
const after = await inspect();
if (
  JSON.stringify(before) !== JSON.stringify(after) ||
  (await hashArtifact(f16.file)).sha256 !== f16.sha256
)
  throw Error("Export input or quantizer changed");
const output = {
  ...f16,
  id: f16.id + "-q8",
  file: model,
  ...(await hashArtifact(model)),
};
await writeFile(
  registry,
  JSON.stringify({ version: 1, artifacts: [output] }, null, 2) + "\n",
  { flag: "wx" },
);
const quantization = {
  version: 1,
  purpose: "candidate10_fit_only_q8_derivation",
  qualified: false,
  qualification: false,
  sourceWeights: f16,
  quantizer: {
    binary,
    sourceDirectory: source,
    sourceRevision: revision,
    binarySha256: binaryPin,
    type: "Q8_0",
    leaveOutputTensorUnquantized: true,
    importanceMatrix: null,
    runtimeLibraries: before.runtimeLibraries,
    runtimeLibraryLinks: before.runtimeLibraryLinks,
  },
  output: {
    ...output,
    modelId: output.id,
    registrySha256: (await hashArtifact(registry)).sha256,
  },
};
await writeFile(manifest, JSON.stringify(quantization, null, 2) + "\n", {
  flag: "wx",
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await child(process.execPath, [
  resolve(root, "scripts/guardrail-cuda-export-check.mjs"),
  "--run",
  run,
  "--model-file",
  model,
  "--model-id",
  output.id,
  "--registry",
  registry,
  "--native-binary",
  resolve(values["native-binary"]),
  "--output",
  report,
]);
console.log(
  JSON.stringify({
    qualified: false,
    run,
    model,
    registry,
    manifest,
    precision: report,
  }),
);
