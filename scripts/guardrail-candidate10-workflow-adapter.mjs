/** Only for an isolated Pi SDK fixture; deliberately never declares qualification. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export function registerExtension(pi, _config, _backend, options) {
  const input = JSON.parse(
    readFileSync(process.env.JEV_C10_WORKFLOW_MANIFEST, "utf8"),
  );
  const env = options.guardrailRisk.env;
  let classifier, native, generation;
  const provider = {
    version: 2,
    id: "jev",
    qualified: false,
    modelSha256: input.modelSha256,
    protocolSha256: input.protocolSha256,
    calibrationSha256: input.calibrationSha256,
    minimumAllowScore: input.minimumAllowScore,
    calibrationPolicySha256: env.JEV_C10_FIXTURE_POLICY_SHA256,
    calibrationBaselineSha256: input.baselineSha256,
    async evaluate(request, signal) {
      if (
        !native?.status.ready ||
        native.status.generation !== generation ||
        native.status.artifact?.sha256 !== input.modelSha256
      )
        throw new Error("C10 workflow native identity unavailable or changed");
      const guardrail = await import(pathToFileURL(input.guardrail.path));
      const result = await guardrail.classifyGuardrailRisk(
        classifier,
        request,
        input.modelId,
        signal,
        input.minimumAllowScore,
      );
      if (
        native.status.generation !== generation ||
        native.status.artifact?.sha256 !== input.modelSha256
      )
        throw new Error("C10 workflow native identity changed during scoring");
      return result;
    },
  };
  const runtime = {
    provider,
    async warmup() {
      if (env.SF_GUARDRAIL_JEV_MODE === "off") return;
      const backend = await import(pathToFileURL(input.backend.path));
      const config = backend.configFromEnv({
        JEV_DEVICE: env.JEV_DEVICE,
        JEV_MODEL_ID: input.modelId,
        JEV_MODEL_FILE: input.model.path,
        JEV_TEMPLATE_VERSION: "v2",
      });
      Object.assign(config, {
        maxModelLen: 2048,
        maxBatchSize: 32,
        maxBatchTokens: 2048,
        artifactRegistryPath: input.registry.path,
        binary: input.binary.path,
        queueTimeoutMs: 750,
        requestTimeoutMs: 750,
      });
      native = new backend.NativeBackend(config);
      classifier = new backend.Classifier(config, native);
      await native.warmup();
      generation = native.status.generation;
      if (
        !native.status.ready ||
        native.status.artifact?.sha256 !== input.modelSha256
      )
        throw new Error("C10 workflow loaded wrong model");
    },
    status: () => ({
      qualified: false,
      modelSha256: input.modelSha256,
      protocolSha256: input.protocolSha256,
      calibrationSha256: input.calibrationSha256,
      minimumAllowScore: input.minimumAllowScore,
      generation,
      fixturePolicySha256: provider.calibrationPolicySha256,
    }),
    dispose: async () => {
      await classifier?.dispose();
    },
  };
  pi.events.on("sf-guardrail:risk-providers", (request) =>
    request.providers.push(provider),
  );
  pi.on("session_start", () => runtime.warmup());
  pi.on("session_shutdown", () => runtime.dispose());
  return { guardrailRisk: runtime };
}
