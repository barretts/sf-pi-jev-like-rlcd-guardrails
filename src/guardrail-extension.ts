import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
  Classifier,
  NativeBackend,
  configFromEnv,
  type Config,
  type InferenceAdapter,
} from "./backend.js";
import {
  CURRENT_ARTIFACT_REGISTRY,
  verifyArtifact,
  hashArtifact,
} from "./models.js";
import {
  C11,
  C11_SCORING_PROTOCOL_SHA256,
  readC11Selection,
  type C11SelectionPaths,
} from "./guardrail-selection.js";
import {
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROVIDER_EVENT,
  classifyGuardrailRisk,
  validateGuardrailInput,
  type GuardrailRiskProvider,
} from "./guardrail.js";

export function guardrailConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bundle = resolve(
    env.JEV_GUARDRAIL_BUNDLE ??
      join(homedir(), "Desktop", "Jev-C11-Step256-Model-2026-09-23"),
  );
  const config = configFromEnv({
    JEV_DEVICE: env.JEV_DEVICE,
    JEV_TEMPLATE_VERSION: "v2",
    JEV_MODEL_ID: C11.modelId,
    JEV_MODEL_FILE: env.JEV_GUARDRAIL_MODEL_FILE ?? join(bundle, "model.gguf"),
  });
  return {
    ...config,
    artifactRegistryPath:
      env.JEV_GUARDRAIL_ARTIFACT_REGISTRY ?? CURRENT_ARTIFACT_REGISTRY,
    binary: join(bundle, "runtime", ".build", "jev-native"),
    maxModelLen: 2048,
    maxBatchSize: 32,
    maxBatchTokens: 2048,
    maxRequestBranches: 1,
    advanced: false,
    queueTimeoutMs: GUARDRAIL_LIMITS.deadlineMs,
    requestTimeoutMs: GUARDRAIL_LIMITS.deadlineMs,
  };
}

export interface GuardrailExtensionOptions {
  env?: NodeJS.ProcessEnv;
  enabled?: () => boolean;
  createBackend?: (config: Config) => InferenceAdapter;
  selectionPaths?: C11SelectionPaths;
}

