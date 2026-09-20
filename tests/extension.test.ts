import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { configFromEnv, type InferenceAdapter } from "../src/backend.js";
import { registerExtension, ToolSchema } from "../src/extension.js";
import { writePreferences } from "../src/preferences.js";
import {
  MANAGER_DISCOVERY_EVENT,
  type ExternalDescriptor,
} from "../src/manager.js";
import type { Plan } from "../src/core.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "jev-extension-"));
  directories.push(directory);
  return {
    cwd: join(directory, "project"),
    agentDir: join(directory, "agent"),
  };
}
function adapter(): InferenceAdapter {
  return {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async (plan) => plan),
    evaluate: vi.fn(async (compiled) => ({
      logits: Object.fromEntries(
        (compiled as Plan).questions.map((branch) => [
          branch.branch_id,
          Object.fromEntries(
            branch.output_labels.map((label, index) => [
              label,
              index === 0 ? 10 : 0,
            ]),
          ),
        ]),
      ),
      input_tokens: 12,
      metrics: {},
    })),
    dispose: vi.fn(async () => {}),
  };
}
function harness() {
  const tools: any[] = [],
    commands = new Map<string, any>(),
    handlers = new Map<string, any[]>();
  const pi: any = {
    events: createEventBus(),
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    on: (name: string, handler: any) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    getActiveTools: vi.fn(() => ["read", "jev_classify", "sf_apex"]),
    getAllTools: vi.fn(() => [
      {
        name: "read",
        sourceInfo: { source: "builtin", path: "<builtin:read>" },
      },
    ]),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendMessage: vi.fn(),
  };
  const context: any = {
    cwd: "",
    hasUI: true,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [],
      getEntries: () => [],
    },
  };
  return {
    pi,
    tools,
    commands,
    context,
    async emit(name: string, event: unknown = {}) {
      const responses: unknown[] = [];
      for (const handler of handlers.get(name) ?? [])
        responses.push(await handler(event, context));
      return responses.filter((response) => response !== undefined);
    },
  };
}
const input = {
  state: "The vehicle is a bicycle.",
  questions: [
    {
      id: "vehicle",
      type: "choice",
      instructions: "Which vehicle?",
      criteria: [
        { id: "bicycle", description: "A bicycle" },
        { id: "car", description: "A car" },
      ],
    },
  ],
};

it("registers a v2-default tool and cache-only Manager descriptor without creating a backend", async () => {
  const paths = await environment(),
    h = harness(),
    createBackend = vi.fn(adapter);
  h.context.cwd = paths.cwd;
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "gemma" }),
    undefined,
    { ...paths, createBackend },
  );
  await h.emit("session_start");
  const request = {
    version: 1,
    cwd: paths.cwd,
    scope: "project",
    extensions: [] as ExternalDescriptor[],
  };
  h.pi.events.emit(MANAGER_DISCOVERY_EVENT, request);
  expect(createBackend).not.toHaveBeenCalled();
  expect(request.extensions[0]).toMatchObject({ id: "jev", enabled: true });
  expect(request.extensions[1]).toMatchObject({
    id: "jev-context",
    enabled: false,
  });
  expect(controller.contextCompression.status().enabled).toBe(false);
  await h.commands.get("jev-context").handler("on", h.context);
  expect(controller.contextCompression.status().enabled).toBe(true);
  expect(createBackend).not.toHaveBeenCalled();
  await expect(
    h.commands.get("jev-context").handler("on global", h.context),
  ).rejects.toThrow("Usage: /jev-context");
  await h.commands.get("jev-context").handler("off", h.context);
  expect(controller.contextCompression.status().enabled).toBe(false);
  expect(controller.preferences()).toEqual({
    enabled: true,
    routing: false,
    evaluation: false,
    templateVersion: "v2",
  });
  await h.commands.get("jev").handler("status", h.context);
  expect(createBackend).not.toHaveBeenCalled();
  const result = await h.tools[0].execute("tool", input);
  expect(result.details.metadata.template_version).toBe("v2");
  expect(JSON.parse(result.content[0].text)).toMatchObject({
    advisory: true,
    calibrated: false,
    answers: [{ id: "vehicle", choice: "bicycle" }],
  });
  expect(createBackend).toHaveBeenCalledOnce();
  expect(
    JSON.parse(JSON.stringify(ToolSchema)).properties.options.properties
      .template_version,
  ).toBeDefined();
  await h.emit("session_shutdown");
});

