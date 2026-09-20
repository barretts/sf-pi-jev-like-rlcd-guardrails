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
import { openJevInManager, registerManager } from "./manager.js";
import {
  readPreferences,
  writePreferences,
  DEFAULT_PREFERENCES,
  type Preferences,
  type SettingsScope,
} from "./preferences.js";
const JsonSchema = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
  },
  "Json",
);
const EntrySchema = Type.Union([
  Type.Null(),
  Type.String(),
  Type.Array(JsonSchema),
  Type.Record(Type.String(), JsonSchema),
]);
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
export function registerExtension(
  pi: ExtensionAPI,
  config: Config = configFromEnv(),
  initialBackend?: InferenceAdapter,
  options: {
    cwd?: string;
    agentDir?: string;
    createBackend?: (config: Config) => InferenceAdapter;
  } = {},
) {
  let cwd = options.cwd ?? process.cwd();
  let resolved = readPreferences(cwd, options.agentDir);
  let backend = initialBackend;
  let classifier: Classifier | undefined;
  let ready = false;
  let stopped = false;
  let retirement: Promise<void> = Promise.resolve();
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
    requested_device: config.device,
    configured: !!config.modelFile,
    ready: backend instanceof NativeBackend ? backend.isReady : ready,
    preferences: { ...resolved.values },
    preference_sources: { ...resolved.sources },
  });
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
    retirement = retirement.then(async () => {
      if (current) await current.dispose();
      else if (currentBackend) await currentBackend.dispose();
    });
    await retirement;
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
    )
      await disposeCurrent();
  };
  // This handler is first so shutdown remains available even on minimal hosts.
  pi.on("session_shutdown", async () => {
    stopped = true;
    await disposeCurrent();
  });
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    const previous = resolved.values;
    resolved = readPreferences(cwd, options.agentDir);
    if (
      !resolved.values.enabled ||
      previous.templateVersion !== resolved.values.templateVersion
    )
      await disposeCurrent();
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
  pi.registerTool({
    name: "jev_classify",
    label: "Jev Classify",
    description:
      "Classify explicitly supplied context using ordered choices, rubrics, or truth judgments with a local Gemma model. Confidence and truth scores are uncalibrated. Questions and choice candidates are ordered arrays with IDs. This tool supplies advisory answers and does not authorize other actions.",
    parameters: ToolSchema,
    async execute(_id, params, signal) {
      const result = await classify(params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
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
    preferences: () => ({ ...resolved.values }),
    get classifier() {
      return classifier;
    },
    dispose: disposeCurrent,
  };
}
export default function extension(pi: ExtensionAPI) {
  registerExtension(pi);
}
