import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeBackend,
  configFromEnv,
  type InferenceAdapter,
} from "../src/backend.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { Plan } from "../src/core.js";
import {
  guardrailConfig,
  registerGuardrailProvider,
} from "../src/guardrail-extension.js";
import { GUARDRAIL_PROVIDER_EVENT } from "../src/guardrail.js";
import { verifyArtifact } from "../src/models.js";
import { registerExtension } from "../src/extension.js";

vi.mock("../src/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models.js")>()),
  verifyArtifact: vi.fn(),
}));

const input = {
  version: 2 as const,
  toolName: "bash",
  input: { command: "git status" },
  facts: {},
};
const verified = vi.mocked(verifyArtifact);
function artifact(sha256 = "a".repeat(64)) {
  return { id: "google/gemma-3-1b-it", sha256 } as Awaited<
    ReturnType<typeof verifyArtifact>
  >;
}
function backend(): InferenceAdapter {
  return {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async (plan: Plan) => plan),
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
      input_tokens: 100,
      metrics: {},
    })),
    dispose: vi.fn(async () => {}),
  };
}
function harness() {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const hooks = new Map<string, any>();
  return {
    commands,
    events,
    hooks,
    pi: {
      events: {
        on: (name: string, handler: unknown) => events.set(name, handler),
      },
      registerCommand: (name: string, command: unknown) =>
        commands.set(name, command),
      on: (name: string, handler: unknown) => hooks.set(name, handler),
    } as any,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  verified.mockReset();
  verified.mockResolvedValue(artifact());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("guardrail worker ownership", () => {
  it("the real /jev disable command disposes the risk worker and re-enable stays lazy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jev-risk-disable-"));
    const commands = new Map<string, any>();
    const hooks = new Map<string, any[]>();
    const tools: any[] = [];
    const pi: any = {
      events: createEventBus(),
      registerCommand: (name: string, command: any) =>
        commands.set(name, command),
      registerTool: (tool: any) => tools.push(tool),
      on: (name: string, handler: any) =>
        hooks.set(name, [...(hooks.get(name) ?? []), handler]),
      getActiveTools: () => ["read", "jev_classify"],
      getAllTools: () => [
        {
          name: "read",
          sourceInfo: { source: "builtin", path: "<builtin:read>" },
        },
      ],
      setActiveTools: vi.fn(),
      appendEntry: vi.fn(),
      registerEntryRenderer: vi.fn(),
      sendMessage: vi.fn(),
    };
    const context: any = {
      cwd: join(directory, "project"),
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
      sessionManager: {
        getSessionId: () => "stub-session",
        getBranch: () => [],
        getEntries: () => [],
      },
    };
    const general = vi.fn(backend);
    const workers: InferenceAdapter[] = [];
    const controller = registerExtension(pi, configFromEnv(), undefined, {
      cwd: context.cwd,
      agentDir: join(directory, "agent"),
      createBackend: general,
      guardrailRisk: {
        env: {},
        createBackend: () => {
          const worker = backend();
          workers.push(worker);
          return worker;
        },
      },
    });
    try {
      await controller.guardrailRisk.warmup();
      expect(general).not.toHaveBeenCalled();
      await commands.get("jev").handler("disable project", context);
      expect(workers[0].dispose).toHaveBeenCalledOnce();
      expect(controller.guardrailRisk.status().state).toBe("disabled");
      await commands.get("jev").handler("enable project", context);
      expect(workers).toHaveLength(1);
      expect(controller.guardrailRisk.status().state).toBe("cold");
      await controller.guardrailRisk.warmup();
      expect(workers).toHaveLength(2);
      for (const shutdown of hooks.get("session_shutdown") ?? [])
        await shutdown({}, context);
      expect(workers[1].dispose).toHaveBeenCalledOnce();
      expect(general).not.toHaveBeenCalled();
    } finally {
      await controller.guardrailRisk.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps risk configuration separate and status/discovery never loads weights", async () => {
    const h = harness();
    const createBackend = vi.fn(backend);
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend,
    });
    expect(
      guardrailConfig({
        JEV_MODEL_ID: "general-only",
        JEV_MODEL_FILE: "/general/model.gguf",
      }).modelId,
    ).toBe("google/gemma-3-1b-it");
    const providers = { version: 1, providers: [] };
    h.events.get(GUARDRAIL_PROVIDER_EVENT)(providers);
    await h.commands
      .get("jev-risk")
      .handler("status", { ui: { notify: vi.fn() } });
    expect(extension.status()).toMatchObject({
      state: "cold",
      qualified: false,
      modelSha256: null,
    });
    expect(providers.providers).toHaveLength(1);
    expect(verified).not.toHaveBeenCalled();
    expect(createBackend).not.toHaveBeenCalled();
  });

  it("releases its own warm worker on disable and creates a fresh one after re-enable", async () => {
    const h = harness();
    let enabled = true;
    const workers: InferenceAdapter[] = [];
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      enabled: () => enabled,
      createBackend: () => {
        const worker = backend();
        workers.push(worker);
        return worker;
      },
    });
    await extension.warmup();
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    enabled = false;
    await extension.reset();
    expect(workers[0].dispose).toHaveBeenCalledOnce();
    expect(extension.status()).toMatchObject({
      state: "disabled",
      modelSha256: null,
      qualified: false,
    });
    await expect(extension.provider.evaluate(input)).rejects.toThrow(
      "disabled",
    );
    enabled = true;
    expect(extension.status().state).toBe("cold");
    await extension.warmup();
    expect(workers).toHaveLength(2);
    expect(workers[1]).not.toBe(workers[0]);
    await h.hooks.get("session_shutdown")();
    expect(workers[1].dispose).toHaveBeenCalledOnce();
    await expect(extension.warmup()).rejects.toThrow("disabled");
  });

  it("disposes during stalled initialization and a retired warmup cannot overwrite a replacement", async () => {
    const h = harness();
    const pending = deferred<void>();
    const first = backend();
    first.warmup = vi.fn(() => pending.promise);
    const second = backend();
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    });
    const oldWarmup = extension.warmup();
    const observedOld = expect(oldWarmup).rejects.toThrow("retired");
    await vi.waitFor(() => expect(first.warmup).toHaveBeenCalled());
    await extension.reset();
    expect(first.dispose).toHaveBeenCalledOnce();
    await observedOld;
    verified.mockResolvedValue(artifact("b".repeat(64)));
    await extension.warmup();
    pending.resolve();
    await Promise.resolve();
    expect(extension.provider.modelSha256).toBe("b".repeat(64));
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    await extension.dispose();
  });

  it("cancels a caller waiting for shared initialization without producing a prediction", async () => {
    const h = harness();
    const pending = deferred<void>();
    const worker = backend();
    worker.warmup = vi.fn(() => pending.promise);
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: () => worker,
    });
    const controller = new AbortController();
    const result = extension.provider.evaluate(input, controller.signal);
    const observed = expect(result).rejects.toThrow("caller cancelled");
    await vi.waitFor(() => expect(worker.warmup).toHaveBeenCalled());
    controller.abort(new Error("caller cancelled"));
    await observed;
    expect(worker.compile).not.toHaveBeenCalled();
    await extension.dispose();
    expect(worker.dispose).toHaveBeenCalledOnce();
    pending.reject(new Error("late initialization failure"));
    await Promise.resolve();
  });
  it("a reset cancels an initializing evaluation before a replacement worker accepts fresh requests", async () => {
    const h = harness();
    const pending = deferred<void>();
    const first = backend();
    first.warmup = vi.fn(() => pending.promise);
    const second = backend();
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    });
    const operation = extension.provider.evaluate(input);
    const observed = expect(operation).rejects.toThrow("retired");
    await vi.waitFor(() => expect(first.warmup).toHaveBeenCalled());
    await extension.reset();
    await extension.warmup();
    await observed;
    expect(first.compile).not.toHaveBeenCalled();
    expect(second.compile).not.toHaveBeenCalled();
    pending.resolve();
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    expect(second.compile).toHaveBeenCalledOnce();
    await extension.dispose();
  });

  it("bounds cold initialization to the check deadline while keeping explicit warmup usable", async () => {
    const h = harness();
    const pending = deferred<void>();
    const worker = backend();
    worker.warmup = vi.fn(() => pending.promise);
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: () => worker,
    });
    const result = extension.provider.evaluate(input);
    await expect(result).rejects.toThrow();
    expect(worker.compile).not.toHaveBeenCalled();
    pending.resolve();
    await extension.warmup();
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    await extension.dispose();
  });

  it("recovers after a failed initialization and rejects malformed worker scoring", async () => {
    const h = harness();
    const worker = backend();
    vi.mocked(worker.warmup).mockRejectedValueOnce(
      new Error("worker unavailable"),
    );
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: () => worker,
    });
    await expect(extension.warmup()).rejects.toThrow("worker unavailable");
    expect(extension.provider.qualified).toBe(false);
    await extension.warmup();
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    vi.mocked(worker.evaluate).mockResolvedValueOnce({
      logits: {},
      input_tokens: 100,
      metrics: {},
    });
    await expect(extension.provider.evaluate(input)).rejects.toThrow(
      "Missing or unexpected branch logits",
    );
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    await extension.dispose();
  });

  it("discards a recovered native worker if its loaded artifact changed", async () => {
    const h = harness();
    let loadedSha256 = "a".repeat(64);
    let worker!: NativeBackend;
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: (config) => {
        worker = new NativeBackend(config);
        const initial = worker.status;
        const stub = backend();
        vi.spyOn(worker, "isReady", "get").mockReturnValue(true);
        vi.spyOn(worker, "warmup").mockImplementation(stub.warmup);
        vi.spyOn(worker, "compile").mockImplementation(stub.compile);
        vi.spyOn(worker, "evaluate").mockImplementation(stub.evaluate);
        vi.spyOn(worker, "dispose");
        vi.spyOn(worker, "status", "get").mockImplementation(() => ({
          ...initial,
          state: "ready",
          generation: 1,
          artifact: {
            id: config.modelId,
            revision: "fixture",
            sha256: loadedSha256,
            size: 1,
            base_model: "google/gemma-3-1b-it",
            template_version: "v2",
          },
        }));
        return worker;
      },
    });
    await extension.warmup();
    expect((await extension.provider.evaluate(input)).action).toBe("allow");
    loadedSha256 = "b".repeat(64);
    await expect(extension.provider.evaluate(input)).rejects.toThrow(
      "changed during worker recovery",
    );
    expect(extension.provider.modelSha256).toBeNull();
    expect(extension.provider.qualified).toBe(false);
    expect(worker.dispose).toHaveBeenCalledOnce();
    await extension.dispose();
  });

  it("rejects incomplete input before starting initialization", async () => {
    const h = harness();
    const createBackend = vi.fn(backend);
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend,
    });
    await expect(
      extension.provider.evaluate({ ...input, toolName: "sf_apex" }),
    ).rejects.toThrow("incomplete");
    expect(verified).not.toHaveBeenCalled();
    expect(createBackend).not.toHaveBeenCalled();
  });
  it("records hostile initialization errors without invoking a message getter", async () => {
    const h = harness();
    const getter = vi.fn(() => {
      throw new Error("message getter must not execute");
    });
    const hostile = Object.defineProperty(new Error(), "message", {
      get: getter,
    });
    verified.mockRejectedValue(hostile);
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: vi.fn(backend),
    });
    await expect(extension.warmup()).rejects.toBe(hostile);
    expect(extension.status().lastError).toBe(
      "Guardrail initialization failed",
    );
    const notify = vi.fn();
    await h.commands.get("jev-risk").handler("warmup", { ui: { notify } });
    expect(notify).toHaveBeenCalledWith("Jev guardrail warmup failed", "error");
    expect(getter).not.toHaveBeenCalled();
    await extension.dispose();
  });

  it("records hostile disposal errors without throwing from its cleanup observer", async () => {
    const h = harness();
    const worker = backend();
    const getter = vi.fn(() => {
      throw new Error("message getter must not execute");
    });
    const hostile = Object.defineProperty(new Error(), "message", {
      get: getter,
    });
    vi.mocked(worker.dispose).mockRejectedValue(hostile);
    const extension = registerGuardrailProvider(h.pi, {
      env: {},
      createBackend: () => worker,
    });
    await extension.warmup();
    await expect(extension.reset()).rejects.toBe(hostile);
    expect(extension.status().lastError).toBe(
      "Guardrail worker disposal failed",
    );
    expect(getter).not.toHaveBeenCalled();
    await expect(extension.dispose()).rejects.toBe(hostile);
  });
});
