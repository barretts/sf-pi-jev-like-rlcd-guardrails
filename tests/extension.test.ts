import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
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
      for (const handler of handlers.get(name) ?? [])
        await handler(event, context);
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
  expect(createBackend).toHaveBeenCalledOnce();
  expect(
    JSON.parse(JSON.stringify(ToolSchema)).properties.options.properties
      .template_version,
  ).toBeDefined();
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
