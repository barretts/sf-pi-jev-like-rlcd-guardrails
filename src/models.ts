import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildResponse,
  canonical,
  preparePrompt,
  type ClassifierResponse,
  type Logits,
  type Request,
} from "./core.js";

export type ModelRole = "classifier" | "agent" | "teacher";
export interface ApprovedArtifact {
  id: string;
  revision: string;
  sha256: string;
  size: number;
  file: string;
  base_model: string;
  template_version?: "v1" | "v2";
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
export const GEMMA_TRAINING_REVISION =
  "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
export const RFDT_QUALITY_SUITE_SHA256 =
  "cd3de2d07db024aeb0f8d22be394ffa9024307680efbe2967569c325bc7af3c9";
export const AGENT_MODEL_ID = "google/gemma-4-31B-it-qat-q4_0";
const root = fileURLToPath(new URL("../", import.meta.url));
const localRegistryDefault = () =>
  join(process.cwd(), ".jev", "artifacts.json");

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
  const details = await stat(file);
  if (!details.isFile()) throw new Error("Artifact must be a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size: details.size };
}
async function localArtifacts(
  registryPath: string,
): Promise<ApprovedArtifact[]> {
  try {
    const data = JSON.parse(await readFile(registryPath, "utf8"));
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
        !["v1", "v2"].includes(artifact.template_version) ||
        typeof artifact.training_run !== "string" ||
        !/^[a-zA-Z0-9._-]+$/.test(artifact.training_run ?? "") ||
        typeof artifact.file !== "string" ||
        !isAbsolute(artifact.file) ||
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
    return data.artifacts;
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
  if (!["classifier", "agent", "teacher"].includes(role))
    throw new Error("Invalid model role");
  const absolute = resolve(file);
  const identity = await hashArtifact(absolute, opts.signal);
  const candidates: ApprovedArtifact[] = [
    ...(await approvedModels()),
    ...(await localArtifacts(opts.registryPath ?? localRegistryDefault())),
  ];
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

export interface FetchOptions {
  directory?: string;
  acceptGemmaTerms?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  concurrency?: number;
  onProgress?: (completed: number, total: number, file: string) => void;
  /** Transport injection is intended for bounded offline verification. */
  fetch?: typeof globalThis.fetch;
}
export async function fetchApprovedFile(
  descriptor: ModelFile,
  opts: FetchOptions = {},
): Promise<string> {
  if (
    !/^[a-f0-9]{40}$/.test(descriptor.revision) ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size <= 0 ||
    descriptor.file !== descriptor.file.split(/[\\/]/).at(-1)
  )
    throw new Error("Invalid pinned file descriptor");
  const destination = join(
    resolve(opts.directory ?? join(root, "models")),
    descriptor.file,
  );
  try {
    const found = await hashArtifact(destination, opts.signal);
    if (found.sha256 === descriptor.sha256 && found.size === descriptor.size)
      return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const part = `${destination}.${randomUUID()}.part`;
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const concurrency = opts.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Download concurrency must be 1 through 8");
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isFinite(idleTimeoutMs) ||
    idleTimeoutMs < 1
  )
    throw new Error("Download deadlines must be positive");
  const deadline = setTimeout(
    () => controller.abort(new Error("Model download deadline exceeded")),
    timeoutMs,
  );
  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error("Model download stalled")),
      idleTimeoutMs,
    );
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (concurrency > 1 && descriptor.size > 128 * 1024 * 1024) {
      handle = await open(part, "wx", 0o600);
      await handle.truncate(descriptor.size);
      let nextOffset = 0;
      let received = 0;
      const active = new Map<number, number>();
      const report = () =>
        opts.onProgress?.(
          received +
            [...active.values()].reduce((sum, count) => sum + count, 0),
          descriptor.size,
          descriptor.file,
        );
      const download = opts.fetch ?? globalThis.fetch;
      const url = `https://huggingface.co/${descriptor.repository}/resolve/${descriptor.revision}/${descriptor.source_file ?? descriptor.file}`;
      const worker = async () => {
        while (nextOffset < descriptor.size) {
          const start = nextOffset;
          const end = Math.min(start + 64 * 1024 * 1024, descriptor.size) - 1;
          nextOffset = end + 1;
          for (let attempt = 0; attempt < 3; attempt++) {
            const rangeController = new AbortController();
            const rangeSignal = AbortSignal.any([
              signal,
              rangeController.signal,
            ]);
            let stalled: NodeJS.Timeout | undefined;
            const reset = () => {
              clearTimeout(stalled);
              stalled = setTimeout(
                () =>
                  rangeController.abort(
                    new Error("Model range download stalled"),
                  ),
                idleTimeoutMs,
              );
            };
            let rangeReader:
              ReadableStreamDefaultReader<Uint8Array> | undefined;
            let retry = false;
            try {
              signal.throwIfAborted();
              reset();
              active.set(start, 0);
              const response = await download(url, {
                headers: { Range: `bytes=${start}-${end}` },
                signal: rangeSignal,
              });
              if (response.status === 429 || response.status >= 500)
                throw new TypeError(
                  `Model range transport failed: HTTP ${response.status}`,
                );
              if (
                response.status !== 206 ||
                response.headers.get("content-range") !==
                  `bytes ${start}-${end}/${descriptor.size}` ||
                !response.body
              )
                throw new Error(
                  "Download server did not honor the exact approved byte range",
                );
              rangeReader = response.body.getReader();
              const buffer = Buffer.allocUnsafe(end - start + 1);
              let count = 0;
              while (true) {
                rangeSignal.throwIfAborted();
                reset();
                const { done, value } = await rangeReader.read();
                if (done) break;
                if (count + value.byteLength > buffer.byteLength)
                  throw new Error("Model range exceeds approved size");
                buffer.set(value, count);
                count += value.byteLength;
                active.set(start, count);
                report();
              }
              if (count !== buffer.byteLength)
                throw new Error("Model range is incomplete");
              let written = 0;
              while (written < buffer.byteLength) {
                const result = await handle!.write(
                  buffer,
                  written,
                  buffer.byteLength - written,
                  start + written,
                );
                if (result.bytesWritten < 1)
                  throw new Error("Model artifact write made no progress");
                written += result.bytesWritten;
              }
              active.delete(start);
              received += count;
              report();
              break;
            } catch (error) {
              active.delete(start);
              const transportError =
                error instanceof TypeError ||
                rangeController.signal.aborted ||
                (error as NodeJS.ErrnoException).code?.startsWith("E");
              if (!signal.aborted && transportError && attempt < 2)
                retry = true;
              else {
                controller.abort(error);
                throw error;
              }
            } finally {
              clearTimeout(stalled);
              await rangeReader?.cancel().catch(() => {});
            }
            if (retry)
              await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
          }
        }
      };
      const outcomes = await Promise.allSettled(
        Array.from({ length: concurrency }, () => worker()),
      );
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (received !== descriptor.size)
        throw new Error("Model download is incomplete");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const found = await hashArtifact(part, signal);
      if (found.sha256 !== descriptor.sha256 || found.size !== descriptor.size)
        throw new Error("Model download size or checksum mismatch");
      signal.throwIfAborted();
      await rename(part, destination);
      return destination;
    }
    resetIdle();
    const response = await (opts.fetch ?? globalThis.fetch)(
      `https://huggingface.co/${descriptor.repository}/resolve/${descriptor.revision}/${descriptor.source_file ?? descriptor.file}`,
      { signal },
    );
    if (!response.ok || !response.body)
      throw new Error(`Download failed: HTTP ${response.status}`);
    const reported = response.headers.get("content-length");
    if (reported && Number(reported) !== descriptor.size)
      throw new Error("Model download reported unexpected size");
    handle = await open(part, "wx", 0o600);
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    while (true) {
      signal.throwIfAborted();
      resetIdle();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > descriptor.size)
        throw new Error("Model download exceeds approved size");
      hash.update(value);
      await handle.writeFile(value);
      opts.onProgress?.(received, descriptor.size, descriptor.file);
    }
    if (
      received !== descriptor.size ||
      hash.digest("hex") !== descriptor.sha256
    )
      throw new Error("Model download size or checksum mismatch");
    await handle.sync();
    await handle.close();
    handle = undefined;
    signal.throwIfAborted();
    await rename(part, destination);
    return destination;
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
    await reader?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    await rm(part, { force: true });
  }
}
export async function fetchApprovedModel(
  id: string,
  opts: FetchOptions = {},
): Promise<ApprovedArtifact & { chat_template_file?: string }> {
  const descriptor = await modelDescriptor(id);
  if (descriptor.license === "gemma" && !opts.acceptGemmaTerms)
    throw new Error(
      "Review https://ai.google.dev/gemma/terms and explicitly accept Gemma terms before downloading.",
    );
  const file = await fetchApprovedFile(descriptor, opts);
  const chat_template_file = descriptor.chat_template
    ? await fetchApprovedFile(descriptor.chat_template, opts)
    : undefined;
  return {
    ...descriptor,
    file,
    ...(chat_template_file ? { chat_template_file } : {}),
  };
}

