import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { access, readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InvalidRequest,
  preparePrompt,
  buildResponse,
  type Plan,
  type Logits,
} from "./core.js";
export interface Config {
  modelFile?: string;
  modelId: string;
  device: "auto" | "cpu" | "metal";
  binary: string;
  maxModelLen: number;
  maxBatchSize: number;
  maxBatchTokens: number;
  maxRequestBranches: number;
  advanced: boolean;
}
const root = new URL("../", import.meta.url);
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const device = env.JEV_DEVICE ?? "auto";
  if (!["auto", "cpu", "metal"].includes(device))
    throw new Error("JEV_DEVICE must be auto, cpu, or metal");
  return {
    modelFile: env.JEV_MODEL_FILE,
    modelId: env.JEV_MODEL_ID ?? env.JEV_MODEL_FILE ?? "google/gemma-3-1b-it",
    device: device as Config["device"],
    binary: fileURLToPath(new URL(".build/jev-native", root)),
    maxModelLen: 16384,
    maxBatchSize: 32,
    maxBatchTokens: 32768,
    maxRequestBranches: 100,
    advanced: /^(1|true|yes|on)$/i.test(
      env.ENABLE_OPEN_JEV_ADVANCED_METRICS ?? "",
    ),
  };
}
export class Overloaded extends Error {
  constructor() {
    super("Scoring queue is full");
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
export class NativeBackend implements InferenceAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private init?: Promise<void>;
  private next = 0;
  private stopped = false;
  private runtimeReady = false;
  get isReady() {
    return this.runtimeReady;
  }
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private stderr = "";
  private runtimeDir?: string;
  public template?: string;
  constructor(public config: Config) {}
  async doctor() {
    const registry = JSON.parse(
      await readFile(new URL("models/registry.json", root), "utf8"),
    );
    await access(this.config.binary);
    if (!this.config.modelFile)
      throw new Error(
        "Set JEV_MODEL_FILE to the approved Gemma F16 GGUF; see README.md",
      );
    await access(this.config.modelFile);
    return {
      model: this.config.modelId,
      device: this.config.device,
      artifact: registry.models[0].file,
      checksum: "verified during warmup",
    };
  }
  async warmup() {
    if (this.stopped) throw new Error("Backend disposed");
    if (this.init) return this.init;
    this.init = this.initialize().catch(async (e) => {
      this.child?.kill();
      this.child = undefined;
      this.runtimeReady = false;
      this.init = undefined;
      if (this.runtimeDir) {
        await rm(this.runtimeDir, { recursive: true, force: true });
        this.runtimeDir = undefined;
      }
      throw e;
    });
    return this.init;
  }
  private async initialize() {
    await this.doctor();
    if (this.stopped) throw new Error("Backend disposed");
    const {
      models: [model],
    } = JSON.parse(
      await readFile(new URL("models/registry.json", root), "utf8"),
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(this.config.modelFile!))
      hash.update(chunk);
    if (hash.digest("hex") !== model.sha256)
      throw new Error(
        "Unapproved model artifact: checksum must match pinned Google Gemma 3 1B F16. No fallback is permitted.",
      );
    this.runtimeDir = await mkdtemp(join(tmpdir(), "jev-gemma-"));
    if (this.stopped) throw new Error("Backend disposed");
    const child = spawn(this.config.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    const runtimeDir = this.runtimeDir;
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.runtimeReady = false;
      if (runtimeDir) void rm(runtimeDir, { recursive: true, force: true });
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      if (this.child === child) {
        this.child = undefined;
        this.init = undefined;
      }
    };
    child.on("error", fail);
    child.on("exit", (code, signal) =>
      fail(
        new Error(`Native backend exited (${code ?? signal}): ${this.stderr}`),
      ),
    );
    child.stdin.on("error", fail);
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const r = JSON.parse(line);
        if (r.v !== 1) throw new Error("Invalid native protocol");
        const p = this.pending.get(r.id);
        if (!p) return;
        this.pending.delete(r.id);
        if (r.error)
          p.reject(
            r.error.kind === "invalid_request"
              ? new InvalidRequest(r.error.message)
              : r.error.kind === "cancelled"
                ? new DOMException("Cancelled", "AbortError")
                : new Error(r.error.message),
          );
        else p.resolve(r.result);
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
        child.kill();
      }
    });
    const result = await this.rpc("init", {
      model_file: this.config.modelFile,
      runtime_file: join(this.runtimeDir, "gemma-f32.gguf"),
      device: this.config.device,
      max_model_len: this.config.maxModelLen,
      max_batch_size: this.config.maxBatchSize,
      max_batch_tokens: this.config.maxBatchTokens,
    });
    this.template = result.template;
    this.runtimeReady = true;
  }
  private rpc(
    op: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    signal?.throwIfAborted();
    if (!this.child) throw new Error("Native backend unavailable");
    const child = this.child,
      id = String(++this.next);
    return new Promise((resolve, reject) => {
      const abort = () => {
        child.stdin.write(
          JSON.stringify({ v: 1, op: "cancel", target: id }) + "\n",
        );
      };
      const timer = setTimeout(
        () => {
          child.kill();
        },
        op === "init" ? 180_000 : 300_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          if (signal?.aborted)
            reject(
              signal.reason ?? new DOMException("Cancelled", "AbortError"),
            );
          else resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(JSON.stringify({ v: 1, id, op, ...data }) + "\n");
    });
  }
  async compile(plan: Plan, signal?: AbortSignal) {
    await this.warmup();
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
    this.stopped = true;
    this.runtimeReady = false;
    this.child?.kill();
    this.child = undefined;
    for (const p of this.pending.values())
      p.reject(new Error("Backend disposed"));
    this.pending.clear();
    if (this.runtimeDir)
      await rm(this.runtimeDir, { recursive: true, force: true });
  }
}
export class Classifier {
  private admitted = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    public config: Config,
    public backend: InferenceAdapter = new NativeBackend(config),
  ) {}
  async classify(input: unknown, signal?: AbortSignal) {
    if (this.closed) throw new Error("Classifier disposed");
    const plan = preparePrompt(input);
    if (plan.request.model !== this.config.modelId)
      throw new InvalidRequest(
        `Loaded model is '${this.config.modelId}'`,
        "model",
      );
    if (plan.questions.length > this.config.maxRequestBranches)
      throw new InvalidRequest("Request exceeds branch limit");
    signal?.throwIfAborted();
    if (this.admitted >= 17) throw new Overloaded();
    this.admitted++;
    const start = performance.now(),
      previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    let acquired = false;
    try {
      await waitForSlot(previous, signal);
      acquired = true;
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Classifier disposed");
      const queue_seconds = (performance.now() - start) / 1000;
      const compiled = await this.backend.compile(plan, signal);
      const backendStart = performance.now();
      const result = await this.backend.evaluate(compiled, signal);
      return buildResponse(
        plan,
        result.logits,
        result.input_tokens,
        this.config.advanced,
        {
          metrics: {
            ...result.metrics,
            backend_seconds: (performance.now() - backendStart) / 1000,
            queue_seconds,
            total_seconds: (performance.now() - start) / 1000,
          },
        },
      );
    } finally {
      this.admitted--;
      if (acquired) release();
      else void previous.then(release, release);
    }
  }
  async dispose() {
    this.closed = true;
    await this.backend.dispose();
  }
}

function waitForSlot(
  previous: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return previous.then(() => {});
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    previous.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
