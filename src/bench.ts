import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Classifier } from "./backend.js";
import { Overloaded } from "./backend.js";
import type { ClassifierResponse, Request, TemplateVersion } from "./core.js";

export interface BenchmarkOptions {
  iterations?: number;
  /** ASCII characters in each generated context; not a token count. */
  contextSizes?: number[];
  branchCounts?: number[];
  /** Total simultaneous callers, including the active caller. */
  queuedCallers?: number[];
  signal?: AbortSignal;
}

export interface BenchmarkSample {
  phase: "first_request" | "warm" | "workload";
  context_characters: number;
  branches: number;
  simultaneous_callers: number;
  iteration: number;
  caller: number;
  runtime_ready_at_submit: boolean | null;
  outcome: "success" | "overloaded" | "cancelled" | "error";
  elapsed_seconds: number;
  queue_seconds: number | null;
  backend_seconds: number | null;
  computed_prompt_tokens: number | null;
  computed_output_tokens: number | null;
  engine_forwards: number | null;
  error: string | null;
}

export interface BenchmarkSummary {
  attempted: number;
  succeeded: number;
  overloaded: number;
  cancelled: number;
  errors: number;
  latency_seconds: Distribution;
  queue_seconds: Distribution;
  backend_seconds: Distribution;
  computed_prompt_tokens: number | null;
  computed_output_tokens: number | null;
  computed_prompt_tokens_per_second: number | null;
}

interface Distribution {
  count: number;
  minimum: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  maximum: number | null;
}

export interface BenchmarkReport {
  schema_version: 1;
  kind: "classifier";
  started_at: string;
  completed_at: string;
  completed: boolean;
  conditions: {
    iterations: number;
    context_sizes_characters: number[];
    branch_counts: number[];
    simultaneous_callers: number[];
    template_version: TemplateVersion;
    cold_start_measured: boolean;
    first_request_state: "uninitialized" | "ready" | "unknown";
  };
  identity: {
    hardware: {
      platform: string;
      architecture: string;
      os_release: string;
      cpu_model: string;
      logical_cpus: number;
      total_memory_bytes: number;
    };
    node: string;
    model_id: string;
    model_file: string | "unknown";
    requested_device: string;
    native_binary: { path: string; sha256: string | "unknown" };
    runtime_before: unknown;
    runtime_after: unknown;
  };
  resources: {
    sampling_interval_ms: number;
    samples: number;
    orchestrator_rss_observed_peak_bytes: number;
    native_rss_observed_peak_bytes: number | null;
    temporary_disk_observed_peak_bytes: number | null;
    temporary_disk_root: string | null;
    temporary_disk_roots: string[];
    temporary_disk_complete: boolean;
    method: string;
  };
  summary: BenchmarkSummary;
  first_request: BenchmarkSummary;
  warm: BenchmarkSummary;
  workloads: {
    context_characters: number;
    branches: number;
    simultaneous_callers: number;
    summary: BenchmarkSummary;
  }[];
  samples: BenchmarkSample[];
  notes: string[];
}