export interface TrainedArtifactManifest {
  version: 1;
  id: string;
  file: string;
  base_model: string;
  base_revision: string;
  template_version: "v1" | "v2";
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
    !["v1", "v2"].includes(manifest.template_version) ||
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
      "Artifact approval requires pinned Google Gemma lineage, valid template, run identity, and absolute artifact/run paths",
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

/** Load the authored acceptance corpus independently of user training rows. */
export async function loadRfdtQualitySuite() {
  const text = await readFile(join(root, "fixtures", "quality.jsonl"), "utf8");
  const digest = createHash("sha256").update(text).digest("hex");
  if (digest !== RFDT_QUALITY_SUITE_SHA256)
    throw new Error("Frozen RFDT quality suite checksum mismatch");
  const { qualityDatasetDigest, validateQualityRecords } =
    await import("./evaluation.js");
  const records = validateQualityRecords(
    text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
  );
  if (qualityDatasetDigest(records) !== RFDT_QUALITY_SUITE_SHA256)
    throw new Error("Frozen RFDT quality suite normalization mismatch");
  return records;
}

function rfdtContext(request: Request): string {
  if (typeof request.state === "string") return canonical(request.state);
  if (request.messages?.length === 1 && request.messages[0].role === "user")
    return canonical(request.messages[0].content);
  return canonical(
    request.state != null
      ? { state: request.state }
      : { messages: request.messages },
  );
}

/** Reject exact known held-out groups or contexts in supplied tuning rows. */
export async function assertRfdtQualityIsolation(
  rows: readonly { group_id: string; split?: string; request: Request }[],
): Promise<void> {
  const suite = await loadRfdtQualitySuite();
  const heldOut = (split: "train" | "validation") => {
    const records = suite.filter((record) =>
      split === "train" ? record.split !== "train" : record.split === "test",
    );
    return {
      groups: new Set(records.map((record) => record.group_id)),
      contexts: new Set(records.map((record) => rfdtContext(record.request))),
    };
  };
  const reserved = {
    train: heldOut("train"),
    validation: heldOut("validation"),
  };
  for (const row of rows) {
    if (row.split !== "train" && row.split !== "validation") continue;
    const protectedRows = reserved[row.split];
    if (
      protectedRows.groups.has(row.group_id) ||
      protectedRows.contexts.has(rfdtContext(row.request))
    )
      throw new Error(
        `RFDT ${row.split} rows overlap a reserved quality suite group or context`,
      );
  }
}

const RFDT_NUMERIC_TOLERANCE = 1e-8;
function sameRfdtValues(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number")
    return (
      typeof left === "number" &&
      typeof right === "number" &&
      Number.isFinite(left) &&
      Number.isFinite(right) &&
      Math.abs(left - right) <= RFDT_NUMERIC_TOLERANCE
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameRfdtValues(value, right[index]))
    );
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameRfdtValues(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function rfdtProbabilities(values: unknown, length: number): number[] {
  if (
    !Array.isArray(values) ||
    values.length !== length ||
    values.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1,
    ) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) >
      RFDT_NUMERIC_TOLERANCE
  )
    throw new Error("invalid or unnormalized native answer probabilities");
  return values;
}

