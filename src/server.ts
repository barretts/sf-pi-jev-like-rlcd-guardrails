#!/usr/bin/env node
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import {
  Classifier,
  NativeBackend,
  Overloaded,
  DeadlineExceeded,
  configFromEnv,
  type Config,
} from "./backend.js";
import { InvalidRequest } from "./core.js";
import { parseHttpRequest } from "./http-input.js";
import { registerWeb } from "./web.js";

export function assertLoopbackHost(host: string | undefined = "127.0.0.1") {
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error(
      "Jev serves loopback only: use 127.0.0.1, ::1, or localhost",
    );
}

function localAuthority(authority: string) {
  try {
    if (/[\s/@\\]/.test(authority)) return null;
    const url = new URL("http://" + authority);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function trustedRequest(
  host: string | undefined,
  origin: string | undefined,
  listeningPort?: number,
) {
  if (!host) return false;
  const authority = localAuthority(host);
  if (!authority) return false;
  if (listeningPort != null && Number(authority.port || "80") !== listeningPort)
    return false;
  if (!origin) return true;
  try {
    const browser = new URL(origin);
    return (
      browser.origin === authority.origin &&
      browser.href === browser.origin + "/"
    );
  } catch {
    return false;
  }
}
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
      properties: {
        raw_logits: { type: "boolean" },
        template_version: { enum: ["v1", "v2"] },
      },
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
  workspace = process.cwd(),
) {
  const app = Fastify({ bodyLimit: 256 * 1024, logger: false });
  const listen = app.listen.bind(app);
  app.listen = ((options: any, ...args: any[]) => {
    try {
      assertLoopbackHost(options?.host);
    } catch (error) {
      const callback = args[0];
      if (typeof callback === "function") {
        callback(error);
        return;
      }
      return Promise.reject(error);
    }
    return (listen as any)(options, ...args);
  }) as typeof app.listen;
  app.addHook("onRequest", async (request, reply) => {
    const address = app.server.address();
    const port =
      address && typeof address === "object" ? address.port : undefined;
    if (!trustedRequest(request.headers.host, request.headers.origin, port))
      return reply.code(403).send({
        error: {
          code: "untrusted_origin",
          message: "Use the same loopback origin as this server",
        },
      });
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers["content-type"] ?? "",
      )
    )
      return reply.code(415).send({
        error: {
          code: "json_required",
          message: "Writes require application/json",
        },
      });
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header("Referrer-Policy", "no-referrer");
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Jev classifier", version: "0.1.0" },
    },
  });
  registerWeb(app, config, workspace);
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
    if (error instanceof DeadlineExceeded)
      return reply.code(504).send({
        error: {
          message: error.message,
          type: "timeout_error",
          code: "deadline_exceeded",
          stage: error.stage,
          param: null,
          details: [],
        },
      });
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
  app.get(
    "/api/status",
    { schema: { hide: true } },
    async () => classifier.status,
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
export async function serverMain(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" },
      "model-file": { type: "string" },
      device: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      workspace: { type: "string" },
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
  assertLoopbackHost(values.host);
  const app = await createServer(config, undefined, true, values.workspace);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void app.close());
  console.log(await app.listen({ host: values.host, port }));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  serverMain().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