it("classifies an explicitly referenced builtin read and invalidates it at the next session", async () => {
  const paths = await environment(),
    h = harness(),
    backend = adapter();
  h.context.cwd = paths.cwd;
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "google/gemma-3-1b-it" }),
    backend,
    paths,
  );
  await h.emit("session_start");
  const raw = JSON.stringify({
    records: [
      { id: "first", request: input },
      { id: "second", request: input },
    ],
  });
  const readEvent = {
    type: "tool_result",
    toolName: "read",
    toolCallId: "observed-read",
    input: { path: "review-input.json" },
    isError: false,
    content: [{ type: "text", text: raw }],
  };
  const changes = (await h.emit("tool_result", readEvent)) as any[];
  expect(changes[0].content[0]).toEqual(readEvent.content[0]);
  expect(changes[0].content[1].text).toContain(
    '"read_tool_call_id":"observed-read"',
  );
  expect(backend.warmup).not.toHaveBeenCalled();
  const tool = h.tools.find(
    (registered) => registered.name === "jev_classify_loaded",
  );
  const result = await tool.execute("classify-read", {
    read_tool_call_id: "observed-read",
  });
  const visible = JSON.parse(result.content[0].text);
  expect(visible.records.map((record: any) => record.id)).toEqual([
    "first",
    "second",
  ]);
  expect(visible.usage).toEqual({ input_tokens: 24, output_tokens: 0 });
  expect(result.details.results).toHaveLength(2);
  expect(result.details.results[0].response.metadata.template_version).toBe(
    "v2",
  );
  expect(controller.status().loaded_requests).toMatchObject({ entries: 1 });
  expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  await h.emit("session_start");
  await expect(
    tool.execute("stale", { read_tool_call_id: "observed-read" }),
  ).rejects.toThrow("absent, evicted, or superseded");
  await h.emit("session_shutdown");
});

it("keeps partial native responses in a progress receipt and fails the loaded tool after a later error", async () => {
  const paths = await environment(),
    h = harness(),
    backend = adapter();
  h.context.cwd = paths.cwd;
  const evaluate = backend.evaluate;
  let calls = 0;
  backend.evaluate = vi.fn(async (...args) => {
    if (++calls === 2) throw new Error("native failure");
    return evaluate(...args);
  });
  registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "google/gemma-3-1b-it" }),
    backend,
    paths,
  );
  await h.emit("session_start");
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "read-for-failure",
    input: { path: "requests.json" },
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          records: [
            { id: "one", request: input },
            { id: "two", request: input },
          ],
        }),
      },
    ],
  });
  const update = vi.fn();
  const tool = h.tools.find(
    (registered) => registered.name === "jev_classify_loaded",
  );
  await expect(
    tool.execute(
      "failed",
      { read_tool_call_id: "read-for-failure" },
      undefined,
      update,
    ),
  ).rejects.toThrow("native failure");
  expect(update).toHaveBeenCalledOnce();
  expect(JSON.parse(update.mock.calls[0][0].content[0].text)).toMatchObject({
    status: "incomplete",
    completed_records: 1,
    total_records: 2,
  });
  expect(
    update.mock.calls[0][0].details.results[0].response.answers.vehicle.choice,
  ).toBe("bicycle");
  const actualReceipt = structuredClone(update.mock.calls[0][0].details);
  update.mock.calls[0][0].details.results.length = 0;
  const final = (await h.emit("tool_result", {
    type: "tool_result",
    toolName: "jev_classify_loaded",
    toolCallId: "failed",
    input: { read_tool_call_id: "read-for-failure" },
    isError: true,
    content: [{ type: "text", text: "native failure" }],
    details: {},
  })) as any[];
  expect(final[0].details).toEqual(actualReceipt);
  await h.emit("session_shutdown");
});

