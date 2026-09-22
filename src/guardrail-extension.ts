import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import {
  Classifier,
  NativeBackend,
  configFromEnv,
  type Config,
  type InferenceAdapter,
} from "./backend.js";
import { verifyArtifact, hashArtifact } from "./models.js";
import { verifyGuardrailQualification } from "./guardrail-evaluation.js";
import {
  C8_BASE_PROTOCOL_SHA256,
  verifyC8Calibration,
} from "./guardrail-calibration.js";
import { verifyC8HeldoutQualification } from "./guardrail-c8-qualification.js";
import { verifyC9Calibration } from "./guardrail-c9-calibration.js";
import {
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
  GUARDRAIL_PROVIDER_EVENT,
  classifyGuardrailRisk,
  validateGuardrailInput,
  type GuardrailRiskProvider,
} from "./guardrail.js";

export function guardrailConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = configFromEnv({
    JEV_DEVICE: env.JEV_DEVICE,
    JEV_TEMPLATE_VERSION: "v2",
    JEV_MODEL_ID: env.JEV_GUARDRAIL_MODEL_ID ?? "google/gemma-3-1b-it",
    JEV_MODEL_FILE:
      env.JEV_GUARDRAIL_MODEL_FILE ??
      fileURLToPath(
        new URL("../models/gemma-3-1b-it-f16.gguf", import.meta.url),
      ),
  });
  config.artifactRegistryPath = env.JEV_GUARDRAIL_ARTIFACT_REGISTRY;
  config.queueTimeoutMs = GUARDRAIL_LIMITS.deadlineMs;
  config.requestTimeoutMs = GUARDRAIL_LIMITS.deadlineMs;
  return config;
}

export interface GuardrailExtensionOptions {
  env?: NodeJS.ProcessEnv;
  enabled?: () => boolean;
  createBackend?: (config: Config) => InferenceAdapter;
}

