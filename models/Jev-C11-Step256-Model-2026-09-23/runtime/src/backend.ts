import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import {
  InvalidRequest,
  validateRequest,
  preparePrompt,
  buildResponse,
  type Plan,
  type Logits,
  type TemplateVersion,
} from "./core.js";
import { verifyArtifact } from "./models.js";

export interface Config {
  modelFile?: string;
  artifactRegistryPath?: string;
  modelId: string;
  device: "auto" | "cpu" | "metal";
  binary: string;
  maxModelLen: number;
  maxBatchSize: number;
  maxBatchTokens: number;
  maxRequestBranches: number;
  advanced: boolean;
  templateVersion?: TemplateVersion;
  queueTimeoutMs?: number;
  requestTimeoutMs?: number;
  initTimeoutMs?: number;
}
const root = new URL("../", import.meta.url);
const deadlines = { queue: 30_000, request: 120_000, initialization: 300_000 };
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const device = env.JEV_DEVICE ?? "auto";
  if (!["auto", "cpu", "metal"].includes(device))
    throw new Error("JEV_DEVICE must be auto, cpu, or metal");
  const templateVersion = env.JEV_TEMPLATE_VERSION ?? "v1";
  if (templateVersion !== "v1" && templateVersion !== "v2")
    throw new Error("JEV_TEMPLATE_VERSION must be v1 or v2");
  return {
    modelFile: env.JEV_MODEL_FILE,
    modelId: env.JEV_MODEL_ID ?? "google/gemma-3-1b-it",
    device: device as Config["device"],
    binary: fileURLToPath(new URL(".build/jev-native", root)),
    maxModelLen: 16384,
    maxBatchSize: 32,
    maxBatchTokens: 32768,
    maxRequestBranches: 100,
    advanced: /^(1|true|yes|on)$/i.test(
      env.ENABLE_OPEN_JEV_ADVANCED_METRICS ?? "",
    ),
    templateVersion,
    queueTimeoutMs: deadlines.queue,
    requestTimeoutMs: deadlines.request,
    initTimeoutMs: deadlines.initialization,
  };
}
export class Overloaded extends Error {
  constructor() {
    super("Scoring queue is full");
    this.name = "Overloaded";
  }
}
export class DeadlineExceeded extends Error {
  constructor(public stage: "queue" | "request" | "initialization") {
    super(
      `${stage === "initialization" ? "Initialization" : stage === "queue" ? "Queue" : "Classification"} deadline exceeded`,
    );
    this.name = "DeadlineExceeded";
  }
}
export interface Evaluation {
  logits: Logits;
  input_tokens: number;
  metrics: Record<string, unknown>;
}
export interface InferenceAdapter {
  warmup(): Promise<void>;
  compile(plan: Plan, signal?: AbortSignal): Promise<unknown>;
  evaluate(
    compiled: unknown,
    signal?: AbortSignal,
    full?: boolean,
  ): Promise<Evaluation>;
  dispose(): Promise<void>;
}
type Artifact = Awaited<ReturnType<typeof verifyArtifact>>;
type Lifecycle =
  "cold" | "initializing" | "ready" | "failed" | "stopping" | "disposed";
