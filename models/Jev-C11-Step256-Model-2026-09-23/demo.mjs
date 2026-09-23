#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(new URL("./", import.meta.url));
const modelId = "jev/c11-step-256";
const modelSha256 = "8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053";
const protocolSha256 = "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530";
const suppliedNativeSha256 = "7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96";
const allowCutoff = 0.955913273071778;
const slowDeadlineMs = 120_000;

function help() {
  console.log(`Jev C11 step 256: local advisory guardrail scoring

Usage:
  node demo.mjs --check
  node demo.mjs [--input operation.json] [--device cpu|metal|auto]
  node demo.mjs --slow --device cpu
  node demo.mjs --binary path/to/jev-native [--check]

Defaults: sample-operation.json, device auto, runtime/.build/jev-native.
JEV_DEMO_NATIVE_BINARY also selects an alternate native binary.
--check validates the model checksum, registry, modules and input protocol.
It does not start the native process, load the model or perform inference.
--slow is exploratory scoring with a 120-second deadline; it is not a
guardrail qualification or a measurement under the 750 ms guardrail deadline.
Scoring treats the operation as data. It never executes the described tool.
`);
}

function options(args) {
  const value = { check: false, slow: false, device: "auto", input: join(bundleRoot, "sample-operation.json"), binary: process.env.JEV_DEMO_NATIVE_BINARY };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help();
      return null;
    }
    if (arg === "--check" || arg === "--slow") {
      value[arg.slice(2)] = true;
      continue;
    }
    if (!["--device", "--input", "--binary"].includes(arg)) throw new Error(`Unknown option: ${arg}. Use --help.`);
    const next = args[++i];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value.`);
    value[arg.slice(2)] = next;
  }
  if (!["cpu", "metal", "auto"].includes(value.device)) throw new Error("--device must be cpu, metal or auto.");
  value.input = resolve(value.input);
  value.binary = value.binary ? resolve(value.binary) : join(bundleRoot, "runtime", ".build", "jev-native");
  return value;
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js 22.19 or later is required.");
}

function portableArtifact(registry) {
  if (registry?.version !== 1 || !Array.isArray(registry.artifacts) || registry.artifacts.length !== 1) {
    throw new Error("portable-registry.json must contain version 1 and exactly one artifact.");
  }
  const artifact = registry.artifacts[0];
  if (artifact?.id !== modelId || artifact.sha256 !== modelSha256 || artifact.file !== "model.gguf" || isAbsolute(artifact.file)) {
    throw new Error("Portable registry must identify the pinned C11 step-256 model with relative file model.gguf.");
  }
  if (artifact.template_version !== "v2") throw new Error("The C11 demo requires classifier template v2.");
  return { ...artifact, file: join(bundleRoot, artifact.file) };
}

async function scoreSlow(classifier, request, canonical) {
  const start = performance.now();
  // Keep the exact exported request/template/logit scoring. Only this explicitly
  // exploratory call uses a longer deadline; project guardrail limits stay put.
  const response = await classifier.classify(request, AbortSignal.timeout(slowDeadlineMs));
  const answer = response.answers?.risk;
  if (response.model !== modelId || answer?.type !== "choice" || !["allow", "confirm"].includes(answer.choice)
    || Object.keys(answer.probabilities ?? {}).sort().join(",") !== "allow,confirm"
    || !Number.isFinite(answer.probabilities.allow) || !Number.isFinite(answer.probabilities.confirm)
    || answer.probabilities.allow < 0 || answer.probabilities.confirm < 0
    || Math.abs(answer.probabilities.allow + answer.probabilities.confirm - 1) > 1e-6
    || !Number.isSafeInteger(response.usage?.input_tokens) || response.usage.input_tokens < 1 || response.usage.output_tokens !== 0) {
    throw new Error("Invalid exploratory guardrail classifier response.");
  }
  const allowScore = answer.probabilities.allow;
  const action = answer.choice === "confirm" ? "confirm" : allowScore >= allowCutoff ? "allow" : "abstain";
  return {
    action,
    reason: action === "confirm" ? "risk_detected" : action === "allow" ? "safe_classification" : "low_allow_score",
    allowScore,
    elapsedMs: performance.now() - start,
    inputSha256: createHash("sha256").update(canonical(request.state)).digest("hex"),
    inputTokens: response.usage.input_tokens,
    calibration: "uncalibrated",
  };
}

async function main() {
  const selected = options(process.argv.slice(2));
  if (!selected) return;
  checkNodeVersion();

  // These modules use Node built-ins only; importing them starts no model.
  const [{ Classifier, NativeBackend, configFromEnv }, { classifyGuardrailRisk, guardrailRequest, GUARDRAIL_PROTOCOL_SHA256, GUARDRAIL_LIMITS }, { canonical, preparePrompt }] = await Promise.all([
    import("./runtime/dist/backend.js"),
    import("./runtime/dist/guardrail.js"),
    import("./runtime/dist/core.js"),
  ]);
  if (GUARDRAIL_PROTOCOL_SHA256 !== protocolSha256 || GUARDRAIL_LIMITS.deadlineMs !== 750) {
    throw new Error("Bundled guardrail protocol does not match the pinned C11 protocol.");
  }
  const artifact = portableArtifact(JSON.parse(await readFile(join(bundleRoot, "portable-registry.json"), "utf8")));
  const operation = JSON.parse(await readFile(selected.input, "utf8"));
  const request = guardrailRequest(operation, modelId);
  const plan = preparePrompt(request, "v2");
  if (plan.template_version !== "v2" || plan.questions.length !== 1 || plan.questions[0].answer_labels.join(",") !== "allow,confirm") {
    throw new Error("Unexpected guardrail scoring plan.");
  }
  const nativeInfo = await stat(selected.binary);
  if (!nativeInfo.isFile()) throw new Error("Native binary must be a regular file.");
  await access(selected.binary, constants.X_OK);
  const nativeSha256 = createHash("sha256").update(await readFile(selected.binary)).digest("hex");
  const suppliedBinary = nativeSha256 === suppliedNativeSha256;
  const binaryTarget = suppliedBinary ? "Supplied binary: macOS 26.0 or later, Apple silicon (arm64)." : "Rebuilt or caller-selected binary; target compatibility has not been checked.";

  // models.js requires an absolute artifact.file. Resolve it now, rather than
  // saving the sender's machine paths in the portable registry.
  const registryDirectory = await mkdtemp(join(tmpdir(), "jev-c11-demo-registry-"));
  let backend;
  let classifier;
  try {
    const runtimeRegistry = join(registryDirectory, "artifacts.json");
    await writeFile(runtimeRegistry, JSON.stringify({ version: 1, artifacts: [artifact] }), { mode: 0o600 });
    const config = {
      ...configFromEnv({}),
      modelId,
      modelFile: artifact.file,
      artifactRegistryPath: runtimeRegistry,
      binary: selected.binary,
      device: selected.device,
      templateVersion: "v2",
      maxModelLen: 4096,
      maxBatchSize: 1,
      maxBatchTokens: 4096,
      maxRequestBranches: 1,
      advanced: false,
    };
    backend = new NativeBackend(config);
    // doctor verifies bytes/registry and paths. It does not call warmup.
    const checked = await backend.doctor();
    if (selected.check) {
      console.log(JSON.stringify({
        check: "passed",
        model: modelId,
        modelSha256: checked.artifact.sha256,
        modelBytes: checked.artifact.size,
        registry: "Relative model path resolved and artifact identity verified; temporary runtime registry removed on exit.",
        protocolSha256,
        templateVersion: plan.template_version,
        operationInput: "Validated with the exact guardrailRequest and preparePrompt functions.",
        allowCutoff,
        guardrailDeadlineMs: GUARDRAIL_LIMITS.deadlineMs,
        slowExploratoryRequested: selected.slow,
        selectedDevice: selected.device,
        nativeBinary: "Present and executable; not started.",
        nativeSha256,
        suppliedBinary,
        binaryTarget,
        host: { platform: process.platform, architecture: process.arch, node: process.versions.node },
        inferencePerformed: false,
        describedOperationExecuted: false,
      }, null, 2));
      return;
    }
    if (suppliedBinary && (process.platform !== "darwin" || process.arch !== "arm64")) {
      throw new Error("The supplied native binary requires Apple-silicon macOS 26+. Rebuild runtime/scripts/build-native.sh for this host, or select --binary / JEV_DEMO_NATIVE_BINARY.");
    }
    console.error(`Loading ${modelId} on ${selected.device}. ${binaryTarget}`);
    console.error("Advisory scoring only. The operation in the JSON file will not be executed.");
    if (selected.slow) console.error("Exploratory --slow mode: 120-second scoring deadline. This is not guardrail qualification timing.");
    // Model loading has its own initialization deadline. Keep it outside the
    // exact helper's existing 750 ms risk-check deadline; do not alter scoring.
    await backend.warmup();
    classifier = new Classifier(config, backend);
    const prediction = selected.slow
      ? await scoreSlow(classifier, request, canonical)
      : await classifyGuardrailRisk(classifier, operation, modelId, undefined, allowCutoff);
    console.log(JSON.stringify({
      model: modelId,
      modelSha256,
      protocolSha256,
      templateVersion: "v2",
      allowCutoff,
      guardrailDeadlineMs: GUARDRAIL_LIMITS.deadlineMs,
      scoringDeadlineMs: selected.slow ? slowDeadlineMs : GUARDRAIL_LIMITS.deadlineMs,
      slowExploratory: selected.slow,
      qualificationTiming: false,
      qualified: false,
      advisoryOnly: true,
      describedOperationExecuted: false,
      ...prediction,
    }, null, 2));
  } finally {
    try {
      if (classifier) await classifier.dispose();
      else if (backend) await backend.dispose();
    } finally {
      await rm(registryDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`Demo failed: ${error?.message ?? String(error)}`);
  console.error("No described operation was executed. A timeout or error is not an allow decision.");
  process.exitCode = 1;
});
