import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeBackend, configFromEnv } from "../src/backend.js";
it("rejects an unapproved artifact before spawning the runtime and permits a later retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-test-"));
  const model = join(dir, "model.gguf");
  await writeFile(model, "unverified model");
  const config = configFromEnv({ JEV_MODEL_FILE: model });
  config.binary = process.execPath;
  const backend = new NativeBackend(config);
  try {
    await expect(backend.warmup()).rejects.toThrow("Unapproved model artifact");
    await expect(backend.warmup()).rejects.toThrow("Unapproved model artifact");
  } finally {
    await backend.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
it("reports missing configuration without a subprocess", async () => {
  const config = configFromEnv({});
  config.binary = process.execPath;
  const backend = new NativeBackend(config);
  await expect(backend.doctor()).rejects.toThrow("Set JEV_MODEL_FILE");
  await backend.dispose();
  await expect(backend.warmup()).rejects.toThrow("disposed");
});
it("validates device selection and diagnostic gating", () => {
  expect(() => configFromEnv({ JEV_DEVICE: "cuda" })).toThrow();
  for (const value of ["1", "true", "YES", "On"])
    expect(
      configFromEnv({ ENABLE_OPEN_JEV_ADVANCED_METRICS: value }).advanced,
    ).toBe(true);
  expect(
    configFromEnv({ ENABLE_OPEN_JEV_ADVANCED_METRICS: "false" }).advanced,
  ).toBe(false);
});
it("defaults to the current v2 template and rejects v1 before starting a worker", () => {
  expect(configFromEnv({}).templateVersion).toBe("v2");
  expect(() => configFromEnv({ JEV_TEMPLATE_VERSION: "v1" })).toThrow(
    "JEV_TEMPLATE_VERSION must be v2",
  );
  expect(
    () =>
      new NativeBackend({
        ...configFromEnv({}),
        templateVersion: "v1" as any,
      }),
  ).toThrow("Unsupported template version");
});
