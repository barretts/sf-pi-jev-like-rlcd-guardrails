import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  CURRENT_ARTIFACT_REGISTRY,
  GEMMA_TRAINING_REVISION,
  hashArtifact,
  verifyArtifact,
  verifyTrainedArtifactExport,
  type TrainedArtifactManifest,
} from "../src/models.js";
import { C11 } from "../src/guardrail-selection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jev-model-identity-"));
  directories.push(directory);
  const model = join(directory, "copied.gguf");
  const bytes = Buffer.from("GGUFfixture model");
  await writeFile(model, bytes);
  const artifact = {
    id: "jev/fixture",
    revision: GEMMA_TRAINING_REVISION,
    base_model: C11.baseModel,
    template_version: "v2",
    training_run: "fixture-run",
    file: "model.gguf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    roles: ["classifier"],
    license: "gemma",
  };
  const registry = join(directory, "registry.json");
  const save = async () =>
    writeFile(registry, JSON.stringify({ version: 1, artifacts: [artifact] }));
  await save();
  return { directory, model, artifact, registry, save };
}

it("keeps only the current portable model in the runtime registry", async () => {
  const registry = JSON.parse(
    await readFile(CURRENT_ARTIFACT_REGISTRY, "utf8"),
  );
  expect(registry.artifacts).toHaveLength(1);
  expect(registry.artifacts[0]).toMatchObject({
    id: C11.modelId,
    sha256: C11.modelSha256,
    size: C11.modelBytes,
    file: "model.gguf",
    base_model: C11.baseModel,
    revision: C11.baseRevision,
    template_version: "v2",
    roles: ["classifier"],
  });
});

it("resolves the model.gguf placeholder through the configured selected file", async () => {
  const f = await fixture();
  const verified = await verifyArtifact(f.model, "classifier", f.artifact.id, {
    registryPath: f.registry,
  });
  expect(verified.file).toBe(f.model);
  expect(await hashArtifact(f.model)).toEqual({
    sha256: f.artifact.sha256,
    size: f.artifact.size,
  });
});

it("accepts a scoped absolute artifact registry for explicit training evaluation", async () => {
  const f = await fixture();
  f.artifact.file = f.model;
  await f.save();
  expect(
    (
      await verifyArtifact(f.model, "classifier", f.artifact.id, {
        registryPath: f.registry,
      })
    ).file,
  ).toBe(f.model);
});

it.each(["lineage", "revision", "role", "path", "template"])(
  "rejects invalid %s in a registry",
  async (change) => {
    const f = await fixture();
    if (change === "lineage") f.artifact.base_model = "unreviewed/model";
    if (change === "revision") f.artifact.revision = "a".repeat(40);
    if (change === "role") f.artifact.roles = ["teacher"];
    if (change === "path") f.artifact.file = "../other.gguf";
    if (change === "template") f.artifact.template_version = "v1";
    await f.save();
    await expect(
      verifyArtifact(f.model, "classifier", f.artifact.id, {
        registryPath: f.registry,
      }),
    ).rejects.toThrow("Invalid local artifact");
  },
);

it("does not accept changed bytes or an unregistered model identity", async () => {
  const f = await fixture();
  await expect(
    verifyArtifact(f.model, "classifier", "jev/missing", {
      registryPath: f.registry,
    }),
  ).rejects.toThrow("Unapproved model");
  await writeFile(f.model, "GGUFchanged model");
  await expect(
    verifyArtifact(f.model, "classifier", f.artifact.id, {
      registryPath: f.registry,
    }),
  ).rejects.toThrow("Unapproved model");
  await expect(
    verifyArtifact(f.model, "teacher" as any, f.artifact.id, {
      registryPath: f.registry,
    }),
  ).rejects.toThrow("Only classifier");
});

it("rejects an aborted hash without reading the model", async () => {
  const controller = new AbortController();
  controller.abort(new Error("hash cancelled"));
  await expect(hashArtifact("/absent/file", controller.signal)).rejects.toThrow(
    "hash cancelled",
  );
});

it("verifies completed export provenance without promoting a candidate", async () => {
  const f = await fixture();
  const runManifest = join(f.directory, "manifest.json");
  const manifest: TrainedArtifactManifest = {
    version: 1,
    id: f.artifact.id,
    file: f.model,
    base_model: C11.baseModel,
    base_revision: C11.baseRevision,
    template_version: "v2",
    training_run: "fixture-run",
    sha256: f.artifact.sha256,
    size: f.artifact.size,
    run_manifest: runManifest,
  };
  const run = {
    version: 1,
    id: manifest.training_run,
    status: "exported",
    directory: f.directory,
    base_model: manifest.base_model,
    base_revision: manifest.base_revision,
    template_version: manifest.template_version,
    exports: {
      id: manifest.id,
      file: manifest.file,
      sha256: manifest.sha256,
      size: manifest.size,
    },
  };
  await writeFile(runManifest, JSON.stringify(run));
  expect(await verifyTrainedArtifactExport(manifest)).toMatchObject({
    roles: ["classifier"],
    training_run: "fixture-run",
  });
  await expect(
    verifyTrainedArtifactExport({
      ...manifest,
      template_version: "v1" as any,
    }),
  ).rejects.toThrow("valid template");
  run.exports.id = "jev/changed";
  await writeFile(runManifest, JSON.stringify(run));
  await expect(verifyTrainedArtifactExport(manifest)).rejects.toThrow(
    "provenance",
  );
});
