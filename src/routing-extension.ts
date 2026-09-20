import { performance } from "node:perf_hooks";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";

type ProviderStream = NonNullable<ProviderConfig["streamSimple"]>;
export type RoutingModel = Parameters<ProviderStream>[0];
export type RoutingContext = Parameters<ProviderStream>[1];
export type RoutingStreamOptions = NonNullable<Parameters<ProviderStream>[2]>;
export type RoutingEventStream = ReturnType<ProviderStream>;
export type RoutingStreamEvent = Parameters<RoutingEventStream["push"]>[0];
export type RoutingAssistantMessage = Awaited<
  ReturnType<RoutingEventStream["result"]>
>;
export type RoutingMode = "off" | "shadow" | "auto" | "fast" | "strong";
export const ROUTING_DISPATCHER_PROVIDER = "jev-routing";
export const ROUTING_DISPATCHER_MODEL = "current-request";
export const ROUTING_DISPATCHER_API = "jev-routing-dispatch-v1";

/** Lineage is a trusted host attestation, never a claim parsed from a prompt. */
export interface RoutingTarget {
  /** Exact approved host registration, including endpoint; never prompt-derived. */
  model: RoutingModel;
  lineage: "google-gemma" | "xai-grok" | "openai";
}
/** The caller verifies the manifest's quality gates before setting qualified. */
export interface RoutingQualification {
  qualified: boolean;
  artifactId: string;
  artifactSha256: string;
  qualificationSha256: string;
  reason?: string;
}
export interface RoutingClassification {
  route: "fast" | "strong" | "uncertain";
  complete: boolean;
  artifactId?: string;
  artifactSha256?: string;
  confidence?: number;
}
export interface RoutingEligibility {
  eligibleForFast: boolean;
  reason?: string;
}
export type RoutingRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getApiKeyAndHeaders" | "getProvider"
>;
export interface RoutingRequestReceipt {
  requestId: number;
  mode: RoutingMode;
  decision: "fast" | "strong";
  shadowDecision?: "fast" | "strong";
  routerElapsedMs: number;
  decisionElapsedMs: number;
  selectedTarget?: string;
  fallbackReason?: string;
  cancelled: boolean;
  completed: boolean;
  usageKnown: boolean;
  /** Each attempted target remains visible, including setup failures. */
  dispatchAttempts: Array<{ target: string; setupFailed: boolean }>;
}
export interface RoutingDispatcherDependencies {
  targets: { fast?: RoutingTarget; strong?: RoutingTarget };
  registry: RoutingRegistry | (() => RoutingRegistry | undefined);
  qualification?:
    RoutingQualification | (() => RoutingQualification | undefined);
  classify?: (
    context: RoutingContext,
    options: { signal: AbortSignal },
  ) => Promise<RoutingClassification>;
  evaluateEligibility?: (
    context: RoutingContext,
    input: {
      classification: RoutingClassification;
      qualification: RoutingQualification;
      mode: RoutingMode;
    },
  ) => RoutingEligibility | Promise<RoutingEligibility>;
  createEventStream: () => RoutingEventStream;
  mode?: RoutingMode;
  classificationTimeoutMs?: number;
  onRequest?: (receipt: Readonly<RoutingRequestReceipt>) => void;
  /** Raw transport attestation; SDK's initialized numeric zeros are insufficient. */
  isUsageObserved?: (message: RoutingAssistantMessage) => boolean;
}

export interface RoutingDispatcherStatus {
  mode: RoutingMode;
  qualified: boolean;
  qualificationReason?: string;
  fastAvailable: boolean;
  strongAvailable: boolean;
  selectedTarget?: string;
  lastFallback?: string;
  totals: {
    requests: number;
    classified: number;
    fast: number;
    strong: number;
    fallbacks: number;
    cancelled: number;
  };
  lastRequest?: RoutingRequestReceipt;
}
export interface RoutingDispatcherController {
  streamSimple: ProviderStream;
  status(): RoutingDispatcherStatus;
  setMode(next: RoutingMode): void;
}

