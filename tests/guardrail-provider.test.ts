import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeBackend } from "../src/backend.js";
import {
  guardrailConfig,
  registerGuardrailProvider,
} from "../src/guardrail-extension.js";
import { GUARDRAIL_PROVIDER_EVENT } from "../src/guardrail.js";
import {
  C11,
  C11_SCORING_PROTOCOL_SHA256,
} from "../src/guardrail-selection.js";
import { hashArtifact, verifyArtifact } from "../src/models.js";
import {
  c11Artifact,
  deferred,
  harness,
  safeInput,
  worker,
} from "./guardrail-fixture.js";

vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  verifyArtifact: vi.fn(),
  hashArtifact: vi.fn(),
}));
const verified = vi.mocked(verifyArtifact);
const hashed = vi.mocked(hashArtifact);
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  verified.mockReset().mockResolvedValue(c11Artifact());
  hashed
    .mockReset()
    .mockResolvedValue({ sha256: C11.nativeBinarySha256, size: 128 });
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers();
});
function fixture(
  options: Parameters<typeof registerGuardrailProvider>[1] = {},
) {
  const h = harness();
  const backend = worker();
  const createBackend = vi.fn(() => backend);
  const runtime = registerGuardrailProvider(h.pi, {
    env: {},
    createBackend,
    ...options,
  });
  cleanup.push(runtime.dispose);
  return { ...h, backend, createBackend, runtime };
}

it("selects the portable current bundle, model, registry and guarded runtime limits", () => {
  const config = guardrailConfig({});
  const bundle = join(homedir(), "Desktop", "Jev-C11-Step256-Model-2026-09-23");
  expect(config).toMatchObject({
    modelId: C11.modelId,
    modelFile: join(bundle, "model.gguf"),
    binary: join(bundle, "runtime", ".build", "jev-native"),
    templateVersion: "v2",
    maxModelLen: 2048,
    maxBatchSize: 32,
    maxBatchTokens: 2048,
    maxRequestBranches: 1,
    queueTimeoutMs: 750,
    requestTimeoutMs: 750,
    advanced: false,
  });
  const overridden = guardrailConfig({
    JEV_GUARDRAIL_BUNDLE: "./moved-bundle",
    JEV_GUARDRAIL_MODEL_FILE: "/copied/current.gguf",
    JEV_GUARDRAIL_ARTIFACT_REGISTRY: "/copied/registry.json",
    JEV_DEVICE: "cpu",
    JEV_GUARDRAIL_MODEL_ID: "obsolete",
    JEV_GUARDRAIL_C9_CALIBRATION: "/obsolete/receipt.json",
  });
  expect(overridden).toMatchObject({
    modelFile: "/copied/current.gguf",
    artifactRegistryPath: "/copied/registry.json",
    device: "cpu",
    modelId: C11.modelId,
    binary: join(resolve("moved-bundle"), "runtime", ".build", "jev-native"),
  });
});

it("discovery and status stay lazy and expose the shadow-only current selection", async () => {
  const h = fixture();
  const request = { version: 1, providers: [] as any[] };
  h.pi.events.emit(GUARDRAIL_PROVIDER_EVENT, request);
  await h.commands.get("jev-risk").handler("status", h.context);
  expect(request.providers).toEqual([h.runtime.provider]);
  expect(h.runtime.provider).toMatchObject({
    version: 2,
    id: "jev",
    qualified: false,
    modelSha256: null,
    minimumAllowScore: C11.minimumAllowScore,
    protocolSha256: C11_SCORING_PROTOCOL_SHA256,
    calibrationSha256: C11.calibrationSha256,
    calibrationPolicySha256: C11.policySha256,
    calibrationBaselineSha256: C11.hostBaselineSha256,
  });
  expect(Reflect.set(h.runtime.provider, "qualified", true)).toBe(false);
  expect(Reflect.set(h.runtime.provider, "minimumAllowScore", 0.5)).toBe(false);
  expect(verified).not.toHaveBeenCalled();
  expect(hashed).not.toHaveBeenCalled();
  expect(h.createBackend).not.toHaveBeenCalled();
  expect(h.pi.registerTool).not.toHaveBeenCalled();
  expect(h.context.ui.confirm).not.toHaveBeenCalled();
});

it("uses the exact C11 cutoff with allow, abstain and confirm outcomes without qualification", async () => {
  let score = 0.98;
  const backend = worker(
    async () => {},
    () => score,
  );
  const h = fixture({ createBackend: () => backend });
  await h.runtime.warmup();
  for (const [nextScore, action] of [
    [0.98, "allow"],
    [0.8, "abstain"],
    [0.2, "confirm"],
  ] as const) {
    score = nextScore;
    const prediction = await h.runtime.provider.evaluate(safeInput);
    expect(prediction.action).toBe(action);
    expect(prediction.calibration).toBe("uncalibrated");
  }
  expect(h.runtime.provider.modelSha256).toBe(C11.modelSha256);
  expect(h.runtime.provider.qualified).toBe(false);
  expect(h.runtime.provider.qualificationSha256).toBeUndefined();
  expect(h.runtime.status().state).toBe("ready");
});

it.each([
  "id",
  "sha256",
  "size",
  "base_model",
  "revision",
  "template_version",
  "training_run",
] as const)(
  "rejects a changed C11 artifact %s before creating a worker",
  async (field) => {
    const changed = {
      ...c11Artifact(),
      [field]: field === "size" ? 1 : "changed",
    };
    verified.mockResolvedValue(changed);
    const h = fixture();
    await expect(h.runtime.warmup()).rejects.toThrow("pinned C11");
    expect(h.createBackend).not.toHaveBeenCalled();
    expect(h.runtime.provider.modelSha256).toBeNull();
  },
);

