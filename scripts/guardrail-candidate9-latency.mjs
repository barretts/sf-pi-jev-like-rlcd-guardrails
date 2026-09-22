#!/usr/bin/env node
/** Evaluator-only C9 latency probe; no tool operation is executed. */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { candidate8OperationSha256 } from "./guardrail-candidate8-host-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const C8_REPORT = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-8-valid-real-256-evidence/report.json",
);
const Q8_MANIFEST = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-9-latency-evidence/q8_0-export-manifest.json",
);
const WARM_DEADLINE_MS = 750;
const COLD_PROBE_DEADLINE_MS = 2_500;
const C9_PINS = Object.freeze({
  c8DeliveryCommit: "4881df64ff2c52a92a6b8754e087637284cda8d4",
  c8ReportSha256:
    "8f6489aba509a340674544e416b2e16a79a4769d1597d1bbaf0bf26c332a479c",
  modelId: "jev/guardrail-c8-256",
  modelSha256:
    "5b2c6be87fef227ea02c71f91b853010f089501035b872a888b100b5d746237f",
  nativeBinarySha256:
    "7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96",
  runtime: Object.freeze({
    "backend.js":
      "fd18233f879bb4ce3b9b281221ec1303149a36e29d958964da91bc39effee60f",
    "core.js":
      "2ee6c409a12b6a4f7b7a7d63c37d84923740e46f8732f625a65d0f39ef04bdf6",
    "guardrail.js":
      "dd649ad57e7711c820f7d67dc25f0ce217bb9d02b317a78dc2b0b156a94b47ff",
    "guardrail-extension.js":
      "2ac082378a8b45314eed2e9a70f41110c1e9e63ab08b30caba7cab6b1a19eef9",
    "guardrail-calibration.js":
      "559a0a696955d5cc58c0143c7b2a33a84ba7ce4cf92c6cfda1b79123de58247f",
    "guardrail-c8-qualification.js":
      "e7dafae77ed553f72a1078b74e4229b6379c841ba383c0be1ed856af7ed08d4b",
    "models.js":
      "d4ec59932608caf84eff0f263b0ef98dccc7ba6f7944caa8204c0bee81858e35",
    "rfdt.js":
      "86181e412d41a49d9274df967deb48c490623a215f0f53d7feee368c48fc8ae5",
  }),
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const outputBase = resolve(root, ".build/guardrail");

function workload(id, command) {
  const operation = { tool: "bash", input: { command } };
  const fixture = { cwd: "/tmp/c9-latency" };
  return {
    id,
    operation,
    fixture,
    operationSha256: candidate8OperationSha256({ operation, fixture }),
    commandBytes: Buffer.byteLength(command),
  };
}

/** Full, original tool requests. The long request is never truncated. */
export function syntheticWorkloads() {
  const fixedLong = workload(
    "fixed_long_cold_probe",
    "printf '%s' '" +
      "Cold path inventory review with no mutation requested. ".repeat(130) +
      "'",
  );
  const short = workload("short", "git status --short");
  const long = workload(
    "long",
    "printf '%s' '" +
      "Reviewed inventory metadata with no mutation requested. ".repeat(130) +
      "'",
  );
  return { fixedLong, short, long };
}

export function nearestRankP95(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export function summarizeWarmSamples(samples) {
  const warm = samples.filter((sample) => sample.scenario !== "cold_probe");
  const sequential = warm.filter((sample) => sample.scenario === "sequential");
  const contended = warm.filter((sample) => sample.scenario === "contended");
  const summarize = (rows) => ({
    calls: rows.length,
    answered: rows.filter((row) => row.status === "answered").length,
    deadlineMisses: rows.filter(
      (row) =>
        row.status !== "answered" || row.fullDirectMs >= WARM_DEADLINE_MS,
    ).length,
    fullDirectP95Ms: nearestRankP95(rows.map((row) => row.fullDirectMs)),
    fullDirectMaxMs: rows.length
      ? Math.max(...rows.map((row) => row.fullDirectMs))
      : null,
    queueP95Ms: nearestRankP95(
      rows.flatMap((row) =>
        row.classifierQueueMs === null ? [] : [row.classifierQueueMs],
      ),
    ),
  });
  return {
    sequential: summarize(sequential),
    contended: summarize(contended),
    allWarm: summarize(warm),
    idealSub500Ms: warm.every(
      (row) => row.status === "answered" && row.fullDirectMs < 500,
    ),
    hard750Ms: warm.every(
      (row) => row.status === "answered" && row.fullDirectMs < 750,
    ),
  };
}

async function verifiedInputs(modelFile, registry, variant) {
  if (!isAbsolute(modelFile) || !isAbsolute(registry))
    throw new Error("Model and registry paths must be absolute");
  const scriptRel = "scripts/guardrail-candidate9-latency.mjs";
  const committedScript = execFileSync("git", ["show", `HEAD:${scriptRel}`], {
    cwd: root,
  });
  if (!(await readFile(scriptPath)).equals(committedScript))
    throw new Error("C9 latency script must be committed before measurement");
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", C9_PINS.c8DeliveryCommit, "HEAD"],
    { cwd: root },
  );
  const c8ReportBytes = await readFile(C8_REPORT);
  if (sha(c8ReportBytes) !== C9_PINS.c8ReportSha256)
    throw new Error("Frozen C8 VALID report bytes changed");
  const c8Report = JSON.parse(c8ReportBytes);
  const c8Prepared = c8Report.records.filter(
    (row) => row.routing === "model_prepared",
  );
  if (
    c8Prepared.length !== 59 ||
    nearestRankP95(c8Prepared.map((row) => row.elapsedMs)) !== 534.085 ||
    c8Report.metrics.hardDeadlineMisses !== 2
  )
    throw new Error("Frozen C8 all-call timing changed");
  for (const [name, expected] of Object.entries(C9_PINS.runtime))
    if (sha(await readFile(resolve(root, "dist", name))) !== expected)
      throw new Error(`Compiled C8 delivery runtime changed: ${name}`);
  const [{ verifyArtifact, hashArtifact }, { canonical }] = await Promise.all([
    import("../dist/models.js"),
    import("../dist/core.js"),
  ]);
  let modelId = C9_PINS.modelId;
  let modelSha256 = C9_PINS.modelSha256;
  let quantization = null;
  if (variant === "q8_0") {
    const raw = await readFile(Q8_MANIFEST);
    const committed = execFileSync(
      "git",
      [
        "show",
        "HEAD:reports/guardrail-risk-2026-09-21/candidate-9-latency-evidence/q8_0-export-manifest.json",
      ],
      { cwd: root },
    );
    if (!raw.equals(committed))
      throw new Error("Quantized export manifest must be committed");
    const manifest = JSON.parse(raw);
    const sourceIdentity = await hashArtifact(
      manifest.sourceWeights?.file ?? "",
    );
    const quantizerRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: manifest.quantizer?.sourceDirectory,
      encoding: "utf8",
    }).trim();
    if (
      manifest.purpose !== "candidate9_same_weights_q8_0_performance_only" ||
      manifest.qualification !== false ||
      manifest.sourceWeights?.sha256 !== C9_PINS.modelSha256 ||
      manifest.sourceWeights?.file !== c8Report.source.model.modelFile ||
      sourceIdentity.sha256 !== C9_PINS.modelSha256 ||
      sourceIdentity.size !== manifest.sourceWeights.size ||
      manifest.quantizer?.type !== "Q8_0" ||
      manifest.quantizer?.sourceDirectory !==
        "/Users/bsonntag/code/simple-jev-ts/.vendor/llama.cpp" ||
      manifest.quantizer?.sourceRevision !==
        "f072b103714dfa1eee531f80b24512faf38e3dd2" ||
      quantizerRevision !== manifest.quantizer.sourceRevision ||
      manifest.quantizer?.leaveOutputTensorUnquantized !== true ||
      manifest.output?.file !== modelFile ||
      !/^[a-f0-9]{64}$/.test(manifest.output?.sha256 ?? "") ||
      !/^jev\/[a-zA-Z0-9._-]+$/.test(manifest.output?.modelId ?? "") ||
      sha(await readFile(registry)) !== manifest.output.registrySha256 ||
      sha(
        await readFile(resolve(root, ".build/quantize/bin/llama-quantize")),
      ) !== manifest.quantizer.binarySha256
    )
      throw new Error(
        "Quantized export provenance differs from committed manifest",
      );
    modelId = manifest.output.modelId;
    modelSha256 = manifest.output.sha256;
    quantization = { manifestSha256: sha(raw), ...manifest };
  }
  const artifact = await verifyArtifact(modelFile, "classifier", modelId, {
    registryPath: registry,
  });
  const nativeBinary = resolve(root, ".build/jev-native");
  const nativeSha256 = (await hashArtifact(nativeBinary)).sha256;
  if (
    artifact.sha256 !== modelSha256 ||
    (quantization !== null && artifact.size !== quantization.output.size) ||
    nativeSha256 !== C9_PINS.nativeBinarySha256
  )
    throw new Error(
      "Model or native scorer differs from the C8 frozen identity",
    );
  return {
    artifact,
    modelId,
    modelSha256,
    quantization,
    nativeBinary,
    canonical,
    c8Report,
    evaluatorHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  };
}

