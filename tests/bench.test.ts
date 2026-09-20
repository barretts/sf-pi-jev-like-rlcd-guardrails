import { expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Classifier,
  configFromEnv,
  type InferenceAdapter,
} from "../src/backend.js";
import type { Plan } from "../src/core.js";
import { percentile, runBenchmark } from "../src/bench.js";

function fake(
  options: {
    delay?: number;
    metrics?: boolean;
    directory?: string;
    onEvaluate?: (count: number) => void;
  } = {},
) {
  let evaluations = 0;
  const backend: InferenceAdapter & {
    isReady: boolean;
    status: () => unknown;
  } = {
    isReady: false,
    status: () => ({
      state: backend.isReady ? "ready" : "idle",
      ready: backend.isReady,
      device: "fake-no-device",
      temporary_directory: options.directory,
      artifact: { revision: "fixture-revision", sha256: "fixture-checksum" },
    }),
    warmup: vi.fn(async () => {
      backend.isReady = true;
    }),
    compile: vi.fn(async (plan, signal) => {
      signal?.throwIfAborted();
      backend.isReady = true;
      return plan;
    }),
    evaluate: vi.fn(async (compiled, signal) => {
      const plan = compiled as Plan;
      options.onEvaluate?.(++evaluations);
      if (options.delay)
        await new Promise((done) => setTimeout(done, options.delay));
      signal?.throwIfAborted();
      return {
        logits: Object.fromEntries(
          plan.questions.map((_, index) => [String(index), { A: 3, B: 1 }]),
        ),
        input_tokens: 999_999,
        metrics:
          options.metrics === false
            ? {}
            : {
                computed_prompt_tokens: 10 * plan.questions.length,
                branch_output_tokens: 0,
                engine_forwards: 1,
              },
      };
    }),
    dispose: vi.fn(async () => {}),
  };
  const config = configFromEnv({ JEV_MODEL_ID: "google/gemma-3-1b-it" });
  config.advanced = true;
  config.templateVersion = "v2";
  config.binary = join(tmpdir(), "nonexistent-jev-bench-binary");
  const classifier = new Classifier(config, backend);
  return { classifier, backend };
}

it("interpolates percentile samples without mutating them", () => {
  const input = [4, 1, 3, 2];
  expect(percentile(input, 0)).toBe(1);
  expect(percentile(input, 50)).toBe(2.5);
  expect(percentile(input, 95)).toBeCloseTo(3.85);
  expect(percentile(input, 100)).toBe(4);
  expect(percentile([7], 95)).toBe(7);
  expect(percentile([], 95)).toBeNull();
  expect(input).toEqual([4, 1, 3, 2]);
  expect(() => percentile([1, Infinity], 50)).toThrow("finite");
  expect(() => percentile([1], 101)).toThrow("between");
});

it("exercises one reused classifier and accounts only for computed native tokens", async () => {
  const { classifier, backend } = fake();
  try {
    const report = await runBenchmark(classifier, {
      iterations: 1,
      contextSizes: [64, 128],
      branchCounts: [1, 2],
      queuedCallers: [1, 3],
    });
    expect(report.completed).toBe(true);
    expect(report.conditions.cold_start_measured).toBe(true);
    expect(report.conditions.first_request_state).toBe("uninitialized");
    expect(report.summary.attempted).toBe(18);
    expect(report.summary.succeeded).toBe(18);
    expect(report.summary.computed_prompt_tokens).toBe(260);
    expect(report.summary.computed_output_tokens).toBe(0);
    expect(report.summary.computed_prompt_tokens_per_second).toBeGreaterThan(0);
    expect(report.workloads).toHaveLength(8);
    expect(report.first_request.attempted).toBe(1);
    expect(report.warm.attempted).toBe(1);
    expect(
      report.samples.every((sample) => sample.queue_seconds !== null),
    ).toBe(true);
    expect(
      report.samples.every(
        (sample) => sample.computed_prompt_tokens! < 999_999,
      ),
    ).toBe(true);
    expect(report.identity.native_binary.sha256).toBe("unknown");
    expect(report.identity.runtime_after).not.toBe("unknown");
    expect(
      report.resources.orchestrator_rss_observed_peak_bytes,
    ).toBeGreaterThan(0);
    expect(report.resources.native_rss_observed_peak_bytes).toBeNull();
    expect(backend.compile).toHaveBeenCalledTimes(18);
    expect(backend.dispose).not.toHaveBeenCalled();
    const firstPlan = vi.mocked(backend.compile).mock.calls[0][0];
    expect(firstPlan.request.state).toHaveLength(64);
    expect(firstPlan.request.options?.template_version).toBe("v2");
    classifier.config.templateVersion = "v1";
    const warmReport = await runBenchmark(classifier, {
      iterations: 1,
      queuedCallers: [1],
    });
    expect(warmReport.conditions.cold_start_measured).toBe(false);
    expect(warmReport.conditions.first_request_state).toBe("ready");
    expect(warmReport.conditions.template_version).toBe("v1");
  } finally {
    await classifier.dispose();
  }
});

