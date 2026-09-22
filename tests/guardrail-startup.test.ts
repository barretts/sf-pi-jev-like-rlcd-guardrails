import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { configFromEnv, type InferenceAdapter } from "../src/backend.js";
import { registerExtension } from "../src/extension.js";
import { verifyArtifact } from "../src/models.js";
import { writePreferences } from "../src/preferences.js";

vi.mock("../src/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models.js")>()),
  verifyArtifact: vi.fn(),
}));

const verified = vi.mocked(verifyArtifact);
const artifactSha = "a".repeat(64);
const cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  verified.mockReset();
  // Stub artifact verification, never qualification or the provider's getters.
  verified.mockResolvedValue({
    id: "google/gemma-3-1b-it",
    sha256: artifactSha,
  } as Awaited<ReturnType<typeof verifyArtifact>>);
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllEnvs();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function worker(warmup: () => Promise<void> = async () => {}) {
  return {
    warmup: vi.fn(warmup),
    compile: vi.fn(async (plan) => plan),
    evaluate: vi.fn(async () => {
      throw new Error("Startup must not evaluate a tool request");
    }),
    dispose: vi.fn(async () => {}),
  } satisfies InferenceAdapter;
}
async function fixture(mode?: string, enabled = true, riskWorker = worker()) {
  const directory = await mkdtemp(join(tmpdir(), "jev-risk-startup-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  if (!enabled) writePreferences(cwd, "project", { enabled }, agentDir);
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const pi: any = {
    events: createEventBus(),
    on: (name: string, handler: any) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerTool: vi.fn(),
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
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => "stub-startup-session",
      getBranch: () => [],
      getEntries: () => [],
    },
  };
  const generalFactory = vi.fn(() => worker());
  const riskFactory = vi.fn(() => riskWorker);
  const controller = registerExtension(
    pi,
    configFromEnv({ JEV_MODEL_ID: "google/gemma-3-1b-it" }),
    undefined,
    {
      cwd,
      agentDir,
      createBackend: generalFactory,
      guardrailRisk: {
        env: {
          SF_GUARDRAIL_JEV_MODE: mode,
          JEV_GUARDRAIL_MODEL_FILE: "/stub/approved-guardrail.gguf",
        },
        createBackend: riskFactory,
      },
    },
  );
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, context);
  };
  cleanup.push(async () => {
    await emit("session_shutdown");
    await rm(directory, { recursive: true, force: true });
  });
  return {
    controller,
    riskWorker,
    riskFactory,
    generalFactory,
    context,
    commands,
    pi,
    emit,
  };
}
function noIndependentDecision(h: Awaited<ReturnType<typeof fixture>>) {
  expect(h.generalFactory).not.toHaveBeenCalled();
  expect(h.riskWorker.evaluate).not.toHaveBeenCalled();
  expect(h.context.ui.select).not.toHaveBeenCalled();
  expect(h.context.ui.confirm).not.toHaveBeenCalled();
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  for (const [message, options] of h.pi.sendMessage.mock.calls) {
    expect(message.customType).toBe("jev-status");
    expect(options).toEqual({ triggerTurn: false });
  }
}

it.each(["shadow", "enforce"])(
  "headless %s startup awaits the real owned provider without qualifying a stub",
  async (mode) => {
    const initialization = deferred();
    const h = await fixture(
      mode,
      true,
      worker(() => initialization.promise),
    );
    let started = false;
    const startup = h.emit("session_start").then(() => {
      started = true;
    });
    await vi.waitFor(() => expect(h.riskWorker.warmup).toHaveBeenCalledOnce());
    expect(started).toBe(false);
    expect(h.controller.guardrailRisk.status().state).toBe("warming");
    initialization.resolve();
    await startup;
    expect(h.controller.guardrailRisk.status()).toMatchObject({
      modelSha256: artifactSha,
      qualified: false,
      qualificationBaselineSha256: null,
      lastError: undefined,
    });
    expect(h.controller.guardrailRisk.provider.qualified).toBe(false);
    await h.emit("session_start");
    expect(h.riskWorker.warmup).toHaveBeenCalledOnce();
    expect(h.context.ui.notify).not.toHaveBeenCalled();
    noIndependentDecision(h);
  },
);

