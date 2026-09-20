import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoutingRuntime,
  routingFeatureProvenance,
  ROUTING_FEATURE_MODEL,
  ROUTING_FEATURE_REVISION,
  ROUTING_RUNTIME_LIMITS,
  type RoutingRuntimeOptions,
} from "../src/routing-runtime.js";

const digest = (data: string) =>
  createHash("sha256").update(data).digest("hex");
const head = {
  version: 1,
  dimension: 1152,
  weights: Array(1152).fill(0),
  bias: -8,
  featureCenter: Array(1152).fill(0),
  featureScale: Array(1152).fill(1),
  threshold: 0.5,
  minMargin: 0.1,
  calibration: "uncalibrated",
  trainingDiagnostics: {
    optimizer: "lbfgs",
    objective: "mean_logistic_loss_plus_l2_weights",
    rowCount: 2,
    classCounts: { fast: 1, strong: 1 },
    standardize: false,
    l2: 0.1,
    maxIterations: 1,
    iterations: 0,
    initialLoss: 0.7,
    loss: 0.5,
    dataLoss: 0.5,
    regularizationLoss: 0,
    fullGradient: Array(1153).fill(0),
    gradientNorm: 0,
    gradientInfinityNorm: 0,
    stationarityTolerance: 1e-7,
    stationary: true,
    termination: "stationary",
  },
};

class FakeWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: { id: number; text: string }[] = [];
  signals: string[] = [];
  closed = false;
  closeOnKill = true;
  stdin = new Writable({
    write: (bytes, _encoding, callback) => {
      this.requests.push(JSON.parse(bytes.toString()));
      callback();
    },
  });
  kill(signal: string) {
    this.signals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.close());
    return true;
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close", 0, null);
    }
  }
  line(value: unknown) {
    this.stdout.write(JSON.stringify(value) + "\n");
  }
}

const directories: string[] = [];
const workers: FakeWorker[] = [];
const runtimes: ReturnType<typeof createRoutingRuntime>[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) worker.close();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(overrides: Partial<RoutingRuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jev-routing-runtime-"));
  directories.push(directory);
  const workerPath = join(directory, "worker.py"),
    source = "# invented CPU protocol fixture\n";
  await writeFile(workerPath, source);
  const worker = new FakeWorker();
  workers.push(worker);
  const spawn = vi.fn(
    (
      _python: string,
      _args: readonly string[],
      _options: SpawnOptionsWithoutStdio,
    ) => worker as unknown as ChildProcessWithoutNullStreams,
  );
  const options: RoutingRuntimeOptions = {
    python: "/usr/bin/python3",
    workerPath,
    workerSha256: digest(source),
    headArtifact: JSON.stringify(head),
    artifactId: "fixture/head-1",
    artifactSha256: digest(JSON.stringify(head)),
    qualificationSha256: "a".repeat(64),
    spawn,
    ...overrides,
  };
  const runtime = createRoutingRuntime(options);
  runtimes.push(runtime);
  const provenance = routingFeatureProvenance(options.workerSha256);
  return {
    runtime,
    worker,
    spawn,
    options,
    provenance,
    ready: () => worker.line({ type: "ready", dimension: 1152, provenance }),
    answer: (
      id = worker.requests.at(-1)!.id,
      patch: Record<string, unknown> = {},
    ) =>
      worker.line({
        id,
        features: Array(1152).fill(0),
        provenance,
        inputTokens: 7,
        elapsedMs: 2.5,
        modelId: ROUTING_FEATURE_MODEL,
        revision: ROUTING_FEATURE_REVISION,
        ...patch,
      }),
  };
}
async function spawned(s: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(() => expect(s.spawn).toHaveBeenCalledTimes(1));
}
const request = {
  text: "What is two plus two?",
  essentialFactsAvailable: true,
};
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