function supportsContext(
  target: RoutingTarget,
  context: RoutingContext,
): boolean {
  const hasImages = context.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image"),
  );
  return (
    target.model.input.includes("text") &&
    (!hasImages || target.model.input.includes("image"))
  );
}

function targetName(target: RoutingTarget): string {
  return `${target.model.provider}/${target.model.id}`;
}
function allowedTarget(
  target: RoutingTarget | undefined,
): target is RoutingTarget {
  if (!target || typeof target.model !== "object" || !target.model)
    return false;
  const { model, lineage } = target;
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    return false;
  }
  if (
    model.provider === ROUTING_DISPATCHER_PROVIDER ||
    model.api === ROUTING_DISPATCHER_API ||
    typeof model.baseUrl !== "string" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      )) ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow <= 0 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0
  )
    return false;
  if (lineage === "xai-grok") return model.id === "grok-4.6";
  if (lineage === "openai") return model.id === "gpt-5.6-sol";
  return (
    lineage === "google-gemma" && /^(?:google\/)?gemma-3-1b-it$/.test(model.id)
  );
}
function validQualification(value: RoutingQualification | undefined): boolean {
  return (
    !!value &&
    value.qualified === true &&
    typeof value.artifactId === "string" &&
    value.artifactId.length > 0 &&
    value.artifactId.length <= 256 &&
    /^[a-f0-9]{64}$/.test(value.artifactSha256) &&
    /^[a-f0-9]{64}$/.test(value.qualificationSha256)
  );
}
function cancelled(): DOMException {
  return new DOMException("Model routing was cancelled.", "AbortError");
}

/** Race uncancellable public auth or classifier work; consume late rejections. */
function withSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => (signal.aborted ? onAbort() : finish(() => resolve(value))),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function safeHeaders(
  incoming: RoutingStreamOptions["headers"],
  resolved: RoutingStreamOptions["headers"],
): RoutingStreamOptions["headers"] {
  const result: NonNullable<RoutingStreamOptions["headers"]> = {};
  const allowed = new Set([
    "traceparent",
    "tracestate",
    "x-request-id",
    "x-client-request-id",
    "x-correlation-id",
    "x-correlation",
    "x-trace-id",
    "x-trace",
  ]);
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (allowed.has(key.toLowerCase())) result[key] = value;
  }
  for (const [key, value] of Object.entries(resolved ?? {})) {
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete result[existing];
    }
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
function failureMessage(
  model: RoutingModel,
  abort: boolean,
  partial?: RoutingAssistantMessage,
): RoutingAssistantMessage {
  let snapshot: Pick<RoutingAssistantMessage, "content" | "usage"> | undefined;
  try {
    snapshot = partial
      ? structuredClone({ content: partial.content, usage: partial.usage })
      : undefined;
  } catch {
    /* Malformed custom provider partial. */
  }
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: snapshot?.content ?? [],
    usage: snapshot?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: abort ? "aborted" : "error",
    errorMessage: abort
      ? "Model routing was cancelled."
      : "Model routing failed before the response completed.",
    timestamp: Date.now(),
  };
}
function knownUsage(
  message: RoutingAssistantMessage,
  observed: boolean,
): boolean {
  if (!observed) return false;
  try {
    return [
      message.usage.input,
      message.usage.output,
      message.usage.cacheRead,
      message.usage.cacheWrite,
      message.usage.totalTokens,
    ].every((value) => Number.isSafeInteger(value) && value >= 0);
  } catch {
    return false;
  }
}

/**
 * The mode and qualified artifact are captured before async work. Changing the
 * controller affects subsequent streams; the current stream owns its decision.
 * There is no model selection in before_agent_start.
 */