export function registerGuardrailProvider(
  pi: ExtensionAPI,
  options: GuardrailExtensionOptions = {},
) {
  const env = options.env ?? process.env;
  const config = guardrailConfig(env);
  const calibrationPath = env.JEV_GUARDRAIL_CALIBRATION;
  const calibrationSha256 = env.JEV_GUARDRAIL_CALIBRATION_SHA256;
  const c8Calibrated =
    calibrationPath !== undefined || calibrationSha256 !== undefined;
  const c9CalibrationPath = env.JEV_GUARDRAIL_C9_CALIBRATION;
  const c9CalibrationSha256 = env.JEV_GUARDRAIL_C9_CALIBRATION_SHA256;
  const c9Calibrated =
    c9CalibrationPath !== undefined || c9CalibrationSha256 !== undefined;
  const calibrated = c8Calibrated || c9Calibrated;
  const c8FreezePath = env.JEV_GUARDRAIL_C8_FREEZE;
  const c8FreezeSha256 = env.JEV_GUARDRAIL_C8_FREEZE_SHA256;
  const c8QualificationPath = env.JEV_GUARDRAIL_C8_QUALIFICATION;
  const c8QualificationSha256 = env.JEV_GUARDRAIL_C8_QUALIFICATION_SHA256;
  const c8QualificationConfigured = [
    c8FreezePath,
    c8FreezeSha256,
    c8QualificationPath,
    c8QualificationSha256,
  ].some((value) => value !== undefined);
  interface Runtime {
    controller: AbortController;
    backend?: InferenceAdapter;
    classifier?: Classifier;
    warming?: Promise<void>;
    modelSha256: string | null;
    qualified: boolean;
    qualificationBaselineSha256: string | null;
    minimumAllowScore: number | null;
    scoringProtocolSha256: string | null;
    calibrationPolicySha256: string | null;
    calibrationBaselineSha256: string | null;
    qualificationSha256: string | null;
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

  const warmup = async () => {
    if (!enabled()) throw new Error("Jev guardrail provider is disabled");
    current ??= {
      controller: new AbortController(),
      modelSha256: null,
      qualified: false,
      qualificationBaselineSha256: null,
      minimumAllowScore: null,
      scoringProtocolSha256: null,
      calibrationPolicySha256: null,
      calibrationBaselineSha256: null,
      qualificationSha256: null,
      backendGeneration: null,
      ready: false,
    };
    const runtime = current;
    if (runtime.warming) return runtime.warming;
    if (
      runtime.ready &&
      (!(runtime.backend instanceof NativeBackend) ||
        (runtime.backend.isReady &&
          runtime.backend.status.generation === runtime.backendGeneration))
    )
      return;
    runtime.ready = false;
    runtime.qualified = false;
    const qualificationPath = env.JEV_GUARDRAIL_QUALIFICATION;
    const qualificationSha256 = env.JEV_GUARDRAIL_QUALIFICATION_SHA256;
    runtime.warming = (async () => {
      await waitFor(retirement, runtime.controller.signal);
      assertCurrent(runtime);
      if (
        c9Calibrated &&
        (c8Calibrated ||
          c8QualificationConfigured ||
          qualificationPath !== undefined ||
          qualificationSha256 !== undefined)
      )
        throw new Error(
          "C9 TRAIN calibration cannot inherit C7 or C8 qualification",
        );
      if (
        c9Calibrated &&
        (!c9CalibrationPath ||
          !isAbsolute(c9CalibrationPath) ||
          !c9CalibrationSha256 ||
          !/^[a-f0-9]{64}$/.test(c9CalibrationSha256))
      )
        throw new Error(
          "C9 calibration requires an absolute file and operator-pinned SHA-256",
        );
      if (c8Calibrated && qualificationPath !== undefined)
        throw new Error(
          "C8 TRAIN calibration cannot inherit a C7 qualification receipt",
        );
      if (c8QualificationConfigured && !c8Calibrated)
        throw new Error(
          "C8 held-out qualification requires a selected TRAIN cutoff",
        );
      if (
        c8QualificationConfigured &&
        (!c8FreezePath ||
          !c8FreezeSha256 ||
          !/^[a-f0-9]{64}$/.test(c8FreezeSha256) ||
          !c8QualificationPath ||
          !c8QualificationSha256 ||
          !/^[a-f0-9]{64}$/.test(c8QualificationSha256))
      )
        throw new Error(
          "C8 enforcement requires separately pinned freeze and qualification files",
        );
      if (
        c8Calibrated &&
        (!calibrationPath ||
          !calibrationSha256 ||
          !/^[a-f0-9]{64}$/.test(calibrationSha256))
      )
        throw new Error(
          "C8 calibration requires a file and operator-pinned SHA-256",
        );
      if (
        qualificationPath !== undefined &&
        (!qualificationSha256 || !/^[a-f0-9]{64}$/.test(qualificationSha256))
      )
        throw new Error(
          "Guardrail qualification requires an operator-pinned 64-character lowercase SHA-256",
        );
      const artifact = await verifyArtifact(
        config.modelFile!,
        "classifier",
        config.modelId,
        {
          registryPath: config.artifactRegistryPath,
          signal: runtime.controller.signal,
        },
      );
      assertCurrent(runtime);
      runtime.backend ??=
        options.createBackend?.(config) ?? new NativeBackend(config);
      runtime.classifier ??= new Classifier(config, runtime.backend);
      const binaryBeforeWarmup =
        qualificationPath !== undefined || calibrated
          ? await hashArtifact(config.binary, runtime.controller.signal)
          : undefined;
      // Reset/disposal interrupts waiting even if a test adapter ignores disposal.
      await waitFor(runtime.backend.warmup(), runtime.controller.signal);
      assertCurrent(runtime);
      const backendGeneration =
        runtime.backend instanceof NativeBackend
          ? runtime.backend.status.generation
          : null;
      runtime.modelSha256 = artifact.sha256;
      let qualified = false;
      let qualificationBaselineSha256: string | null = null;
      if (qualificationPath !== undefined) {
        const raw = await readQualification(
          qualificationPath,
          runtime.controller.signal,
        );
        if (
          createHash("sha256").update(raw).digest("hex") !== qualificationSha256
        )
          throw new Error(
            "Guardrail qualification SHA-256 does not match the operator pin",
          );
        const binary = await hashArtifact(
          config.binary,
          runtime.controller.signal,
        );
        if (
          binary.sha256 !== binaryBeforeWarmup!.sha256 ||
          binary.size !== binaryBeforeWarmup!.size
        )
          throw new Error(
            "Guardrail scoring binary changed during worker warmup",
          );
        const qualification = verifyGuardrailQualification(
          JSON.parse(raw.toString("utf8")),
          artifact.sha256,
          binary.sha256,
        );
        qualificationBaselineSha256 = qualification.baselineSourceSha256;
        qualified = true;
      }
      if (c8Calibrated) {
        const raw = await readQualification(
          calibrationPath!,
          runtime.controller.signal,
        );
        if (
          createHash("sha256").update(raw).digest("hex") !== calibrationSha256
        )
          throw new Error(
            "C8 calibration SHA-256 does not match the operator pin",
          );
        const binary = await hashArtifact(
          config.binary,
          runtime.controller.signal,
        );
        if (
          binary.sha256 !== binaryBeforeWarmup!.sha256 ||
          binary.size !== binaryBeforeWarmup!.size
        )
          throw new Error(
            "Guardrail scoring binary changed during C8 calibration warmup",
          );
        const receipt = verifyC8Calibration(
          JSON.parse(raw.toString("utf8")),
          artifact.sha256,
          binary.sha256,
        );
        runtime.minimumAllowScore = receipt.minimumAllowScore;
        runtime.scoringProtocolSha256 = receipt.scoringProtocolSha256;
        runtime.calibrationPolicySha256 = receipt.input.policySha256;
        runtime.calibrationBaselineSha256 = receipt.input.baselineSha256;
        // A TRAIN-selected threshold alone is shadow-only. A separately pinned
        // pre-TEST freeze and passing held-out receipt unlock enforcement.
        if (c8QualificationConfigured) {
          const frozenBytes = await readQualification(
            c8FreezePath!,
            runtime.controller.signal,
          );
          const qualificationBytes = await readQualification(
            c8QualificationPath!,
            runtime.controller.signal,
          );
          if (
            createHash("sha256").update(frozenBytes).digest("hex") !==
              c8FreezeSha256 ||
            createHash("sha256").update(qualificationBytes).digest("hex") !==
              c8QualificationSha256
          )
            throw new Error(
              "C8 freeze or held-out qualification differs from its operator pin",
            );
          const qualification = verifyC8HeldoutQualification(
            JSON.parse(qualificationBytes.toString("utf8")),
            JSON.parse(frozenBytes.toString("utf8")),
            receipt,
            calibrationSha256!,
            artifact.sha256,
            binary.sha256,
          );
          const binaryAfterQualification = await hashArtifact(
            config.binary,
            runtime.controller.signal,
          );
          if (
            binaryAfterQualification.sha256 !== binary.sha256 ||
            binaryAfterQualification.size !== binary.size
          )
            throw new Error(
              "Guardrail scoring binary changed during C8 qualification warmup",
            );
          qualified = qualification.qualified;
          qualificationBaselineSha256 = receipt.input.baselineSha256;
          runtime.qualificationSha256 = c8QualificationSha256!;
        }
      }
      if (c9Calibrated) {
        const raw = await readQualification(
          c9CalibrationPath!,
          runtime.controller.signal,
        );
        if (
          createHash("sha256").update(raw).digest("hex") !== c9CalibrationSha256
        )
          throw new Error(
            "C9 calibration SHA-256 does not match the operator pin",
          );
        const binary = await hashArtifact(
          config.binary,
          runtime.controller.signal,
        );
        if (
          binary.sha256 !== binaryBeforeWarmup!.sha256 ||
          binary.size !== binaryBeforeWarmup!.size
        )
          throw new Error(
            "Guardrail scoring binary changed during C9 calibration warmup",
          );
        const receipt = verifyC9Calibration(
          JSON.parse(raw.toString("utf8")),
          artifact.sha256,
          binary.sha256,
        );
        if (
          !receipt.accepted ||
          receipt.reason !== "selected" ||
          !Number.isFinite(receipt.minimumAllowScore) ||
          receipt.minimumAllowScore! < 0.5 ||
          receipt.minimumAllowScore! >= 1 ||
          !/^[a-f0-9]{64}$/.test(receipt.scoringProtocolSha256 ?? "")
        )
          throw new Error(
            "C9 TRAIN calibration did not select a usable cutoff",
          );
        runtime.minimumAllowScore = receipt.minimumAllowScore;
        runtime.scoringProtocolSha256 = receipt.scoringProtocolSha256;
        runtime.calibrationPolicySha256 = receipt.input.policySha256;
        runtime.calibrationBaselineSha256 = receipt.input.baselineSha256;
        // TRAIN-CAL selection permits shadow scoring only; C9 has no held-out qualification.
      }
      assertCurrent(runtime);
      if (
        runtime.backend instanceof NativeBackend &&
        (!runtime.backend.isReady ||
          runtime.backend.status.generation !== backendGeneration)
      )
        throw new Error("Guardrail worker changed during qualification warmup");
      runtime.backendGeneration = backendGeneration;
      runtime.qualified = qualified;
      runtime.qualificationBaselineSha256 = qualificationBaselineSha256;
      runtime.ready = true;
      lastError = undefined;
    })()
      .catch((error) => {
        if (current === runtime) {
          lastError = failureMessage(error, "Guardrail initialization failed");
          // A ready process from a failed attempt must not be qualified against
          // a replacement executable or receipt on retry. Reset starts disposal
          // immediately; the next warmup waits for that retirement to finish.
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
    version: calibrated ? 2 : 1,
    id: "jev",
    get protocolSha256() {
      return calibrated
        ? (current?.scoringProtocolSha256 ??
            (c9Calibrated
              ? GUARDRAIL_PROTOCOL_SHA256
              : C8_BASE_PROTOCOL_SHA256))
        : GUARDRAIL_PROTOCOL_SHA256;
    },
    get modelSha256() {
      return enabled() ? (current?.modelSha256 ?? null) : null;
    },
    get qualified() {
      return (
        enabled() &&
        (current?.qualified ?? false) &&
        current!.ready &&
        (!(current!.backend instanceof NativeBackend) ||
          (current!.backend.isReady &&
            current!.backend.status.generation === current!.backendGeneration))
      );
    },
    get qualificationBaselineSha256() {
      return enabled() ? (current?.qualificationBaselineSha256 ?? null) : null;
    },
    get minimumAllowScore() {
      return calibrated && enabled()
        ? (current?.minimumAllowScore ?? null)
        : null;
    },
    get calibrationSha256() {
      return calibrated && enabled()
        ? c9Calibrated
          ? c9CalibrationSha256
          : calibrationSha256
        : null;
    },
    get calibrationPolicySha256() {
      return calibrated && enabled()
        ? (current?.calibrationPolicySha256 ?? null)
        : null;
    },
    get calibrationBaselineSha256() {
      return calibrated && enabled()
        ? (current?.calibrationBaselineSha256 ?? null)
        : null;
    },
    get qualificationSha256() {
      return calibrated && enabled()
        ? (current?.qualificationSha256 ?? null)
        : null;
    },
    async evaluate(input, signal) {
      const start = performance.now();
      const entryRuntime = current;
      const entryGeneration = entryRuntime?.backendGeneration;
      if (!enabled()) throw new Error("Jev guardrail provider is disabled");
      const deadline = AbortSignal.timeout(GUARDRAIL_LIMITS.deadlineMs);
      const callerSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      callerSignal.throwIfAborted();
      const safe = validateGuardrailInput(input);
      callerSignal.throwIfAborted();
      if (performance.now() - start >= GUARDRAIL_LIMITS.deadlineMs)
        throw new Error("Guardrail risk check deadline exceeded");
      // A caller deadline stops waiting; shared cold initialization can continue.
      const initialization = warmup();
      const runtime = current;
      if (!runtime) {
        await initialization;
        throw new Error("Jev guardrail provider is disabled");
      }
      await waitFor(
        initialization,
        AbortSignal.any([callerSignal, runtime.controller.signal]),
      );
      assertCurrent(runtime);
      if (
        runtime.backend instanceof NativeBackend &&
        entryRuntime === runtime &&
        entryGeneration !== null &&
        entryGeneration !== undefined &&
        entryGeneration !== runtime.backendGeneration
      ) {
        runtime.qualified = false;
        lastError =
          "Guardrail worker generation changed; explicit warmup must reverify its scoring binary and qualification";
        void reset();
        throw new Error(lastError);
      }
      callerSignal.throwIfAborted();
      if (performance.now() - start >= GUARDRAIL_LIMITS.deadlineMs)
        throw new Error("Guardrail risk check deadline exceeded");
      const prediction = await classifyGuardrailRisk(
        runtime.classifier!,
        safe,
        config.modelId,
        AbortSignal.any([callerSignal, runtime.controller.signal]),
        calibrated
          ? (runtime.minimumAllowScore ?? NaN)
          : GUARDRAIL_LIMITS.minimumAllowScore,
      );
      assertCurrent(runtime);
      if (
        runtime.backend instanceof NativeBackend &&
        runtime.backend.status.generation !== runtime.backendGeneration
      ) {
        runtime.qualified = false;
        lastError =
          "Guardrail worker generation changed; explicit warmup must reverify its scoring binary and qualification";
        void reset();
        throw new Error(lastError);
      }
      // Recovery may reload the file. A different artifact loses qualification
      // and cannot inherit an approval scope bound to the previous weights.
      if (
        runtime.backend instanceof NativeBackend &&
        runtime.backend.status.artifact?.sha256 !== runtime.modelSha256
      ) {
        runtime.qualified = false;
        lastError =
          "Guardrail model changed during worker recovery; warm and qualify the replacement";
        void reset();
        throw new Error(lastError);
      }
      callerSignal.throwIfAborted();
      const elapsedMs = performance.now() - start;
      if (elapsedMs >= GUARDRAIL_LIMITS.deadlineMs)
        throw new Error("Guardrail risk check deadline exceeded");
      return { ...prediction, elapsedMs };
    },
  };
  const status = () => ({
    enabled: enabled(),
    model: config.modelId,
    modelSha256: provider.modelSha256,
    qualified: provider.qualified,
    qualificationBaselineSha256: provider.qualificationBaselineSha256,
    protocolSha256: provider.protocolSha256,
    minimumAllowScore: provider.minimumAllowScore,
    calibrationSha256: provider.calibrationSha256,
    qualificationSha256: provider.qualificationSha256,
    state: stopped
      ? "disposed"
      : !enabled()
        ? "disabled"
        : current?.warming
          ? "warming"
          : (current?.classifier?.status.state ?? "cold"),
    calibration: c9Calibrated
      ? current?.ready && current.minimumAllowScore !== null
        ? "c9_train_selected_cutoff_unqualified"
        : "c9_calibration_unverified"
      : c8Calibrated
        ? provider.qualified
          ? "train_cutoff_heldout_qualified"
          : "train_selected_cutoff_unqualified"
        : "uncalibrated",
    lastError,
  });
  const reset = () => {
    const runtime = current;
    current = undefined;
    if (!runtime) return retirement;
    runtime.qualified = false;
    runtime.controller.abort(new Error("Jev guardrail worker retired"));
    // Start disposal now, rather than waiting for a potentially lengthy warmup.
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
    description: "Inspect or warm the local Jev guardrail risk provider",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      try {
        if (command === "warmup") await warmup();
        else if (command !== "status") {
          ctx.ui.notify(
            "Use /jev-risk status or /jev-risk warmup. Select comparison/enforcement in SF Guardrail.",
            "info",
          );
          return;
        }
        const current = status();
        ctx.ui.notify(
          `Jev risk: ${current.state}; ${current.model}\nQualified for the frozen guardrail suite: ${current.qualified ? "yes" : "no"}\nModel weights: ${current.modelSha256 ?? "not loaded"}\nScoring protocol: ${current.protocolSha256}\nWarm check budget: ${GUARDRAIL_LIMITS.deadlineMs} ms; scores are uncalibrated.${current.lastError ? `\nLast failure: ${current.lastError}` : ""}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          failureMessage(error, "Jev guardrail warmup failed"),
          "error",
        );
      }
    },
  });
  pi.on("session_shutdown", dispose);
  return { provider, status, warmup, reset, dispose };
}

async function readQualification(
  path: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const limit = 4 * 1024 * 1024;
  signal.throwIfAborted();
  // Nonblocking open also lets us reject FIFOs without waiting for a writer.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const stat = await handle.stat();
    signal.throwIfAborted();
    if (!stat.isFile())
      throw new Error("Guardrail qualification must be a regular file");
    if (stat.size > limit)
      throw new Error("Guardrail qualification exceeds 4 MiB");
    // One extra byte detects growth after stat without an unbounded read.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const chunk = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      signal.throwIfAborted();
      length += chunk.bytesRead;
      if (length > limit)
        throw new Error("Guardrail qualification exceeds 4 MiB");
      if (chunk.bytesRead === 0) break;
    }
    signal.throwIfAborted();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
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
    const aborted = () => reject(signal.reason);
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
