import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createRoutingDispatcher,
  registerRoutingDispatcher,
  ROUTING_DISPATCHER_API,
  ROUTING_DISPATCHER_PROVIDER,
  type RoutingAssistantMessage,
  type RoutingClassification,
  type RoutingContext,
  type RoutingDispatcherDependencies,
  type RoutingEventStream,
  type RoutingModel,
  type RoutingRegistry,
  type RoutingStreamOptions,
} from "../src/routing-extension.js";

const peerPackage = findPackageJSON(
  "@earendil-works/pi-ai",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { createAssistantMessageEventStream } = (await import(
  new URL("./dist/utils/event-stream.js", pathToFileURL(peerPackage!)).href
)) as { createAssistantMessageEventStream: () => RoutingEventStream };
const artifactSha256 = "a".repeat(64);
const qualification = {
  qualified: true,
  artifactId: "synthetic-cpu-artifact",
  artifactSha256,
  qualificationSha256: "b".repeat(64),
};
const model = (provider: string, id = "grok-4.6"): RoutingModel => ({
  provider,
  id,
  api: "openai-completions",
  baseUrl: "http://127.0.0.1/synthetic",
  name: "CPU mock",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 8_192,
  maxTokens: 256,
});
const capturedModel = model(ROUTING_DISPATCHER_PROVIDER, "current-request");
capturedModel.api = ROUTING_DISPATCHER_API;
const context = (): RoutingContext => ({
  systemPrompt: "Trusted system policy.",
  messages: [{ role: "user", content: "Return exactly OK.", timestamp: 1 }],
  tools: [
    {
      name: "check",
      description: "CPU fixture",
      parameters: { type: "object" },
    },
  ],
});
const classification = (
  route: RoutingClassification["route"] = "fast",
): RoutingClassification => ({
  route,
  confidence: 0.99,
  complete: true,
  artifactId: qualification.artifactId,
  artifactSha256,
});
function message(target: RoutingModel): RoutingAssistantMessage {
  return {
    role: "assistant",
    api: target.api,
    provider: target.provider,
    model: target.id,
    content: [{ type: "text", text: "OK" }],
    timestamp: 2,
    stopReason: "stop",
    usage: {
      input: 17,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 19,
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.01,
        cacheWrite: 0,
        total: 0.31,
      },
    },
  };
}
function successfulStream(target: RoutingModel) {
  const stream = createAssistantMessageEventStream();
  const answer = message(target);
  stream.push({ type: "start", partial: answer });
  stream.push({ type: "done", reason: "stop", message: answer });
  stream.end();
  return stream;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<RoutingDispatcherDependencies> = {}) {
  const calls: Array<{
    model: RoutingModel;
    context: RoutingContext;
    options: RoutingStreamOptions;
  }> = [];
  const generate = vi.fn(
    (
      target: RoutingModel,
      incoming: RoutingContext,
      options: RoutingStreamOptions,
    ) => {
      calls.push({ model: target, context: incoming, options });
      return successfulStream(target);
    },
  );
  const auth = vi.fn(async () => ({
    ok: true as const,
    apiKey: "synthetic-target-key",
    headers: {
      Authorization: "synthetic-target-auth",
      "X-Trace": "target-trace",
    },
    env: { SYNTHETIC_TARGET: "yes" },
  }));
  const registry: RoutingRegistry = {
    getApiKeyAndHeaders: auth,
    getProvider: vi.fn(() => ({
      streamSimple: generate,
    })) as RoutingRegistry["getProvider"],
  };
  const classify = vi.fn(async () => classification());
  const guard = vi.fn(() => ({ eligibleForFast: true }));
  const controller = createRoutingDispatcher({
    mode: "auto",
    targets: {
      fast: { model: model("synthetic-fast"), lineage: "xai-grok" },
      strong: { model: model("synthetic-strong"), lineage: "xai-grok" },
    },
    registry,
    qualification,
    classify,
    evaluateEligibility: guard,
    createEventStream: createAssistantMessageEventStream,
    isUsageObserved: () => true,
    ...overrides,
  });
  return { controller, calls, generate, registry, auth, classify, guard };
}
async function collect(stream: RoutingEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

describe("current-request routing dispatcher", () => {
  it("dispatches the captured current request fast while preserving context, tools, callbacks and usage", async () => {
    const h = setup();
    const incoming = context();
    const controller = new AbortController();
    const onPayload = vi.fn();
    const answer = await collect(
      h.controller.streamSimple(capturedModel, incoming, {
        signal: controller.signal,
        maxTokens: 512,
        onPayload,
        apiKey: "synthetic-dispatcher-key",
        env: { SYNTHETIC_DISPATCHER: "drop" },
        headers: {
          authorization: "synthetic-dispatcher-auth",
          Cookie: "drop",
          "X-AMZ-Security-Token": "drop",
          "X-Trace": "caller",
          "X-Correlation": "keep",
        },
      }),
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model.provider).toBe("synthetic-fast");
    expect(h.calls[0].context).toEqual(incoming);
    expect(h.calls[0].context).not.toBe(incoming);
    expect(h.calls[0].options).toMatchObject({
      signal: controller.signal,
      maxTokens: 256,
      onPayload,
      apiKey: "synthetic-target-key",
      env: { SYNTHETIC_TARGET: "yes" },
      headers: {
        Authorization: "synthetic-target-auth",
        "X-Trace": "target-trace",
        "X-Correlation": "keep",
      },
    });
    expect(h.calls[0].options.headers).not.toHaveProperty("Cookie");
    expect(h.calls[0].options.headers).not.toHaveProperty("authorization");
    expect(h.calls[0].options.headers).not.toHaveProperty(
      "X-AMZ-Security-Token",
    );
    expect(answer.events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(answer.result.usage).toEqual(message(h.calls[0].model).usage);
    expect(h.guard.mock.calls[0][1]).toMatchObject({
      classification: { route: "fast", confidence: 0.99 },
      qualification,
      mode: "auto",
    });
    expect(h.controller.status().lastRequest).toMatchObject({
      decision: "fast",
      selectedTarget: "synthetic-fast/grok-4.6",
      completed: true,
      usageKnown: true,
      cancelled: false,
    });
  });

  it("isolates classifier and guard mutations from the canonical provider context", async () => {
    const incoming = context();
    const before = structuredClone(incoming);
    const h = setup({
      classify: async (copy) => {
        copy.messages.length = 0;
        return classification();
      },
      evaluateEligibility: (copy) => {
        copy.systemPrompt = "untrusted";
        return { eligibleForFast: true };
      },
    });
    await collect(h.controller.streamSimple(capturedModel, incoming));
    expect(incoming).toEqual(before);
    expect(h.calls[0].context).toEqual(incoming);
    expect(h.calls[0].context).not.toBe(incoming);
  });

  it.each(["off", "strong"] as const)(
    "%s selects strong without any classifier work",
    async (mode) => {
      const h = setup({ mode });
      await collect(h.controller.streamSimple(capturedModel, context()));
      expect(h.calls[0].model.provider).toBe("synthetic-strong");
      expect(h.classify).not.toHaveBeenCalled();
      expect(h.guard).not.toHaveBeenCalled();
      expect(h.controller.status().totals.classified).toBe(0);
    },
  );

  it("shadow records the fast decision but executes the actual strong target", async () => {
    const h = setup({ mode: "shadow" });
    await collect(h.controller.streamSimple(capturedModel, context()));
    expect(h.calls[0].model.provider).toBe("synthetic-strong");
    expect(h.controller.status().lastRequest).toMatchObject({
      decision: "strong",
      shadowDecision: "fast",
    });
  });

  it("late mode changes affect the next request, leaving the active stream's captured decision intact", async () => {
    const waiting = deferred<RoutingClassification>();
    const entered = deferred<boolean>();
    const h = setup({
      classify: async () => {
        entered.resolve(true);
        return waiting.promise;
      },
    });
    const active = h.controller.streamSimple(capturedModel, context());
    await entered.promise;
    h.controller.setMode("strong");
    waiting.resolve(classification());
    await collect(active);
    await collect(h.controller.streamSimple(capturedModel, context()));
    expect(h.calls.map((call) => call.model.provider)).toEqual([
      "synthetic-fast",
      "synthetic-strong",
    ]);
  });

  it.each([
    [
      "incomplete",
      { ...classification(), complete: false },
      "classification-incomplete",
    ],
    ["unknown", classification("uncertain"), "classification-uncertain"],
    [
      "wrong artifact",
      { ...classification(), artifactSha256: "c".repeat(64) },
      "classification-artifact-mismatch",
    ],
    [
      "wrong artifact id",
      { ...classification(), artifactId: "other" },
      "classification-artifact-mismatch",
    ],
  ] as const)(
    "%s classification falls back strong",
    async (_name, result, reason) => {
      const h = setup({ classify: async () => result });
      await collect(h.controller.streamSimple(capturedModel, context()));
      expect(h.calls[0].model.provider).toBe("synthetic-strong");
      expect(h.controller.status().lastFallback).toBe(reason);
    },
  );

  it.each(["auto", "fast"] as const)(
    "%s never bypasses the guard on a fast branch",
    async (mode) => {
      const h = setup({
        mode,
        evaluateEligibility: () => ({
          eligibleForFast: false,
          reason: "missing-essential-fact",
        }),
      });
      await collect(h.controller.streamSimple(capturedModel, context()));
      expect(h.calls[0].model.provider).toBe("synthetic-strong");
      expect(h.controller.status().lastFallback).toBe("input-ineligible");
    },
  );

  it("unqualified and forged qualification pins are fail-closed without classification", async () => {
    for (const proof of [
      { ...qualification, qualified: false },
      { ...qualification, qualificationSha256: "invalid" },
    ]) {
      const h = setup({ qualification: proof });
      await collect(h.controller.streamSimple(capturedModel, context()));
      expect(h.calls[0].model.provider).toBe("synthetic-strong");
      expect(h.classify).not.toHaveBeenCalled();
      expect(h.controller.status().qualified).toBe(false);
    }
  });

  it("classifier failures and timeouts safely dispatch strong without replaying inference", async () => {
    const failures = setup({
      classify: async () => {
        throw new Error("synthetic-private-value");
      },
    });
    const failingAnswer = await collect(
      failures.controller.streamSimple(capturedModel, context()),
    );
    expect(failingAnswer.result.stopReason).toBe("stop");
    expect(failures.controller.status().lastFallback).toBe(
      "classification-failed",
    );
    expect(JSON.stringify(failures.controller.status())).not.toContain(
      "synthetic-private-value",
    );
    const timeout = setup({
      classificationTimeoutMs: 5,
      classify: async () => new Promise(() => {}),
    });
    await collect(timeout.controller.streamSimple(capturedModel, context()));
    expect(timeout.calls[0].model.provider).toBe("synthetic-strong");
    expect(timeout.controller.status().lastFallback).toBe(
      "classification-timeout",
    );
    expect(timeout.controller.status().totals.classified).toBe(1);
  });

  it("cancels blocked classification immediately and never starts generation after its late result", async () => {
    const waiting = deferred<RoutingClassification>();
    const entered = deferred<AbortSignal>();
    const h = setup({
      classify: async (_context, options) => {
        entered.resolve(options.signal);
        return waiting.promise;
      },
    });
    const controller = new AbortController();
    const response = collect(
      h.controller.streamSimple(capturedModel, context(), {
        signal: controller.signal,
      }),
    );
    const classifierSignal = await entered.promise;
    controller.abort();
    const answer = await response;
    expect(classifierSignal.aborted).toBe(true);
    expect(answer.result.stopReason).toBe("aborted");
    expect(h.calls).toHaveLength(0);
    waiting.resolve(classification());
    await Promise.resolve();
    expect(h.calls).toHaveLength(0);
    expect(h.controller.status().lastRequest?.usageKnown).toBe(false);
  });

  it("cancels uncancellable registry auth and ignores its late credential result", async () => {
    const waiting = deferred<{ ok: true; apiKey: string }>();
    const entered = deferred<boolean>();
    const h = setup({ mode: "strong" });
    h.auth.mockImplementation(async () => {
      entered.resolve(true);
      return waiting.promise as ReturnType<typeof h.auth>;
    });
    const controller = new AbortController();
    const response = collect(
      h.controller.streamSimple(capturedModel, context(), {
        signal: controller.signal,
      }),
    );
    await entered.promise;
    controller.abort();
    expect((await response).result.stopReason).toBe("aborted");
    waiting.resolve({ ok: true, apiKey: "synthetic-late-key" });
    await Promise.resolve();
    expect(h.calls).toHaveLength(0);
  });

  it("forwards live tool/text events and cancels a stalled generation without waiting for iterator return", async () => {
    const h = setup();
    const started = deferred<boolean>();
    h.generate.mockImplementation((target, incoming, options) => {
      h.calls.push({ model: target, context: incoming, options });
      const inner = createAssistantMessageEventStream();
      const partial = message(target);
      inner.push({ type: "start", partial });
      inner.push({ type: "text_delta", contentIndex: 0, delta: "OK", partial });
      started.resolve(true);
      return inner;
    });
    const controller = new AbortController();
    const response = collect(
      h.controller.streamSimple(capturedModel, context(), {
        signal: controller.signal,
      }),
    );
    await started.promise;
    controller.abort();
    const answer = await response;
    expect(answer.result.stopReason).toBe("aborted");
    expect(answer.result.provider).toBe("synthetic-fast");
    expect(h.calls[0].options.signal).toBe(controller.signal);
    expect(h.calls).toHaveLength(1);
  });

  it("retries strong only when fast target setup fails, recording the failed attempt", async () => {
    const h = setup();
    h.auth.mockImplementation(async (target?: RoutingModel) =>
      target?.provider === "synthetic-fast"
        ? ({ ok: false, error: "synthetic-private-auth-error" } as never)
        : { ok: true, apiKey: "synthetic-strong-key", headers: {}, env: {} },
    );
    await collect(h.controller.streamSimple(capturedModel, context()));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model.provider).toBe("synthetic-strong");
    expect(h.controller.status().lastRequest).toMatchObject({
      fallbackReason: "target-auth-unavailable",
      dispatchAttempts: [
        { target: "synthetic-fast/grok-4.6", setupFailed: true },
        { target: "synthetic-strong/grok-4.6", setupFailed: false },
      ],
    });
    expect(JSON.stringify(h.controller.status())).not.toContain(
      "synthetic-private-auth-error",
    );
  });

  it("measures operational router latency through delayed authentication and fast setup fallback", async () => {
    const h = setup();
    h.auth.mockImplementation(async (target?: RoutingModel) => {
      await new Promise((complete) => setTimeout(complete, 15));
      return target?.provider === "synthetic-fast"
        ? ({ ok: false, error: "CPU setup failure" } as never)
        : { ok: true, apiKey: "synthetic-strong-key", headers: {}, env: {} };
    });
    await collect(h.controller.streamSimple(capturedModel, context()));
    const receipt = h.controller.status().lastRequest!;
    expect(receipt.routerElapsedMs).toBeGreaterThanOrEqual(25);
    expect(receipt.routerElapsedMs).toBeGreaterThan(receipt.decisionElapsedMs);
    expect(receipt.dispatchAttempts).toHaveLength(2);
  });

  it("does not call usage known from SDK zero placeholders without transport evidence", async () => {
    const h = setup({ isUsageObserved: undefined });
    h.generate.mockImplementation((target) => {
      const inner = createAssistantMessageEventStream();
      const answer = message(target);
      answer.usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      inner.push({ type: "start", partial: answer });
      inner.push({ type: "done", reason: "stop", message: answer });
      inner.end();
      return inner;
    });
    await collect(h.controller.streamSimple(capturedModel, context()));
    expect(h.controller.status().lastRequest?.usageKnown).toBe(false);
  });

  it("refuses auth endpoint changes before exposing a credential to a provider", async () => {
    const h = setup({ mode: "strong" });
    h.auth.mockImplementation(async () => ({
      ok: true,
      apiKey: "synthetic-target-key",
      headers: {},
      env: {},
      baseUrl: "https://unapproved.example.invalid/v1",
    }));
    const answer = await collect(
      h.controller.streamSimple(capturedModel, context()),
    );
    expect(answer.result.stopReason).toBe("error");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.controller.status().lastFallback).toBe("target-endpoint-changed");
  });

  it("pins the active target endpoint while classification waits, and strips unknown credential headers", async () => {
    const fast = {
      model: model("synthetic-fast"),
      lineage: "xai-grok" as const,
    };
    const waiting = deferred<RoutingClassification>();
    const entered = deferred<boolean>();
    const h = setup({
      targets: {
        fast,
        strong: { model: model("synthetic-strong"), lineage: "xai-grok" },
      },
      classify: async () => {
        entered.resolve(true);
        return waiting.promise;
      },
    });
    const response = collect(
      h.controller.streamSimple(capturedModel, context(), {
        headers: {
          "X-Credential": "drop",
          "X-Token": "drop",
          "X-Trace": "keep",
        },
      }),
    );
    await entered.promise;
    fast.model.baseUrl = "https://new-config.example.invalid/v1";
    waiting.resolve(classification());
    await response;
    expect(h.calls[0].model.baseUrl).toBe("http://127.0.0.1/synthetic");
    expect(h.calls[0].options.headers).not.toHaveProperty("X-Credential");
    expect(h.calls[0].options.headers).not.toHaveProperty("X-Token");
  });

  it("does not retry generation after a provider terminal error, preserving reported usage", async () => {
    const h = setup();
    h.generate.mockImplementation((target) => {
      const inner = createAssistantMessageEventStream();
      const partial = {
        ...message(target),
        stopReason: "error" as const,
        errorMessage: "CPU mock error",
      };
      inner.push({ type: "start", partial });
      inner.push({ type: "error", reason: "error", error: partial });
      inner.end();
      return inner;
    });
    const answer = await collect(
      h.controller.streamSimple(capturedModel, context()),
    );
    expect(answer.result.stopReason).toBe("error");
    expect(answer.result.usage.totalTokens).toBe(19);
    expect(h.generate).toHaveBeenCalledOnce();
    expect(h.controller.status().lastRequest?.completed).toBe(false);
  });

  it("sanitizes provider terminal error bodies and causes while preserving attribution, content and observed usage", async () => {
    const h = setup();
    h.generate.mockImplementation((target) => {
      const inner = createAssistantMessageEventStream();
      const partial = message(target);
      inner.push({ type: "start", partial });
      const error = Object.assign(
        partial,
        {
          stopReason: "error" as const,
          errorMessage: "APIError 401 synthetic-private-credential",
        },
        {
          cause: {
            authorization: "synthetic-private-credential",
            body: "synthetic-private-credential",
          },
          body: "synthetic-private-credential",
          diagnostics: [{ message: "synthetic-private-credential" }],
        },
      );
      inner.push({ type: "error", reason: "error", error });
      inner.end();
      return inner;
    });
    const answer = await collect(
      h.controller.streamSimple(capturedModel, context()),
    );
    expect(answer.result.stopReason).toBe("error");
    expect(answer.result.errorMessage).toBe(
      "Model routing failed before the response completed.",
    );
    expect(answer.result.provider).toBe("synthetic-fast");
    expect(answer.result.content).toEqual([{ type: "text", text: "OK" }]);
    expect(answer.result.usage).toEqual(message(model("synthetic-fast")).usage);
    expect(h.controller.status().lastRequest?.usageKnown).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(
      "synthetic-private-credential",
    );
    expect(answer.result).not.toHaveProperty("cause");
    expect(answer.result).not.toHaveProperty("body");
    expect(answer.result).not.toHaveProperty("diagnostics");
    expect(h.generate).toHaveBeenCalledOnce();
  });

  it("rejects attribution/protocol violations and exhausted streams without hanging on result", async () => {
    for (const invalid of [
      "wrong-provider",
      "missing-start",
      "missing-terminal",
    ] as const) {
      const h = setup();
      h.generate.mockImplementation((target) => {
        const inner = createAssistantMessageEventStream();
        const partial = message(target);
        if (invalid === "wrong-provider") partial.provider = "synthetic-wrong";
        if (invalid !== "missing-start") inner.push({ type: "start", partial });
        if (invalid !== "missing-terminal")
          inner.push({ type: "done", reason: "stop", message: partial });
        inner.end();
        return inner;
      });
      const answer = await collect(
        h.controller.streamSimple(capturedModel, context()),
      );
      expect(answer.result.stopReason).toBe("error");
      expect(h.generate).toHaveBeenCalledOnce();
    }
  });

  it("blocks forbidden aliases even with a false lineage attestation and rejects recursive dispatch", async () => {
    for (const id of ["qwen", "gpt-5.6-luna", "current-request"]) {
      const target = model(
        id === "current-request" ? ROUTING_DISPATCHER_PROVIDER : "synthetic",
        id,
      );
      const h = setup({
        targets: {
          fast: { model: target, lineage: "xai-grok" },
          strong: { model: model("synthetic-strong"), lineage: "xai-grok" },
        },
      });
      await collect(h.controller.streamSimple(capturedModel, context()));
      expect(h.calls[0].model.provider).toBe("synthetic-strong");
      expect(h.classify).not.toHaveBeenCalled();
    }
  });

  it("uses strong for images when the approved fast target supports only text", async () => {
    const fast = model("synthetic-fast");
    fast.input = ["text"];
    const h = setup({
      targets: {
        fast: { model: fast, lineage: "xai-grok" },
        strong: { model: model("synthetic-strong"), lineage: "xai-grok" },
      },
    });
    const incoming = context();
    incoming.messages = [
      {
        role: "user",
        content: [{ type: "image", data: "synthetic", mimeType: "image/png" }],
        timestamp: 1,
      },
    ];
    await collect(h.controller.streamSimple(capturedModel, incoming));
    expect(h.calls[0].model.provider).toBe("synthetic-strong");
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.controller.status().lastFallback).toBe(
      "fast-target-input-unsupported",
    );
  });

  it("uses the captured request if the caller adds images while classification is pending", async () => {
    const fast = model("synthetic-fast");
    fast.input = ["text"];
    const waiting = deferred<RoutingClassification>();
    const entered = deferred<boolean>();
    const h = setup({
      targets: {
        fast: { model: fast, lineage: "xai-grok" },
        strong: { model: model("synthetic-strong"), lineage: "xai-grok" },
      },
      classify: async () => {
        entered.resolve(true);
        return waiting.promise;
      },
    });
    const incoming = context();
    const before = structuredClone(incoming);
    const response = collect(
      h.controller.streamSimple(capturedModel, incoming),
    );
    await entered.promise;
    incoming.messages.push({
      role: "user",
      content: [{ type: "image", data: "synthetic", mimeType: "image/png" }],
      timestamp: 2,
    });
    waiting.resolve(classification());
    const answer = await response;
    expect(answer.result.stopReason).toBe("stop");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model.provider).toBe("synthetic-fast");
    expect(h.calls[0].context).toEqual(before);
    expect(h.calls[0].context).not.toBe(incoming);
    expect(h.controller.status().lastRequest).toMatchObject({
      decision: "fast",
      dispatchAttempts: [
        { target: "synthetic-fast/grok-4.6", setupFailed: false },
      ],
    });
  });

  it("executes the exact classified and guarded context when messages and tool schemas mutate during authentication", async () => {
    const h = setup();
    const incoming = context();
    const before = structuredClone(incoming);
    const waiting = deferred<{
      ok: true;
      apiKey: string;
      headers: {};
      env: {};
    }>();
    const entered = deferred<boolean>();
    h.auth.mockImplementation(async () => {
      entered.resolve(true);
      return waiting.promise;
    });
    const response = collect(
      h.controller.streamSimple(capturedModel, incoming),
    );
    await entered.promise;
    incoming.systemPrompt = "Changed policy after routing.";
    incoming.messages[0].content = "Changed user request after routing.";
    incoming.tools![0].parameters = {
      type: "object",
      properties: { changed: { type: "string" } },
    };
    waiting.resolve({
      ok: true,
      apiKey: "synthetic-target-key",
      headers: {},
      env: {},
    });
    expect((await response).result.stopReason).toBe("stop");
    expect(h.calls[0].model.provider).toBe("synthetic-fast");
    expect(h.calls[0].context).toEqual(before);
    expect(h.calls[0].context).toEqual(h.classify.mock.calls[0][0]);
    expect(h.calls[0].context).toEqual(h.guard.mock.calls[0][0]);
    expect(h.calls[0].context).not.toBe(incoming);
  });

  it("reports unsupported strong input without authenticating or starting generation", async () => {
    const strong = model("synthetic-strong");
    strong.input = ["text"];
    const h = setup({
      mode: "strong",
      targets: { strong: { model: strong, lineage: "xai-grok" } },
    });
    const incoming = context();
    incoming.messages = [
      {
        role: "user",
        content: [{ type: "image", data: "synthetic", mimeType: "image/png" }],
        timestamp: 1,
      },
    ];
    const answer = await collect(
      h.controller.streamSimple(capturedModel, incoming),
    );
    expect(answer.result.stopReason).toBe("error");
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.controller.status().lastFallback).toBe("target-input-unsupported");
  });

  it("preserves every text/thinking/tool event in provider order and keeps its terminal result authoritative", async () => {
    const h = setup();
    const controller = new AbortController();
    h.generate.mockImplementation((target) => {
      const inner = createAssistantMessageEventStream();
      const answer = message(target);
      inner.push({ type: "start", partial: answer });
      inner.push({ type: "thinking_start", contentIndex: 0, partial: answer });
      inner.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "check",
        partial: answer,
      });
      inner.push({
        type: "thinking_end",
        contentIndex: 0,
        content: "check",
        partial: answer,
      });
      inner.push({ type: "toolcall_start", contentIndex: 1, partial: answer });
      inner.push({
        type: "toolcall_delta",
        contentIndex: 1,
        delta: "{}",
        partial: answer,
      });
      inner.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "fixture-call",
          name: "check",
          arguments: {},
        },
        partial: answer,
      });
      inner.push({ type: "text_start", contentIndex: 2, partial: answer });
      inner.push({
        type: "text_delta",
        contentIndex: 2,
        delta: "OK",
        partial: answer,
      });
      inner.push({
        type: "text_end",
        contentIndex: 2,
        content: "OK",
        partial: answer,
      });
      inner.push({ type: "done", reason: "stop", message: answer });
      inner.end();
      return inner;
    });
    const stream = h.controller.streamSimple(capturedModel, context(), {
      signal: controller.signal,
    });
    const answer = await collect(stream);
    controller.abort();
    expect(answer.events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect((await stream.result()).stopReason).toBe("stop");
    expect(h.controller.status().lastRequest?.cancelled).toBe(false);
  });

  it("keeps receipts private and stale completions cannot replace the most recent request status", async () => {
    const waiting = deferred<RoutingClassification>();
    let call = 0;
    const h = setup({
      classify: async () =>
        ++call === 1 ? waiting.promise : classification("strong"),
      onRequest: () => {
        throw new Error("observer-error");
      },
    });
    const first = h.controller.streamSimple(capturedModel, context());
    await Promise.resolve();
    const second = h.controller.streamSimple(capturedModel, context());
    await collect(second);
    waiting.resolve(classification());
    await collect(first);
    expect(h.controller.status().lastRequest?.requestId).toBe(2);
    expect(h.controller.status().lastRequest?.decision).toBe("strong");
    expect(JSON.stringify(h.controller.status())).not.toContain(
      "Trusted system policy",
    );
    expect(JSON.stringify(h.controller.status())).not.toContain(
      "synthetic-target-key",
    );
  });

  it("registers a public custom provider without late hooks, global settings writes or selecting a model", async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((name: string, handler: Function) =>
        handlers.set(name, handler),
      ),
      registerProvider: vi.fn(),
      setModel: vi.fn(),
    };
    const h = setup();
    const registered = await registerRoutingDispatcher(pi as never, {
      targets: {
        strong: { model: model("synthetic-strong"), lineage: "xai-grok" },
      },
      createEventStream: createAssistantMessageEventStream,
    });
    expect(pi.registerProvider).toHaveBeenCalledWith(
      ROUTING_DISPATCHER_PROVIDER,
      expect.objectContaining({
        streamSimple: registered.streamSimple,
        authHeader: false,
      }),
    );
    expect(handlers.has("before_agent_start")).toBe(false);
    expect(pi.setModel).not.toHaveBeenCalled();
    handlers.get("session_start")!({}, { modelRegistry: h.registry });
    expect(
      (await collect(registered.streamSimple(capturedModel, context()))).result
        .stopReason,
    ).toBe("stop");
    handlers.get("session_shutdown")!();
    expect(
      (await collect(registered.streamSimple(capturedModel, context()))).result
        .stopReason,
    ).toBe("error");
  });

  it("loads the peer utility from an ESM-only nested Pi installation without an added root dependency", async () => {
    const pi = { on: vi.fn(), registerProvider: vi.fn() };
    const registered = await registerRoutingDispatcher(pi as never);
    const answer = await collect(
      registered.streamSimple(capturedModel, context()),
    );
    expect(answer.result.stopReason).toBe("error");
    expect(registered.status().lastRequest?.usageKnown).toBe(false);
  });
});
