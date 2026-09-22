#!/usr/bin/env node
/** Local-only derivative export + FIT precision. Does not qualify a candidate. */
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashArtifact, verifyTrainedArtifactExport } from "../dist/models.js";
import { inspectQuantizerLibraries } from "./guardrail-candidate9-quantizer-libraries.mjs";
import { createHash } from "node:crypto";
import {
  C11_SOURCE_RUNTIME,
  C11_CAMPAIGN_SHA256,
  C10_CAMPAIGN_SHA256,
  verifyC11Checkpoint,
  verifyC10PreparedInputs,
  verifyC10Precision,
  verifyC10LocalArchitecture,
  c11Q8SourceIdentity,
} from "./guardrail-candidate10-evaluate.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function child(command, args) {
  await new Promise((yes, no) => {
    const proc = spawn(command, args, { stdio: "inherit" });
    proc.on("error", no);
    proc.on("exit", (code, signal) =>
      code === 0 ? yes() : no(Error(`Child failed ${code ?? signal}`)),
    );
  });
}
export async function runC11Q8(args = process.argv.slice(2), dependencies) {
  return runQ8(args, true, dependencies);
}
async function runQ8(args, candidate11, dependencies) {
  const api = {
    readFile,
    writeFile,
    access,
    hashArtifact,
    verifyTrainedArtifactExport,
    inspectQuantizerLibraries,
    execFileSync,
    child,
    ...dependencies,
  };
  const { values } = parseArgs({
    args,
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
  let sourceCheckpoint;
  const f16 = await api.verifyTrainedArtifactExport(
    JSON.parse(await api.readFile(resolve(run, "artifact.json"), "utf8")),
  );
  const prior = JSON.parse(
    await api.readFile(resolve(run, "precision-f16.json"), "utf8"),
  );
  if (
    prior.ok !== true ||
    prior.modelSha256 !== f16.sha256 ||
    prior.answered !== 327 ||
    prior.qualified !== false
  )
    throw Error("Passing matching F16 FIT precision is required");
  if (!candidate11) {
    const imported = JSON.parse(
      await api.readFile(
        resolve(run, "adapter/cuda-import-report.json"),
        "utf8",
      ),
    );
    if (
      imported.cuda_source?.source?.experiment !== "candidate10" ||
      imported.cuda_campaign_sha256 !== C10_CAMPAIGN_SHA256
    )
      throw Error("C10 Q8 entry requires an explicit C10 checkpoint");
  }
  if (candidate11) {
    const localRun = JSON.parse(
      await api.readFile(resolve(run, "manifest.json"), "utf8"),
    );
    const imported = JSON.parse(
      await api.readFile(
        resolve(run, "adapter/cuda-import-report.json"),
        "utf8",
      ),
    );
    const handoff = JSON.parse(
      await api.readFile(resolve(run, "local-checkpoint-handoff.json"), "utf8"),
    );
    const runtime = {};
    for (const [name, digest] of Object.entries(C11_SOURCE_RUNTIME)) {
      runtime[name] = (await api.hashArtifact(resolve(root, name))).sha256;
      if (runtime[name] !== digest)
        throw Error("C11 source implementation changed: " + name);
    }
    const campaign = JSON.parse(
      await api.readFile(
        resolve(
          root,
          "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json",
        ),
        "utf8",
      ),
    );
    if (
      (
        await api.hashArtifact(
          resolve(
            root,
            "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json",
          ),
        )
      ).sha256 !== C11_CAMPAIGN_SHA256
    )
      throw Error("C11 campaign changed");
    const originalObjective = JSON.parse(
      await api.readFile(
        resolve(root, "fixtures/guardrail/candidate9/objective-plan-B.json"),
        "utf8",
      ),
    );
    if (
      handoff.purpose !== "candidate11_local_checkpoint_handoff" ||
      handoff.qualified !== false ||
      handoff.run !== run ||
      handoff.checkpoint !== imported.checkpoint_step ||
      handoff.artifact !== resolve(run, "artifact.json") ||
      handoff.model !== f16.file ||
      handoff.precision !== resolve(run, "precision-f16.json") ||
      localRun.status !== "exported" ||
      localRun.training?.training_backend !== "torch_cuda" ||
      localRun.id !== f16.training_run ||
      imported.ok !== true ||
      imported.reload_verified !== true ||
      imported.qualified !== false
    )
      throw Error("Completed linked C11 local checkpoint handoff required");
    verifyC10PreparedInputs(
      localRun,
      (await api.hashArtifact(localRun.prepared.files.train)).sha256,
    );
    verifyC11Checkpoint({
      campaign,
      run: localRun,
      imported,
      receipt: imported.cuda_source,
      runtime,
      checkpoint: handoff.checkpoint,
      originalObjective,
    });
    await verifyC10LocalArchitecture(imported, runtime);
    verifyC10Precision(
      prior,
      f16.sha256,
      (await api.hashArtifact(resolve(values["native-binary"]))).sha256,
    );
    const bytes = await api.readFile(
      resolve(run, "adapter/local-fit-margins.jsonl"),
    );
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      imported.local_fit_margins_sha256
    )
      throw Error("C11 local FIT reference changed");
    const rows = bytes.toString().trim().split("\n").map(JSON.parse);
    const reference = new Map(rows.map((row) => [row.source_id, row.margin]));
    if (
      rows.length !== 327 ||
      reference.size !== 327 ||
      rows.some((row) => !Number.isFinite(row.margin)) ||
      prior.records.some(
        (row) => reference.get(row.sourceId) !== row.referenceMargin,
      )
    )
      throw Error(
        "C11 full F16 precision proof is not bound to imported FIT margins",
      );
    sourceCheckpoint = c11Q8SourceIdentity(localRun, imported, runtime);
  }
  const model = resolve(run, "model-q8.gguf"),
    registry = resolve(run, "q8-registry.json"),
    report = resolve(run, "precision-q8.json"),
    manifest = resolve(
      run,
      candidate11
        ? "candidate11-q8-manifest.json"
        : "candidate10-q8-manifest.json",
    );
  for (const file of [model, registry, report, manifest]) {
    try {
      await api.access(file);
      throw Error("Preserve existing Q8 attempt: " + file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const binaryPin =
    "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";
  const revision = "f072b103714dfa1eee531f80b24512faf38e3dd2";
  async function inspect() {
    const identity = await api.hashArtifact(binary);
    if (identity.sha256 !== binaryPin) throw Error("Quantizer binary changed");
    if (
      api
        .execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
          encoding: "utf8",
        })
        .trim() !== revision
    )
      throw Error("Quantizer source revision changed");
    api.execFileSync("git", ["-C", source, "diff", "--quiet", "HEAD"]);
    return {
      identity,
      ...(await api.inspectQuantizerLibraries(dirname(binary))),
    };
  }
  const before = await inspect();

  await api.child(binary, ["--leave-output-tensor", f16.file, model, "Q8_0"]);
  const after = await inspect();
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    (await api.hashArtifact(f16.file)).sha256 !== f16.sha256
  )
    throw Error("Export input or quantizer changed");
  const output = {
    ...f16,
    id: f16.id + "-q8",
    file: model,
    ...(await api.hashArtifact(model)),
  };
  await api.writeFile(
    registry,
    JSON.stringify({ version: 1, artifacts: [output] }, null, 2) + "\n",
    { flag: "wx" },
  );
  const quantization = {
    version: 1,
    purpose: candidate11
      ? "candidate11_fit_only_q8_derivation"
      : "candidate10_fit_only_q8_derivation",
    ...(candidate11 ? { sourceCheckpoint } : {}),
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
      registrySha256: (await api.hashArtifact(registry)).sha256,
    },
  };
  await api.writeFile(manifest, JSON.stringify(quantization, null, 2) + "\n", {
    flag: "wx",
  });
  let precisionError;
  try {
    await api.child(process.execPath, [
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
  } catch (error) {
    precisionError = error;
  }
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

  if (precisionError) throw precisionError;
  return {
    qualified: false,
    run,
    model,
    registry,
    manifest,
    precision: report,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runQ8(process.argv.slice(2), false);
}