it("reports actual queue saturation and observed waits per workload", async () => {
  const { classifier } = fake({ delay: 2 });
  try {
    const report = await runBenchmark(classifier, {
      iterations: 1,
      queuedCallers: [18],
    });
    expect(report.summary.attempted).toBe(20);
    expect(report.summary.succeeded).toBe(19);
    expect(report.summary.overloaded).toBe(1);
    expect(report.workloads[0].summary.succeeded).toBe(17);
    expect(report.workloads[0].summary.overloaded).toBe(1);
    expect(report.workloads[0].summary.queue_seconds.maximum).toBeGreaterThan(
      0.002,
    );
    expect(
      report.samples.find((sample) => sample.outcome === "overloaded")
        ?.computed_prompt_tokens,
    ).toBeNull();
    expect(report.summary.latency_seconds.count).toBe(19);
  } finally {
    await classifier.dispose();
  }
});

it("leaves missing computed metrics unknown instead of substituting logical usage", async () => {
  const { classifier } = fake({ metrics: false });
  try {
    const report = await runBenchmark(classifier, {
      iterations: 1,
      queuedCallers: [1],
    });
    expect(report.summary.computed_prompt_tokens).toBeNull();
    expect(report.summary.computed_output_tokens).toBeNull();
    expect(report.summary.computed_prompt_tokens_per_second).toBeNull();
    expect(
      report.notes.some((note) => note.includes("omitted computed-token")),
    ).toBe(true);
  } finally {
    await classifier.dispose();
  }
});

it("returns a partial report and stops scheduling work after cancellation", async () => {
  const controller = new AbortController();
  const { classifier } = fake({
    onEvaluate: (count) => {
      if (count === 3)
        controller.abort(new DOMException("cancelled", "AbortError"));
    },
  });
  try {
    const report = await runBenchmark(classifier, {
      iterations: 1,
      contextSizes: [64, 128],
      queuedCallers: [4],
      signal: controller.signal,
    });
    expect(report.completed).toBe(false);
    expect(report.summary.attempted).toBe(6);
    expect(report.summary.succeeded).toBe(2);
    expect(report.summary.cancelled).toBe(4);
    expect(report.workloads[1].summary.attempted).toBe(0);
  } finally {
    await classifier.dispose();
  }
});

it("measures only a status-reported owned temporary directory without following symlinks", async () => {
  const owned = await mkdtemp(join(tmpdir(), "jev-gemma-bench-test-"));
  const outside = await mkdtemp(join(tmpdir(), "jev-bench-outside-"));
  const { classifier } = fake({ directory: owned });
  try {
    await writeFile(join(owned, "runtime.gguf"), "1234567");
    await writeFile(join(outside, "private-data"), "1234567890");
    await symlink(outside, join(owned, "outside"));
    const report = await runBenchmark(classifier, {
      iterations: 1,
      queuedCallers: [1],
    });
    expect(report.resources.temporary_disk_observed_peak_bytes).toBe(7);
    expect(report.resources.temporary_disk_complete).toBe(false);
    expect(report.resources.temporary_disk_roots).toContain(owned);
  } finally {
    await classifier.dispose();
    await rm(owned, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it("rejects invalid or excessive workload envelopes before touching the backend", async () => {
  const { classifier, backend } = fake();
  try {
    await expect(runBenchmark(classifier, { iterations: 0 })).rejects.toThrow(
      "iterations",
    );
    await expect(
      runBenchmark(classifier, { contextSizes: [] }),
    ).rejects.toThrow("contextSizes");
    await expect(
      runBenchmark(classifier, { branchCounts: [101] }),
    ).rejects.toThrow("branchCounts");
    await expect(
      runBenchmark(classifier, {
        iterations: 100,
        contextSizes: [64, 128],
        branchCounts: [1, 2],
        queuedCallers: [64],
      }),
    ).rejects.toThrow("10000");
    await expect(
      runBenchmark(classifier, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(backend.compile).not.toHaveBeenCalled();
  } finally {
    await classifier.dispose();
  }
});