function reconstructRfdtAnswers(
  request: Request,
  predictions: unknown[],
  manifest: TrainedArtifactManifest,
): ClassifierResponse["answers"] {
  const plan = preparePrompt(
    {
      ...request,
      model: manifest.id,
      options: {
        ...request.options,
        template_version: manifest.template_version,
      },
    },
    manifest.template_version,
  );
  const logits: Logits = {};
  for (const [index, branch] of plan.questions.entries()) {
    const question = plan.request.questions[index];
    const answer = predictions[index] as Record<string, any> | null;
    if (!answer || answer.type !== question.type)
      throw new Error("incorrect native answer type");
    let values: number[];
    if (question.type === "noul") {
      values = rfdtProbabilities(answer.rating?.probabilities, 9);
    } else {
      const probabilities = answer.probabilities;
      if (
        !probabilities ||
        typeof probabilities !== "object" ||
        Array.isArray(probabilities) ||
        Object.keys(probabilities).length !== branch.answer_labels.length ||
        branch.answer_labels.some(
          (label) => !Object.hasOwn(probabilities, label),
        )
      )
        throw new Error(
          "native answer probability labels do not match exactly",
        );
      values = rfdtProbabilities(
        branch.answer_labels.map((label) => probabilities[label]),
        branch.answer_labels.length,
      );
    }
    logits[branch.branch_id] = Object.fromEntries(
      branch.output_labels.map((label, labelIndex) => [
        label,
        Math.log(Math.max(values[labelIndex], Number.MIN_VALUE)),
      ]),
    );
  }
  const reconstructed = buildResponse(plan, logits, 0, true).answers;
  for (const [index, question] of request.questions.entries())
    if (!sameRfdtValues(predictions[index], reconstructed[question.id]))
      throw new Error("native answer fields do not match their probabilities");
  return reconstructed;
}