it("persists an incomplete loaded receipt through pi's actual thrown-error tool_result path and consumes it", async () => {
  const paths = await environment(),
    backend = adapter();
  await Promise.all([
    mkdir(paths.cwd, { recursive: true }),
    mkdir(paths.agentDir, { recursive: true }),
  ]);
  await writeFile(
    join(paths.cwd, "requests.json"),
    JSON.stringify({
      records: [
        { id: "one", request: input },
        { id: "two", request: input },
      ],
    }),
  );
  const evaluate = backend.evaluate;
  let calls = 0;
  backend.evaluate = vi.fn(async (...args) => {
    if (++calls === 2) throw new Error("native failure");
    return evaluate(...args);
  });
  let controller!: ReturnType<typeof registerExtension>;
  const observedFinalResults: any[] = [];
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    ...paths,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        controller = registerExtension(
          pi,
          configFromEnv({ JEV_MODEL_ID: "google/gemma-3-1b-it" }),
          backend,
          paths,
        );
        pi.on("tool_result", (event) => {
          if (event.toolName === "jev_classify_loaded")
            observedFinalResults.push(structuredClone(event));
        });
      },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const model: any = {
    id: "integration-harness",
    name: "Non-generating test harness",
    provider: "local-test",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 1024,
  };
  const { session } = await createAgentSession({
    ...paths,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.create(
      paths.cwd,
      join(paths.agentDir, "sessions"),
    ),
    tools: ["read", "jev_classify_loaded"],
  });
  const updates: any[] = [],
    executions: any[] = [],
    extensionErrors: any[] = [];
  session.extensionRunner.onError((error) => extensionErrors.push(error));
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_update") updates.push(event);
    if (event.type === "tool_execution_end") executions.push(event);
  });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected provider request"));
  try {
    await session.bindExtensions({ mode: "print" });
    session.modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: "unused-harness",
      models: [model],
    });
    let turns = 0;
    // Authored dispatch exercises the installed SDK, without a model call.
    session.agent.streamFunction = (currentModel) => {
      const turn = ++turns;
      expect(turn).toBeLessThanOrEqual(3);
      const reason = turn < 3 ? "toolUse" : "stop";
      const message: any = {
        role: "assistant",
        content:
          turn === 1
            ? [
                {
                  type: "toolCall",
                  id: "sdk-read",
                  name: "read",
                  arguments: { path: "requests.json" },
                },
              ]
            : turn === 2
              ? [
                  {
                    type: "toolCall",
                    id: "sdk-loaded-failure",
                    name: "jev_classify_loaded",
                    arguments: { read_tool_call_id: "sdk-read" },
                  },
                ]
              : [{ type: "text", text: "The batch was incomplete." }],
        api: currentModel.api,
        provider: currentModel.provider,
        model: currentModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: reason,
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason, message });
      return stream;
    };
    await session.prompt("Read requests.json and classify its loaded bundle.", {
      expandPromptTemplates: false,
    });
    expect(turns).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(extensionErrors).toEqual([]);
    expect(backend.evaluate).toHaveBeenCalledTimes(2);
    const completed = executions.find(
      (event) => event.toolName === "jev_classify_loaded",
    );
    expect(completed.isError).toBe(true);
    const final = session.agent.state.messages.findLast(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "jev_classify_loaded",
    ) as any;
    expect(final.isError).toBe(true);
    expect(final.content[0].text).toContain("native failure");
    expect(JSON.parse(final.content[1].text)).toMatchObject({
      status: "incomplete",
      failure_kind: "classification_failed",
      completed_records: 1,
      total_records: 2,
      source: { read_tool_call_id: "sdk-read", source_path: "requests.json" },
    });
    const partialUpdate = updates.find(
      (event) => event.toolName === "jev_classify_loaded",
    );
    expect(final.details).toEqual(partialUpdate.partialResult.details);
    expect(final.details.results[0].response.answers.vehicle.choice).toBe(
      "bicycle",
    );
    expect(final.details.results[0].response.usage.input_tokens).toBe(12);
    expect(observedFinalResults[0].details).toEqual(final.details);
    expect(controller.status().pending_loaded_failure_receipts).toBe(0);
    const persisted = (
      await readFile(session.sessionManager.getSessionFile()!, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "jev_classify_loaded",
      );
    expect(persisted.message.isError).toBe(true);
    expect(persisted.message.details).toEqual(final.details);
    const duplicate = await session.extensionRunner.emitToolResult({
      ...observedFinalResults[0],
      content: [{ type: "text", text: "Unrelated later error" }],
      details: {},
    });
    expect(duplicate).toBeUndefined();
  } finally {
    fetch.mockRestore();
    unsubscribe();
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
});