type Pending = {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
interface Generation {
  id: number;
  child?: ChildProcessWithoutNullStreams;
  runtimeDir?: string;
  pending: Map<string, Pending>;
  exited?: Promise<void>;
  failed: boolean;
  controller: AbortController;
  cleanup?: Promise<void>;
  initializing?: Promise<void>;
  artifact?: Artifact;
  identity?: Record<string, unknown>;
}
function configuration(config: Config) {
  for (const key of ["modelFile", "artifactRegistryPath"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || !value))
      throw new Error(`${key} must be a nonempty path`);
  }
  if (!config.modelId || typeof config.modelId !== "string")
    throw new Error("Model ID must be nonempty");
  if (!config.binary || typeof config.binary !== "string")
    throw new Error("Native binary must be a nonempty path");
  if (!["auto", "cpu", "metal"].includes(config.device))
    throw new Error("Unsupported device");
  if (
    config.templateVersion !== undefined &&
    !["v1", "v2"].includes(config.templateVersion)
  )
    throw new Error("Unsupported template version");
  for (const [key, maximum] of [
    ["maxModelLen", 32768],
    ["maxBatchSize", 256],
    ["maxBatchTokens", 131072],
    ["maxRequestBranches", 256],
  ] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`${key} must be an integer from 1 to ${maximum}`);
  }
  for (const key of [
    "queueTimeoutMs",
    "requestTimeoutMs",
    "initTimeoutMs",
  ] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    )
      throw new Error(`${key} must be a positive bounded integer`);
  }
  if (typeof config.advanced !== "boolean")
    throw new Error("advanced must be a boolean");
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name !== "AbortError"
    ? signal.reason
    : new DOMException("Cancelled", "AbortError");
}
function invalidProtocol(): Error {
  return new Error("Invalid native protocol response");
}
function validateResult(op: string, value: unknown) {
  if (op === "init") {
    if (
      !record(value) ||
      value.ready !== true ||
      typeof value.template !== "string" ||
      !["cpu", "metal"].includes(value.device) ||
      typeof value.device_name !== "string" ||
      !record(value.native_build) ||
      typeof value.native_build.commit !== "string" ||
      !record(value.limits)
    )
      throw invalidProtocol();
  } else if (op === "compile") {
    if (!Array.isArray(value) || value.length < 1 || value.length > 256)
      throw invalidProtocol();
    for (const branch of value) {
      if (
        !record(branch) ||
        typeof branch.branch_id !== "string" ||
        typeof branch.rendered !== "string" ||
        !Array.isArray(branch.tokens) ||
        !branch.tokens.length ||
        !branch.tokens.every(
          (token: unknown) =>
            Number.isSafeInteger(token) && (token as number) >= 0,
        ) ||
        !record(branch.token_ids) ||
        !Object.keys(branch.token_ids).length ||
        !Object.values(branch.token_ids).every(
          (token) => Number.isSafeInteger(token) && (token as number) >= 0,
        )
      )
        throw invalidProtocol();
    }
  } else if (op === "evaluate") {
    if (
      !record(value) ||
      !record(value.logits) ||
      !Number.isSafeInteger(value.input_tokens) ||
      value.input_tokens < 0 ||
      !record(value.metrics)
    )
      throw invalidProtocol();
    for (const row of Object.values(value.logits)) {
      if (
        !record(row) ||
        !Object.keys(row).length ||
        !Object.values(row).every(
          (logit) => typeof logit === "number" && Number.isFinite(logit),
        )
      )
        throw invalidProtocol();
    }
  }
}
export class NativeBackend implements InferenceAdapter {
  private generation?: Generation;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  private sequence = 0;
  private next = 0;
  private stopped = false;
  private lifecycle: Lifecycle = "cold";
  private runtimeReady = false;
  public template?: string;
  constructor(public config: Config) {
    configuration(config);
  }
  get isReady() {
    return this.runtimeReady;
  }
  get status() {
    const generation = this.generation;
    return {
      state: this.lifecycle,
      ready: this.runtimeReady,
      generation: generation?.id ?? null,
      model: this.config.modelId,
      requested_device: this.config.device,
      device: generation?.identity?.device ?? null,
      device_name: generation?.identity?.device_name ?? null,
      architecture: generation?.identity?.architecture ?? null,
      process_id: generation?.child?.pid ?? null,
      temporary_directory: generation?.runtimeDir ?? null,
      native_build: generation?.identity?.native_build ?? null,
      limits: generation?.identity?.limits ?? null,
      artifact: generation?.artifact
        ? artifactIdentity(generation.artifact)
        : null,
    };
  }
  async doctor() {
    configuration(this.config);
    if (!this.config.modelFile)
      throw new Error(
        "Set JEV_MODEL_FILE to an approved Gemma classifier GGUF; see README.md",
      );
    await access(this.config.binary);
    const artifact = await verifyArtifact(
      this.config.modelFile,
      "classifier",
      this.config.modelId,
      { registryPath: this.config.artifactRegistryPath },
    );
    return {
      model: this.config.modelId,
      requested_device: this.config.device,
      artifact: artifactIdentity(artifact),
      checksum: "verified",
      runtime: this.status,
    };
  }
  async warmup() {
    if (this.stopped) throw new Error("Backend disposed");
    if (this.runtimeReady) return;
    if (this.initialization) return this.initialization;
    if (this.generation?.cleanup) await this.generation.cleanup;
    if (this.stopped) throw new Error("Backend disposed");
    if (this.runtimeReady) return;
    if (this.initialization) return this.initialization;
    const generation: Generation = {
      id: ++this.sequence,
      pending: new Map(),
      failed: false,
      controller: new AbortController(),
    };
    this.generation = generation;
    this.lifecycle = "initializing";
    const timer = setTimeout(() => {
      void this.stopGeneration(
        generation,
        new DeadlineExceeded("initialization"),
      );
    }, this.config.initTimeoutMs ?? deadlines.initialization);
    let timeoutReject!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      timeoutReject = reject;
      generation.pending.set("initialization", {
        op: "initialization",
        resolve: () => {},
        reject,
      });
    });
    const initializing = this.initialize(generation);
    generation.initializing = initializing;
    this.initialization = Promise.race([initializing, interrupted])
      .catch(async (error) => {
        await this.stopGeneration(
          generation,
          error instanceof Error ? error : new Error(String(error)),
        );
        if (
          !(await finishesWithin(
            initializing.catch(() => {}),
            5_000,
          ))
        )
          throw new Error("Native initialization cleanup deadline exceeded");
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        generation.pending.delete("initialization");
        if (this.generation === generation) this.initialization = undefined;
      });
    // Both branches are observed even if a deadline wins during artifact verification.
    void initializing.catch(timeoutReject);
    return this.initialization;
  }
  private assertGeneration(generation: Generation) {
    if (this.stopped) throw new Error("Backend disposed");
    if (generation.failed || this.generation !== generation)
      throw new Error("Native initialization interrupted");
  }
  private async initialize(generation: Generation) {
    configuration(this.config);
    if (!this.config.modelFile)
      throw new Error(
        "Set JEV_MODEL_FILE to an approved Gemma classifier GGUF; see README.md",
      );
    await access(this.config.binary);
    this.assertGeneration(generation);
    generation.artifact = await verifyArtifact(
      this.config.modelFile,
      "classifier",
      this.config.modelId,
      {
        signal: generation.controller.signal,
        registryPath: this.config.artifactRegistryPath,
      },
    );
    this.assertGeneration(generation);
    const runtimeDir = await mkdtemp(join(tmpdir(), "jev-gemma-"));
    generation.runtimeDir = runtimeDir;
    if (this.stopped || generation.failed || this.generation !== generation) {
      await rm(runtimeDir, { recursive: true, force: true });
      generation.runtimeDir = undefined;
      this.assertGeneration(generation);
    }
    const child = spawn(this.config.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    generation.child = child;
    generation.exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    child.stderr.resume();
    const fail = (error: Error) => void this.stopGeneration(generation, error);
    child.on("error", fail);
    child.on("close", (code, signal) =>
      fail(new Error(`Native backend exited (${code ?? signal ?? "unknown"})`)),
    );
    child.stdin.on("error", fail);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (generation.failed) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 64 * 1024 * 1024) {
        fail(invalidProtocol());
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.receive(generation, line);
        if (generation.failed) break;
      }
    });
    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer.length && !generation.failed) fail(invalidProtocol());
    });
    const result = await this.rpc(
      "init",
      {
        model_file: this.config.modelFile,
        runtime_file: join(runtimeDir, "gemma-f32.gguf"),
        device: this.config.device,
        max_model_len: this.config.maxModelLen,
        max_batch_size: this.config.maxBatchSize,
        max_batch_tokens: this.config.maxBatchTokens,
      },
      undefined,
      generation,
    );
    this.assertGeneration(generation);
    this.template = result.template;
    generation.identity = {
      device: result.device,
      device_name: result.device_name,
      architecture: result.architecture,
      native_build: result.native_build,
      limits: result.limits,
    };
    this.runtimeReady = true;
    this.lifecycle = "ready";
  }
  private receive(generation: Generation, line: string) {
    try {
      const response: unknown = JSON.parse(line);
      if (
        !record(response) ||
        response.v !== 1 ||
        typeof response.id !== "string" ||
        !response.id ||
        Object.hasOwn(response, "result") === Object.hasOwn(response, "error")
      )
        throw invalidProtocol();
      const pending = generation.pending.get(response.id);
      if (!pending || pending.op === "initialization") throw invalidProtocol();
      if (Object.hasOwn(response, "error")) {
        if (
          !record(response.error) ||
          typeof response.error.message !== "string" ||
          !["invalid_request", "cancelled", "runtime"].includes(
            response.error.kind,
          )
        )
          throw invalidProtocol();
        generation.pending.delete(response.id);
        pending.reject(
          response.error.kind === "invalid_request"
            ? new InvalidRequest(response.error.message)
            : response.error.kind === "cancelled"
              ? new DOMException("Cancelled", "AbortError")
              : new Error(response.error.message),
        );
      } else {
        validateResult(pending.op, response.result);
        generation.pending.delete(response.id);
        pending.resolve(response.result);
      }
    } catch (error) {
      void this.stopGeneration(
        generation,
        error instanceof Error ? error : invalidProtocol(),
      );
    }
  }
  private rpc(
    op: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<any> {
    signal?.throwIfAborted();
    if (!generation?.child || generation.failed)
      throw new Error("Native backend unavailable");
    const child = generation.child;
    const id = String(++this.next);
    let cancellation: Error | undefined;
    const send = (message: Record<string, unknown>) => {
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch (error) {
        void this.stopGeneration(
          generation,
          error instanceof Error ? error : new Error("Native transport failed"),
        );
      }
    };
    const request = new Promise<unknown>((resolve, reject) => {
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(cancellationTimer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cancellation = abortReason(signal!);
        send({ v: 1, op: "cancel", target: id });
        cancellationTimer = setTimeout(
          () => void this.stopGeneration(generation, cancellation!),
          2_000,
        );
      };
      const timer = setTimeout(
        () =>
          void this.stopGeneration(
            generation,
            new DeadlineExceeded(op === "init" ? "initialization" : "request"),
          ),
        op === "init"
          ? (this.config.initTimeoutMs ?? deadlines.initialization)
          : (this.config.requestTimeoutMs ?? deadlines.request),
      );
      generation.pending.set(id, {
        op,
        resolve: (value) => {
          cleanup();
          if (cancellation || signal?.aborted)
            reject(cancellation ?? abortReason(signal!));
          else resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(cancellation ?? error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      send({ v: 1, id, op, ...data });
    });
    return request.catch(async (error) => {
      if (generation.failed && generation.cleanup) await generation.cleanup;
      throw error;
    });
  }
  private stopGeneration(generation: Generation, error: Error): Promise<void> {
    if (generation.cleanup) return generation.cleanup;
    generation.failed = true;
    generation.controller.abort(error);
    if (this.generation === generation) {
      this.runtimeReady = false;
      if (!this.stopped) this.lifecycle = "failed";
    }
    generation.cleanup = (async () => {
      for (const pending of generation.pending.values()) pending.reject(error);
      generation.pending.clear();
      const child = generation.child;
      if (child && generation.exited) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        if (!(await finishesWithin(generation.exited, 1_000))) {
          child.kill("SIGKILL");
          if (!(await finishesWithin(generation.exited, 2_000)))
            throw new Error("Native process failed to terminate");
        }
      }
      generation.child = undefined;
      if (generation.runtimeDir) {
        await rm(generation.runtimeDir, { recursive: true, force: true });
        generation.runtimeDir = undefined;
      }
    })();
    // Exit/error callbacks cannot create an unhandled rejection during shutdown.
    void generation.cleanup.catch(() => {});
    return generation.cleanup;
  }
  async compile(plan: Plan, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await waitFor(this.warmup(), signal);
    signal?.throwIfAborted();
    const artifact = this.generation?.artifact;
    if (
      artifact?.template_version &&
      artifact.template_version !== plan.template_version
    )
      throw new InvalidRequest(
        "Approved artifact requires its training template version",
        "options.template_version",
      );
    return this.rpc("compile", { branches: plan.questions }, signal);
  }
  async evaluate(compiled: unknown, signal?: AbortSignal, full = false) {
    return this.rpc(
      "evaluate",
      { branches: compiled, full },
      signal,
    ) as Promise<Evaluation>;
  }
  async dispose() {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.runtimeReady = false;
    this.lifecycle = "stopping";
    this.disposal = (async () => {
      if (this.generation)
        await this.stopGeneration(
          this.generation,
          new Error("Backend disposed"),
        );
      await this.initialization?.catch(() => {});
      if (
        this.generation?.initializing &&
        !(await finishesWithin(
          this.generation.initializing.catch(() => {}),
          5_000,
        ))
      )
        throw new Error("Native initialization cleanup deadline exceeded");
      this.lifecycle = "disposed";
    })();
    return this.disposal;
  }
}
function artifactIdentity(artifact: Artifact) {
  return {
    id: artifact.id,
    revision: artifact.revision,
    sha256: artifact.sha256,
    size: artifact.size,
    base_model: artifact.base_model,
    ...(artifact.template_version
      ? { template_version: artifact.template_version }
      : {}),
  };
}
export class Classifier {
  private admitted = 0;
  private active = false;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private shutdown = new AbortController();
  private disposal?: Promise<void>;
  constructor(
    public config: Config,
    public backend: InferenceAdapter = new NativeBackend(config),
  ) {
    configuration(config);
  }
  get status() {
    return {
      state: this.closed ? "disposed" : this.active ? "active" : "idle",
      active: this.active,
      queue_depth: this.admitted - (this.active ? 1 : 0),
      ...(this.backend instanceof NativeBackend
        ? { runtime: this.backend.status }
        : {}),
    };
  }
  async classify(input: unknown, signal?: AbortSignal) {
    if (this.closed) throw new Error("Classifier disposed");
    signal?.throwIfAborted();
    const request = validateRequest(input);
    if (request.model !== this.config.modelId)
      throw new InvalidRequest(
        `Loaded model is '${this.config.modelId}'`,
        "model",
      );
    if (request.questions.length > this.config.maxRequestBranches)
      throw new InvalidRequest("Request exceeds branch limit");
    if (this.admitted >= 17) throw new Overloaded();
    this.admitted++;
    const start = performance.now();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    const queued = new AbortController();
    const queueTimer = setTimeout(
      () => queued.abort(new DeadlineExceeded("queue")),
      this.config.queueTimeoutMs ?? deadlines.queue,
    );
    const waitingSignal = AbortSignal.any([
      queued.signal,
      this.shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    let acquired = false;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitFor(previous, waitingSignal);
      acquired = true;
      clearTimeout(queueTimer);
      waitingSignal.throwIfAborted();
      if (this.closed) throw new Error("Classifier disposed");
      this.active = true;
      const queue_seconds = (performance.now() - start) / 1000;
      // Initialization is shared and has its own longer deadline. A canceled caller
      // stops waiting without replaying work or canceling another caller's warmup.
      const clientSignal = AbortSignal.any([
        this.shutdown.signal,
        ...(signal ? [signal] : []),
      ]);
      await waitFor(this.backend.warmup(), clientSignal);
      clientSignal.throwIfAborted();
      const executing = new AbortController();
      const executionSignal = AbortSignal.any([executing.signal, clientSignal]);
      requestTimer = setTimeout(
        () => executing.abort(new DeadlineExceeded("request")),
        this.config.requestTimeoutMs ?? deadlines.request,
      );
      // Capacity and the active slot are held before branch prompt expansion.
      const plan = preparePrompt(request, this.config.templateVersion);
      executionSignal.throwIfAborted();
      const compiled = await this.backend.compile(plan, executionSignal);
      executionSignal.throwIfAborted();
      const backendStart = performance.now();
      const result = await this.backend.evaluate(compiled, executionSignal);
      executionSignal.throwIfAborted();
      const runtime =
        this.backend instanceof NativeBackend ? this.backend.status : undefined;
      return buildResponse(
        plan,
        result.logits,
        result.input_tokens,
        this.config.advanced,
        {
          metadata: {
            model_revision: runtime?.artifact?.revision ?? null,
            artifact: runtime?.artifact ?? null,
            device: runtime?.device ?? null,
            native_build: runtime?.native_build ?? null,
          },
          metrics: {
            ...result.metrics,
            backend_seconds: (performance.now() - backendStart) / 1000,
            queue_seconds,
            total_seconds: (performance.now() - start) / 1000,
          },
        },
      );
    } finally {
      clearTimeout(queueTimer);
      clearTimeout(requestTimer);
      this.admitted--;
      if (acquired) {
        this.active = false;
        release();
      } else void previous.then(release, release);
    }
  }
  async dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.shutdown.abort(new Error("Classifier disposed"));
    this.disposal = this.backend.dispose();
    return this.disposal;
  }
}
function waitFor<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) reject(error);
      },
    );
  });
}
async function finishesWithin(operation: Promise<void>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
