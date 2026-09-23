import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerExtension } from "../src/extension.js";
import { C11 } from "../src/guardrail-selection.js";
import { hashArtifact, verifyArtifact } from "../src/models.js";
import { c11Artifact, deferred, harness, worker } from "./guardrail-fixture.js";

vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  verifyArtifact: vi.fn(),
  hashArtifact: vi.fn(),
}));
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.mocked(verifyArtifact).mockReset().mockResolvedValue(c11Artifact());
  vi.mocked(hashArtifact)
    .mockReset()
    .mockResolvedValue({ sha256: C11.nativeBinarySha256, size: 128 });
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
function fixture(mode?: string, backend = worker(), enabled = true) {
  const h = harness();
  const createBackend = vi.fn(() => backend);
  const runtime = registerExtension(h.pi, {
    env: { SF_GUARDRAIL_JEV_MODE: mode },
    enabled: () => enabled,
    createBackend,
  });
  cleanup.push(runtime.guardrailRisk.dispose);
  return { ...h, runtime, backend, createBackend };
}
it.each([undefined, "off"])(
  "off startup (%s) remains cold and registers no tools or independent enforcement",
  async (mode) => {
    const h = fixture(mode);
    await h.emit("session_start");
    expect(h.createBackend).not.toHaveBeenCalled();
    expect(verifyArtifact).not.toHaveBeenCalled();
    expect(h.runtime.guardrailRisk.status().state).toBe("cold");
    expect(h.pi.registerTool).not.toHaveBeenCalled();
    expect(h.handlers.has("tool_call")).toBe(false);
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  },
);
it.each(["shadow", "enforce"])(
  "%s startup awaits its owned worker but never qualifies it",
  async (mode) => {
    const initialization = deferred();
    const backend = worker(() => initialization.promise);
    const h = fixture(mode, backend);
    let started = false;
    const startup = h.emit("session_start").then(() => {
      started = true;
    });
    await vi.waitFor(() => expect(backend.warmup).toHaveBeenCalledOnce());
    expect(started).toBe(false);
    initialization.resolve();
    await startup;
    expect(h.runtime.guardrailRisk.status().state).toBe("ready");
    expect(h.runtime.guardrailRisk.provider.qualified).toBe(false);
    expect(backend.evaluate).not.toHaveBeenCalled();
    expect(h.context.ui.confirm).not.toHaveBeenCalled();
    expect(h.context.ui.select).not.toHaveBeenCalled();
  },
);
it("disabled startup remains lazy", async () => {
  const h = fixture("shadow", worker(), false);
  await h.emit("session_start");
  expect(h.createBackend).not.toHaveBeenCalled();
  expect(h.runtime.guardrailRisk.status().state).toBe("disabled");
});
it("startup retains a failed artifact check for the host's rules fallback", async () => {
  vi.mocked(verifyArtifact).mockRejectedValue(new Error("fixture rejected"));
  const h = fixture("shadow");
  await expect(h.emit("session_start")).resolves.toBeUndefined();
  expect(h.runtime.guardrailRisk.status().lastError).toBe("fixture rejected");
  expect(h.runtime.guardrailRisk.provider.modelSha256).toBeNull();
  expect(h.createBackend).not.toHaveBeenCalled();
});
it("shutdown interrupts a stalled startup and disposes only its owned worker", async () => {
  const initialization = deferred();
  const backend = worker(() => initialization.promise);
  const h = fixture("shadow", backend);
  const startup = h.emit("session_start");
  await vi.waitFor(() => expect(backend.warmup).toHaveBeenCalledOnce());
  await h.emit("session_shutdown");
  await startup;
  expect(backend.dispose).toHaveBeenCalledOnce();
  expect(h.runtime.guardrailRisk.status().state).toBe("disposed");
  initialization.resolve();
});