/** Recompute native acceptance from the fixed corpus and recorded predictions. */
export async function verifyNativeRfdtAcceptance(
  manifest: TrainedArtifactManifest,
  splits: readonly ("validation" | "test")[] = ["validation", "test"],
): Promise<void> {
  const run = await exportedRun(manifest);
  const fail = (message: string): never => {
    throw new Error(`Native RFDT acceptance: ${message}`);
  };
  if (
    !run.prepared?.dataset_file ||
    !/^[a-f0-9]{64}$/.test(run.prepared.dataset_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(run.prepared.sha256 ?? "")
  )
    fail("frozen dataset and prepared prompt identities are required");
  const dataset = await readFile(run.prepared.dataset_file, "utf8");
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  if (digest(dataset) !== run.prepared.dataset_sha256)
    fail("frozen dataset checksum mismatch");
  const { evaluateRecords, qualityDatasetDigest } =
    await import("./evaluation.js");
  const { assignRfdtSplits, validateRfdtExample } = await import("./rfdt.js");
  const trainingRecords = dataset
    .split(/\r?\n/)
    .filter((line: string) => line.trim())
    .map((line: string) => validateRfdtExample(JSON.parse(line)));
  const trainingSplits = assignRfdtSplits(trainingRecords);
  if (
    trainingRecords.some(
      (record) => record.split !== trainingSplits.get(record.group_id),
    )
  )
    fail("training split identities do not match frozen rows");
  const records = await loadRfdtQualitySuite();
  await assertRfdtQualityIsolation(trainingRecords);
  let frozen = "";
  for (const split of ["train", "validation", "test"] as const) {
    const file = run.prepared.files?.[split];
    if (typeof file !== "string") fail(`missing frozen ${split} prompts`);
    const text = await readFile(file, "utf8");
    frozen += `${split}\n${text}`;
    const branches = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const selected = trainingRecords.filter((record) => record.split === split);
    if (
      branches.length !== run.prepared.branches?.[split] ||
      branches.length !==
        selected.reduce(
          (count, record) => count + record.request.questions.length,
          0,
        ) ||
      branches.some(
        (branch) =>
          branch.split !== split ||
          branch.template_version !== manifest.template_version,
      )
    )
      fail(`frozen ${split} prompt coverage mismatch`);
  }
  if (digest(frozen) !== run.prepared.sha256)
    fail("frozen prepared prompt checksum mismatch");
  const binding = {
    training_run: manifest.training_run,
    artifact_id: manifest.id,
    artifact_sha256: manifest.sha256,
    artifact_size: manifest.size,
    template_version: manifest.template_version,
    prepared_sha256: run.prepared.sha256,
    dataset_sha256: run.prepared.dataset_sha256,
    quality_suite_sha256: RFDT_QUALITY_SUITE_SHA256,
  };
  for (const split of splits) {
    const acceptance = run.evaluation?.[`native_${split}`];
    if (
      acceptance?.artifact !== "native_gguf" ||
      acceptance.artifact_sha256 !== manifest.sha256 ||
      typeof acceptance.file !== "string" ||
      !/^[a-f0-9]{64}$/.test(acceptance.sha256 ?? "") ||
      canonical(acceptance.binding ?? null) !== canonical(binding)
    )
      fail(`matching native ${split} evidence is required`);
    const text = await readFile(acceptance.file, "utf8");
    if (digest(text) !== acceptance.sha256)
      fail(`native ${split} report checksum mismatch`);
    const report = JSON.parse(text);
    const selected = records.filter((record) => record.split === split);
    if (
      selected.length === 0 ||
      report.schema_version !== 1 ||
      report.template_version !== manifest.template_version ||
      canonical(report.splits) !== canonical([split]) ||
      canonical(report.rfdt ?? null) !== canonical(binding) ||
      report.dataset_sha256 !== qualityDatasetDigest(selected) ||
      !Array.isArray(report.results) ||
      report.results.length !== selected.length
    )
      fail(`native ${split} report identity or dataset mismatch`);
    const predictions: ClassifierResponse[] = selected.map((record, index) => {
      const result = report.results[index];
      const artifact = result?.metadata?.artifact;
      if (
        result?.id !== record.id ||
        result.group_id !== record.group_id ||
        result.split !== split ||
        result.regression !== (record.regression === true) ||
        result.error !== undefined ||
        result.model !== manifest.id ||
        result.metadata?.backend !== "llama.cpp" ||
        result.metadata.template_version !== manifest.template_version ||
        result.metadata.model_revision !== manifest.base_revision ||
        artifact?.id !== manifest.id ||
        artifact.sha256 !== manifest.sha256 ||
        artifact.size !== manifest.size ||
        artifact.revision !== manifest.base_revision ||
        artifact.base_model !== manifest.base_model ||
        artifact.template_version !== manifest.template_version ||
        !Array.isArray(result.answers) ||
        result.answers.length !== record.request.questions.length ||
        result.answers.some(
          (answer: any, answerIndex: number) =>
            answer?.question_id !== record.request.questions[answerIndex].id ||
            canonical(answer.target) !==
              canonical(record.targets[answer.question_id]),
        )
      )
        fail(`native ${split} result coverage or artifact identity mismatch`);
      const answers = (() => {
        try {
          return reconstructRfdtAnswers(
            record.request,
            result.answers.map((answer: any) => answer.prediction),
            manifest,
          );
        } catch (error) {
          return fail(
            `native ${split} quality gates or derived scores do not pass: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
      return {
        model: result.model,
        answers,
        metadata: result.metadata,
        usage: result.usage,
      };
    });
    let index = 0;
    const recomputed = await evaluateRecords(
      { classify: async () => predictions[index++] },
      selected,
      manifest.template_version,
      { modelId: manifest.id },
    );
    if (
      report.prompt_manifest_sha256 !== recomputed.prompt_manifest_sha256 ||
      report.results.some(
        (result: any, resultIndex: number) =>
          result.logical_prompt_sha256 !==
            recomputed.results[resultIndex].logical_prompt_sha256 ||
          !sameRfdtValues(
            result.answers,
            recomputed.results[resultIndex].answers,
          ),
      ) ||
      !sameRfdtValues(report.summary, recomputed.summary) ||
      !sameRfdtValues(acceptance.summary, recomputed.summary) ||
      recomputed.summary.gates.passed !== true
    )
      fail(`native ${split} quality gates or derived scores do not pass`);
  }
}

export async function approveTrainedArtifact(
  manifest: TrainedArtifactManifest,
  opts: { registryPath?: string } = {},
): Promise<ApprovedArtifact> {
  const descriptor = await verifyTrainedArtifactExport(manifest);
  await verifyNativeRfdtAcceptance(manifest);
  const registryPath = resolve(opts.registryPath ?? localRegistryDefault());
  const artifacts = (await localArtifacts(registryPath)).filter(
    (a) => a.id !== descriptor.id,
  );
  artifacts.push(descriptor);
  await mkdir(dirname(registryPath), { recursive: true });
  const part = `${registryPath}.${randomUUID()}.part`;
  try {
    await writeFile(
      part,
      JSON.stringify({ version: 1, artifacts }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await rename(part, registryPath);
  } finally {
    await rm(part, { force: true });
  }
  return descriptor;
}