/** Linear interpolation over finite samples, with a percentile in [0, 100]. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 100)
    throw new RangeError("Percentile must be between 0 and 100");
  if (values.some((value) => !Number.isFinite(value)))
    throw new RangeError("Percentile samples must be finite");
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = ((ordered.length - 1) * p) / 100;
  const lower = Math.floor(index);
  return (
    ordered[lower] +
    (ordered[Math.ceil(index)] - ordered[lower]) * (index - lower)
  );
}

/** Exercise the supplied classifier without warming, disposing, or reconfiguring it. */
export async function runBenchmark(
  classifier: Classifier,
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const iterations = positiveInteger(
    options.iterations ?? 3,
    "iterations",
    100,
  );
  const contextSizes = sizes(
    options.contextSizes ?? [256],
    "contextSizes",
    131_072,
  );
  const branchCounts = sizes(options.branchCounts ?? [1], "branchCounts", 100);
  const queuedCallers = sizes(
    options.queuedCallers ?? [1, 4],
    "queuedCallers",
    64,
  );
  if (branchCounts.some((n) => n > classifier.config.maxRequestBranches))
    throw new RangeError("branchCounts exceeds the configured branch limit");
  const requestCount =
    1 +
    iterations +
    iterations *
      contextSizes.length *
      branchCounts.length *
      queuedCallers.reduce((a, b) => a + b, 0);
  if (requestCount > 10_000)
    throw new RangeError("Benchmark envelope exceeds 10000 attempted requests");
  options.signal?.throwIfAborted();

  const started = new Date().toISOString();
  const runtimeBefore = await runtimeStatus(classifier);
  const ready = readyState(classifier, runtimeBefore);
  const templateVersion = classifier.config.templateVersion ?? "v2";
  const observer = new ResourceObserver(classifier);
  const binary = resolve(classifier.config.binary);
  const binaryChecksum = await checksum(binary);
  await observer.start();
  const samples: BenchmarkSample[] = [];

  const execute = async (
    phase: BenchmarkSample["phase"],
    characters: number,
    branches: number,
    callers: number,
    iteration: number,
    caller: number,
  ) => {
    const input = workload(
      classifier.config.modelId,
      characters,
      branches,
      templateVersion,
    );
    const readyAtSubmit = readyState(classifier, undefined) ?? null;
    const started = performance.now();
    let response: ClassifierResponse | undefined;
    let outcome: BenchmarkSample["outcome"] = "success";
    let error: string | null = null;
    try {
      response = await classifier.classify(input, options.signal);
    } catch (reason) {
      outcome =
        reason instanceof Overloaded
          ? "overloaded"
          : options.signal?.aborted ||
              (reason instanceof Error && reason.name === "AbortError")
            ? "cancelled"
            : "error";
      error = (reason instanceof Error ? reason.message : String(reason)).slice(
        0,
        1_024,
      );
    }
    const metrics = response?.metrics;
    samples.push({
      phase,
      context_characters: characters,
      branches,
      simultaneous_callers: callers,
      iteration,
      caller,
      runtime_ready_at_submit: readyAtSubmit,
      outcome,
      elapsed_seconds: (performance.now() - started) / 1_000,
      queue_seconds: metric(metrics, "queue_seconds"),
      backend_seconds: metric(metrics, "backend_seconds"),
      computed_prompt_tokens: metric(metrics, "computed_prompt_tokens"),
      computed_output_tokens: metric(metrics, "branch_output_tokens"),
      engine_forwards: metric(metrics, "engine_forwards"),
      error,
    });
  };

  try {
    await execute("first_request", contextSizes[0], branchCounts[0], 1, 0, 0);
    for (let i = 0; i < iterations && !options.signal?.aborted; i++)
      await execute("warm", contextSizes[0], branchCounts[0], 1, i, 0);
    for (const characters of contextSizes)
      for (const branches of branchCounts)
        for (const callers of queuedCallers)
          for (let i = 0; i < iterations && !options.signal?.aborted; i++)
            await Promise.all(
              Array.from({ length: callers }, (_, caller) =>
                execute("workload", characters, branches, callers, i, caller),
              ),
            );
  } finally {
    await observer.stop();
  }
  const runtimeAfter = await runtimeStatus(classifier);
  const allCpus = cpus();
  const missingMetrics = samples.some(
    (sample) =>
      sample.outcome === "success" && sample.computed_prompt_tokens === null,
  );
  return {
    schema_version: 1,
    kind: "classifier",
    started_at: started,
    completed_at: new Date().toISOString(),
    completed: !options.signal?.aborted,
    conditions: {
      iterations,
      context_sizes_characters: contextSizes,
      branch_counts: branchCounts,
      simultaneous_callers: queuedCallers,
      template_version: templateVersion,
      cold_start_measured: ready === false && samples[0]?.outcome === "success",
      first_request_state:
        ready === true
          ? "ready"
          : ready === false
            ? "uninitialized"
            : "unknown",
    },
    identity: {
      hardware: {
        platform: platform(),
        architecture: arch(),
        os_release: release(),
        cpu_model: allCpus[0]?.model ?? "unknown",
        logical_cpus: allCpus.length,
        total_memory_bytes: totalmem(),
      },
      node: process.version,
      model_id: classifier.config.modelId,
      model_file: classifier.config.modelFile
        ? resolve(classifier.config.modelFile)
        : "unknown",
      requested_device: classifier.config.device,
      native_binary: { path: binary, sha256: binaryChecksum },
      runtime_before: runtimeBefore,
      runtime_after: runtimeAfter,
    },
    resources: observer.report(),
    summary: summarize(samples),
    first_request: summarize(
      samples.filter((sample) => sample.phase === "first_request"),
    ),
    warm: summarize(samples.filter((sample) => sample.phase === "warm")),
    workloads: contextSizes.flatMap((characters) =>
      branchCounts.flatMap((branches) =>
        queuedCallers.map((callers) => ({
          context_characters: characters,
          branches,
          simultaneous_callers: callers,
          summary: summarize(
            samples.filter(
              (sample) =>
                sample.phase === "workload" &&
                sample.context_characters === characters &&
                sample.branches === branches &&
                sample.simultaneous_callers === callers,
            ),
          ),
        })),
      ),
    ),
    samples,
    notes: [
      "Computed token counts come only from native response metrics, never logical usage accounting.",
      "The first request includes initialization only when the supplied backend was uninitialized; warm trials reuse that backend.",
      "RSS and temporary disk maxima are observed snapshots, not guaranteed physical or device-memory peaks.",
      "Native/model revision and actual device are unknown unless the runtime status provides verified identity.",
      ...(missingMetrics
        ? [
            "Some successful requests omitted computed-token metrics; configure advanced diagnostics before benchmarking.",
          ]
        : []),
    ],
  };
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

function sizes(values: number[], name: string, maximum: number): number[] {
  if (!Array.isArray(values) || !values.length || values.length > 16)
    throw new RangeError(`${name} must contain between 1 and 16 values`);
  return [
    ...new Set(values.map((value) => positiveInteger(value, name, maximum))),
  ];
}

function workload(
  model: string,
  characters: number,
  branches: number,
  templateVersion: TemplateVersion,
): Request {
  const context =
    "Customer reports a duplicate subscription charge and requests a refund. ";
  return {
    model,
    state: context
      .repeat(Math.ceil(characters / context.length))
      .slice(0, characters),
    questions: Array.from({ length: branches }, (_, i) => ({
      id: `route-${i}`,
      type: "choice" as const,
      instructions: `Select the responsible team for request ${i + 1}.`,
      criteria: [
        { id: "billing", description: "Payments, invoices, and refunds" },
        { id: "technical", description: "Technical product problems" },
      ],
    })),
    options: { template_version: templateVersion },
  };
}

function metric(
  metrics: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function distribution(values: number[]): Distribution {
  return {
    count: values.length,
    minimum: percentile(values, 0),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    maximum: percentile(values, 100),
  };
}

function summarize(samples: BenchmarkSample[]): BenchmarkSummary {
  const successful = samples.filter((sample) => sample.outcome === "success");
  const sum = (key: "computed_prompt_tokens" | "computed_output_tokens") =>
    successful.length && successful.every((sample) => sample[key] !== null)
      ? successful.reduce((total, sample) => total + sample[key]!, 0)
      : null;
  const computedPrompt = sum("computed_prompt_tokens");
  const backendSeconds = successful.every(
    (sample) => sample.backend_seconds !== null,
  )
    ? successful.reduce((total, sample) => total + sample.backend_seconds!, 0)
    : 0;
  return {
    attempted: samples.length,
    succeeded: successful.length,
    overloaded: samples.filter((sample) => sample.outcome === "overloaded")
      .length,
    cancelled: samples.filter((sample) => sample.outcome === "cancelled")
      .length,
    errors: samples.filter((sample) => sample.outcome === "error").length,
    latency_seconds: distribution(
      successful.map((sample) => sample.elapsed_seconds),
    ),
    queue_seconds: distribution(
      successful.flatMap((sample) =>
        sample.queue_seconds === null ? [] : [sample.queue_seconds],
      ),
    ),
    backend_seconds: distribution(
      successful.flatMap((sample) =>
        sample.backend_seconds === null ? [] : [sample.backend_seconds],
      ),
    ),
    computed_prompt_tokens: computedPrompt,
    computed_output_tokens: sum("computed_output_tokens"),
    computed_prompt_tokens_per_second:
      computedPrompt !== null && backendSeconds > 0
        ? computedPrompt / backendSeconds
        : null,
  };
}

async function checksum(path: string): Promise<string | "unknown"> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return "unknown";
  }
}

