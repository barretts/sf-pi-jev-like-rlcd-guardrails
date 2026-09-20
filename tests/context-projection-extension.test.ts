import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { convertMessages } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import {
  registerTaskContextCompression,
  TASK_CONTEXT_READ_TOOL,
} from "../src/context-projection-extension.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const model: any = {
  id: "grok-4.6",
  api: "openai-completions",
  provider: "test",
  reasoning: false,
  input: ["text", "image"],
};
const task = "What is deploy alpha final_state, exit and retry_count?";
const source =
  Array.from(
    { length: 450 },
    (_, index) =>
      `cache shard_${index} digest=trace_${index.toString(16).padStart(8, "0")} metric=${index * 13} location=/build/cache/${index}\r\n`,
  ).join("") +
  "deploy alpha final_state=failed exit=17 retry_count=3\n" +
  "deploy beta final_state=ready exit=0 retry_count=1\n";
const tool = (text = source, changes: any = {}): any => ({
  role: "toolResult",
  toolCallId: "read-1",
  toolName: "read",
  timestamp: 12,
  isError: false,
  content: [{ type: "text", text }],
  details: { identity: "kept" },
  ...changes,
});
const assistant = (id = "read-1", name = "read"): any => ({
  role: "assistant",
  api: "openai-completions",
  provider: "test",
  model: "grok-4.6",
  content: [
    {
      type: "thinking",
      thinking: "Inspect the trace",
      thinkingSignature: "signature-kept",
    },
    { type: "toolCall", id, name, arguments: { path: "trace.txt" } },
  ],
  stopReason: "toolUse",
  timestamp: 10,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const messages = (text = source): any[] => [
  { role: "user", content: task, timestamp: 9 },
  assistant(),
  tool(text),
];
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function harness(
  options: Parameters<typeof registerTaskContextCompression>[1] = {},
) {
  const handlers = new Map<string, any[]>();
  const tools = new Map<string, any>([
    [
      "read",
      {
        name: "read",
        description: "Read authorized trace",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  ]);
  let active = ["read"];
  const pi: any = {
    on(name: string, fn: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    getActiveTools: vi.fn(() => active.slice()),
    setActiveTools: vi.fn((names: string[]) => {
      active = names.slice();
    }),
    getAllTools: vi.fn(() => [...tools.values()]),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    setModel: vi.fn(),
  };
  const controller = registerTaskContextCompression(pi, options);
  const ctx: any = { model, signal: undefined };
  return {
    pi,
    tools,
    controller,
    ctx,
    async emit(name: string, event: any = {}) {
      let result;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
    async start(prompt = task) {
      return this.emit("before_agent_start", {
        prompt,
        systemPrompt: "Existing system instructions",
        systemPromptOptions: {},
      });
    },
    async project(input: any[]) {
      return (
        (await this.emit("context", { type: "context", messages: input }))
          ?.messages ?? input
      );
    },
    payload(input: any[]) {
      return {
        model: "grok-4.6",
        messages: convertMessages(
          model,
          {
            systemPrompt: "Existing system instructions",
            messages: convertToLlm(input),
          },
          {} as any,
          {},
        ),
        tools: active.map((name) => ({
          type: "function",
          function: {
            name,
            description: tools.get(name).description,
            parameters: tools.get(name).parameters,
          },
        })),
        max_tokens: 4096,
      } as any;
    },
    async guard(payload: any) {
      return (
        (await this.emit("before_provider_request", { payload })) ?? payload
      );
    },
  };
}

it("defaults disabled with no instructions, archives or no-op host mutations", async () => {
  const h = harness();
  const input = freeze(messages());
  expect(await h.start()).toBeUndefined();
  expect(await h.project(input)).toBe(input);
  expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  expect(h.controller.status()).toMatchObject({
    enabled: false,
    strategy: "excerpts",
    targetReduction: 0.5,
    targetReached: false,
    originals: { sourceCount: 0 },
  });
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

it("offers no retrieval schema or extra instructions before any applied source", async () => {
  const h = harness({ enabled: true });
  expect(await h.start()).toBeUndefined();
  const raw = h.payload([{ role: "user", content: task, timestamp: 9 }]);
  const guarded = await h.guard(raw);
  expect(guarded.tools.map((row: any) => row.function.name)).toEqual(["read"]);
  expect(guarded.messages).toEqual(raw.messages);
  await expect(
    h.tools.get(TASK_CONTEXT_READ_TOOL).execute("early", {
      reference: "ctxorig_" + "0".repeat(48),
    }),
  ).rejects.toThrow("context-original-unavailable");
});

it("copies only source text and keeps errors, images, signatures, metadata and canonical order", async () => {
  const h = harness({ enabled: true });
  await h.start();
  const image = { type: "image", data: "AA==", mimeType: "image/png" };
  const input = freeze([
    messages()[0],
    assistant(),
    tool(source, {
      content: [image, { type: "text", text: source }],
      isError: true,
    }),
  ]);
  const original = JSON.stringify(input);
  const projected = await h.project(input);
  expect(projected).not.toBe(input);
  expect(projected[0]).toBe(input[0]);
  expect(projected[1]).toBe(input[1]);
  expect(projected[2]).not.toBe(input[2]);
  expect(projected[2].content[0]).toBe(image);
  expect(projected[2]).toMatchObject({
    toolCallId: "read-1",
    toolName: "read",
    isError: true,
    timestamp: 12,
    details: { identity: "kept" },
  });
  expect(projected[2].content[1].text).toContain(
    "deploy alpha final_state=failed",
  );
  expect(projected[2].content[1].text).toContain("omitted");
  expect(JSON.stringify(input)).toBe(original);
  const candidate = h.controller.status().candidate!;
  expect(candidate.blocks[0]).toMatchObject({
    messageIndex: 2,
    contentIndex: 1,
    toolResultOrdinal: 1,
    originalSha256: hash(source),
    compressedSha256: hash(projected[2].content[1].text),
  });
  const guarded = await h.guard(h.payload(projected));
  expect(
    guarded.messages.some(
      (message: any) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part: any) => part.type === "image_url"),
    ),
  ).toBe(true);
  expect(h.controller.status().targetReached).toBe(true);
});

it("gates on entire real SDK wire payload including schema, headers and annotation", async () => {
  const h = harness({ enabled: true });
  await h.start();
  const original = messages();
  const projected = await h.project(original);
  const raw = h.payload(projected);
  const rawSnapshot = JSON.stringify(raw);
  const guarded = await h.guard(raw);
  const baseline = h.payload(original);
  baseline.tools = baseline.tools.filter(
    (row: any) => row.function.name !== TASK_CONTEXT_READ_TOOL,
  );
  const status = h.controller.status();
  expect(status.candidate).toMatchObject({
    applied: true,
    targetReached: true,
    wholePayloadOriginalBytes: size(baseline),
    wholePayloadProjectedBytes: size(guarded),
    actualTokenMetrics: null,
  });
  expect(status.candidate!.actualByteReductionFraction).toBeGreaterThanOrEqual(
    0.5,
  );
  expect(size(guarded)).toBeLessThanOrEqual(size(baseline) / 2);
  expect(status.estimatedOriginalPromptTokens).toBe(
    Math.ceil(size(baseline) / 4),
  );
  expect(status.validatedProviderRequests).toBe(1);
  expect(guarded.messages[0].content).toContain(
    "omitted passages may contain facts",
  );
  expect(guarded.tools.map((row: any) => row.function.name)).toEqual([
    "read",
    TASK_CONTEXT_READ_TOOL,
  ]);
  expect(JSON.stringify(raw)).toBe(rawSnapshot);
});

it("uses the current task to choose passages and protects other conversation text", async () => {
  const h = harness({ enabled: true });
  await h.start("What is deploy beta final_state?");
  const projected = await h.project(messages());
  expect(projected[2].content[0].text).toContain(
    "deploy beta final_state=ready",
  );
  const other = {
    role: "user",
    content: "Protected narrative ".repeat(6000),
    timestamp: 11,
  };
  await h.start();
  const input = [...messages(), other];
  expect(await h.project(input)).toBe(input);
  expect(h.controller.status().projectionFallbackReason).toContain(
    "protected-floor",
  );
  const guarded = await h.guard(h.payload(input));
  expect(guarded.messages.at(-1).content).toBe(other.content);
  expect(guarded.tools.map((row: any) => row.function.name)).toEqual(["read"]);
});

it("restores originals and removes schema when actual envelope overhead makes 50% impossible", async () => {
  const h = harness({ enabled: true });
  await h.start();
  const projected = await h.project(messages());
  const raw = h.payload(projected);
  raw.extra_retained_context = "Protected wire field ".repeat(5000);
  const guarded = await h.guard(raw);
  expect(guarded.messages.find((row: any) => row.role === "tool").content).toBe(
    source,
  );
  expect(guarded.messages[0].content).toBe("Existing system instructions");
  expect(guarded.extra_retained_context).toBe(raw.extra_retained_context);
  expect(guarded.tools.map((row: any) => row.function.name)).toEqual(["read"]);
  expect(h.controller.status()).toMatchObject({
    targetReached: false,
    compressedBlocks: 0,
    restoredProviderRequests: 1,
    projectionFallbackReason: "target-unreachable:whole-request-overhead",
  });
  expect(
    h.controller.status().candidate!.actualByteReductionFraction,
  ).toBeLessThan(0.5);
});

it.each([
  "text",
  "order",
  "model",
  "schema",
  "missing-schema",
  "inactive-dispatch",
])("restores literal source on %s boundary mutation", async (mutation) => {
  const h = harness({ enabled: true });
  await h.start();
  const input = [
    ...messages(),
    assistant("read-2"),
    tool(source.replaceAll("alpha", "gamma"), { toolCallId: "read-2" }),
  ];
  const projected = await h.project(input);
  const raw = h.payload(projected);
  const wireTools = raw.messages.filter((row: any) => row.role === "tool");
  if (mutation === "text") wireTools[0].content += " changed";
  if (mutation === "order") {
    const one = raw.messages.indexOf(wireTools[0]);
    const two = raw.messages.indexOf(wireTools[1]);
    [raw.messages[one], raw.messages[two]] = [
      raw.messages[two],
      raw.messages[one],
    ];
  }
  if (mutation === "model") raw.model = "unattested-model";
  if (mutation === "schema")
    raw.tools.find(
      (row: any) => row.function.name === TASK_CONTEXT_READ_TOOL,
    ).function = {
      ...raw.tools.find(
        (row: any) => row.function.name === TASK_CONTEXT_READ_TOOL,
      ).function,
      description: "wrong",
    };
  if (mutation === "missing-schema")
    raw.tools = raw.tools.filter(
      (row: any) => row.function.name !== TASK_CONTEXT_READ_TOOL,
    );
  if (mutation === "inactive-dispatch") h.pi.setActiveTools(["read"]);
  const guarded = await h.guard(raw);
  expect(
    guarded.messages.find((row: any) => row.tool_call_id === "read-1").content,
  ).toBe(source);
  expect(guarded.tools.map((row: any) => row.function.name)).toEqual(["read"]);
  expect(h.controller.status().targetReached).toBe(false);
  expect(h.controller.status().restoredProviderRequests).toBe(1);
});

it.each(["rename", "role", "malformed"])(
  "returns complete literal fallback for %s identity loss",
  async (mutation) => {
    const h = harness({ enabled: true });
    await h.start();
    const projected = await h.project(messages());
    const raw = h.payload(projected);
    const result = raw.messages.find((row: any) => row.role === "tool");
    if (mutation === "rename") result.tool_call_id = "changed-id";
    if (mutation === "role") result.role = "user";
    if (mutation === "malformed") raw.messages = null;
    const guarded = await h.guard(raw);
    expect(
      guarded.messages.find((row: any) => row.tool_call_id === "read-1")
        .content,
    ).toBe(source);
    expect(JSON.stringify(guarded)).not.toContain(
      hash(projected[2].content[0].text),
    );
    expect(guarded.tools.map((row: any) => row.function.name)).toEqual([
      "read",
    ]);
    expect(h.controller.status()).toMatchObject({
      targetReached: false,
      restoredProviderRequests: 1,
      unverifiedProviderRequests: 1,
    });
  },
);

it.each(["off", "strategy", "branch", "session", "new-task", "settled"])(
  "retains immutable restoration across %s lifecycle invalidation",
  async (change) => {
    const h = harness({ enabled: true });
    await h.start();
    const projected = await h.project(messages());
    const raw = h.payload(projected);
    if (change === "off") h.controller.setEnabled(false);
    if (change === "strategy") h.controller.setStrategy("caveman");
    if (change === "branch") await h.emit("session_before_tree");
    if (change === "session") await h.emit("session_before_switch");
    if (change === "new-task") await h.start("A different question");
    if (change === "settled") await h.emit("agent_settled");
    const guarded = await h.guard(raw);
    expect(
      guarded.messages.find((row: any) => row.role === "tool").content,
    ).toBe(source);
    expect(guarded.tools.map((row: any) => row.function.name)).toEqual([
      "read",
    ]);
    expect(h.controller.status().targetReached).toBe(false);
  },
);

it("retrieves exact immutable originals with scoped bounds and rejects public accessors", async () => {
  const h = harness({ enabled: true });
  await h.start();
  await h.project(messages());
  const reference = h.controller.status().candidate!.blocks[0].reference;
  const retrieval = h.tools.get(TASK_CONTEXT_READ_TOOL);
  const response = await retrieval.execute("retrieve-1", {
    reference,
    offset: 1,
    limit: 2,
  });
  const decoded = JSON.parse(response.content[0].text);
  expect(decoded.text).toBe(
    source
      .split(/(?<=\n)/)
      .slice(0, 2)
      .join(""),
  );
  expect(decoded.source.sha256).toBe(hash(source));
  expect(decoded.nextOffset).toBe(3);
  expect(decoded.truncated).toBe(true);
  const getter = vi.fn(() => reference);
  await expect(
    retrieval.execute(
      "getter",
      Object.defineProperty({}, "reference", { get: getter }),
    ),
  ).rejects.toThrow("context-original-unavailable");
  expect(getter).not.toHaveBeenCalled();
  await expect(
    retrieval.execute("bad-path", { reference, path: "/any/file" }),
  ).rejects.toThrow("context-original-unavailable");
  await h.emit("session_before_fork");
  await expect(retrieval.execute("old-ref", { reference })).rejects.toThrow(
    "context-original-unavailable",
  );
});

it("keeps multipart text and retrieved originals literal", async () => {
  const h = harness({ enabled: true });
  await h.start();
  const input = [
    tool(source, {
      content: [
        { type: "text", text: source },
        { type: "text", text: "second" },
      ],
    }),
    tool(source, {
      toolCallId: "retrieval-1",
      toolName: TASK_CONTEXT_READ_TOOL,
    }),
  ];
  expect(await h.project(input)).toBe(input);
  expect(h.controller.status().originals.sourceCount).toBe(0);
});

it.each(["throw", "truncated", "oversized", "unavailable"])(
  "falls back to exact excerpts on %s caveman generation",
  async (failure) => {
    const summarize =
      failure === "unavailable"
        ? undefined
        : vi.fn((input: any) => {
            if (failure === "throw") throw new Error("private-error");
            return {
              text:
                failure === "oversized"
                  ? "x".repeat(input.maxOutputBytes + 1)
                  : "failed exit17",
              complete: failure !== "truncated",
            };
          });
    const h = harness({ enabled: true, strategy: "caveman", summarize });
    await h.start();
    const projected = await h.project(messages());
    expect(projected[2].content[0].text).toContain(
      "deploy alpha final_state=failed",
    );
    expect(h.controller.status().candidate!.blocks[0].format).toBe(
      "jev-tool-excerpts-v1",
    );
    expect(h.controller.status().candidate!.summarizerFallbacks).toBe(1);
    await h.guard(h.payload(projected));
    expect(h.controller.status().targetReached).toBe(true);
  },
);

it("uses only explicitly supplied complete bounded caveman fragments", async () => {
  const summarize = vi.fn((input: any) => ({
    text: "alpha failed; exit17; retries3",
    complete: true,
  }));
  const h = harness({ enabled: true, strategy: "caveman", summarize });
  await h.start();
  const projected = await h.project(messages());
  expect(summarize).toHaveBeenCalledOnce();
  expect(summarize.mock.calls[0][0]).toMatchObject({ task });
  expect(summarize.mock.calls[0][0].excerpt).toContain(
    "deploy alpha final_state=failed",
  );
  expect(projected[2].content[0].text).toContain(
    "alpha failed; exit17; retries3",
  );
  expect(h.controller.status().candidate!.blocks[0].format).toBe(
    "jev-caveman-v1",
  );
  expect(messages()[2].content[0].text).toBe(source);
  await h.guard(h.payload(projected));
  expect(h.controller.status().targetReached).toBe(true);
});

it("rejects unowned APIs and accepts only explicitly attested dispatcher targets", async () => {
  const h = harness({
    enabled: true,
    additionalSupportedModelApis: ["jev-routing-dispatch-v1"],
    allowedOpenAiTargetModelIds: ["grok-4.6", "grok-4.6"],
  });
  h.ctx.model = {
    ...model,
    api: "jev-routing-dispatch-v1",
    id: "own-dispatch",
  };
  await h.start();
  const projected = await h.project(messages());
  await h.guard(h.payload(projected));
  expect(h.controller.status().targetReached).toBe(true);
  h.ctx.model = { ...model, api: "unsupported" };
  await h.start();
  const input = messages();
  expect(await h.project(input)).toBe(input);
  expect(h.controller.status().projectionFallbackReason).toBe(
    "unsupported-provider",
  );
  expect(() =>
    harness({ additionalSupportedModelApis: ["arbitrary"] }),
  ).toThrow();
});

it("rejects bounds and aborts without changing originals or discovering models", async () => {
  const h = harness({ enabled: true, maxContextOriginalBytes: 1024 });
  await h.start();
  const input = messages();
  expect(await h.project(input)).toBe(input);
  expect(h.controller.status().projectionFallbackReason).toBe("context-limit");
  const normal = harness({ enabled: true });
  normal.ctx.signal = AbortSignal.abort();
  await normal.start();
  expect(await normal.project(input)).toBe(input);
  expect(normal.controller.status().projectionFallbackReason).toBe("cancelled");
  expect(normal.pi.setModel).not.toHaveBeenCalled();
});

it("restores a repeated exact owned provider projection with annotation and schema removed", async () => {
  const h = harness({ enabled: true });
  await h.start();
  const projected = await h.project(messages());
  const guarded = await h.guard(h.payload(projected));
  const repeated = await h.guard(guarded);
  expect(
    repeated.messages.find((row: any) => row.role === "tool").content,
  ).toBe(source);
  expect(repeated.messages[0].content).toBe("Existing system instructions");
  expect(repeated.tools.map((row: any) => row.function.name)).toEqual(["read"]);
  expect(h.controller.status().targetReached).toBe(false);
});

it("dispatches scoped retrieval through the installed SDK with fake streamed inference", async () => {
  const {
    DefaultResourceLoader,
    SettingsManager,
    SessionManager,
    createAgentSession,
    createEventBus,
    ModelRuntime,
  } = await import("@earendil-works/pi-coding-agent");
  const { AuthStorage } =
    await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js");
  const { InMemoryCodingAgentModelsStore } =
    await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js");
  const workspace = await mkdtemp(join(tmpdir(), "jev-projection-sdk-cpu-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error("CPU test forbids network");
  });
  let runtime: any;
  let session: any;
  let controller: ReturnType<typeof registerTaskContextCompression> | undefined;
  const observed: any[] = [];
  const events: any[] = [];
  const settings = SettingsManager.inMemory({
    packages: [],
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    enableAnalytics: false,
    enableInstallTelemetry: false,
  });
  try {
    runtime = await ModelRuntime.create({
      modelsPath: null,
      credentials: AuthStorage.inMemory(),
      modelsStore: new InMemoryCodingAgentModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("projection-cpu", {
      baseUrl: "https://cpu.invalid/v1",
      api: "openai-completions",
      models: [
        {
          id: "projection-cpu",
          name: "Invented CPU stream",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4096,
          compat: {
            supportsStore: false,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
          },
        },
      ],
    });
    await runtime.setRuntimeApiKey(
      "projection-cpu",
      "invented-cpu-placeholder",
    );
    const selected = runtime.getModel("projection-cpu", "projection-cpu")!;
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: join(workspace, "agent"),
      settingsManager: settings,
      eventBus: createEventBus(),
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          controller = registerTaskContextCompression(pi, { enabled: true });
        },
      ],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: workspace,
      agentDir: join(workspace, "agent"),
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace),
      modelRuntime: runtime,
      model: selected,
      thinkingLevel: "off",
      tools: ["read", TASK_CONTEXT_READ_TOOL],
      customTools: [
        {
          name: "read",
          label: "Read invented trace",
          description: "Read trace.txt",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          async execute(_id: string, args: any) {
            expect(args).toEqual({ path: "trace.txt" });
            return {
              content: [{ type: "text", text: source }],
              details: { cpu: true },
            };
          },
        },
      ],
    }));
    await session.bindExtensions({
      mode: "print",
      onError(error: any) {
        events.push({ extensionError: error.event });
      },
    });
    session.subscribe((event: any) => {
      if (event.type === "tool_execution_end") events.push(event);
    });
    const fetch = async (_url: unknown, options: any) => {
      const body = JSON.parse(options.body);
      observed.push(body);
      const call = (id: string, name: string, args: unknown) => ({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      let delta: any;
      let finish: string;
      if (observed.length === 1) {
        expect(body.tools.map((entry: any) => entry.function.name)).toEqual([
          "read",
        ]);
        delta = call("read-sdk-1", "read", { path: "trace.txt" });
        finish = "tool_calls";
      } else if (observed.length === 2) {
        expect(body.tools.map((entry: any) => entry.function.name)).toContain(
          TASK_CONTEXT_READ_TOOL,
        );
        const excerpt = body.messages.find(
          (message: any) => message.role === "tool",
        ).content;
        const reference = excerpt.match(/ctxorig_[a-f0-9]{48}/)?.[0];
        expect(reference).toBeDefined();
        delta = call("retrieve-sdk-1", TASK_CONTEXT_READ_TOOL, {
          reference,
          offset: 451,
          limit: 2,
        });
        finish = "tool_calls";
      } else {
        expect(observed.length).toBe(3);
        const retrieved = JSON.parse(
          body.messages.filter((message: any) => message.role === "tool").at(-1)
            .content,
        );
        expect(retrieved.text).toBe(
          source
            .split(/(?<=\n)/)
            .slice(450)
            .join(""),
        );
        delta = { role: "assistant", content: '{"done":true}' };
        finish = "stop";
      }
      const text =
        `data: ${JSON.stringify({ id: "cpu", model: "projection-cpu", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n` +
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 25,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        })}\n\ndata: [DONE]\n\n`;
      return new Response(text, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    session.agent.streamFunction = (
      selectedModel: any,
      context: any,
      options: any,
    ) =>
      runtime.streamSimple(selectedModel, context, {
        ...options,
        fetch,
        maxTokens: 4096,
      });
    await session.prompt(task, { expandPromptTemplates: false });
    expect(observed).toHaveLength(3);
    expect(
      events.filter((event) => event.type === "tool_execution_end"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.isError || event.extensionError),
    ).toEqual([]);
    const canonical = session.agent.state.messages.filter(
      (message: any) => message.role === "toolResult",
    );
    expect(canonical[0].content[0].text).toBe(source);
    expect(canonical[1].toolName).toBe(TASK_CONTEXT_READ_TOOL);
    expect(JSON.parse(canonical[1].content[0].text).source.sha256).toBe(
      hash(source),
    );
    expect(controller!.status().validatedProviderRequests).toBe(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    if (runtime) await runtime.removeRuntimeApiKey("projection-cpu");
    globalThis.fetch = originalFetch;
    await rm(workspace, { recursive: true, force: true });
  }
});