async function failingLoadedHarness() {
  const paths = await environment(),
    h = harness(),
    backend = adapter();
  h.context.cwd = paths.cwd;
  backend.evaluate = vi.fn(async () => {
    throw new Error("native failure");
  });
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "google/gemma-3-1b-it" }),
    backend,
    paths,
  );
  await h.emit("session_start");
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "failed-read",
    input: { path: "requests.json" },
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({ records: [{ id: "one", request: input }] }),
      },
    ],
  });
  const tool = h.tools.find(
    (registered) => registered.name === "jev_classify_loaded",
  );
  const finalError = (id: string, overrides: Record<string, unknown> = {}) => ({
    type: "tool_result",
    toolName: "jev_classify_loaded",
    toolCallId: id,
    input: { read_tool_call_id: "failed-read" },
    isError: true,
    content: [{ type: "text", text: "native failure" }],
    details: {},
    ...overrides,
  });
  return { paths, h, backend, controller, tool, finalError };
}

it.each(["session_start", "session_shutdown", "disable", "template"])(
  "clears pending failure receipts at %s without attaching them to a later result",
  async (boundary) => {
    const { paths, h, controller, tool, finalError } =
      await failingLoadedHarness();
    await expect(
      tool.execute("failure", { read_tool_call_id: "failed-read" }),
    ).rejects.toThrow("native failure");
    expect(controller.status().pending_loaded_failure_receipts).toBe(1);
    if (boundary === "disable")
      await controller.apply(paths.cwd, "project", { enabled: false });
    else if (boundary === "template")
      await controller.apply(paths.cwd, "project", { templateVersion: "v1" });
    else await h.emit(boundary);
    expect(controller.status().pending_loaded_failure_receipts).toBe(0);
    expect(await h.emit("tool_result", finalError("failure"))).toEqual([]);
    await h.emit("session_shutdown");
  },
);

it("bounds unconsumed failure receipts and isolates the matching errored loaded call", async () => {
  const { h, controller, tool, finalError } = await failingLoadedHarness();
  for (let index = 0; index < 19; index++)
    await expect(
      tool.execute(`failure-${index}`, { read_tool_call_id: "failed-read" }),
    ).rejects.toThrow("native failure");
  expect(controller.status().pending_loaded_failure_receipts).toBe(17);
  expect(await h.emit("tool_result", finalError("failure-0"))).toEqual([]);
  expect(
    await h.emit("tool_result", finalError("failure-18", { toolName: "read" })),
  ).toEqual([]);
  expect(
    await h.emit("tool_result", finalError("failure-18", { isError: false })),
  ).toEqual([]);
  expect(controller.status().pending_loaded_failure_receipts).toBe(17);
  const attached = (await h.emit(
    "tool_result",
    finalError("failure-18"),
  )) as any[];
  expect(attached[0]).toMatchObject({
    isError: true,
    details: { total_records: 1, results: [] },
  });
  expect(controller.status().pending_loaded_failure_receipts).toBe(16);
  // Reused execution IDs must lose their old receipt even when resolving the
  // new reference fails before inference starts.
  await expect(
    tool.execute("failure-17", { read_tool_call_id: "missing-read" }),
  ).rejects.toThrow("absent, evicted, or superseded");
  expect(await h.emit("tool_result", finalError("failure-17"))).toEqual([]);
  expect(controller.status().pending_loaded_failure_receipts).toBe(15);
  await h.emit("session_shutdown");
});