export function createRoutingDispatcher(
  deps: RoutingDispatcherDependencies,
): RoutingDispatcherController {
  let mode = deps.mode ?? "off";
  if (!["off", "shadow", "auto", "fast", "strong"].includes(mode))
    throw new Error("Invalid routing mode.");
  const timeoutMs = deps.classificationTimeoutMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error("Invalid routing classification timeout.");
  let requestSequence = 0;
  let lastRequest: RoutingRequestReceipt | undefined;
  const totals = {
    requests: 0,
    classified: 0,
    fast: 0,
    strong: 0,
    fallbacks: 0,
    cancelled: 0,
  };
  const qualification = (): RoutingQualification | undefined =>
    typeof deps.qualification === "function"
      ? deps.qualification()
      : deps.qualification;
  const status = (): RoutingDispatcherStatus => {
    let value: RoutingQualification | undefined;
    try {
      value = qualification();
    } catch {
      /* Cold status is fail-closed. */
    }
    return {
      mode,
      qualified: validQualification(value),
      qualificationReason: validQualification(value)
        ? undefined
        : "artifact-unqualified",
      fastAvailable: allowedTarget(deps.targets.fast),
      strongAvailable: allowedTarget(deps.targets.strong),
      selectedTarget: lastRequest?.selectedTarget,
      lastFallback: lastRequest?.fallbackReason,
      totals: { ...totals },
      lastRequest: lastRequest ? structuredClone(lastRequest) : undefined,
    };
  };
  const notify = (receipt: RoutingRequestReceipt) => {
    if (!lastRequest || receipt.requestId >= lastRequest.requestId)
      lastRequest = structuredClone(receipt);
    try {
      deps.onRequest?.(structuredClone(receipt));
    } catch {
      /* Observers cannot strand a stream. */
    }
  };
  const streamSimple: ProviderStream = (model, context, options = {}) => {
    const routeStarted = performance.now();
    const outer = deps.createEventStream();
    // Route and execute precisely one captured request, even if the caller
    // updates its conversation/tool descriptors while asynchronous work awaits.
    let requestContext: RoutingContext | undefined;
    try {
      requestContext = structuredClone(context);
    } catch {
      /* Fail closed below. */
    }
    const activeMode = mode;
    // Snapshot all descriptor fields before authentication/classification awaits.
    // A concurrent host update cannot change the active prompt's approved endpoint.
    let targets: RoutingDispatcherDependencies["targets"] = {};
    try {
      targets = structuredClone(deps.targets);
    } catch {
      /* Fail closed. */
    }
    let artifact: RoutingQualification | undefined;
    try {
      const value = qualification();
      artifact = value ? { ...value } : undefined;
    } catch {
      /* Unqualified. */
    }
    const signal = options.signal ?? new AbortController().signal;
    const receipt: RoutingRequestReceipt = {
      requestId: ++requestSequence,
      mode: activeMode,
      decision: "strong",
      routerElapsedMs: 0,
      decisionElapsedMs: 0,
      cancelled: false,
      completed: false,
      usageKnown: false,
      dispatchAttempts: [],
    };
    totals.requests += 1;
    notify(receipt);
    let executingModel = model;
    let partial: RoutingAssistantMessage | undefined;
    let publicPartial: RoutingAssistantMessage | undefined;
    let terminalOwned = false;
    let fallbackCounted = false;
    const fallback = (reason: string) => {
      receipt.decision = "strong";
      receipt.fallbackReason = reason;
      if (!fallbackCounted) {
        totals.fallbacks += 1;
        fallbackCounted = true;
      }
    };
    void (async () => {
      try {
        signal.throwIfAborted();
        if (!requestContext) {
          receipt.fallbackReason = "context-snapshot-failed";
          throw new Error("context-snapshot-failed");
        }
        const needsFast =
          activeMode === "auto" ||
          activeMode === "fast" ||
          activeMode === "shadow";
        if (needsFast) {
          if (!validQualification(artifact)) fallback("artifact-unqualified");
          else if (!allowedTarget(targets.fast))
            fallback("fast-target-unavailable");
          else if (!supportsContext(targets.fast, requestContext))
            fallback("fast-target-input-unsupported");
          else if (!deps.evaluateEligibility)
            fallback("eligibility-unavailable");
          else if (!deps.classify) fallback("classifier-unavailable");
          else {
            const routingAbort = new AbortController();
            const onAbort = () => routingAbort.abort(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(
              () => routingAbort.abort(new Error("routing-timeout")),
              timeoutMs,
            );
            try {
              totals.classified += 1;
              const classification = await withSignal(routingAbort.signal, () =>
                deps.classify!(structuredClone(requestContext!), {
                  signal: routingAbort.signal,
                }),
              );
              if (classification?.complete !== true)
                fallback("classification-incomplete");
              else if (
                classification.artifactId !== artifact!.artifactId ||
                classification.artifactSha256 !== artifact!.artifactSha256
              )
                fallback("classification-artifact-mismatch");
              else if (classification.route === "fast") {
                const guard = await withSignal(routingAbort.signal, () =>
                  Promise.resolve(
                    deps.evaluateEligibility!(
                      structuredClone(requestContext!),
                      {
                        classification: { ...classification },
                        qualification: { ...artifact! },
                        mode: activeMode,
                      },
                    ),
                  ),
                );
                if (guard?.eligibleForFast === true) receipt.decision = "fast";
                else fallback("input-ineligible");
              } else if (classification.route === "strong")
                receipt.decision = "strong";
              else fallback("classification-uncertain");
            } catch {
              if (signal.aborted) throw cancelled();
              fallback(
                routingAbort.signal.aborted
                  ? "classification-timeout"
                  : "classification-failed",
              );
            } finally {
              clearTimeout(timer);
              signal.removeEventListener("abort", onAbort);
            }
          }
        }
        signal.throwIfAborted();
        if (activeMode === "shadow") {
          receipt.shadowDecision = receipt.decision;
          receipt.decision = "strong";
        }
        receipt.decisionElapsedMs = performance.now() - routeStarted;
        const registry =
          typeof deps.registry === "function" ? deps.registry() : deps.registry;
        if (!registry) {
          fallback("registry-unavailable");
          throw new Error("registry-unavailable");
        }
        let target = targets[receipt.decision];
        if (!allowedTarget(target)) {
          fallback(
            receipt.decision === "fast"
              ? "fast-target-unavailable"
              : "strong-target-unavailable",
          );
          target = targets.strong;
        }
        if (!allowedTarget(target))
          throw new Error("strong-target-unavailable");
        let inner: RoutingEventStream | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const dispatch = { target: targetName(target), setupFailed: false };
          receipt.dispatchAttempts.push(dispatch);
          let setupReason = "target-auth-unavailable";
          try {
            if (!supportsContext(target, requestContext)) {
              setupReason = "target-input-unsupported";
              throw new Error("target-input-unsupported");
            }
            const auth = await withSignal(signal, () =>
              registry.getApiKeyAndHeaders(target!.model),
            );
            signal.throwIfAborted();
            if (!auth.ok) throw new Error("target-auth-unavailable");
            // The supplied target is the approved registration. Authentication
            // cannot redirect its credential to a different endpoint.
            setupReason = "target-endpoint-changed";
            if (
              auth.baseUrl !== undefined &&
              new URL(auth.baseUrl).href !== new URL(target.model.baseUrl).href
            )
              throw new Error("target-endpoint-changed");
            setupReason = "target-provider-unavailable";
            const provider = registry.getProvider(target.model.provider);
            if (!provider) throw new Error("target-provider-unavailable");
            setupReason = "target-output-capacity-invalid";
            const maxTokens = Math.min(
              options.maxTokens ?? target.model.maxTokens,
              target.model.maxTokens,
            );
            if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
              throw new Error("target-output-capacity-invalid");
            const requestModel = auth.baseUrl
              ? { ...target.model, baseUrl: auth.baseUrl }
              : target.model;
            const requestOptions: RoutingStreamOptions = {
              ...options,
              signal,
              apiKey: auth.apiKey,
              env: auth.env,
              headers: safeHeaders(options.headers, auth.headers),
              maxTokens,
            };
            signal.throwIfAborted();
            executingModel = requestModel;
            receipt.selectedTarget = targetName(target);
            setupReason = "target-dispatch-failed";
            inner = provider.streamSimple(
              requestModel,
              requestContext,
              requestOptions,
            );
            receipt.routerElapsedMs = performance.now() - routeStarted;
            break;
          } catch {
            dispatch.setupFailed = true;
            if (signal.aborted) throw cancelled();
            if (
              receipt.decision !== "fast" ||
              attempt !== 0 ||
              !allowedTarget(targets.strong)
            ) {
              fallback(setupReason);
              throw new Error(setupReason);
            }
            fallback(setupReason);
            target = targets.strong;
          }
        }
        if (!inner) throw new Error("target-dispatch-failed");
        totals[receipt.decision] += 1;
        notify(receipt);
        const iterator = inner[Symbol.asyncIterator]();
        let exhausted = false;
        let started = false;
        try {
          while (true) {
            const next = await withSignal(signal, () => iterator.next());
            if (next.done) {
              exhausted = true;
              break;
            }
            const event = next.value;
            let forwardedEvent = event;
            if ("partial" in event) {
              if (
                event.partial.provider !== executingModel.provider ||
                event.partial.model !== executingModel.id ||
                event.partial.api !== executingModel.api
              )
                throw new Error("target-attribution-mismatch");
              partial = event.partial;
              // SDK helpers share a mutable response object: its later HTTP
              // errorMessage must not leak through already forwarded updates.
              // Keep live content references and one public helper while omitting
              // error bodies, causes and diagnostics from that shared object.
              const safePartial: RoutingAssistantMessage = {
                role: "assistant",
                api: partial.api,
                provider: partial.provider,
                model: partial.model,
                content: partial.content,
                usage: partial.usage,
                stopReason: partial.stopReason,
                timestamp: partial.timestamp,
                responseModel: partial.responseModel,
                responseId: partial.responseId,
                providerThinkingLevel: partial.providerThinkingLevel,
                deferred: partial.deferred,
                endTurn: partial.endTurn,
                errorMessage:
                  partial.stopReason === "error"
                    ? "Model routing failed before the response completed."
                    : partial.stopReason === "aborted"
                      ? "Model routing was cancelled."
                      : undefined,
              };
              publicPartial ??= safePartial;
              Object.assign(publicPartial, safePartial);
              forwardedEvent = { ...event, partial: publicPartial };
            }
            if (event.type === "start") {
              if (started) throw new Error("duplicate-start");
              started = true;
            } else if (event.type !== "error" && !started)
              throw new Error("missing-start");
            if (event.type === "done" || event.type === "error") {
              const message =
                event.type === "done" ? event.message : event.error;
              if (
                event.type === "done" &&
                (event.reason !== message.stopReason ||
                  !["stop", "length", "toolUse", "deferred"].includes(
                    message.stopReason,
                  ))
              )
                throw new Error("target-terminal-invalid");
              if (
                message.provider !== executingModel.provider ||
                message.model !== executingModel.id ||
                message.api !== executingModel.api
              )
                throw new Error("target-attribution-mismatch");
              terminalOwned = true;
              receipt.completed =
                event.type === "done" && message.stopReason !== "deferred";
              receipt.cancelled = message.stopReason === "aborted";
              let observed = false;
              try {
                observed = deps.isUsageObserved?.(message) === true;
              } catch {
                /* Unknown usage. */
              }
              receipt.usageKnown = knownUsage(message, observed);
              if (receipt.cancelled) totals.cancelled += 1;
              notify(receipt);
              // SDK errorMessage may contain a raw HTTP/APIError body. Forward
              // only the public content/usage/attribution with fixed error text;
              // arbitrary cause/body/header/diagnostic fields never cross this boundary.
              outer.push(
                event.type === "error"
                  ? {
                      type: "error",
                      reason: receipt.cancelled ? "aborted" : "error",
                      error: failureMessage(
                        executingModel,
                        receipt.cancelled,
                        message,
                      ),
                    }
                  : event,
              );
              outer.end();
              return;
            }
            outer.push(forwardedEvent);
          }
          // An exhausted provider without a terminal event violates Pi's public protocol.
          // Do not wait forever on a result promise which that provider never resolves.
          throw new Error("target-terminal-missing");
        } finally {
          if (!exhausted && iterator.return) {
            void Promise.resolve()
              .then(() => iterator.return!())
              .catch(() => undefined);
          }
        }
      } catch {
        if (terminalOwned) return;
        receipt.routerElapsedMs ||= performance.now() - routeStarted;
        receipt.cancelled = signal.aborted;
        if (receipt.cancelled) totals.cancelled += 1;
        if (!receipt.cancelled && !receipt.fallbackReason)
          receipt.fallbackReason = "target-stream-failed";
        const message = failureMessage(
          executingModel,
          receipt.cancelled,
          partial,
        );
        // Required SDK zero placeholders before inference are not known usage.
        receipt.usageKnown = false;
        notify(receipt);
        outer.push({
          type: "error",
          reason: message.stopReason === "aborted" ? "aborted" : "error",
          error: message,
        });
        outer.end();
      }
    })();
    return outer;
  };
  return {
    streamSimple,
    status,
    setMode(next: RoutingMode) {
      if (!["off", "shadow", "auto", "fast", "strong"].includes(next))
        throw new Error("Invalid routing mode.");
      mode = next;
    },
  };
}

