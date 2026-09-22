#!/usr/bin/env node
/** Compile C8 VALID prompts with a pinned Gemma tokenizer; never infer. */
import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCandidate8HostRows } from "./guardrail-candidate8-host-core.mjs";
import {
  C8_VALID_SEAL,
  readCandidate8SealedSources,
  verifyCandidate8ValidPopulation,
} from "./guardrail-candidate8-valid-eval.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reference = Object.freeze({
  baseModel: "google/gemma-3-1b-it",
  modelId: "jev/gemma-3-1b-guardrail-c7-256-v1",
  modelSha256:
    "9d1bffc4ed982dea529841d20ac4a56cd0f5086107f2aa6da0c1ea17ae148006",
  nativeBinarySha256:
    "7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96",
  maxPromptTokens: 2048,
  maxInputBytes: 32 * 1024,
});

const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    "reference-model-file": { type: "string" },
    "reference-registry": { type: "string" },
    output: { type: "string" },
  },
});
if (
  !values["sf-pi"] ||
  !values["sf-deps"] ||
  !values["reference-model-file"] ||
  !values["reference-registry"] ||
  !values.output
)
  throw new Error(
    "Required: --sf-pi --sf-deps --reference-model-file --reference-registry --output",
  );
const sfPi = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const modelFile = resolve(values["reference-model-file"]);
const registryFile = resolve(values["reference-registry"]);
const output = resolve(values.output);
const sources = await readCandidate8SealedSources();
const population = JSON.parse(sources.bytes.valid);
const preflight = JSON.parse(sources.bytes.preflight);
const preflightById = verifyCandidate8ValidPopulation(population, preflight);
const [
  { GUARDRAIL_PROTOCOL_SHA256, guardrailRequest, validateGuardrailInput },
  { canonical, preparePrompt },
  { configFromEnv, NativeBackend },
  { verifyArtifact, hashArtifact },
] = await Promise.all([
  import(pathToFileURL(resolve(dist, "guardrail.js")).href),
  import(pathToFileURL(resolve(dist, "core.js")).href),
  import(pathToFileURL(resolve(dist, "backend.js")).href),
  import(pathToFileURL(resolve(dist, "models.js")).href),
]);
if (GUARDRAIL_PROTOCOL_SHA256 !== C8_VALID_SEAL.protocolSha256)
  throw new Error("C8 prompt protocol differs from VALID preflight");
const artifact = await verifyArtifact(
  modelFile,
  "classifier",
  reference.modelId,
  { registryPath: registryFile },
);
if (
  artifact.sha256 !== reference.modelSha256 ||
  artifact.base_model !== reference.baseModel ||
  artifact.template_version !== "v2"
)
  throw new Error("Reference Gemma tokenizer/model identity changed");
const config = configFromEnv({
  JEV_DEVICE: "cpu",
  JEV_MODEL_ID: reference.modelId,
  JEV_MODEL_FILE: modelFile,
  JEV_TEMPLATE_VERSION: "v2",
});
config.artifactRegistryPath = registryFile;
config.maxModelLen = reference.maxPromptTokens;
config.maxBatchTokens = reference.maxPromptTokens;
const binaryIdentity = await hashArtifact(config.binary);
if (binaryIdentity.sha256 !== reference.nativeBinarySha256)
  throw new Error("Pinned native compiler binary changed");
