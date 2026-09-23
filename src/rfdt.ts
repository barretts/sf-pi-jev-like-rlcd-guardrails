import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTrainedArtifactExport } from "./models.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export const RFDT_BASE_MODEL = "google/gemma-3-1b-it";
export const RFDT_BASE_REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
export const RFDT_MLX_LM_REVISION = "9d1e356e7cc6549e7d1697adabe2ea01ff8e062c";
export const RFDT_LLAMA_REVISION = "f072b103714dfa1eee531f80b24512faf38e3dd2";
export const TRAINING_INPUT_SHA256 = Object.freeze({
  "fit.jsonl":
    "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25",
  "prepared-fit.jsonl":
    "8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3",
  "pairs.json":
    "343ed1062e590fca8938099dc058074bea3f9f74d6118efc9df5b9ead35a4773",
  "families.json":
    "51062c174bfa28d798ca9eb338441e3d03ed73685b1f4ec707af20c41d8dcf13",
  "objective.json":
    "a1fbaaa262fa2d103c8ac9771ba1d9db774e7a90be5336cec3665f6b22dd3da9",
});
export interface RfdtRunManifest {
  version: 1;
  id: string;
  status: "prepared" | "trained" | "exported";
  directory: string;
  base_model: string;
  base_revision: string;
  template_version: "v2";
  qualified: false;
  source: { file: string; sha256: string; examples: number };
  prepared: {
    files: { train: string };
    branches: { train: number };
    sha256: string;
  };
  training?: Record<string, any>;
  exports?: {
    id: string;
    file: string;
    sha256: string;
    size: number;
    converter_revision: string;
    converter_sha256: string;
  };
}
export interface RfdtArtifactManifest {
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
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export async function rfdtSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function freshDirectory(directory: string) {
  try {
    await access(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw new Error(
    "Output already exists; preserve the previous attempt and choose a fresh directory",
  );
}
async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, file);
}
function manifestPath(runDir: string) {
  return join(resolve(runDir), "manifest.json");
}
async function readManifest(runDir: string): Promise<RfdtRunManifest> {
  const value = JSON.parse(await readFile(manifestPath(runDir), "utf8"));
  requireThat(
    value.version === 1 &&
      value.qualified === false &&
      value.base_model === RFDT_BASE_MODEL &&
      value.base_revision === RFDT_BASE_REVISION &&
      value.template_version === "v2" &&
      resolve(value.directory) === resolve(runDir),
    "Invalid current guardrail training run",
  );
  return value;
}
export async function verifyTrainingInputs(
  dataDir = join(root, "training", "data"),
) {
  for (const [name, digest] of Object.entries(TRAINING_INPUT_SHA256))
    requireThat(
      (await rfdtSha256(join(dataDir, name))) === digest,
      `Immutable C11 training input changed: ${name}`,
    );
  const rows = (await readFile(join(dataDir, "prepared-fit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  requireThat(
    rows.length === 327 &&
      rows.every((row) => row.split === "train") &&
      new Set(rows.map((row) => row.source_id)).size === 327 &&
      new Set(rows.map((row) => row.group_id)).size === 133,
    "C11 FIT ownership or inventory changed",
  );
  return {
    rows: 327,
    groups: 133,
    pairs: 86,
    validationRows: 0,
    testRows: 0,
    qualified: false,
  };
}
/** Prepare only the immutable current FIT prompts. Training verifies original-base tokenizer parity. */
export async function prepareRfdt(
  inputPath = join(root, "training", "data", "fit.jsonl"),
  options: { outputDir: string },
): Promise<RfdtRunManifest> {
  await verifyTrainingInputs();
  requireThat(
    (await rfdtSha256(inputPath)) === TRAINING_INPUT_SHA256["fit.jsonl"],
    "Current FIT source changed",
  );
  const directory = resolve(options.outputDir);
  await freshDirectory(directory);
  await mkdir(directory, { recursive: true });
  const train = join(directory, "train.jsonl");
  await copyFile(join(root, "training", "data", "prepared-fit.jsonl"), train);
  const manifest: RfdtRunManifest = {
    version: 1,
    id: `guardrail-${randomUUID()}`,
    status: "prepared",
    directory,
    base_model: RFDT_BASE_MODEL,
    base_revision: RFDT_BASE_REVISION,
    template_version: "v2",
    qualified: false,
    source: {
      file: resolve(inputPath),
      sha256: TRAINING_INPUT_SHA256["fit.jsonl"],
      examples: 327,
    },
    prepared: {
      files: { train },
      branches: { train: 327 },
      sha256: TRAINING_INPUT_SHA256["prepared-fit.jsonl"],
    },
  };
  await atomicJson(manifestPath(directory), manifest);
  return manifest;
}
/** Read the actual importer handoff, preserving its reported margin digest and fixed FIT inventory. */
export async function readImportedFitReference(runDir: string) {
  const run = resolve(runDir),
    manifest = await readManifest(run);
  requireThat(
    manifest.status === "exported" &&
      manifest.training?.training_backend === "torch_cuda" &&
      manifest.training?.qualified === false,
    "A locally imported and exported CUDA run is required",
  );
  await verifyPrepared(manifest);
  const report = JSON.parse(
    await readFile(join(run, "adapter", "import-report.json"), "utf8"),
  );
  requireThat(
    report.ok === true &&
      report.reload_verified === true &&
      report.qualified === false &&
      report.training_backend === "torch_cuda" &&
      report.cross_backend_equivalence?.ok === true,
    "Local importer did not produce a successful unqualified equivalence report",
  );
  const bytes = await readFile(join(run, "adapter", "local-fit-margins.jsonl"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  requireThat(
    digest === report.local_fit_margins_sha256 &&
      digest === manifest.training.local_fit_margins_sha256,
    "Local reload reference margins changed",
  );
  const cells = bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reference = new Map<string, number>();
  for (const cell of cells) {
    requireThat(
      typeof cell.source_id === "string" &&
        Number.isFinite(cell.margin) &&
        !reference.has(cell.source_id),
      "Invalid or duplicate local FIT margin",
    );
    reference.set(cell.source_id, cell.margin);
  }
  const rows: Record<string, any>[] = (
    await readFile(manifest.prepared.files.train, "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  requireThat(
    rows.length === 327 &&
      reference.size === 327 &&
      rows.every(
        (row) => row.split === "train" && reference.has(row.source_id),
      ),
    "FIT precision-check inventory changed",
  );
  return { manifest, rows, reference, report };
}
async function verifyPrepared(manifest: RfdtRunManifest) {
  requireThat(
    manifest.prepared.branches.train === 327 &&
      (await rfdtSha256(manifest.prepared.files.train)) ===
        TRAINING_INPUT_SHA256["prepared-fit.jsonl"],
    "Prepared current FIT prompts changed",
  );
}
function pythonBinary(python?: string) {
  return python ?? join(root, ".build", "rfdt-venv", "bin", "python");
}
async function runProcess(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0,
      stderr: Buffer = Buffer.alloc(0),
      stopping = false,
      stopReason: unknown,
      processError: Error | undefined,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: unknown) => {
      if (stopping) return;
      stopping = true;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        // Descendants can retain inherited pipes after the worker has exited.
        // Closing our readers still lets close wait for the worker to be reaped.
        child.stdout.destroy();
        child.stderr.destroy();
      }, 500);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopping) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 8 * 1024 * 1024)
        stop(new Error("RFDT process stdout exceeded the 8 MiB output limit"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-16_384);
    });
    const abort = () => stop(signal?.reason ?? new Error("RFDT cancelled"));
    child.on("error", (error) => {
      processError ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (stopping) reject(stopReason);
      else if (signal?.aborted)
        reject(signal.reason ?? new Error("RFDT cancelled"));
      else if (processError) reject(processError);
      else if (code !== 0)
        reject(
          new Error(
            `RFDT process failed (${code}): ${stderr.length ? stderr.toString() : Buffer.concat(stdout).toString()}`,
          ),
        );
      else resolveResult(Buffer.concat(stdout).toString());
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function parseWorker(text: string): Record<string, any> {
  const line = text.trim().split(/\r?\n/).at(-1);
  requireThat(line, "RFDT worker returned no result");
  const result = JSON.parse(line);
  requireThat(object(result), "Invalid RFDT worker result");
  return result;
}

/** Import a supervised completed C11 checkpoint; this never grants enforcement admission. */
export async function importCudaRfdt(
  runDir: string,
  options: {
    cudaRun: string;
    receiptSha256: string;
    modelPath: string;
    python?: string;
    signal?: AbortSignal;
  },
): Promise<Record<string, any>> {
  const manifest = await readManifest(runDir);
  await verifyPrepared(manifest);
  requireThat(
    manifest.status === "prepared" &&
      !manifest.training &&
      /^[a-f0-9]{64}$/.test(options.receiptSha256),
    "Import requires a fresh prepared run and an explicitly pinned checkpoint receipt",
  );
  const training = parseWorker(
    await runProcess(
      pythonBinary(options.python),
      [
        join(root, "training", "import_checkpoint.py"),
        "--cuda-run",
        resolve(options.cudaRun),
        "--receipt-sha256",
        options.receiptSha256,
        "--model",
        resolve(options.modelPath),
        "--data",
        manifest.prepared.files.train,
        "--output",
        join(manifest.directory, "adapter"),
      ],
      options.signal,
    ),
  );
  requireThat(
    training.ok === true &&
      training.reload_verified === true &&
      training.training_backend === "torch_cuda" &&
      training.qualified === false,
    "Checkpoint failed local reload or cross-backend checks",
  );
  manifest.training = training;
  manifest.status = "trained";
  await atomicJson(manifestPath(runDir), manifest);
  return training;
}
export async function exportRfdt(
  runDir: string,
  options: {
    modelId: string;
    outputFile?: string;
    modelPath: string;
    python?: string;
    converter?: string;
    signal?: AbortSignal;
  },
): Promise<RfdtArtifactManifest> {
  const manifest = await readManifest(runDir);
  await verifyPrepared(manifest);
  requireThat(
    manifest.status === "trained" &&
      manifest.training &&
      /^jev\/[\w.-]+$/.test(options.modelId),
    "F16 export requires an imported trained checkpoint and a scoped jev/ model ID",
  );
  const python = pythonBinary(options.python),
    fused = join(manifest.directory, "fused");
  const fusion = parseWorker(
    await runProcess(
      python,
      [
        join(root, "training", "local_export.py"),
        "--model",
        resolve(options.modelPath),
        "--adapter",
        String(manifest.training.adapter_dir),
        "--data",
        manifest.prepared.files.train,
        "--output",
        fused,
      ],
      options.signal,
    ),
  );
  requireThat(
    fusion.fused === true && fusion.fusion_dtype === "float32",
    "Local fusion did not preserve FP32",
  );
  const vendor = join(root, ".vendor", "llama.cpp"),
    converter = options.converter ?? join(vendor, "convert_hf_to_gguf.py");
  requireThat(
    (await runProcess("git", ["-C", vendor, "rev-parse", "HEAD"])).trim() ===
      RFDT_LLAMA_REVISION,
    "Export requires the pinned llama.cpp converter checkout",
  );
  requireThat(
    (await rfdtSha256(converter)) ===
      sha(
        await runProcess("git", [
          "-C",
          vendor,
          "show",
          `${RFDT_LLAMA_REVISION}:convert_hf_to_gguf.py`,
        ]),
      ),
    "Converter differs from pinned source",
  );
  await runProcess("git", [
    "-C",
    vendor,
    "diff",
    "--quiet",
    "--",
    "conversion",
    "gguf-py",
  ]);
  await runProcess(python, [
    "-c",
    "import importlib.metadata; assert importlib.metadata.version('torch') == '2.11.0', 'F16 conversion requires torch==2.11.0'",
  ]);
  const file = resolve(
    options.outputFile ?? join(manifest.directory, "model-f16.gguf"),
  );
  await freshDirectory(file);
  await mkdir(dirname(file), { recursive: true });
  await runProcess(
    python,
    [converter, fused, "--outfile", file, "--outtype", "f16"],
    options.signal,
  );
  const handle = await open(file, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    requireThat(magic.toString() === "GGUF", "Converter output is not GGUF");
  } finally {
    await handle.close();
  }
  const artifact: RfdtArtifactManifest = {
    version: 1,
    id: options.modelId,
    file,
    base_model: RFDT_BASE_MODEL,
    base_revision: RFDT_BASE_REVISION,
    template_version: "v2",
    training_run: manifest.id,
    sha256: await rfdtSha256(file),
    size: (await stat(file)).size,
    run_manifest: manifestPath(runDir),
  };
  manifest.status = "exported";
  manifest.exports = {
    id: artifact.id,
    file,
    sha256: artifact.sha256,
    size: artifact.size,
    converter_revision: RFDT_LLAMA_REVISION,
    converter_sha256: await rfdtSha256(converter),
  };
  manifest.training = { ...manifest.training, fusion };
  await atomicJson(manifestPath(runDir), manifest);
  await atomicJson(join(manifest.directory, "artifact.json"), artifact);
  const descriptor = await verifyTrainedArtifactExport(artifact);
  await atomicJson(join(manifest.directory, "registry.json"), {
    version: 1,
    artifacts: [descriptor],
  });
  return artifact;
}