it("does not retain an older execution's late failure after the session was cleared", async () => {
  const { h, backend, controller, tool, finalError } =
    await failingLoadedHarness();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.evaluate = vi.fn(async () => {
    entered();
    await pending;
    throw new Error("late native failure");
  });
  const execution = tool.execute("late-failure", {
    read_tool_call_id: "failed-read",
  });
  const rejected = expect(execution).rejects.toThrow();
  await started;
  await h.emit("session_start");
  release();
  await rejected;
  expect(controller.status().pending_loaded_failure_receipts).toBe(0);
  expect(await h.emit("tool_result", finalError("late-failure"))).toEqual([]);
  await h.emit("session_shutdown");
});

it("retains explicit request v1 and disposes then lazily replaces a disabled backend", async () => {
  const paths = await environment(),
    h = harness(),
    adapters: InferenceAdapter[] = [];
  h.context.cwd = paths.cwd;
  const createBackend = vi.fn(() => {
    const backend = adapter();
    adapters.push(backend);
    return backend;
  });
  registerExtension(h.pi, configFromEnv({ JEV_MODEL_ID: "gemma" }), undefined, {
    ...paths,
    createBackend,
  });
  expect(
    (
      await h.tools[0].execute("first", {
        ...input,
        options: { template_version: "v1" },
      })
    ).details.metadata.template_version,
  ).toBe("v1");
  await h.commands.get("jev").handler("disable project", h.context);
  expect(adapters[0].dispose).toHaveBeenCalledOnce();
  await expect(h.tools[0].execute("disabled", input)).rejects.toThrow(
    "Jev is disabled",
  );
  await h.commands.get("jev").handler("enable project", h.context);
  expect(createBackend).toHaveBeenCalledOnce();
  await h.tools[0].execute("next", input);
  expect(createBackend).toHaveBeenCalledTimes(2);
  expect(adapters[1]).not.toBe(adapters[0]);
  expect(
    JSON.parse(await readFile(join(paths.cwd, ".pi", "settings.json"), "utf8"))
      .jev.enabled,
  ).toBe(true);
  await h.emit("session_shutdown");
  expect(adapters[1].dispose).toHaveBeenCalledOnce();
});

it("uses Manager actions, respects project settings, and opens its page with standalone fallback", async () => {
  const paths = await environment(),
    h = harness();
  h.context.cwd = paths.cwd;
  writePreferences(paths.cwd, "global", { routing: true }, paths.agentDir);
  writePreferences(paths.cwd, "project", { routing: false }, paths.agentDir);
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "gemma" }),
    undefined,
    { ...paths, createBackend: adapter },
  );
  const request = { extensionId: "jev", actions: [] as any[] };
  h.pi.events.emit("sf-pi-manager:actions", request);
  await request.actions
    .find((action) => action.id === "routing-toggle")
    .run(h.context, "project");
  expect(controller.preferences().routing).toBe(true);
  await h.commands.get("jev").handler("", h.context);
  expect(h.context.ui.notify).toHaveBeenCalledOnce();
  h.pi.events.on("sf-pi-manager:open", (request: any) => {
    expect(request.route).toEqual({ extensionId: "jev", view: "detail" });
    request.accept();
    request.resolve();
  });
  h.context.ui.notify.mockClear();
  await h.commands.get("jev").handler("", h.context);
  expect(h.context.ui.notify).not.toHaveBeenCalled();
  await expect(
    h.commands.get("jev").handler("enable global project", h.context),
  ).rejects.toThrow();
  await h.emit("session_shutdown");
});