const backend = new NativeBackend(config);
const aggregate = {
  prepared: 0,
  compiled: 0,
  over2048: 0,
  over32768InputBytes: 0,
  compileErrors: 0,
  maxCompiledTokens: 0,
  maxInputBytes: 0,
};
try {
  // Backend compilation uses the retained Gemma tokenizer and chat template.
  // No candidate weights are loaded, no logits are selected, and no native
  // evaluate/classify call is made.
  await backend.warmup();
  const result = await runCandidate8HostRows({
    rows: population.cases,
    preflightById,
    sfPi,
    sfDeps,
    stubFile: resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
    hostCommit: C8_VALID_SEAL.sfPiCommit,
    hostRuntimeSha256: C8_VALID_SEAL.hostRuntimeSha256,
    protocolSha256: C8_VALID_SEAL.protocolSha256,
    expectedModelSha256: "f".repeat(64),
    validateInput: validateGuardrailInput,
    createProvider: async (pi, event) => {
      pi.events.on(event, (request) =>
        request.providers.push({
          version: 1,
          id: "jev",
          protocolSha256: C8_VALID_SEAL.protocolSha256,
          modelSha256: "f".repeat(64),
          qualified: false,
          async evaluate(input) {
            return {
              action: "confirm",
              reason: "risk_detected",
              allowScore: 0.01,
              elapsedMs: 0,
              inputSha256: sha(canonical(input)),
              inputTokens: 1,
              calibration: "uncalibrated",
            };
          },
        }),
      );
      return {
        status: () => ({
          protocolSha256: C8_VALID_SEAL.protocolSha256,
          modelSha256: "f".repeat(64),
        }),
        async dispose() {},
      };
    },
    onPreparedCall: async ({ input }) => {
      aggregate.prepared++;
      const inputBytes = Buffer.byteLength(canonical(input));
      aggregate.maxInputBytes = Math.max(aggregate.maxInputBytes, inputBytes);
      if (inputBytes > reference.maxInputBytes) {
        aggregate.over32768InputBytes++;
        return;
      }
      try {
        const plan = preparePrompt(
          guardrailRequest(input, reference.modelId),
          "v2",
        );
        const branches = await backend.compile(plan);
        if (
          !Array.isArray(branches) ||
          branches.length !== 1 ||
          !Array.isArray(branches[0]?.tokens)
        )
          throw new Error("Native compiler returned malformed C8 prompt");
        const tokens = branches[0].tokens.length;
        aggregate.maxCompiledTokens = Math.max(
          aggregate.maxCompiledTokens,
          tokens,
        );
        if (tokens > reference.maxPromptTokens) aggregate.over2048++;
        else aggregate.compiled++;
      } catch (error) {
        if (/Branch exceeds context limit/.test(String(error?.message)))
          aggregate.over2048++;
        else aggregate.compileErrors++;
      }
    },
  });
  if (
    result.providerCalls !== C8_VALID_SEAL.modelPrepared ||
    aggregate.prepared !== C8_VALID_SEAL.modelPrepared
  )
    throw new Error(
      "Native compile preflight did not cover every prepared C8 request",
    );
  if (
    (await hashArtifact(modelFile)).sha256 !== reference.modelSha256 ||
    (await hashArtifact(config.binary)).sha256 !== reference.nativeBinarySha256
  )
    throw new Error(
      "Reference model or native compiler changed during preflight",
    );
  const after = await readCandidate8SealedSources();
  if (JSON.stringify(after.hashes) !== JSON.stringify(sources.hashes))
    throw new Error("C8 VALID source changed during compile preflight");
  const report = {
    version: 1,
    purpose: "candidate8_valid_native_compile_only_preflight",
    validationOnly: true,
    candidateModelScored: false,
    nativeInferenceCalls: 0,
    externalOperationsExecuted: 0,
    sourceSha256: C8_VALID_SEAL.sourceSha256,
    preflightSha256: C8_VALID_SEAL.preflightSha256,
    sfPiCommit: C8_VALID_SEAL.sfPiCommit,
    hostRuntimeSha256: C8_VALID_SEAL.hostRuntimeSha256,
    protocolSha256: C8_VALID_SEAL.protocolSha256,
    referenceModelSha256: reference.modelSha256,
    nativeCompilerSha256: reference.nativeBinarySha256,
    aggregate,
    readyForScoring:
      aggregate.prepared === C8_VALID_SEAL.modelPrepared &&
      aggregate.over2048 === 0 &&
      aggregate.over32768InputBytes === 0 &&
      aggregate.compileErrors === 0,
    proofLimits: [
      "Compilation uses retained C7 Gemma tokenizer and chat template only; it is not a C8 effectiveness score.",
      "No candidate or held-out split was scored.",
      "This checks prompt size and shape, not latency or model judgment.",
    ],
  };
  const outputEntry = await lstat(dirname(output));
  if (!outputEntry.isDirectory())
    throw new Error("C8 compile output parent unavailable");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      output,
      aggregate,
      readyForScoring: report.readyForScoring,
    }),
  );
  if (!report.readyForScoring) process.exitCode = 1;
} finally {
  await backend.dispose();
}