function nativeCounters(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  const names = [
    "prefill_strategy",
    "prefix_tokens",
    "suffix_batch_sizes",
    "engine_forwards",
    "branch_prompt_tokens",
    "computed_prompt_tokens",
    "logical_prefill_tokens",
    "padded_suffix_tokens",
    "branch_output_tokens",
    "scored_positions",
  ];
  return Object.fromEntries(names.map((name) => [name, metrics[name] ?? null]));
}

async function main() {
  const { values } = parseArgs({
    options: {
      "model-file": { type: "string" },
      registry: { type: "string" },
      output: { type: "string" },
      variant: { type: "string" },
    },
  });
  if (!values["model-file"] || !values.registry || !values.output)
    throw new Error(
      "Required: --model-file PATH --registry PATH --output PATH",
    );
  const variant = values.variant ?? "f16";
  if (!["f16", "q8_0"].includes(variant))
    throw new Error("C9 latency variant must be f16 or q8_0");
  const output = resolve(values.output);
  if (
    !output.startsWith(`${outputBase}/`) ||
    !/^candidate-9-latency-.*\.json$/.test(output.split("/").at(-1))
  )
    throw new Error(
      "Output must be a new .build/guardrail/candidate-9-latency-*.json file",
    );
  const inputs = await verifiedInputs(
    values["model-file"],
    values.registry,
    variant,
  );
  const [
    { NativeBackend, Classifier },
    { guardrailConfig },
    { guardrailRequest },
  ] = await Promise.all([
    import("../dist/backend.js"),
    import("../dist/guardrail-extension.js"),
    import("../dist/guardrail.js"),
  ]);
  const config = guardrailConfig({
    JEV_DEVICE: "metal",
    JEV_GUARDRAIL_MODEL_ID: inputs.modelId,
    JEV_GUARDRAIL_MODEL_FILE: values["model-file"],
    JEV_GUARDRAIL_ARTIFACT_REGISTRY: values.registry,
  });
  if (
    config.queueTimeoutMs !== WARM_DEADLINE_MS ||
    config.requestTimeoutMs !== WARM_DEADLINE_MS ||
    config.binary !== inputs.nativeBinary
  )
    throw new Error("C9 probe changed the guardrail warm deadline or scorer");
  // This only exposes existing classifier/native counters in this diagnostic
  // process; it does not change the model's prompt, logits or cutoff.
  config.advanced = true;
  const context = new AsyncLocalStorage();
  class TimedNativeBackend extends NativeBackend {
    async compile(plan, signal) {
      const sample = context.getStore();
      const start = performance.now();
      try {
        const compiled = await super.compile(plan, signal);
        if (sample) {
          sample.nativeCompileMs = performance.now() - start;
          sample.compiledBranchCount = compiled.length;
          sample.compiledPromptTokens = compiled.reduce(
            (sum, branch) => sum + branch.tokens.length,
            0,
          );
        }
        return compiled;
      } catch (error) {
        if (sample) sample.nativeCompileMs = performance.now() - start;
        throw error;
      }
    }
    async evaluate(compiled, signal, full) {
      const sample = context.getStore();
      const start = performance.now();
      try {
        const result = await super.evaluate(compiled, signal, full);
        if (sample) {
          sample.nativeEvaluateMs = performance.now() - start;
          sample.nativeCounters = nativeCounters(result.metrics);
          sample.nativeInputTokens = result.input_tokens;
        }
        return result;
      } catch (error) {
        if (sample) sample.nativeEvaluateMs = performance.now() - start;
        throw error;
      }
    }
  }
  const backend = new TimedNativeBackend(config);
  const classifier = new Classifier(config, backend);
  const workloads = syntheticWorkloads();
  const samples = [];
  async function measure(workload, scenario, iteration, deadlineMs) {
    const sample = {
      id: `${workload.id}-${scenario}-${iteration}`,
      scenario,
      operationSha256: workload.operationSha256,
      commandBytes: workload.commandBytes,
      deadlineMs,
      status: "pending",
      classifierQueueMs: null,
      classifierBackendMs: null,
      classifierTotalMs: null,
      nativeCompileMs: null,
      nativeEvaluateMs: null,
      compiledBranchCount: null,
      compiledPromptTokens: null,
      nativeCounters: null,
      nativeInputTokens: null,
      responseInputTokens: null,
    };
    const start = performance.now();
    try {
      const input = {
        version: 2,
        toolName: workload.operation.tool,
        input: workload.operation.input,
        facts: {},
      };
      const request = guardrailRequest(input, inputs.modelId);
      sample.requestStateSha256 = sha(inputs.canonical(request.state));
      sample.requestPreparationMs = performance.now() - start;
      const response = await context.run(sample, () =>
        classifier.classify(request, AbortSignal.timeout(deadlineMs)),
      );
      sample.status = "answered";
      sample.responseInputTokens = response.usage.input_tokens;
      sample.allowScore = response.answers.risk.probabilities.allow;
      sample.classifierQueueMs =
        typeof response.metrics?.queue_seconds === "number"
          ? response.metrics.queue_seconds * 1_000
          : null;
      sample.classifierBackendMs =
        typeof response.metrics?.backend_seconds === "number"
          ? response.metrics.backend_seconds * 1_000
          : null;
      sample.classifierTotalMs =
        typeof response.metrics?.total_seconds === "number"
          ? response.metrics.total_seconds * 1_000
          : null;
    } catch (error) {
      sample.status = "failed";
      sample.errorName = error instanceof Error ? error.name : "Unknown";
      sample.error = error instanceof Error ? error.message : String(error);
    } finally {
      sample.fullDirectMs = performance.now() - start;
      samples.push(sample);
    }
    return sample;
  }
  const coldStart = performance.now();
  let coldInitializationMs;
  let coldProbe;
  try {
    await backend.warmup();
    coldInitializationMs = performance.now() - coldStart;
    // A fixed long-input inference is startup work, not a live risk check.
    // The distinct 2.5s startup cap cannot weaken the 750ms warm deadline.
    config.queueTimeoutMs = COLD_PROBE_DEADLINE_MS;
    config.requestTimeoutMs = COLD_PROBE_DEADLINE_MS;
    try {
      coldProbe = await measure(
        workloads.fixedLong,
        "cold_probe",
        1,
        COLD_PROBE_DEADLINE_MS,
      );
    } finally {
      config.queueTimeoutMs = WARM_DEADLINE_MS;
      config.requestTimeoutMs = WARM_DEADLINE_MS;
    }
    for (let iteration = 1; iteration <= 3; iteration++) {
      await measure(workloads.short, "sequential", iteration, WARM_DEADLINE_MS);
      await measure(workloads.long, "sequential", iteration, WARM_DEADLINE_MS);
    }
    await Promise.all([
      measure(workloads.long, "contended", 1, WARM_DEADLINE_MS),
      measure(workloads.short, "contended", 1, WARM_DEADLINE_MS),
    ]);
    await Promise.all([
      measure(workloads.short, "contended", 2, WARM_DEADLINE_MS),
      measure(workloads.long, "contended", 2, WARM_DEADLINE_MS),
    ]);
  } finally {
    await classifier.dispose();
  }
  const report = {
    version: 1,
    purpose: "candidate9_latency_diagnostic_only",
    variant,
    qualification: false,
    heldOutTestUsed: false,
    externalOperationsExecuted: 0,
    source: {
      evaluatorHead: inputs.evaluatorHead,
      c8DeliveryCommit: C9_PINS.c8DeliveryCommit,
      c8ValidReportSha256: C9_PINS.c8ReportSha256,
      modelSha256: inputs.modelSha256,
      sourceF16WeightsSha256: C9_PINS.modelSha256,
      quantization: inputs.quantization,
      nativeBinarySha256: C9_PINS.nativeBinarySha256,
      compiledRuntimeSha256: C9_PINS.runtime,
    },
    protocol: {
      workload: "full_original_guardrail_request_selected_next_token_logits",
      device: "metal",
      modelId: inputs.modelId,
      warmDeadlineMs: WARM_DEADLINE_MS,
      coldProbeDeadlineMs: COLD_PROBE_DEADLINE_MS,
      advancedMetricsDiagnosticOnly: true,
      nativePrefixReuse: "within_request_branches_only",
      generatedOutputTokens: 0,
      decodeTiming: "not_applicable_selected_logit_scoring",
    },
    cold: {
      initializationMs: coldInitializationMs,
      fixedLongProbe: coldProbe,
      totalStartupMs: coldInitializationMs + coldProbe.fullDirectMs,
    },
    workloads: Object.fromEntries(
      [workloads.short, workloads.long].map((workload) => [
        workload.id,
        {
          operationSha256: workload.operationSha256,
          commandBytes: workload.commandBytes,
        },
      ]),
    ),
    summary: summarizeWarmSamples(samples),
    historicalC8Valid: {
      preparedChecks: 59,
      fullHostP95Ms: inputs.c8Report.metrics.warmP95Ms,
      fullHostMaxMs: inputs.c8Report.metrics.warmMaxMs,
      deadlineMisses: inputs.c8Report.metrics.hardDeadlineMisses,
      note: "Frozen C8 VALID evidence is retained and not rescored here.",
    },
    samples,
    limits: [
      "Synthetic direct-classifier timing excludes sf-pi policy/baseline and request-fact preparation; frozen C8 full-host timing remains authoritative.",
      "Backend evaluate RPC includes native prompt prefill and selected-logit scoring; no separate generated-token decode phase exists.",
      "The native worker clears KV state and retokenizes each request; shared-prefix reuse occurs only among answer branches within one request.",
      "Evaluator-only advanced metrics and timing wrappers add overhead; this diagnostic is not a qualification or effectiveness score.",
    ],
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ output, cold: report.cold, summary: report.summary }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