export type RegisterRoutingDispatcherOptions = Omit<
  RoutingDispatcherDependencies,
  "registry" | "createEventStream"
> & {
  registry?: RoutingDispatcherDependencies["registry"];
  createEventStream?: RoutingDispatcherDependencies["createEventStream"];
};

/** Load the peer's own utility, even when npm nests pi-ai under coding-agent. */
async function peerEventStreamFactory(): Promise<() => RoutingEventStream> {
  const packagePath = findPackageJSON(
    "@earendil-works/pi-ai",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  if (!packagePath)
    throw new Error("Pi peer event stream utility is unavailable.");
  const moduleUrl = new URL(
    "./dist/utils/event-stream.js",
    pathToFileURL(packagePath),
  ).href;
  const utility = (await import(moduleUrl)) as {
    createAssistantMessageEventStream: () => RoutingEventStream;
  };
  return utility.createAssistantMessageEventStream;
}

/** Registering does not select a model or persist changes to user settings. */
export async function registerRoutingDispatcher(
  pi: ExtensionAPI,
  options: RegisterRoutingDispatcherOptions = { targets: {} },
): Promise<RoutingDispatcherController> {
  let liveRegistry: RoutingRegistry | undefined;
  pi.on("session_start", (_event, ctx) => {
    liveRegistry = ctx.modelRegistry;
  });
  const controller = createRoutingDispatcher({
    ...options,
    registry: options.registry ?? (() => liveRegistry),
    createEventStream:
      options.createEventStream ?? (await peerEventStreamFactory()),
  });
  const models = [
    options.targets.fast?.model,
    options.targets.strong?.model,
  ].filter((model): model is RoutingModel => !!model);
  pi.registerProvider(ROUTING_DISPATCHER_PROVIDER, {
    name: "Jev current-request routing",
    api: ROUTING_DISPATCHER_API,
    baseUrl: "http://127.0.0.1",
    apiKey: "jev-local-dispatch-only",
    authHeader: false,
    models: [
      {
        id: ROUTING_DISPATCHER_MODEL,
        name: "Jev current-request routing",
        reasoning: true,
        input: ["text", "image"],
        // Zero rates describe the dispatcher itself, not the selected target's bill.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Math.min(
          ...(models.length
            ? models.map((model) => model.contextWindow)
            : [8_192]),
        ),
        maxTokens: Math.min(
          ...(models.length ? models.map((model) => model.maxTokens) : [2_048]),
        ),
      },
    ],
    streamSimple: controller.streamSimple,
  });
  pi.on("session_shutdown", () => {
    liveRegistry = undefined;
  });
  return controller;
}
