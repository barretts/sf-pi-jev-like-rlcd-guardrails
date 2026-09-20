#!/usr/bin/env node
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  Classifier,
  NativeBackend,
  Overloaded,
  configFromEnv,
  type Config,
} from "./backend.js";
import { InvalidRequest } from "./core.js";
import { parseHttpRequest } from "./http-input.js";
const entry = {
  anyOf: [
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "null" },
  ],
};
const question = {
  oneOf: [
    {
      type: "object",
      required: ["type", "instructions", "criteria"],
      properties: {
        type: { const: "choice" },
        instructions: entry,
        criteria: {
          type: "object",
          minProperties: 2,
          maxProperties: 50,
          additionalProperties: entry,
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "instructions", "criteria"],
      properties: {
        type: { const: "score" },
        instructions: entry,
        criteria: { type: "array", minItems: 2, maxItems: 50, items: entry },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "instructions"],
      properties: {
        type: { const: "noul" },
        instructions: entry,
        criteria: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: { true: entry, false: entry },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
  ],
};
export const HttpSchema = {
  type: "object",
  required: ["model", "questions"],
  properties: {
    model: { type: "string", minLength: 1 },
    state: entry,
    messages: {
      anyOf: [
        { type: "null" },
        {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["role", "content"],
            properties: {
              role: { enum: ["system", "developer", "user", "assistant"] },
              content: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      ],
    },
    questions: {
      type: "object",
      minProperties: 1,
      maxProperties: 256,
      propertyNames: { minLength: 1 },
      additionalProperties: question,
    },
    options: {
      type: "object",
      properties: { raw_logits: { type: "boolean" } },
      additionalProperties: false,
    },
    tools: { anyOf: [{ type: "null" }, { type: "array", maxItems: 0 }] },
    mm_processor_kwargs: {
      anyOf: [{ type: "null" }, { type: "object", maxProperties: 0 }],
    },
    media_io_kwargs: {
      anyOf: [{ type: "null" }, { type: "object", maxProperties: 0 }],
    },
  },
  additionalProperties: true,
};
export async function createServer(
  config: Config = configFromEnv(),
  classifier = new Classifier(config),
  initialize = true,
) {
  const app = Fastify({ bodyLimit: 8 * 1024 * 1024, logger: false });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Jev classifier", version: "0.1.0" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  // Validation uses the ordered parser rather than AJV, which sees reordered keys.
  app.setValidatorCompiler(() => () => true);
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof Overloaded)
      return reply
        .code(429)
        .header("Retry-After", "1")
        .send({ detail: "Scoring queue is full" });
    if (error instanceof InvalidRequest)
      return reply.code(422).send({
        error: {
          message: error.message,
          type: "invalid_request_error",
          code: 422,
          param: error.param,
          details: error.param
            ? [
                {
                  param: error.param,
                  message: error.message,
                  type: "value_error",
                },
              ]
            : [],
        },
      });
    if (error instanceof Error && error.name === "AbortError")
      return reply.code(499).send({ detail: "Client disconnected" });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: {
        message:
          status === 500
            ? "Model execution failed"
            : error instanceof Error
              ? error.message
              : "Request failed",
        type: "server_error",
        code: status,
        param: null,
        details: [],
      },
    });
  });
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const abort = new AbortController();
    const close = () => {
      if (!reply.raw.writableEnded)
        abort.abort(new DOMException("Client disconnected", "AbortError"));
    };
    reply.raw.on("close", close);
    try {
      return await classifier.classify(
        parseHttpRequest(request.body as string),
        abort.signal,
      );
    } finally {
      reply.raw.removeListener("close", close);
    }
  };
  app.post("/v1/classifier", { schema: { body: HttpSchema } }, handler);
  app.post("/v1/systemone", { schema: { hide: true } }, handler);
  let ready = !initialize;
  app.get("/health", async (_req, reply) =>
    ready &&
    (!(classifier.backend instanceof NativeBackend) ||
      classifier.backend.isReady)
      ? { status: "ready", model: config.modelId }
      : reply.code(503).send({ status: "initializing", model: config.modelId }),
  );
  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
  app.get("/redoc", { schema: { hide: true } }, async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        '<!doctype html><html><head><title>Jev API</title></head><body><redoc spec-url="/openapi.json"></redoc><script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script></body></html>',
      ),
  );
  app.addHook("onClose", async () => classifier.dispose());
  try {
    if (initialize) {
      await classifier.backend.warmup();
      ready = true;
    }
    await app.ready();
    return app;
  } catch (e) {
    await classifier.dispose();
    throw e;
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      "model-file": { type: "string" },
      device: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8000" },
      "max-model-len": { type: "string", default: "16384" },
      "max-batch-size": { type: "string", default: "32" },
      "max-batch-tokens": { type: "string", default: "32768" },
      "max-request-branches": { type: "string", default: "100" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "jev-server --model-file APPROVED_GEMMA.gguf [--model ID] [--device auto|cpu|metal] [--host 127.0.0.1] [--port 8000] [--max-model-len 16384] [--max-batch-size 32] [--max-batch-tokens 32768] [--max-request-branches 100]",
    );
    return;
  }
  const config = configFromEnv({
    ...process.env,
    ...(values["model-file"] ? { JEV_MODEL_FILE: values["model-file"] } : {}),
    ...(values.model ? { JEV_MODEL_ID: values.model } : {}),
    ...(values.device ? { JEV_DEVICE: values.device } : {}),
  });
  for (const [key, flag] of [
    ["maxModelLen", "max-model-len"],
    ["maxBatchSize", "max-batch-size"],
    ["maxBatchTokens", "max-batch-tokens"],
    ["maxRequestBranches", "max-request-branches"],
  ] as const) {
    const n = Number(values[flag]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid --${flag}`);
    config[key] = n;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  const app = await createServer(config);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void app.close());
  console.log(await app.listen({ host: values.host, port }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