it.each([undefined, "off", "", "invalid", "SHADOW", "enforce "])(
  "startup remains lazy with absent/off/malformed mode %s",
  async (mode) => {
    // An explicitly supplied provider environment must override ambient activation.
    vi.stubEnv("SF_GUARDRAIL_JEV_MODE", "enforce");
    const h = await fixture(mode);
    await h.emit("session_start");
    expect(verified).not.toHaveBeenCalled();
    expect(h.riskFactory).not.toHaveBeenCalled();
    expect(h.controller.guardrailRisk.status()).toMatchObject({
      state: "cold",
      modelSha256: null,
      qualified: false,
    });
    noIndependentDecision(h);
  },
);

it.each(["shadow", "enforce"])(
  "disabled %s startup stays lazy and same-session /jev enable awaits warmup",
  async (mode) => {
    const initialization = deferred();
    const h = await fixture(
      mode,
      false,
      worker(() => initialization.promise),
    );
    await h.emit("session_start");
    expect(verified).not.toHaveBeenCalled();
    expect(h.riskFactory).not.toHaveBeenCalled();
    expect(h.controller.guardrailRisk.status().state).toBe("disabled");
    let enabled = false;
    const enabling = h.commands
      .get("jev")
      .handler("enable project", h.context)
      .then(() => {
        enabled = true;
      });
    await vi.waitFor(() => expect(h.riskWorker.warmup).toHaveBeenCalledOnce());
    expect(enabled).toBe(false);
    initialization.resolve();
    await enabling;
    expect(h.controller.guardrailRisk.status()).toMatchObject({
      modelSha256: artifactSha,
      qualified: false,
    });
    noIndependentDecision(h);
  },
);

it.each(["off", "invalid"])(
  "same-session /jev enable remains lazy for %s mode",
  async (mode) => {
    const h = await fixture(mode, false);
    await h.emit("session_start");
    await h.commands.get("jev").handler("enable project", h.context);
    expect(verified).not.toHaveBeenCalled();
    expect(h.riskFactory).not.toHaveBeenCalled();
    expect(h.controller.guardrailRisk.status().modelSha256).toBeNull();
    noIndependentDecision(h);
  },
);

it.each(["shadow", "enforce"])(
  "%s template retirement restores only the owned risk worker",
  async (mode) => {
    const h = await fixture(mode);
    await h.emit("session_start");
    const replacement = worker();
    h.riskFactory.mockReturnValue(replacement);
    await h.commands.get("jev").handler("template v1 project", h.context);
    expect(h.riskWorker.dispose).toHaveBeenCalledOnce();
    expect(replacement.warmup).toHaveBeenCalledOnce();
    expect(replacement.evaluate).not.toHaveBeenCalled();
    expect(h.controller.guardrailRisk.status()).toMatchObject({
      modelSha256: artifactSha,
      qualified: false,
    });
    noIndependentDecision(h);
  },
);

it.each(["shadow", "enforce"])(
  "%s startup failure preserves the provider error and an unqualified fallback",
  async (mode) => {
    const h = await fixture(
      mode,
      true,
      worker(async () => {
        throw new Error("stub worker initialization failed");
      }),
    );
    await expect(h.emit("session_start")).resolves.toBeUndefined();
    expect(h.controller.guardrailRisk.status()).toMatchObject({
      state: "cold",
      modelSha256: null,
      qualified: false,
      lastError: "stub worker initialization failed",
    });
    expect(h.riskWorker.dispose).toHaveBeenCalledOnce();
    expect(h.context.ui.notify).not.toHaveBeenCalled();
    noIndependentDecision(h);
  },
);

it.each(["shadow", "enforce"])(
  "shutdown interrupts pending %s startup and late initialization cannot revive it",
  async (mode) => {
    const initialization = deferred();
    const h = await fixture(
      mode,
      true,
      worker(() => initialization.promise),
    );
    const startup = h.emit("session_start");
    await vi.waitFor(() => expect(h.riskWorker.warmup).toHaveBeenCalledOnce());
    await h.emit("session_shutdown");
    await expect(startup).resolves.toBeUndefined();
    expect(h.riskWorker.dispose).toHaveBeenCalledOnce();
    expect(h.controller.guardrailRisk.status()).toMatchObject({
      state: "disposed",
      modelSha256: null,
      qualified: false,
    });
    initialization.resolve();
    await Promise.resolve();
    await h.emit("session_start");
    expect(h.riskFactory).toHaveBeenCalledOnce();
    expect(h.controller.guardrailRisk.status().state).toBe("disposed");
    noIndependentDecision(h);
  },
);