async function runtimeStatus(classifier: Classifier): Promise<unknown> {
  const candidate = classifier as unknown as {
    status?: unknown;
    backend: { status?: unknown };
  };
  try {
    const outer =
      typeof candidate.status === "function"
        ? await candidate.status.call(candidate)
        : candidate.status;
    const backend =
      typeof candidate.backend.status === "function"
        ? await candidate.backend.status.call(candidate.backend)
        : candidate.backend.status;
    if (outer !== undefined) {
      const outerObject = object(outer);
      return outerObject &&
        outerObject.runtime === undefined &&
        backend !== undefined
        ? { ...outerObject, runtime: backend }
        : outer;
    }
    if (backend !== undefined) return backend;
  } catch {
    // A failed status probe must not hide the classifier's measured behavior.
  }
  return "unknown";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function backendStatus(status: unknown): Record<string, unknown> | undefined {
  const outer = object(status);
  return object(outer?.runtime) ?? object(outer?.backend) ?? outer;
}

function readyState(
  classifier: Classifier,
  status: unknown,
): boolean | undefined {
  const value = (classifier.backend as unknown as { isReady?: boolean })
    .isReady;
  if (typeof value === "boolean") return value;
  const ready = backendStatus(status)?.ready;
  return typeof ready === "boolean" ? ready : undefined;
}

const executeFile = promisify(execFile);

class ResourceObserver {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private points = 0;
  private parentPeak = 0;
  private nativePeak: number | null = null;
  private diskPeak: number | null = null;
  private diskComplete = true;
  private diskRoot: string | null = null;
  private diskRoots = new Set<string>();
  constructor(private classifier: Classifier) {
    const build = dirname(resolve(classifier.config.binary));
    if (basename(build) === ".build") {
      this.diskRoot = join(build, "runtime");
      this.diskRoots.add(this.diskRoot);
    }
  }
  async start() {
    await this.sample();
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.sample().finally(() => {
        this.pending = undefined;
      });
    }, 100);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    await this.pending;
    await this.sample();
  }
  private async sample() {
    this.points++;
    this.parentPeak = Math.max(this.parentPeak, process.memoryUsage().rss);
    const status = backendStatus(await runtimeStatus(this.classifier));
    const pid = status?.process_id ?? status?.pid;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
      try {
        const { stdout } = await executeFile(
          "ps",
          ["-o", "rss=", "-p", String(pid)],
          { timeout: 1_000, maxBuffer: 1_024 },
        );
        const rss = Number(stdout.trim()) * 1_024;
        if (Number.isFinite(rss) && rss >= 0)
          this.nativePeak = Math.max(this.nativePeak ?? 0, rss);
      } catch {
        // Native process may have exited between lifecycle and RSS snapshots.
      }
    }
    const currentDirectory = status?.temporary_directory;
    if (
      typeof currentDirectory === "string" &&
      dirname(resolve(currentDirectory)) === resolve(tmpdir()) &&
      basename(currentDirectory).startsWith("jev-gemma-")
    ) {
      this.diskRoot = resolve(currentDirectory);
      if (this.diskRoots.size < 16) this.diskRoots.add(this.diskRoot);
      else this.diskComplete = false;
    }
    let observedDisk = false;
    let diskBytes = 0;
    for (const directory of this.diskRoots) {
      const disk = await directoryBytes(directory);
      if (disk !== null) {
        observedDisk = true;
        diskBytes += disk.bytes;
        this.diskComplete &&= disk.complete;
      }
    }
    if (observedDisk) this.diskPeak = Math.max(this.diskPeak ?? 0, diskBytes);
  }
  report(): BenchmarkReport["resources"] {
    return {
      sampling_interval_ms: 100,
      samples: this.points,
      orchestrator_rss_observed_peak_bytes: this.parentPeak,
      native_rss_observed_peak_bytes: this.nativePeak,
      temporary_disk_observed_peak_bytes: this.diskPeak,
      temporary_disk_root: this.diskRoot,
      temporary_disk_roots: [...this.diskRoots],
      temporary_disk_complete:
        this.diskRoot !== null && this.diskComplete && this.diskPeak !== null,
      method:
        "process.memoryUsage().rss and native PID ps RSS; .build/runtime and status-reported immediate tmpdir/jev-gemma-* directories only, no symlinks, at most 4096 entries and depth 4 per root; snapshots can miss short-lived peaks and do not measure device memory",
    };
  }
}

async function directoryBytes(
  root: string,
): Promise<{ bytes: number; complete: boolean } | null> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const canonicalRoot = await realpath(root);
    const lexicalRoot = resolve(root);
    if (
      canonicalRoot !== lexicalRoot &&
      !(platform() === "darwin" && canonicalRoot === `/private${lexicalRoot}`)
    )
      return null;
    let entries = 0;
    let bytes = 0;
    let complete = true;
    const walk = async (path: string, depth: number): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++entries > 4_096) {
          complete = false;
          return;
        }
        const file = join(path, entry.name);
        if (
          relative(canonicalRoot, file).startsWith("..") ||
          entry.isSymbolicLink()
        ) {
          complete = false;
          continue;
        }
        if (entry.isDirectory()) {
          if (depth >= 4) complete = false;
          else await walk(file, depth + 1);
        } else if (entry.isFile()) {
          const current = await lstat(file);
          if (current.isFile() && !current.isSymbolicLink())
            bytes += current.size;
          else complete = false;
        }
      }
    };
    await walk(canonicalRoot, 0);
    return { bytes, complete };
  } catch {
    return null;
  }
}
