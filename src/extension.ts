import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Classifier,
  NativeBackend,
  configFromEnv,
  type Config,
  type InferenceAdapter,
} from "./backend.js";
import { registerAutomation } from "./automation.js";
import {
  registerGuardrailProvider,
  type GuardrailExtensionOptions,
} from "./guardrail-extension.js";
import { validateRequest } from "./core.js";
import {
  LoadedRequestCache,
  LoadedRequestExecutionError,
  type LoadedRequestReceipt,
} from "./loaded-requests.js";
import {
  compactClassifierBatchToolResult,
  serializeClassifierToolResult,
} from "./tool-result.js";
import { openJevInManager, registerManager } from "./manager.js";
import {
  registerContextCompression,
  type ContextCompressionOptions,
} from "./context-extension.js";
import { registerContextManager } from "./context-manager.js";
import { registerContextActivity } from "./context-activity.js";
import {
  registerRoutingDispatcher,
  ROUTING_DISPATCHER_API,
  ROUTING_DISPATCHER_MODEL,
  ROUTING_DISPATCHER_PROVIDER,
  type RegisterRoutingDispatcherOptions,
  type RoutingContext,
  type RoutingMode,
} from "./routing-extension.js";
import {
  readPreferences,
  writePreferences,
  DEFAULT_PREFERENCES,
  type Preferences,
  type SettingsScope,
} from "./preferences.js";
// Keep recursive definitions beside each entry so tool prompt templates that
// render question items without root $defs still expose the complete schema.
const EntrySchema = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
    Entry: Type.Union([
      Type.Null(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
  },
  "Entry",
);
const common = { id: Type.String({ minLength: 1 }), instructions: EntrySchema };
export const ToolSchema = Type.Object(
  {
    state: Type.Optional(EntrySchema),
    messages: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Array(
          Type.Object(
            {
              role: Type.Union(
                ["system", "developer", "user", "assistant"].map((v) =>
                  Type.Literal(v),
                ),
              ),
              content: Type.String(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      ]),
    ),
    questions: Type.Array(
      Type.Union([
        Type.Object(
          {
            ...common,
            type: Type.Literal("choice"),
            criteria: Type.Array(
              Type.Object(
                { id: Type.String(), description: EntrySchema },
                { additionalProperties: false },
              ),
              { minItems: 2, maxItems: 50 },
            ),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            ...common,
            type: Type.Literal("score"),
            criteria: Type.Array(EntrySchema, { minItems: 2, maxItems: 50 }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            ...common,
            type: Type.Literal("noul"),
            criteria: Type.Optional(
              Type.Union([
                Type.Null(),
                Type.Object(
                  {
                    true: Type.Optional(EntrySchema),
                    false: Type.Optional(EntrySchema),
                  },
                  { additionalProperties: false },
                ),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 256 },
    ),
    options: Type.Optional(
      Type.Object(
        {
          raw_logits: Type.Optional(Type.Boolean()),
          template_version: Type.Optional(
            Type.Union([Type.Literal("v1"), Type.Literal("v2")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const LoadedToolSchema = Type.Object(
  {
    read_tool_call_id: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export function registerExtension(
  pi: ExtensionAPI,
  config: Config = configFromEnv(),
  initialBackend?: InferenceAdapter,
  options: {
    cwd?: string;
    agentDir?: string;
    createBackend?: (config: Config) => InferenceAdapter;
    guardrailRisk?: Omit<GuardrailExtensionOptions, "enabled">;
    contextCompression?: ContextCompressionOptions;
    routingDispatcher?: RegisterRoutingDispatcherOptions;
  } = {},
) {
  let cwd = options.cwd ?? process.cwd();
  let resolved = readPreferences(cwd, options.agentDir);
  let backend = initialBackend;
  let classifier: Classifier | undefined;
  let ready = false;
  let stopped = false;
  let retirement: Promise<void> = Promise.resolve();
  const loadedRequests = new LoadedRequestCache();
  // Match the classifier's one active request plus sixteen queued requests.
  // pi turns thrown tool errors into fresh results, so preserve partial work
  // until its final tool_result event can attach the actual receipt.
  const pendingLoadedFailures = new Map<
    string,
    {
      receipt: LoadedRequestReceipt;
      kind: LoadedRequestExecutionError["kind"];
    }
  >();
  const clearLoadedRequests = () => {
    loadedRequests.clear();
    pendingLoadedFailures.clear();
  };
  const status = (): Record<string, unknown> => ({
    ...((backend as { status?: Record<string, unknown> } | undefined)?.status ??
      {}),
    ...(classifier?.status ?? {}),
    state: !resolved.values.enabled
      ? "disabled"
      : stopped
        ? "disposed"
        : (classifier?.status.state ??
          (backend as { status?: Record<string, unknown> } | undefined)?.status
            ?.state ??
          "cold"),
    model: config.modelId,
    loaded_requests: loadedRequests.status,
    pending_loaded_failure_receipts: pendingLoadedFailures.size,
    requested_device: config.device,
    configured: !!config.modelFile,
    ready: backend instanceof NativeBackend ? backend.isReady : ready,
    preferences: { ...resolved.values },
    preference_sources: { ...resolved.sources },
  });
  const guardrailRisk = registerGuardrailProvider(pi, {
    ...options.guardrailRisk,
    enabled: () => !stopped && resolved.values.enabled,
  });
  const warmConfiguredGuardrailRisk = async () => {
    const mode = (options.guardrailRisk?.env ?? process.env)
      .SF_GUARDRAIL_JEV_MODE;
    if (
      stopped ||
      !resolved.values.enabled ||
      (mode !== "shadow" && mode !== "enforce")
    )
      return;
    try {
      await guardrailRisk.warmup();
    } catch {
      // The provider retains initialization failures; SF Guardrail keeps its fallback.
    }
  };
  const getClassifier = () => {
    if (stopped) throw new Error("Jev extension is shut down");
    if (!resolved.values.enabled)
      throw new Error(
        "Jev is disabled. Enable it with /jev enable or in SF Pi Manager.",
      );
    if (!classifier) {
      const runtimeConfig = {
        ...config,
        templateVersion: resolved.values.templateVersion,
      };
      backend ??=
        options.createBackend?.(runtimeConfig) ??
        new NativeBackend(runtimeConfig);
      classifier = new Classifier(runtimeConfig, backend);
    }
    return classifier;
  };
  const disposeCurrent = async () => {
    const current = classifier;
    const currentBackend = backend;
    classifier = undefined;
    backend = undefined;
    ready = false;
    const riskRetirement = guardrailRisk.reset();
    retirement = retirement.then(async () => {
      if (current) await current.dispose();
      else if (currentBackend) await currentBackend.dispose();
    });
    await Promise.all([retirement, riskRetirement]);
  };
  const apply = async (
    targetCwd: string,
    scope: SettingsScope,
    patch: Partial<Preferences>,
  ) => {
    const previous = resolved.values;
    resolved = writePreferences(targetCwd, scope, patch, options.agentDir);
    cwd = targetCwd;
    if (
      !resolved.values.enabled ||
      previous.templateVersion !== resolved.values.templateVersion
    ) {
      clearLoadedRequests();
      await disposeCurrent();
    }
    if (
      resolved.values.enabled &&
      (!previous.enabled ||
        previous.templateVersion !== resolved.values.templateVersion)
    )
      await warmConfiguredGuardrailRisk();
  };
  // This handler is first so shutdown remains available even on minimal hosts.
  pi.on("session_shutdown", async () => {
    stopped = true;
    clearLoadedRequests();
    await disposeCurrent();
  });
  pi.on("session_start", async (_event, ctx) => {
    clearLoadedRequests();
    cwd = ctx.cwd;
    const previous = resolved.values;
    resolved = readPreferences(cwd, options.agentDir);
    if (
      !resolved.values.enabled ||
      previous.templateVersion !== resolved.values.templateVersion
    )
      await disposeCurrent();
    await warmConfiguredGuardrailRisk();
  });
  const classify = async (input: unknown, signal?: AbortSignal) => {
    const request =
      input && typeof input === "object" && !Array.isArray(input)
        ? { ...input, model: config.modelId }
        : input;
    await retirement;
    const current = getClassifier();
    const result = await current.classify(request, signal);
    if (classifier === current) ready = true;
    return result;
  };
  const reports = registerAutomation(pi, {
    preferences: () => resolved.values,
    classify,
  });
  pi.on("tool_result", async (event) => {
    if (event.toolName === "jev_classify_loaded" && event.isError === true) {
      const failure = pendingLoadedFailures.get(event.toolCallId);
      if (failure) {
        pendingLoadedFailures.delete(event.toolCallId);
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "incomplete",
                failure_kind: failure.kind,
                source: failure.receipt.source,
                completed_records: failure.receipt.results.length,
                total_records: failure.receipt.total_records,
              }),
            },
          ],
          details: failure.receipt,
          isError: true,
        };
      }
    }
    if (!resolved.values.enabled || stopped) return;
    const readSource = pi
      .getAllTools?.()
      .find((tool) => tool.name === "read")?.sourceInfo;
    const captured = loadedRequests.capture(event, readSource);
    if (!captured.captured) return;
    // Gemma's template uses tool-call IDs internally but does not show them.
    // Preserve the complete read text and expose the explicit source reference.
    const reference = JSON.stringify({
      read_tool_call_id: captured.source.read_tool_call_id,
      records: captured.source.record_ids.length,
      content_sha256: captured.source.content_sha256,
    });
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `Jev loaded request reference: ${reference}`,
        },
      ],
    };
  });
  const display = (result: unknown, ctx: ExtensionCommandContext) => {
    const content = JSON.stringify(result, null, 2);
    if (ctx.hasUI) ctx.ui.notify(content, "info");
    else
      pi.sendMessage(
        { customType: "jev-status", content, display: true },
        { triggerTurn: false },
      );
  };
  const action = async (
    name:
      "status" | "doctor" | "warmup" | "routing-report" | "evaluation-report",
    ctx: ExtensionCommandContext,
  ) => {
    let result: unknown;
    if (name === "status") result = status();
    else if (name === "routing-report")
      result = reports.latestRoute() ?? {
        status: "No routing report in this session.",
      };
    else if (name === "evaluation-report")
      result = reports.latestEvaluation() ?? {
        status: "No evaluation report in this session.",
      };
    else if (name === "doctor") {
      const runtimeConfig = {
        ...config,
        templateVersion: resolved.values.templateVersion,
      };
      if (backend && !(backend instanceof NativeBackend))
        result = { backend: "custom", ...status() };
      else
        result = await (
          backend instanceof NativeBackend
            ? backend
            : new NativeBackend(runtimeConfig)
        ).doctor();
    } else {
      await retirement;
      const current = getClassifier();
      await current.backend.warmup();
      ready = true;
      result = status();
    }
    display(result, ctx);
  };
  const managerActions = registerManager(pi, {
    preferences: () => resolved.values,
    scopePreferences: (scope) =>
      scope === "global"
        ? { ...DEFAULT_PREFERENCES, ...resolved.scopes.global }
        : resolved.values,
    status,
    apply,
    action,
  });
  const contextCompression = registerContextCompression(pi, {
    strategy: "excerpts",
    ...options.contextCompression,
    ...(options.routingDispatcher?.targets.fast?.model.api ===
      "openai-completions" &&
    options.routingDispatcher.targets.strong?.model.api === "openai-completions"
      ? {
          additionalSupportedModelApis: [ROUTING_DISPATCHER_API],
          allowedOpenAiTargetModelIds: [
            ...new Set([
              options.routingDispatcher.targets.fast.model.id,
              options.routingDispatcher.targets.strong.model.id,
            ]),
          ],
        }
      : {}),
  });
  const contextActivity = registerContextActivity(pi, contextCompression);
  const contextManagerActions = registerContextManager(pi, {
    compression: {
      status: () => {
        const current = contextCompression.status();
        return {
          ...current,
          lastFallback: current.lastFallback ?? undefined,
          lastContext: current.lastContext ?? undefined,
        };
      },
      setEnabled: (enabled) => {
        contextCompression.setEnabled(enabled);
        contextActivity.refresh(undefined, true);
      },
    },
  });
  pi.registerCommand("jev-context", {
    description:
      "Task-aware tool context: status, on, off, reset, excerpts, caveman, log, logging on|off",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "log") return contextActivity.showLog(ctx);
      if (command === "logging on" || command === "logging off")
        return contextActivity.setLogging(command === "logging on", ctx);
      if (command === "on" || command === "off")
        contextCompression.setEnabled(command === "on");
      else if (command === "reset") contextCompression.resetMetrics();
      else if (command === "excerpts" || command === "caveman") {
        if (!contextCompression.setStrategy)
          throw new Error("This host selected the fixed lossless strategy.");
        contextCompression.setStrategy(command);
        contextCompression.setEnabled(true);
      } else if (command !== "status")
        throw new Error(
          "Usage: /jev-context [status|on|off|reset|excerpts|caveman|log|logging on|logging off]",
        );
      if (command === "reset") contextActivity.reset(ctx);
      else contextActivity.refresh(ctx, command !== "status");
      display(contextCompression.status(), ctx);
    },
  });
  const classifierContext = (context: RoutingContext): RoutingContext =>
    contextCompression.isContextManifest(context.messages.at(-1))
      ? { ...context, messages: context.messages.slice(0, -1) }
      : context;
  const routingOptions = options.routingDispatcher;
  const routingReady = routingOptions
    ? registerRoutingDispatcher(pi, {
        ...routingOptions,
        classify: routingOptions.classify
          ? (context, requestOptions) =>
              routingOptions.classify!(
                classifierContext(context),
                requestOptions,
              )
          : undefined,
        evaluateEligibility: routingOptions.evaluateEligibility
          ? (context, input) =>
              routingOptions.evaluateEligibility!(
                classifierContext(context),
                input,
              )
          : undefined,
      }).then((controller) => {
        registerContextManager(pi, { routing: controller });
        pi.registerCommand("jev-routing", {
          description:
            "Current-request dispatcher: status, use, off, shadow, auto, fast, strong",
          handler: async (args, ctx) => {
            const command = args.trim() || "status";
            if (command === "use") {
              const model = ctx.modelRegistry.find(
                ROUTING_DISPATCHER_PROVIDER,
                ROUTING_DISPATCHER_MODEL,
              );
              if (!model || !(await pi.setModel(model)))
                throw new Error("Jev routing dispatcher is unavailable.");
            } else if (
              ["off", "shadow", "auto", "fast", "strong"].includes(command)
            ) {
              controller.setMode(command as RoutingMode);
            } else if (command !== "status") {
              throw new Error(
                "Usage: /jev-routing [status|use|off|shadow|auto|fast|strong]",
              );
            }
            display(controller.status(), ctx);
          },
        });
        return controller;
      })
    : Promise.resolve(undefined);
  pi.registerTool({
    name: "jev_classify",
    label: "Jev Classify",
    description:
      "Classify explicitly supplied context using ordered choices, rubrics, or truth judgments with a local Gemma model. Confidence and truth scores are uncalibrated. Questions and choice candidates are ordered arrays with IDs. This tool supplies advisory answers and does not authorize other actions.",
    parameters: ToolSchema,
    async execute(_id, params, signal) {
      const request = validateRequest({ ...params, model: config.modelId });
      const result = await classify(params, signal);
      return {
        content: [
          {
            type: "text",
            text: serializeClassifierToolResult(request, result),
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "jev_classify_loaded",
    label: "Jev Classify Loaded",
    description:
      "Classify a JSON request bundle already returned by builtin read. Use the read_tool_call_id shown in Jev's read reference. Bundle format: {records:[{id,request:{state or messages,questions,options?}}]}; requests use the same ordered choice, score, or truth questions as jev_classify. Local Gemma estimates are advisory and uncalibrated. This tool uses the observed read result and authorizes no other actions.",
    parameters: LoadedToolSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      pendingLoadedFailures.delete(toolCallId);
      const loaded = loadedRequests.resolve(
        params.read_tool_call_id,
        config.modelId,
      );
      try {
        const receipt = await loadedRequests.classify(
          params.read_tool_call_id,
          config.modelId,
          classify,
          signal,
        );
        const result = compactClassifierBatchToolResult(
          loaded.records.map((record, index) => ({
            id: record.id,
            request: record.request,
            response: receipt.results[index].response,
          })),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ source: receipt.source, ...result }),
            },
          ],
          details: receipt,
        };
      } catch (error) {
        if (error instanceof LoadedRequestExecutionError) {
          // An older execution must not refill the map after a session or
          // preference change cleared and aborted its loaded requests.
          if (
            !stopped &&
            resolved.values.enabled &&
            error.receipt.session_generation ===
              loadedRequests.status.session_generation
          ) {
            pendingLoadedFailures.set(toolCallId, {
              receipt: structuredClone(error.receipt),
              kind: error.kind,
            });
            if (pendingLoadedFailures.size > 17) {
              // Prefer discarding an empty overload receipt over completed work.
              const oldestEmpty = [...pendingLoadedFailures].find(
                ([, failure]) => failure.receipt.results.length === 0,
              )?.[0];
              pendingLoadedFailures.delete(
                oldestEmpty ?? pendingLoadedFailures.keys().next().value!,
              );
            }
          }
          onUpdate?.({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "incomplete",
                  failure_kind: error.kind,
                  completed_records: error.receipt.results.length,
                  total_records: error.receipt.total_records,
                }),
              },
            ],
            details: error.receipt,
          });
        }
        throw error;
      }
    },
  });
  pi.registerCommand("jev", {
    description:
      "Local Gemma classifier: Manager, status, doctor, warmup, settings, reports",
    handler: async (args, ctx) => {
      if (!args.trim() && ctx.hasUI && (await openJevInManager(pi, ctx)))
        return;
      const [name = "status", ...tail] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const [value, requestedScope = "project"] = tail;
      if (
        [
          "status",
          "doctor",
          "warmup",
          "routing-report",
          "evaluation-report",
        ].includes(name) &&
        !tail.length
      )
        return action(name as Parameters<typeof action>[0], ctx);
      const scope =
        name === "enable" || name === "disable"
          ? (value ?? "project")
          : requestedScope;
      if (
        tail.length > (name === "enable" || name === "disable" ? 1 : 2) ||
        !["global", "project"].includes(scope)
      )
        throw new Error("Jev settings scope must be global or project");
      let patch: Partial<Preferences>;
      if (name === "enable" || name === "disable")
        patch = { enabled: name === "enable" };
      else if (
        (name === "routing" || name === "evaluation") &&
        (value === "on" || value === "off")
      )
        patch = { [name]: value === "on" };
      else if (name === "template" && (value === "v1" || value === "v2"))
        patch = { templateVersion: value };
      else
        throw new Error(
          "Usage: /jev [status|doctor|warmup|routing-report|evaluation-report|enable [global|project]|disable [global|project]|routing on|off [global|project]|evaluation on|off [global|project]|template v1|v2 [global|project]]",
        );
      await apply(ctx.cwd, scope as SettingsScope, patch);
      display(status(), ctx);
    },
  });
  return {
    classify,
    status,
    apply,
    managerActions,
    contextManagerActions,
    contextCompression,
    contextActivity,
    routingReady,
    guardrailRisk,
    preferences: () => ({ ...resolved.values }),
    get classifier() {
      return classifier;
    },
    dispose: disposeCurrent,
  };
}
export default async function extension(pi: ExtensionAPI) {
  await registerExtension(pi).routingReady;
}