it("does not run advisory hooks until enabled explicitly", async () => {
  const paths = await environment(),
    h = harness(),
    createBackend = vi.fn(adapter);
  h.context.cwd = paths.cwd;
  registerExtension(h.pi, configFromEnv({ JEV_MODEL_ID: "gemma" }), undefined, {
    ...paths,
    createBackend,
  });
  await h.emit("before_agent_start", { prompt: "Run Apex tests." });
  await h.emit("agent_end");
  await h.emit("agent_settled");
  expect(createBackend).not.toHaveBeenCalled();
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it("saves Manager panel settings without starting a model and supports scoped enablement", async () => {
  const paths = await environment(),
    h = harness(),
    createBackend = vi.fn(adapter);
  h.context.cwd = paths.cwd;
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "gemma" }),
    undefined,
    { ...paths, createBackend },
  );
  const request = {
    version: 1,
    cwd: paths.cwd,
    scope: "project",
    extensions: [] as ExternalDescriptor[],
  };
  h.pi.events.emit(MANAGER_DISCOVERY_EVENT, request);
  const descriptor = request.extensions[0];
  const factory = await descriptor.getConfigPanel();
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const done = vi.fn();
  const panel = factory(theme, paths.cwd, "project", done);
  expect(panel.render(80).join("\n")).toContain("Jev Settings");
  panel.handleInput("j");
  panel.handleInput(" ");
  panel.handleInput("s");
  await vi.waitFor(() => expect(controller.preferences().routing).toBe(true));
  expect(createBackend).not.toHaveBeenCalled();
  await descriptor.setEnabled(false, h.context, "project");
  expect(controller.preferences().enabled).toBe(false);
  panel.handleInput("q");
  expect(done).toHaveBeenCalledWith(undefined);
  await h.emit("session_shutdown");
});

it("waits for old backend disposal before lazily starting a replacement", async () => {
  const paths = await environment(),
    h = harness(),
    first = adapter(),
    next = adapter();
  h.context.cwd = paths.cwd;
  let release!: () => void;
  first.dispose = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const createBackend = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(next);
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "gemma" }),
    undefined,
    { ...paths, createBackend },
  );
  await controller.classify(input);
  const disabled = controller.apply(paths.cwd, "project", { enabled: false });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await controller.apply(paths.cwd, "project", { enabled: true });
  const request = controller.classify(input);
  await Promise.resolve();
  expect(createBackend).toHaveBeenCalledOnce();
  release();
  await disabled;
  await request;
  expect(createBackend).toHaveBeenCalledTimes(2);
  await h.emit("session_shutdown");
});

it("displays selected global settings while preserving effective project overrides", async () => {
  const paths = await environment(),
    h = harness(),
    backend = adapter();
  h.context.cwd = paths.cwd;
  writePreferences(paths.cwd, "project", { enabled: true }, paths.agentDir);
  const controller = registerExtension(
    h.pi,
    configFromEnv({ JEV_MODEL_ID: "gemma" }),
    backend,
    paths,
  );
  await controller.classify(input);
  const global = {
    version: 1,
    cwd: paths.cwd,
    scope: "global",
    extensions: [] as ExternalDescriptor[],
  };
  h.pi.events.emit(MANAGER_DISCOVERY_EVENT, global);
  await global.extensions[0].setEnabled(false, h.context, "global");
  const refreshed = { ...global, extensions: [] as ExternalDescriptor[] };
  h.pi.events.emit(MANAGER_DISCOVERY_EVENT, refreshed);
  expect(refreshed.extensions[0].enabled).toBe(false);
  expect(refreshed.extensions[0].statusLines).toContain(
    "Effective classifier: enabled",
  );
  expect(controller.preferences().enabled).toBe(true);
  expect(backend.dispose).not.toHaveBeenCalled();
  expect((await controller.classify(input)).answers.vehicle.type).toBe(
    "choice",
  );
  await h.emit("session_shutdown");
});
