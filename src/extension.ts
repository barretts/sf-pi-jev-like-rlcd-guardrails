import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Classifier,
  NativeBackend,
  configFromEnv,
  type Config,
  type InferenceAdapter,
} from "./backend.js";
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
        { raw_logits: Type.Optional(Type.Boolean()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export function registerExtension(
  pi: ExtensionAPI,
  config: Config = configFromEnv(),
  backend: InferenceAdapter = new NativeBackend(config),
) {
  const classifier = new Classifier(config, backend);
  let ready = false;
  pi.registerTool({
    name: "jev_classify",
    label: "Jev Classify",
    description:
      "Classify explicitly supplied context using ordered choices, rubrics, or truth judgments with a local Gemma model. Confidence and truth scores are uncalibrated. Questions and choice candidates are ordered arrays with IDs. This tool supplies advisory answers and does not authorize other actions.",
    parameters: ToolSchema,
    async execute(_id, params, signal) {
      const result = await classifier.classify(
        { ...params, model: config.modelId },
        signal,
      );
      ready = true;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
  pi.registerCommand("jev", {
    description: "Local Gemma classifier: status, doctor, warmup",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      let result: unknown;
      if (action === "status")
        result = {
          model: config.modelId,
          device: config.device,
          configured: !!config.modelFile,
          ready: backend instanceof NativeBackend ? backend.isReady : ready,
        };
      else if (action === "doctor")
        result =
          backend instanceof NativeBackend
            ? await backend.doctor()
            : { backend: "custom" };
      else if (action === "warmup") {
        await backend.warmup();
        ready = true;
        result = { ready: true, model: config.modelId };
      } else throw new Error("Usage: /jev [status|doctor|warmup]");
      if (ctx.hasUI) ctx.ui.notify(JSON.stringify(result), "info");
      else
        pi.sendMessage(
          {
            customType: "jev-status",
            content: JSON.stringify(result),
            display: true,
          },
          { triggerTurn: false },
        );
    },
  });
  pi.on("session_shutdown", async () => {
    ready = false;
    await classifier.dispose();
  });
  return classifier;
}
export default function extension(pi: ExtensionAPI) {
  registerExtension(pi);
}