it("rejects an alternate native binary and a binary changed during warmup", async () => {
  const h = fixture();
  hashed.mockResolvedValue({ sha256: "a".repeat(64), size: 128 });
  await expect(h.runtime.warmup()).rejects.toThrow("native binary");
  expect(h.createBackend).not.toHaveBeenCalled();
  hashed
    .mockReset()
    .mockResolvedValueOnce({ sha256: C11.nativeBinarySha256, size: 128 })
    .mockResolvedValueOnce({ sha256: C11.nativeBinarySha256, size: 129 });
  await expect(h.runtime.warmup()).rejects.toThrow("changed during warmup");
  expect(h.backend.dispose).toHaveBeenCalledOnce();
  expect(h.runtime.provider.modelSha256).toBeNull();
});

it("rejects incomplete input before any artifact or worker initialization", async () => {
  const h = fixture();
  await expect(
    h.runtime.provider.evaluate({ ...safeInput, input: {} }),
  ).rejects.toThrow();
  expect(verified).not.toHaveBeenCalled();
  expect(h.createBackend).not.toHaveBeenCalled();
});

it("caller cancellation stops waiting without producing a prediction, while shared warmup completes", async () => {
  const init = deferred();
  const backend = worker(() => init.promise);
  const h = fixture({ createBackend: () => backend });
  const controller = new AbortController();
  const scoring = h.runtime.provider.evaluate(safeInput, controller.signal);
  await vi.waitFor(() => expect(backend.warmup).toHaveBeenCalledOnce());
  controller.abort(new Error("cancelled fixture"));
  await expect(scoring).rejects.toThrow("cancelled fixture");
  expect(backend.evaluate).not.toHaveBeenCalled();
  expect(h.runtime.status().state).toBe("warming");
  init.resolve();
  await h.runtime.warmup();
  expect((await h.runtime.provider.evaluate(safeInput)).action).toBe("allow");
});

it("reset interrupts an uncooperative warmup and a retired worker cannot overwrite its replacement", async () => {
  const init = deferred();
  const oldWorker = worker(() => init.promise);
  const nextWorker = worker();
  const createBackend = vi
    .fn()
    .mockReturnValueOnce(oldWorker)
    .mockReturnValueOnce(nextWorker);
  const h = fixture({ createBackend });
  const warming = h.runtime.warmup();
  await vi.waitFor(() => expect(oldWorker.warmup).toHaveBeenCalledOnce());
  await h.runtime.reset();
  await expect(warming).rejects.toThrow("retired");
  await h.runtime.warmup();
  init.resolve();
  await Promise.resolve();
  expect(oldWorker.dispose).toHaveBeenCalledOnce();
  expect(h.runtime.status().state).toBe("ready");
  expect(nextWorker.dispose).not.toHaveBeenCalled();
});

it("disable hides the provider and disposal rejects later calls", async () => {
  let enabled = true;
  const h = fixture({ enabled: () => enabled });
  await h.runtime.warmup();
  enabled = false;
  await h.runtime.reset();
  const request = { version: 1, providers: [] as any[] };
  h.pi.events.emit(GUARDRAIL_PROVIDER_EVENT, request);
  expect(request.providers).toHaveLength(0);
  expect(h.runtime.status().state).toBe("disabled");
  await expect(h.runtime.provider.evaluate(safeInput)).rejects.toThrow(
    "disabled",
  );
  enabled = true;
  await h.runtime.warmup();
  await h.runtime.dispose();
  expect(h.runtime.status().state).toBe("disposed");
  await expect(h.runtime.warmup()).rejects.toThrow("disabled");
});

it("invalidates a native worker whose generation or loaded model changes", async () => {
  const native = new NativeBackend(guardrailConfig({}));
  let generation = 1;
  let modelSha = C11.modelSha256;
  Object.defineProperty(native, "isReady", { get: () => true });
  Object.defineProperty(native, "status", {
    get: () => ({ generation, artifact: { sha256: modelSha } }),
  });
  const fake = worker();
  vi.spyOn(native, "warmup").mockImplementation(async () => {});
  vi.spyOn(native, "compile").mockImplementation(fake.compile);
  vi.spyOn(native, "evaluate").mockImplementation(async (compiled, signal) => {
    const result = await fake.evaluate(compiled, signal);
    generation++;
    modelSha = "a".repeat(64);
    return result;
  });
  vi.spyOn(native, "dispose").mockImplementation(async () => {});
  const h = fixture({ createBackend: () => native });
  await h.runtime.warmup();
  await expect(h.runtime.provider.evaluate(safeInput)).rejects.toThrow(
    "identity changed",
  );
  expect(h.runtime.provider.modelSha256).toBeNull();
  expect(native.dispose).toHaveBeenCalledOnce();
});

it("records hostile initialization errors without invoking a message getter", async () => {
  let calls = 0;
  const error = new Error();
  Object.defineProperty(error, "message", {
    get() {
      calls++;
      return "hostile";
    },
  });
  verified.mockRejectedValue(error);
  const h = fixture();
  await expect(h.runtime.warmup()).rejects.toBe(error);
  expect(h.runtime.status().lastError).toBe("Guardrail initialization failed");
  expect(calls).toBe(0);
});