describe("persistent routing runtime with injected CPU worker", () => {
  it("verifies source, uses fixed isolated spawn arguments, and conservatively requires an explicit fact flag", async () => {
    const s = await setup();
    expect(await s.runtime.classify({ text: request.text })).toMatchObject({
      decision: "strong",
      confidence: 0,
      reason: "essential-facts-not-verified",
      provenance: null,
    });
    expect(s.spawn).not.toHaveBeenCalled();
    const result = s.runtime.classify(request);
    await spawned(s);
    expect(s.spawn.mock.calls[0][0]).toBe("/usr/bin/python3");
    expect(s.spawn.mock.calls[0][1]).toEqual([
      "-I",
      "-u",
      s.options.workerPath,
    ]);
    const options = s.spawn.mock.calls[0][2];
    expect(options.shell).toBe(false);
    expect(options.env).toMatchObject({
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
    });
    expect(Object.keys(options.env!)).toEqual(
      expect.arrayContaining(["PYTHONUTF8", "PYTHONUNBUFFERED"]),
    );
    expect(Object.keys(options.env!)).not.toEqual(
      expect.arrayContaining(["HF_TOKEN"]),
    );
    expect(Object.keys(options.env!)).not.toEqual(
      expect.arrayContaining(["OPENAI_API_KEY"]),
    );
    s.ready();
    s.answer();
    expect(await result).toMatchObject({
      decision: "fast",
      calibration: "uncalibrated",
      artifactId: s.options.artifactId,
      artifactSha256: s.options.artifactSha256,
      qualificationSha256: s.options.qualificationSha256,
      workerSha256: s.options.workerSha256,
      provenance: s.provenance,
      inputTokens: 7,
      featureElapsedMs: 2.5,
    });
    expect(s.runtime.status).toMatchObject({
      state: "ready",
      completedRequests: 1,
      activeRequests: 0,
      queuedRequests: 0,
    });
  });

  it("serializes requests, retains the worker, and measures startup and queue time", async () => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const s = await setup();
    const first = s.runtime.classify(request),
      second = s.runtime.classify({ ...request, text: "Second request" });
    await spawned(s);
    await vi.advanceTimersByTimeAsync(30);
    clock = 30;
    s.ready();
    expect(s.worker.requests).toEqual([{ id: 1, text: request.text }]);
    await vi.advanceTimersByTimeAsync(20);
    clock = 50;
    s.answer(1);
    expect(s.worker.requests).toEqual([
      { id: 1, text: request.text },
      { id: 2, text: "Second request" },
    ]);
    await vi.advanceTimersByTimeAsync(15);
    clock = 65;
    s.answer(2);
    const a = await first,
      b = await second;
    expect(a.operationalElapsedMs).toBeGreaterThanOrEqual(50);
    expect(b.operationalElapsedMs).toBeGreaterThanOrEqual(65);
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds eight queued requests and validates input before adding work", async () => {
    const s = await setup();
    const pending = Array.from({ length: 9 }, () =>
      observe(s.runtime.classify(request)),
    );
    expect(s.runtime.status).toMatchObject({
      activeRequests: 1,
      queuedRequests: 8,
    });
    await expect(s.runtime.classify(request)).rejects.toMatchObject({
      code: "queue-full",
    });
    await expect(
      s.runtime.classify({
        ...request,
        text: "x".repeat(ROUTING_RUNTIME_LIMITS.textBytes + 1),
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      s.runtime.classify({ ...request, text: "\ud800" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await s.runtime.dispose();
    expect((await Promise.all(pending)).every((item) => "error" in item)).toBe(
      true,
    );
  });

  it("checks the worker digest before spawning", async () => {
    const s = await setup({ workerSha256: "b".repeat(64) });
    await expect(s.runtime.classify(request)).rejects.toMatchObject({
      code: "worker-hash-mismatch",
    });
    expect(s.spawn).not.toHaveBeenCalled();
  });

  it("rejects unbound head bytes and invalid head shapes before worker work", async () => {
    await expect(
      setup({ artifactSha256: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "head-hash-mismatch" });
    await expect(
      setup({ headArtifact: JSON.stringify({ ...head, dimension: 1 }) }),
    ).rejects.toMatchObject({ code: "invalid-head" });
    await expect(setup({ python: "python3" })).rejects.toMatchObject({
      code: "invalid-path",
    });
  });

  it("keeps equal head scores uncertain", async () => {
    const tied = JSON.stringify({ ...head, bias: 0 });
    const s = await setup({ headArtifact: tied, artifactSha256: digest(tied) });
    const result = s.runtime.classify(request);
    await spawned(s);
    s.ready();
    s.answer();
    expect(await result).toMatchObject({
      decision: "uncertain",
      confidence: 0.5,
      fastScore: 0.5,
      strongScore: 0.5,
    });
  });

  it("maps startup and request worker errors to safe codes without retaining messages", async () => {
    const s = await setup();
    const failed = observe(s.runtime.classify(request));
    await spawned(s);
    s.worker.line({
      id: null,
      error: { code: "pin_mismatch", message: "invented secret-shaped detail" },
    });
    expect(await failed).toMatchObject({
      error: {
        code: "worker-startup-rejected",
        message: "Routing runtime: worker-startup-rejected",
      },
    });
    const s2 = await setup();
    const failed2 = observe(s2.runtime.classify(request));
    await spawned(s2);
    s2.ready();
    s2.worker.line({
      id: 1,
      error: {
        code: "invalid_features",
        message: "invented secret-shaped detail",
      },
    });
    expect(await failed2).toMatchObject({
      error: {
        code: "worker-rejected-request",
        message: "Routing runtime: worker-rejected-request",
      },
    });
  });

  it("cancellation retires the owned worker and all queued requests, including queued cancellation", async () => {
    const s = await setup(),
      abort = new AbortController();
    const first = observe(s.runtime.classify(request));
    const second = observe(s.runtime.classify(request, abort.signal));
    await spawned(s);
    s.ready();
    abort.abort();
    expect(await first).toMatchObject({ error: { code: "aborted" } });
    expect(await second).toMatchObject({ error: { code: "aborted" } });
    expect(s.worker.signals).toEqual(["SIGTERM"]);
    s.answer(1);
    await expect(s.runtime.classify(request)).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("pre-aborted requests do not spawn or retire an otherwise cold runtime", async () => {
    const s = await setup(),
      abort = new AbortController();
    abort.abort();
    await expect(
      s.runtime.classify(request, abort.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(s.runtime.status.state).toBe("cold");
    expect(s.spawn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unexpected-response-id",
      (s: Awaited<ReturnType<typeof setup>>) => s.answer(99),
    ],
    [
      "provenance-mismatch",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.answer(1, {
          provenance: { ...s.provenance, revision: "f".repeat(40) },
        }),
    ],
    [
      "provenance-mismatch",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.answer(1, {
          provenance: { ...s.provenance, preprocessing: "chat_template" },
        }),
    ],
    [
      "provenance-mismatch",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.answer(1, {
          provenance: {
            ...s.provenance,
            filesSha256: {
              ...s.provenance.filesSha256,
              "tokenizer.json": "0".repeat(64),
            },
          },
        }),
    ],
    [
      "invalid-features",
      (s: Awaited<ReturnType<typeof setup>>) => s.answer(1, { features: [0] }),
    ],
    [
      "invalid-protocol-number",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.answer(1, { inputTokens: -1 }),
    ],
    [
      "invalid-protocol-number",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.answer(1, { inputTokens: 2049 }),
    ],
    [
      "duplicate-json-key",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.worker.stdout.write('{"id":1,"id":2}\n'),
    ],
    [
      "malformed-json",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.worker.stdout.write("not JSON\n"),
    ],
    [
      "invalid-worker-response",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.worker.stdout.write(Buffer.from([0xff, 10])),
    ],
    [
      "line-too-large",
      (s: Awaited<ReturnType<typeof setup>>) =>
        s.worker.stdout.write(
          Buffer.alloc(ROUTING_RUNTIME_LIMITS.lineBytes + 1, 120),
        ),
    ],
    [
      "truncated-stdout",
      (s: Awaited<ReturnType<typeof setup>>) => {
        s.worker.stdout.write('{"id":');
        s.worker.stdout.end();
      },
    ],
    ["worker-eof", (s: Awaited<ReturnType<typeof setup>>) => s.worker.close()],
  ])(
    "fails closed on %s without printing worker data",
    async (code, corrupt) => {
      const s = await setup();
      const first = observe(s.runtime.classify(request)),
        second = observe(s.runtime.classify(request));
      await spawned(s);
      s.ready();
      s.worker.stderr.write("invented sensitive stderr fixture\n");
      corrupt(s);
      expect(await first).toMatchObject({ error: { code } });
      expect(await second).toMatchObject({ error: { code } });
      expect(s.runtime.status).toMatchObject({
        state: "failed",
        errorCode: code,
        queuedRequests: 0,
      });
    },
  );

  it("accepts split multibyte UTF-8 JSON lines", async () => {
    const s = await setup();
    const result = s.runtime.classify({ ...request, text: "Translate café" });
    await spawned(s);
    const ready = Buffer.from(
      JSON.stringify({
        type: "ready",
        dimension: 1152,
        provenance: s.provenance,
      }) + "\n",
    );
    for (const byte of ready) s.worker.stdout.write(Buffer.from([byte]));
    s.answer();
    expect((await result).decision).toBe("fast");
    expect(s.worker.requests[0].text).toBe("Translate café");
  });

  it("times out startup and requests and escalates owned cleanup", async () => {
    vi.useFakeTimers();
    const s = await setup();
    s.worker.closeOnKill = false;
    const pending = observe(s.runtime.classify(request));
    await spawned(s);
    await vi.advanceTimersByTimeAsync(ROUTING_RUNTIME_LIMITS.startupMs);
    expect(await pending).toMatchObject({ error: { code: "startup-timeout" } });
    await vi.advanceTimersByTimeAsync(ROUTING_RUNTIME_LIMITS.killMs);
    expect(s.worker.signals).toEqual(["SIGTERM", "SIGKILL"]);
    s.worker.close();
    await s.runtime.dispose();
    const s2 = await setup();
    const warmup = s2.runtime.classify(request);
    await spawned(s2);
    s2.ready();
    s2.answer();
    await warmup;
    const pending2 = observe(s2.runtime.classify(request));
    await vi.advanceTimersByTimeAsync(ROUTING_RUNTIME_LIMITS.requestMs);
    expect(await pending2).toMatchObject({
      error: { code: "request-timeout" },
    });
  });

  it("bounds lazy first-model loading separately from warmed request time", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const pending = observe(s.runtime.classify(request));
    await spawned(s);
    s.ready();
    await vi.advanceTimersByTimeAsync(ROUTING_RUNTIME_LIMITS.requestMs);
    expect(s.runtime.status).toMatchObject({
      state: "ready",
      activeRequests: 1,
      modelReady: false,
    });
    await vi.advanceTimersByTimeAsync(
      ROUTING_RUNTIME_LIMITS.modelStartupMs - ROUTING_RUNTIME_LIMITS.requestMs,
    );
    expect(await pending).toMatchObject({
      error: { code: "model-startup-timeout" },
    });
  });

  it("reports cleanup uncertainty when neither TERM nor KILL obtains close", async () => {
    vi.useFakeTimers();
    const s = await setup();
    s.worker.closeOnKill = false;
    const failed = observe(s.runtime.classify(request));
    await spawned(s);
    s.ready();
    s.worker.line({ id: 999 });
    expect(await failed).toMatchObject({
      error: { code: "invalid-protocol-fields" },
    });
    await vi.advanceTimersByTimeAsync(2 * ROUTING_RUNTIME_LIMITS.killMs);
    await expect(s.runtime.dispose()).rejects.toMatchObject({
      code: "cleanup-timeout",
    });
    expect(s.runtime.status).toMatchObject({
      state: "disposed",
      errorCode: "cleanup-timeout",
    });
    runtimes.splice(runtimes.indexOf(s.runtime), 1);
  });

  it("disposal waits for owned close and rejects active/queued work", async () => {
    const s = await setup();
    s.worker.closeOnKill = false;
    const first = observe(s.runtime.classify(request)),
      second = observe(s.runtime.classify(request));
    await spawned(s);
    s.ready();
    let disposed = false;
    const disposal = s.runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(await first).toMatchObject({ error: { code: "disposed" } });
    expect(await second).toMatchObject({ error: { code: "disposed" } });
    s.worker.close();
    await disposal;
    await expect(s.runtime.classify(request)).rejects.toMatchObject({
      code: "disposed",
    });
  });
});