export function registerGuardrailProvider(
  pi: ExtensionAPI,
  options: GuardrailExtensionOptions = {},
) {
  const config = guardrailConfig(options.env ?? process.env);
  interface Runtime {
    controller: AbortController;
    backend?: InferenceAdapter;
    classifier?: Classifier;
    warming?: Promise<void>;
    modelSha256: string | null;
    backendGeneration: number | null;
    ready: boolean;
  }
  let current: Runtime | undefined;
  let retirement: Promise<void> = Promise.resolve();
  let stopped = false;
  let lastError: string | undefined;
  const enabled = () => !stopped && (options.enabled?.() ?? true);
  const assertCurrent = (runtime: Runtime) => {
    runtime.controller.signal.throwIfAborted();
    if (!enabled() || current !== runtime)
      throw new Error("Jev guardrail provider is disabled");
  };
  const nativeReady = (runtime: Runtime) =>
    !(runtime.backend instanceof NativeBackend) ||
    (runtime.backend.isReady &&
      runtime.backend.status.generation === runtime.backendGeneration &&
      runtime.backend.status.artifact?.sha256 === runtime.modelSha256);

  const warmup = async () => {
    if (!enabled()) throw new Error("Jev guardrail provider is disabled");
    current ??= {
      controller: new AbortController(),
      modelSha256: null,
      backendGeneration: null,
      ready: false,
    };
    const runtime = current;
    if (runtime.warming) return runtime.warming;
    if (runtime.ready && nativeReady(runtime)) return;
    runtime.ready = false;
    runtime.modelSha256 = null;
    runtime.warming = (async () => {
      await waitFor(retirement, runtime.controller.signal);
      assertCurrent(runtime);
      await readC11Selection(options.selectionPaths, runtime.controller.signal);
      assertCurrent(runtime);
      const artifact = await verifyArtifact(
        config.modelFile!,
        "classifier",
        C11.modelId,
        {
          registryPath: config.artifactRegistryPath,
          signal: runtime.controller.signal,
        },
      );
      assertCurrent(runtime);
      if (
        artifact.id !== C11.modelId ||
        artifact.sha256 !== C11.modelSha256 ||
        artifact.size !== C11.modelBytes ||
        artifact.base_model !== C11.baseModel ||
        artifact.revision !== C11.baseRevision ||
        artifact.template_version !== "v2" ||
        artifact.training_run !== C11.trainingRun
      )
        throw new Error(
          "The selected artifact is not the pinned C11 step-256 model",
        );
      const binary = await hashArtifact(
        config.binary,
        runtime.controller.signal,
      );
      assertCurrent(runtime);
      if (binary.sha256 !== C11.nativeBinarySha256)
        throw new Error(
          "The native binary does not match the saved C11 scorer",
        );
      runtime.backend ??=
        options.createBackend?.(config) ?? new NativeBackend(config);
      runtime.classifier ??= new Classifier(config, runtime.backend);
      await waitFor(runtime.backend.warmup(), runtime.controller.signal);
      assertCurrent(runtime);
      const generation =
        runtime.backend instanceof NativeBackend
          ? runtime.backend.status.generation
          : null;
      const binaryAfter = await hashArtifact(
        config.binary,
        runtime.controller.signal,
      );
      assertCurrent(runtime);
      if (
        binaryAfter.sha256 !== binary.sha256 ||
        binaryAfter.size !== binary.size
      )
        throw new Error("The C11 native binary changed during warmup");
      runtime.backendGeneration = generation;
      runtime.modelSha256 = artifact.sha256;
      if (!nativeReady(runtime))
        throw new Error("The C11 worker changed during warmup");
      runtime.ready = true;
      lastError = undefined;
    })()
      .catch((error) => {
        if (current === runtime) {
          lastError = failureMessage(error, "Guardrail initialization failed");
          // Disposal starts now; a replacement waits for the old worker to exit.
          void reset();
        }
        throw error;
      })
      .finally(() => {
        if (current === runtime) runtime.warming = undefined;
      });
    return runtime.warming;
  };

  const provider: GuardrailRiskProvider = {
    version: 2,
    id: "jev",
    protocolSha256: C11_SCORING_PROTOCOL_SHA256,
    get modelSha256() {
      return enabled() && current?.ready && nativeReady(current)
        ? current.modelSha256
        : null;
    },
    // C11 failed safety qualification. Saved metadata can never enable enforcement.
    get qualified() {
      return false;
    },
    minimumAllowScore: C11.minimumAllowScore,
    calibrationSha256: C11.calibrationSha256,
    calibrationPolicySha256: C11.policySha256,
    calibrationBaselineSha256: C11.hostBaselineSha256,
    async evaluate(input, signal) {
      const start = performance.now();
      const entryRuntime = current;
      const entryGeneration = entryRuntime?.backendGeneration;
      const deadline = AbortSignal.timeout(GUARDRAIL_LIMITS.deadlineMs);
      const callerSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      callerSignal.throwIfAborted();
      if (!enabled()) throw new Error("Jev guardrail provider is disabled");
      const safe = validateGuardrailInput(input);
      checkDeadline(start, callerSignal);
      // A caller can stop waiting while shared cold loading finishes separately.
      const initialization = warmup();
      const runtime = current;
      if (!runtime) {
        await initialization;
        throw new Error("Jev guardrail provider is disabled");
      }
      const executionSignal = AbortSignal.any([
        callerSignal,
        runtime.controller.signal,
      ]);
      await waitFor(initialization, executionSignal);
      assertCurrent(runtime);
      if (
        runtime.backend instanceof NativeBackend &&
        entryRuntime === runtime &&
        entryGeneration !== null &&
        entryGeneration !== undefined &&
        entryGeneration !== runtime.backendGeneration
      ) {
        lastError =
          "C11 worker generation changed; explicitly warm the provider again";
        void reset();
        throw new Error(lastError);
      }
      checkDeadline(start, executionSignal);
      const prediction = await classifyGuardrailRisk(
        runtime.classifier!,
        safe,
        C11.modelId,
        executionSignal,
        C11.minimumAllowScore,
      );
      assertCurrent(runtime);
      if (!nativeReady(runtime)) {
        lastError = "C11 worker or model identity changed during scoring";
        void reset();
        throw new Error(lastError);
      }
      checkDeadline(start, executionSignal);
      return { ...prediction, elapsedMs: performance.now() - start };
    },
  };

  Object.freeze(provider);
  const status = () => ({
    enabled: enabled(),
    model: C11.modelId,
    modelSha256: provider.modelSha256,
    qualified: false,
    advisoryOnly: true,
    protocolSha256: provider.protocolSha256,
    promptProtocolSha256: C11.promptProtocolSha256,
    minimumAllowScore: provider.minimumAllowScore,
    calibrationSha256: provider.calibrationSha256,
    calibrationPolicySha256: provider.calibrationPolicySha256,
    calibrationBaselineSha256: provider.calibrationBaselineSha256,
    state: stopped
      ? "disposed"
      : !enabled()
        ? "disabled"
        : current?.warming
          ? "warming"
          : current?.ready && nativeReady(current)
            ? "ready"
            : "cold",
    lastError,
  });
  const reset = () => {
    const runtime = current;
    current = undefined;
    if (!runtime) return retirement;
    runtime.ready = false;
    runtime.controller.abort(new Error("Jev guardrail worker retired"));
    let disposal: Promise<void>;
    try {
      disposal =
        runtime.classifier?.dispose() ??
        runtime.backend?.dispose() ??
        Promise.resolve();
    } catch (error) {
      disposal = Promise.reject(error);
    }
    retirement = Promise.all([retirement, disposal]).then(() => {});
    void retirement.catch((error) => {
      lastError = failureMessage(error, "Guardrail worker disposal failed");
    });
    return retirement;
  };
  const dispose = () => {
    stopped = true;
    return reset();
  };

  pi.events?.on(GUARDRAIL_PROVIDER_EVENT, (payload) => {
    const request = payload as {
      version?: number;
      providers?: GuardrailRiskProvider[];
    };
    if (request?.version === 1 && Array.isArray(request.providers) && enabled())
      request.providers.push(provider);
  });
  pi.registerCommand("jev-risk", {
    description: "Inspect or warm the local C11 guardrail risk provider",
    handler: async (args, ctx) => {
      try {
        const command = args.trim() || "status";
        if (command === "warmup") await warmup();
        else if (command !== "status") {
          ctx.ui.notify("Use /jev-risk status or /jev-risk warmup.", "info");
          return;
        }
        const currentStatus = status();
        ctx.ui.notify(
          [
            "Jev C11: " + currentStatus.state + "; " + currentStatus.model,
            "Advisory shadow scoring; not qualified for enforcement.",
            "Model weights: " + (currentStatus.modelSha256 ?? "not loaded"),
            "Scoring protocol: " + currentStatus.protocolSha256,
            "Allow cutoff: " + C11.minimumAllowScore,
            "Risk-check budget: " +
              GUARDRAIL_LIMITS.deadlineMs +
              " ms; scores are uncalibrated.",
            ...(currentStatus.lastError
              ? ["Last failure: " + currentStatus.lastError]
              : []),
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(failureMessage(error, "C11 warmup failed"), "error");
      }
    },
  });
  pi.on("session_shutdown", dispose);
  return { provider, status, warmup, reset, dispose };
}

function checkDeadline(start: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (performance.now() - start >= GUARDRAIL_LIMITS.deadlineMs)
    throw new Error("Guardrail risk check deadline exceeded");
}
function failureMessage(error: unknown, fallback: string): string {
  try {
    if (types.isProxy(error) || !(error instanceof Error)) return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value.slice(0, 1024)
      : fallback;
  } catch {
    return fallback;
  }
}
function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        if (!signal.aborted) reject(error);
      },
    );
  });
}
