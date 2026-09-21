import { it, expect, vi } from "vitest";
import {
  Classifier,
  configFromEnv,
  Overloaded,
  type InferenceAdapter,
} from "../src/backend.js";
import { registerExtension, ToolSchema } from "../src/extension.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { GUARDRAIL_PROVIDER_EVENT } from "../src/guardrail.js";
import { createServer } from "../src/server.js";
import { preparePrompt } from "../src/core.js";
const config = configFromEnv({ JEV_MODEL_ID: "gemma" });
const input = {
  state: "A bicycle.",
  questions: [
    {
      id: "x",
      type: "choice",
      instructions: "What?",
      criteria: [
        { id: "yes", description: null },
        { id: "no", description: null },
      ],
    },
  ],
};
function fake(): InferenceAdapter {
  return {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async (p) => p),
    evaluate: vi.fn(async () => ({
      logits: { "0": { A: 3, B: 1 } },
      input_tokens: 42,
      metrics: { engine_forwards: 2 },
    })),
    dispose: vi.fn(async () => {}),
  };
}
it("invokes real factory and tool handler with no initialization at registration", async () => {
  const backend = fake(),
    riskBackend = vi.fn(fake),
    tools: any[] = [],
    commands: any[] = [],
    events: any[] = [],
    pi: any = {
      events: createEventBus(),
      registerTool: (t: any) => tools.push(t),
      registerCommand: (name: string, c: any) => commands.push({ name, ...c }),
      on: (name: string, h: any) => events.push({ name, h }),
    };
  const extension = registerExtension(pi, config, backend, {
    guardrailRisk: { env: {}, createBackend: riskBackend },
  });
  expect(backend.warmup).not.toHaveBeenCalled();
  expect(backend.compile).not.toHaveBeenCalled();
  expect(tools.map((t) => t.name)).toEqual([
    "jev_context_read",
    "jev_classify",
    "jev_classify_loaded",
  ]);
  expect(commands.some((command) => command.name === "jev")).toBe(true);
  expect(commands.some((command) => command.name === "jev-context")).toBe(true);
  expect(commands.some((command) => command.name === "jev-risk")).toBe(true);
  expect(events.some((event) => event.name === "session_shutdown")).toBe(true);
  const discovery = { version: 1, providers: [] as any[] };
  pi.events.emit(GUARDRAIL_PROVIDER_EVENT, discovery);
  expect(discovery.providers).toHaveLength(1);
  expect(discovery.providers[0]).toBe(extension.guardrailRisk.provider);
  await commands
    .find((command) => command.name === "jev-risk")
    .handler("status", {
      ui: { notify: vi.fn() },
    });
  expect(extension.guardrailRisk.status()).toMatchObject({
    state: "cold",
    qualified: false,
    modelSha256: null,
  });
  expect(riskBackend).not.toHaveBeenCalled();
  const result = await tools
    .find((tool) => tool.name === "jev_classify")
    .execute("test", input, undefined, undefined, {});
  expect(result.details.answers.x.choice).toBe("yes");
  expect(JSON.parse(result.content[0].text).usage.output_tokens).toBe(0);
  for (const event of events.filter(
    (event) => event.name === "session_shutdown",
  ))
    await event.h();
  expect(backend.dispose).toHaveBeenCalledOnce();
  expect(riskBackend).not.toHaveBeenCalled();
});
it("exposes a serializable tool schema", () =>
  expect(JSON.parse(JSON.stringify(ToolSchema)).properties.questions.type).toBe(
    "array",
  ));
