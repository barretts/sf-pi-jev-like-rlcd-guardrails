import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configFromEnv, type InferenceAdapter } from "../src/backend.js";
import {
  buildResponse,
  canonical,
  preparePrompt,
  type Request,
  type Logits,
} from "../src/core.js";
import {
  loadRfdtQualitySuite,
  RFDT_QUALITY_SUITE_SHA256,
} from "../src/models.js";
import { evaluateRecords, type QualityReport } from "../src/evaluation.js";
import {
  prepareRfdt,
  rfdtSha256,
  type RfdtArtifactManifest,
  type RfdtExample,
} from "../src/rfdt.js";

/** Synthetic compiler and predictions exercise evidence validation without weights. */
export async function rfdtFixture(
  directory: string,
  nativeEvidence = true,
  trainOnly = false,
) {
  const splits = trainOnly
    ? (["train"] as const)
    : (["train", "validation", "test"] as const);
  const rows: RfdtExample[] = splits.map((split) => ({
    id: split,
    group_id: split,
    split,
    request: {
      model: "google/gemma-3-1b-it",
      state: `Synthetic context ${split}`,
      questions: [
        {
          id: "route",
          type: "choice",
          instructions: "Select a team",
          criteria: [
            { id: "billing", description: "Payments" },
            { id: "product", description: "Product" },
          ],
        },
        {
          id: "support",
          type: "score",
          instructions: "How much?",
          criteria: ["None", "Some", "All"],
        },
        {
          id: "refund",
          type: "noul",
          instructions: "Was a refund requested?",
        },
      ],
    },
    targets: {
      route: { answer: "billing" },
      support: { answer: 1.25 },
      refund: { answer: true },
    },
    regression: split === "validation",
  }));
  const source = join(directory, "input.jsonl");
  await writeFile(
    source,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const backend: InferenceAdapter = {
    warmup: async () => {},
    compile: async (plan) =>
      plan.questions.map((question) => ({
        branch_id: question.branch_id,
        rendered: `Synthetic native prompt ${question.question_id}`,
        tokens: [2, 11, 12],
        token_ids: Object.fromEntries(
          question.output_labels.map((label, index) => [label, 20 + index]),
        ),
      })),
    evaluate: async () => {
      throw new Error("Synthetic preparation must not infer");
    },
    dispose: async () => {},
  };
  const run = await prepareRfdt(source, {
    outputDir: join(directory, "run"),
    templateVersion: "v2",
    backend,
    config: configFromEnv({}),
  });
  const file = join(run.directory, "trained.gguf");
  await writeFile(file, "GGUFfixture");
  const artifact: RfdtArtifactManifest = {
    version: 1,
    id: "jev/trained-fixture",
    file,
    base_model: run.base_model,
    base_revision: run.base_revision,
    template_version: run.template_version,
    training_run: run.id,
    sha256: await rfdtSha256(file),
    size: Buffer.byteLength("GGUFfixture"),
    run_manifest: join(run.directory, "manifest.json"),
  };
  run.status = "exported";
  run.training = { adapter_dir: "synthetic" };
  run.exports = {
    id: artifact.id,
    file: artifact.file,
    sha256: artifact.sha256,
    size: artifact.size,
  };
  const binding = {
    training_run: artifact.training_run,
    artifact_id: artifact.id,
    artifact_sha256: artifact.sha256,
    artifact_size: artifact.size,
    template_version: artifact.template_version,
    prepared_sha256: run.prepared.sha256,
    dataset_sha256: run.prepared.dataset_sha256,
    quality_suite_sha256: RFDT_QUALITY_SUITE_SHA256,
  };
  const suite = await loadRfdtQualitySuite();
  const requestKey = (request: Request) =>
    canonical({
      state: request.state ?? null,
      messages: request.messages ?? null,
      questions: request.questions,
    });
  const byRequest = new Map(
    suite.map((record) => [requestKey(record.request), record]),
  );
  const response = (request = suite[0].request) => {
    const record = byRequest.get(requestKey(request));
    if (!record)
      throw new Error("Synthetic response needs a fixed suite request");
    const plan = preparePrompt({ ...request, model: artifact.id }, "v2");
    const logits: Logits = {};
    for (const [questionIndex, branch] of plan.questions.entries()) {
      const question = plan.request.questions[questionIndex];
      const target = record.targets[branch.question_id];
      if (!("answer" in target))
        throw new Error("Expected authored answer fixture");
      const value =
        question.type === "noul"
          ? target.answer === null
            ? 4
            : target.answer === true
              ? 8
              : 0
          : Number(target.answer);
      logits[branch.branch_id] = Object.fromEntries(
        branch.output_labels.map((label, index) => {
          const probability =
            question.type === "choice"
              ? Number(branch.answer_labels[index] === target.answer)
              : Math.max(0, 1 - Math.abs(index - value));
          return [label, Math.log(Math.max(probability, 1e-12))];
        }),
      );
    }
    return buildResponse(plan, logits, 3, true, {
      metadata: {
        backend: "llama.cpp",
        model_revision: artifact.base_revision,
        template_version: artifact.template_version,
        calibration: "not_calibrated",
        usage_accounting: "synthetic fixture",
        artifact: {
          id: artifact.id,
          revision: artifact.base_revision,
          sha256: artifact.sha256,
          size: artifact.size,
          base_model: artifact.base_model,
          template_version: artifact.template_version,
        },
      },
    });
  };
  const writeRun = async () => {
    await writeFile(artifact.run_manifest, JSON.stringify(run) + "\n");
    await writeFile(
      join(run.directory, "artifact.json"),
      JSON.stringify(artifact) + "\n",
    );
  };
  const reports: Partial<
    Record<"validation" | "test", QualityReport & { rfdt: typeof binding }>
  > = {};
  const writeReport = async (split: "validation" | "test") => {
    const report = reports[split]!;
    const file = join(run.directory, `native-${split}-report.json`);
    await writeFile(file, JSON.stringify(report) + "\n");
    run.evaluation = {
      ...run.evaluation,
      [`native_${split}`]: {
        summary: report.summary,
        artifact_sha256: artifact.sha256,
        artifact: "native_gguf",
        binding,
        file,
        sha256: await rfdtSha256(file),
      },
    };
    await writeRun();
  };
  if (nativeEvidence) {
    for (const split of ["validation", "test"] as const) {
      const report = await evaluateRecords(
        { classify: async (request) => response(request as Request) },
        suite.filter((row) => row.split === split),
        "v2",
        { modelId: artifact.id },
      );
      reports[split] = { ...report, rfdt: binding };
      await writeReport(split);
    }
  }
  await writeRun();
  return {
    artifact,
    run,
    registryPath: join(directory, "artifacts.json"),
    reports,
    response,
    writeRun,
    writeReport,
  };
}
