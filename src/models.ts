import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { C11, readBoundedFile } from "./guardrail-selection.js";

export type ModelRole = "classifier";
export interface ApprovedArtifact {
  id: string;
  revision: string;
  sha256: string;
  size: number;
  file: string;
  base_model: string;
  template_version?: "v2";
  roles: ModelRole[];
  license: string;
  training_run?: string;
}
export interface ModelFile {
  repository: string;
  revision: string;
  file: string;
  source_file?: string;
  sha256: string;
  size: number;
}
export interface ApprovedModel extends ModelFile {
  id: string;
  base_model: string;
  publisher: string;
  roles: ModelRole[];
  license: string;
  chat_template?: ModelFile;
}
export const GEMMA_TRAINING_REVISION = C11.baseRevision;
const root = fileURLToPath(new URL("../", import.meta.url));
export const CURRENT_ARTIFACT_REGISTRY = fileURLToPath(
  new URL("../models/current/registry.json", import.meta.url),
);

export async function approvedModels(): Promise<ApprovedModel[]> {
  const data = JSON.parse(
    await readFile(join(root, "models/registry.json"), "utf8"),
  );
  if (data.schema_version !== 1 || !Array.isArray(data.models))
    throw new Error("Invalid model registry");
  return data.models;
}
export async function modelDescriptor(id: string): Promise<ApprovedModel> {
  const model = (await approvedModels()).find((m) => m.id === id);
  if (!model)
    throw new Error(
      `Unapproved model: ${id}. Only pinned Google models are permitted.`,
    );
  return model;
}
export async function hashArtifact(
  file: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  signal?.throwIfAborted();
  const details = await stat(file);
  signal?.throwIfAborted();
  if (!details.isFile()) throw new Error("Artifact must be a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  signal?.throwIfAborted();
  return { sha256: hash.digest("hex"), size: details.size };
}
async function localArtifacts(
  registryPath: string,
  selectedFile: string,
  signal?: AbortSignal,
): Promise<ApprovedArtifact[]> {
  try {
    const data = JSON.parse(
      (await readBoundedFile(registryPath, signal)).toString("utf8"),
    );
    if (data.version !== 1 || !Array.isArray(data.artifacts))
      throw new Error("Invalid local artifact registry");
    const ids = new Set<string>();
    for (const artifact of data.artifacts) {
      if (
        !artifact ||
        !/^jev\/[a-zA-Z0-9._-]+$/.test(artifact.id ?? "") ||
        ids.has(artifact.id) ||
        artifact.base_model !== "google/gemma-3-1b-it" ||
        artifact.revision !== GEMMA_TRAINING_REVISION ||
        !Array.isArray(artifact.roles) ||
        artifact.roles.length !== 1 ||
        artifact.roles[0] !== "classifier" ||
        artifact.template_version !== "v2" ||
        typeof artifact.training_run !== "string" ||
        !/^[a-zA-Z0-9._-]+$/.test(artifact.training_run ?? "") ||
        typeof artifact.file !== "string" ||
        (!isAbsolute(artifact.file) && artifact.file !== "model.gguf") ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size <= 0 ||
        artifact.license !== "gemma"
      )
        throw new Error(
          "Invalid local artifact: only pinned Gemma RFDT derivatives with a jev/ identity and classifier role are permitted",
        );
      ids.add(artifact.id);
    }
    return data.artifacts.map((artifact: ApprovedArtifact) => ({
      ...artifact,
      // Resolve the current portable placeholder through the selected model.
      file: isAbsolute(artifact.file) ? artifact.file : selectedFile,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function verifyArtifact(
  file: string,
  role: ModelRole = "classifier",
  modelId?: string,
  opts: { registryPath?: string; signal?: AbortSignal } = {},
): Promise<ApprovedArtifact> {
  if (role !== "classifier")
    throw new Error("Only classifier artifacts are supported");
  const absolute = resolve(file);
  const identity = await hashArtifact(absolute, opts.signal);
  // Base verification is used by explicit training preparation. The current
  // derivative runtime does not load the unrelated public base registry.
  const candidates: ApprovedArtifact[] = modelId?.startsWith("google/")
    ? await approvedModels()
    : await localArtifacts(
        opts.registryPath ?? CURRENT_ARTIFACT_REGISTRY,
        absolute,
        opts.signal,
      );
  const descriptor = candidates.find(
    (m) =>
      m.roles.includes(role) &&
      (!modelId || m.id === modelId) &&
      m.sha256 === identity.sha256 &&
      m.size === identity.size,
  );
  if (
    !descriptor ||
    !descriptor.base_model.startsWith("google/gemma-") ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  )
    throw new Error(
      "Unapproved model artifact: role, pinned Google lineage, size and checksum must match an approved artifact. No fallback is permitted.",
    );
  return { ...descriptor, file: absolute };
}

export interface TrainedArtifactManifest {
  version: 1;
  id: string;
  file: string;
  base_model: string;
  base_revision: string;
  template_version: "v2";
  training_run: string;
  sha256: string;
  size: number;
  run_manifest: string;
}
async function exportedRun(manifest: TrainedArtifactManifest) {
  const run = JSON.parse(await readFile(manifest.run_manifest, "utf8"));
  if (
    run.version !== 1 ||
    run.id !== manifest.training_run ||
    run.status !== "exported" ||
    run.base_model !== manifest.base_model ||
    run.base_revision !== manifest.base_revision ||
    run.template_version !== manifest.template_version ||
    resolve(run.directory ?? "") !== dirname(manifest.run_manifest) ||
    run.exports?.sha256 !== manifest.sha256 ||
    run.exports?.size !== manifest.size ||
    resolve(run.exports?.file ?? "") !== resolve(manifest.file) ||
    run.exports?.id !== manifest.id
  )
    throw new Error(
      "Artifact provenance does not match the completed RFDT export manifest",
    );
  return run;
}

/** Verify an export for scoped native evaluation without promoting it. */
export async function verifyTrainedArtifactExport(
  manifest: TrainedArtifactManifest,
): Promise<ApprovedArtifact> {
  if (
    manifest.version !== 1 ||
    manifest.base_model !== "google/gemma-3-1b-it" ||
    manifest.base_revision !== GEMMA_TRAINING_REVISION ||
    manifest.template_version !== "v2" ||
    !/^jev\/[a-zA-Z0-9._-]+$/.test(manifest.id) ||
    typeof manifest.training_run !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(manifest.training_run) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0 ||
    !isAbsolute(manifest.file) ||
    !isAbsolute(manifest.run_manifest)
  )
    throw new Error(
      "Export verification requires pinned Google Gemma lineage, valid template, run identity, and absolute artifact/run paths",
    );
  await exportedRun(manifest);
  const identity = await hashArtifact(manifest.file);
  if (identity.sha256 !== manifest.sha256 || identity.size !== manifest.size)
    throw new Error("Trained artifact size or checksum mismatch");
  const handle = await open(manifest.file, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (magic.toString() !== "GGUF")
      throw new Error("Approved trained artifact must be GGUF");
  } finally {
    await handle.close();
  }
  return {
    id: manifest.id,
    revision: manifest.base_revision,
    sha256: manifest.sha256,
    size: manifest.size,
    file: resolve(manifest.file),
    base_model: manifest.base_model,
    template_version: manifest.template_version,
    roles: ["classifier"],
    license: "gemma",
    training_run: manifest.training_run,
  };
}