it("enforces queue capacity and releases requests after errors", async () => {
  let release!: () => void;
  const backend = fake();
  backend.evaluate = vi.fn(async () => {
    await new Promise<void>((r) => (release = r));
    return { logits: { "0": { A: 0, B: 0 } }, input_tokens: 1, metrics: {} };
  });
  const c = new Classifier(config, backend);
  const active = c.classify({ ...input, model: "gemma" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const waiting = Array.from({ length: 16 }, () =>
    c.classify({ ...input, model: "gemma" }),
  );
  await expect(c.classify({ ...input, model: "gemma" })).rejects.toBeInstanceOf(
    Overloaded,
  );
  backend.evaluate = fake().evaluate;
  release();
  await Promise.all([active, ...waiting]);
  await c.dispose();
});
it("cancels queued work before invoking inference", async () => {
  const backend = fake(),
    c = new Classifier(config, backend),
    signal = AbortSignal.abort(new DOMException("cancelled", "AbortError"));
  await expect(
    c.classify({ ...input, model: "gemma" }, signal),
  ).rejects.toThrow();
  expect(backend.compile).not.toHaveBeenCalled();
});
it("serves both aliases, schema, docs, errors, and gated diagnostics", async () => {
  const c = new Classifier(config, fake()),
    app = await createServer(config, c, false);
  const payload = {
    model: "gemma",
    state: "A bicycle.",
    questions: {
      x: {
        type: "choice",
        instructions: "What?",
        criteria: { yes: null, no: null },
      },
    },
  };
  for (const url of ["/v1/classifier", "/v1/systemone"]) {
    const r = await app.inject({ method: "POST", url, payload });
    expect(r.statusCode).toBe(200);
    expect(r.json().answers.x.choice).toBe("yes");
  }
  expect((await app.inject("/health")).json()).toEqual({
    status: "ready",
    model: "gemma",
  });
  const schema = (await app.inject("/openapi.json")).json();
  expect(schema.paths["/v1/classifier"]).toBeDefined();
  expect(schema.paths["/v1/systemone"]).toBeUndefined();
  expect((await app.inject("/docs/")).statusCode).toBe(200);
  expect((await app.inject("/redoc")).statusCode).toBe(200);
  const bad = await app.inject({
    method: "POST",
    url: "/v1/classifier",
    payload: { ...payload, model: "wrong" },
  });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().error.type).toBe("invalid_request_error");
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/classifier",
        headers: { "content-type": "application/json" },
        payload: "{bad",
      })
    ).statusCode,
  ).toBe(422);
  await app.close();
});
it("cancels a waiting request promptly while preserving execution order", async () => {
  const backend = fake();
  let release!: () => void;
  backend.evaluate = vi.fn(async () => {
    await new Promise<void>((r) => (release = r));
    return { logits: { "0": { A: 0, B: 0 } }, input_tokens: 1, metrics: {} };
  });
  const c = new Classifier(config, backend);
  const active = c.classify({ ...input, model: "gemma" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const abort = new AbortController();
  const queued = c.classify({ ...input, model: "gemma" }, abort.signal);
  abort.abort();
  await expect(queued).rejects.toThrow("Cancelled");
  const next = c.classify({ ...input, model: "gemma" });
  expect(backend.evaluate).toHaveBeenCalledTimes(1);
  backend.evaluate = fake().evaluate;
  release();
  await Promise.all([active, next]);
  await c.dispose();
});
it("recovers the queue after a backend failure", async () => {
  const backend = fake(),
    c = new Classifier(config, backend);
  vi.mocked(backend.evaluate).mockRejectedValueOnce(
    new Error("forward failed"),
  );
  await expect(c.classify({ ...input, model: "gemma" })).rejects.toThrow(
    "forward failed",
  );
  expect((await c.classify({ ...input, model: "gemma" })).answers.x.type).toBe(
    "choice",
  );
  await c.dispose();
});
it("returns HTTP overload and generic runtime failure without leaking inputs", async () => {
  const c = new Classifier(config, fake()),
    app = await createServer(config, c, false);
  const body = {
    model: "gemma",
    state: "private context",
    questions: { x: { type: "noul", instructions: null } },
  };
  vi.spyOn(c, "classify").mockRejectedValueOnce(new Overloaded());
  let r = await app.inject({
    method: "POST",
    url: "/v1/classifier",
    payload: body,
  });
  expect(r.statusCode).toBe(429);
  expect(r.headers["retry-after"]).toBe("1");
  vi.mocked(c.classify).mockRejectedValueOnce(new Error("private context"));
  r = await app.inject({
    method: "POST",
    url: "/v1/classifier",
    payload: body,
  });
  expect(r.statusCode).toBe(500);
  expect(r.body).not.toContain("private context");
  await app.close();
});
