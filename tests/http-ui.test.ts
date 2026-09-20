import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Classifier,
  DeadlineExceeded,
  configFromEnv,
  type InferenceAdapter,
} from "../src/backend.js";
import type { Plan } from "../src/core.js";
import type { QualitySummary } from "../src/evaluation.js";
import {
  assertLoopbackHost,
  createServer,
  trustedRequest,
} from "../src/server.js";
import {
  listInspectorRecords,
  playgroundScript,
  readInspectorRecord,
} from "../src/web.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const config = configFromEnv({ JEV_MODEL_ID: "gemma" });
function fake(): InferenceAdapter {
  return {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async (plan) => plan),
    evaluate: vi.fn(async (compiled) => ({
      logits: Object.fromEntries(
        (compiled as Plan).questions.map((branch) => [
          branch.branch_id,
          Object.fromEntries(
            branch.output_labels.map((label, index) => [label, -index]),
          ),
        ]),
      ),
      input_tokens: 19,
      metrics: { computed_prompt_tokens: 19 },
    })),
    dispose: vi.fn(async () => {}),
  };
}
const request = {
  model: "gemma",
  state: "Please refund a duplicate charge.",
  questions: {
    route: {
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "Payments", technical: "Product failures" },
    },
    support: {
      type: "score",
      instructions: "How much support?",
      criteria: ["Absent", "Partial", "Full"],
    },
    refund: { type: "noul", instructions: "Requests a refund?" },
  },
};

describe("local HTTP boundary", () => {
  it("accepts only exact loopback bindings and same-origin browser requests", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"])
      expect(() => assertLoopbackHost(host)).not.toThrow();
    for (const host of [
      "0.0.0.0",
      "::",
      "example.com",
      "127.0.0.1.example.com",
    ])
      expect(() => assertLoopbackHost(host)).toThrow("loopback");
    expect(
      trustedRequest("127.0.0.1:8000", "http://127.0.0.1:8000", 8000),
    ).toBe(true);
    expect(trustedRequest("[::1]:8000", "http://[::1]:8000", 8000)).toBe(true);
    expect(trustedRequest("localhost:8000", undefined, 8000)).toBe(true);
    expect(trustedRequest("localhost:8001", undefined, 8000)).toBe(false);
    expect(trustedRequest("evil.example:8000", undefined)).toBe(false);
    expect(trustedRequest("localhost:8000", "http://evil.example")).toBe(false);
    expect(trustedRequest("localhost:8000", "null")).toBe(false);
    expect(
      trustedRequest("localhost:8000", "http://localhost:8000/extra"),
    ).toBe(false);
  });
  it("rejects rebinding, cross-origin writes, non-JSON writes, large bodies, and non-loopback listen", async () => {
    const app = await createServer(
      config,
      new Classifier(config, fake()),
      false,
    );
    try {
      await expect(app.listen({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
        "loopback",
      );
      expect(
        (await app.inject({ url: "/", headers: { host: "evil.example" } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/classifier",
            payload: request,
            headers: { origin: "https://evil.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/classifier",
            payload: "hello",
            headers: { "content-type": "text/plain" },
          })
        ).statusCode,
      ).toBe(415);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/classifier",
            payload: { ...request, state: "x".repeat(256 * 1024) },
          })
        ).statusCode,
      ).toBe(413);
      const response = await app.inject({
        method: "POST",
        url: "/v1/classifier",
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain(
        "script-src 'self'",
      );
    } finally {
      await app.close();
    }
  });
  it("retains API v1 and resolves explicit v2 across all three answer types", async () => {
    const backend = fake(),
      app = await createServer(config, new Classifier(config, backend), false);
    try {
      for (const [url, template] of [
        ["/v1/classifier", "v1"],
        ["/v1/systemone", "v2"],
      ] as const) {
        const payload =
          template === "v1"
            ? request
            : { ...request, options: { template_version: template } };
        const response = await app.inject({ method: "POST", url, payload });
        expect(response.statusCode).toBe(200);
        const result = response.json();
        expect(
          Object.values(result.answers).map((answer: any) => answer.type),
        ).toEqual(["choice", "score", "noul"]);
        expect(result.usage).toEqual({ input_tokens: 19, output_tokens: 0 });
        expect(
          vi.mocked(backend.compile).mock.calls.at(-1)?.[0].template_version,
        ).toBe(template);
      }
    } finally {
      await app.close();
    }
  });
  it("reports deadlines without exposing request context", async () => {
    const classifier = new Classifier(config, fake()),
      app = await createServer(config, classifier, false);
    try {
      vi.spyOn(classifier, "classify").mockRejectedValueOnce(
        new DeadlineExceeded("queue"),
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/classifier",
        payload: request,
      });
      expect(response.statusCode).toBe(504);
      expect(response.json().error).toMatchObject({
        code: "deadline_exceeded",
        stage: "queue",
      });
      expect(response.body).not.toContain(request.state);
    } finally {
      await app.close();
    }
  });
});

describe("local browser routes and report scoping", () => {
  it("serves self-contained assets and local docs without initializing inference", async () => {
    const backend = fake(),
      app = await createServer(config, new Classifier(config, backend), false);
    try {
      for (const url of [
        "/",
        "/inspector",
        "/docs/",
        "/redoc",
        "/assets/playground.js",
        "/assets/inspector.js",
        "/assets/docs.js",
      ]) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toMatch(/https:\/\/(?:cdn|unpkg|jsdelivr)/);
      }
      expect((await app.inject("/api/ui/config")).json()).toMatchObject({
        model: "gemma",
        template_version: "v2",
      });
      expect(backend.warmup).not.toHaveBeenCalled();
      expect(playgroundScript).toContain("response.textContent = output");
      expect(playgroundScript).not.toContain("innerHTML");
    } finally {
      await app.close();
    }
  });
  it("lists scoped reports and refuses path traversal, external symlinks, and raw context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jev-web-test-"));
    temporary.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), "jev-web-outside-"));
    temporary.push(outside);
    await mkdir(join(workspace, ".jev", "reports"), { recursive: true });
    await mkdir(join(workspace, ".jev", "rfdt", "run-01"), { recursive: true });
    await writeFile(
      join(workspace, ".jev", "reports", "report-01.json"),
      JSON.stringify({
        id: "report-01",
        kind: "routing",
        createdAt: "2026-09-19T00:00:00Z",
        answers: { route: "billing" },
        prompt: "private raw prompt",
        filepath: "/secret/file",
      }),
    );
    await writeFile(
      join(workspace, ".jev", "rfdt", "run-01", "manifest.json"),
      JSON.stringify({
        id: "run-01",
        status: "prepared",
        base_model: "google/gemma-3-1b-it",
        template_version: "v2",
        data_path: "/secret/data",
      }),
    );
    await writeFile(
      join(outside, "secret.json"),
      JSON.stringify({ kind: "routing", answers: "outside" }),
    );
    await symlink(
      join(outside, "secret.json"),
      join(workspace, ".jev", "reports", "outside.json"),
    );
    const index = await listInspectorRecords(workspace);
    expect(index.reports).toHaveLength(1);
    expect(index.runs).toHaveLength(1);
    expect(JSON.stringify(index)).not.toMatch(
      /private raw prompt|secret\/|data_path|filepath/,
    );
    expect(
      await readInspectorRecord(workspace, "routing", "../secret"),
    ).toBeNull();
    expect(
      await readInspectorRecord(workspace, "routing", "outside"),
    ).toBeNull();
    expect(
      await readInspectorRecord(workspace, "evaluation", "report-01"),
    ).toBeNull();
    expect(
      await readInspectorRecord(workspace, "rfdt", "run-01"),
    ).toMatchObject({ kind: "rfdt", status: "prepared" });
  });
  it("serves saved native RFDT quality summaries and legacy adapter metrics over cold read-only HTTP", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jev-rfdt-inspector-"));
    temporary.push(workspace);
    const runId = "rfdt-native-saved",
      directory = join(workspace, ".jev", "rfdt", runId),
      artifactHash = "a".repeat(64),
      validationHash = "b".repeat(64),
      testHash = "c".repeat(64),
      completedAt = "2026-09-20T04:57:32.463Z";
    const validationSummary: QualitySummary = {
      records: 120,
      failures: 1,
      choice: { count: 40, correct: 38, accuracy: 0.95 },
      noul: {
        clear_count: 30,
        clear_correct: 29,
        clear_accuracy: 29 / 30,
        brier: 0.04,
        uncertain_count: 10,
        uncertainty_mae: 0.08,
      },
      score: { count: 40, normalized_mae: 0.06 },
      regressions: { count: 7, passed: 6 },
      gates: {
        no_failures: false,
        choice_accuracy: true,
        noul_clear_accuracy: true,
        noul_brier: true,
        normalized_score_mae: true,
        known_regressions: false,
        passed: false,
      },
    };
    const testSummary: QualitySummary = {
      records: 0,
      failures: 0,
      choice: { count: 0, correct: 0, accuracy: null },
      noul: {
        clear_count: 0,
        clear_correct: 0,
        clear_accuracy: null,
        brier: null,
        uncertain_count: 0,
        uncertainty_mae: null,
      },
      score: { count: 0, normalized_mae: null },
      regressions: { count: 0, passed: 0 },
      gates: {
        no_failures: true,
        choice_accuracy: false,
        noul_clear_accuracy: false,
        noul_brier: false,
        normalized_score_mae: false,
        known_regressions: true,
        passed: false,
      },
    };
    const binding = {
      training_run: runId,
      artifact_id: "jev/gemma-3-1b-rfdt-saved",
      artifact_sha256: artifactHash,
      artifact_size: 2_000_000,
      template_version: "v2",
      prepared_sha256: "d".repeat(64),
      dataset_sha256: "e".repeat(64),
      quality_suite_sha256: "f".repeat(64),
    };
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        version: 1,
        id: runId,
        status: "exported",
        base_model: "google/gemma-3-1b-it",
        base_revision: "dcc83ea841ab6100d6b47a070329e1ba4cf78752",
        template_version: "v2",
        directory,
        source: { file: "/private/rfdt/source.jsonl" },
        prepared: {
          sha256: binding.prepared_sha256,
          branches: { train: 180, validation: 40, test: 40 },
          files: { train: "/private/rfdt/train.jsonl" },
          dataset_file: "/private/rfdt/dataset.jsonl",
          raw_data: "private prepared rows",
        },
        evaluation: {
          native_validation: {
            summary: validationSummary,
            artifact_sha256: artifactHash,
            binding,
            file: "/private/rfdt/native-validation-report.json",
            sha256: validationHash,
            completed_at: completedAt,
            artifact: "native_gguf",
            raw_results: [{ prompt: "private validation prompt" }],
          },
          native_test: {
            summary: testSummary,
            artifact_sha256: artifactHash,
            binding,
            file: "/private/rfdt/native-test-report.json",
            sha256: testHash,
            completed_at: completedAt,
            artifact: "native_gguf",
            arbitrary: { tokenizer: "/private/rfdt/tokenizer.json" },
          },
          validation: {
            rows: 12,
            mean_loss: 0.25,
            selected_label_accuracy: 0.75,
            completed_at: completedAt,
            artifact: "mlx_adapter",
            adapter_dir: "/private/rfdt/adapter",
            predictions: [{ prompt: "private adapter validation prompt" }],
          },
          test: {
            rows: 8,
            mean_loss: 0.5,
            selected_label_accuracy: 0.625,
            completed_at: completedAt,
            artifact: "mlx_adapter",
            provenance: { model_path: "/private/rfdt/model" },
          },
        },
      }),
    );
    const backend = fake(),
      app = await createServer(
        config,
        new Classifier(config, backend),
        false,
        workspace,
      );
    try {
      const index = await app.inject({ method: "GET", url: "/api/inspector" });
      expect(index.statusCode).toBe(200);
      expect(index.json().runs).toContainEqual(
        expect.objectContaining({
          id: runId,
          kind: "rfdt",
          status: "exported",
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: `/api/inspector/rfdt/${runId}`,
      });
      expect(response.statusCode).toBe(200);
      const saved = response.json();
      expect(saved.evaluation).toEqual({
        native_validation: {
          summary: validationSummary,
          artifact_sha256: artifactHash,
          sha256: validationHash,
          completed_at: completedAt,
          artifact: "native_gguf",
        },
        native_test: {
          summary: testSummary,
          artifact_sha256: artifactHash,
          sha256: testHash,
          completed_at: completedAt,
          artifact: "native_gguf",
        },
        validation: {
          rows: 12,
          mean_loss: 0.25,
          selected_label_accuracy: 0.75,
          completed_at: completedAt,
          artifact: "mlx_adapter",
        },
        test: {
          rows: 8,
          mean_loss: 0.5,
          selected_label_accuracy: 0.625,
          completed_at: completedAt,
          artifact: "mlx_adapter",
        },
      });
      expect(saved.prepared).toEqual({
        sha256: binding.prepared_sha256,
        branches: { train: 180, validation: 40, test: 40 },
      });
      expect(response.body).not.toMatch(
        /\/private\/|raw_results|predictions|binding|tokenizer|prompt|dataset_file|raw_data|adapter_dir|model_path/,
      );
      expect(backend.warmup).not.toHaveBeenCalled();
      expect(backend.compile).not.toHaveBeenCalled();
      expect(backend.evaluate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("redacts malformed nested RFDT evaluation values instead of rendering saved raw context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jev-rfdt-inspector-"));
    temporary.push(workspace);
    const runId = "rfdt-malformed-saved",
      directory = join(workspace, ".jev", "rfdt", runId),
      privateText = "/private/rfdt/raw-prompt-or-path";
    await mkdir(directory, { recursive: true });
    const manifest = JSON.stringify({
      id: runId,
      status: "exported",
      prepared: {
        sha256: "d".repeat(64),
        branches: {
          train: 180,
          validation: { prompt: privateText },
          test: privateText,
          arbitrary: { file: privateText },
        },
        files: { train: privateText },
      },
      evaluation: {
        native_validation: {
          summary: {
            records: { prompt: privateText },
            failures: privateText,
            choice: {
              count: privateText,
              correct: { file: privateText },
              accuracy: null,
              raw_results: privateText,
            },
            noul: {
              clear_count: 3,
              clear_correct: { prompt: privateText },
              clear_accuracy: privateText,
              brier: "nonfinite-metric",
              uncertain_count: 0,
              uncertainty_mae: null,
              predictions: [{ prompt: privateText }],
            },
            score: { count: 4, normalized_mae: { file: privateText } },
            regressions: { count: 2, passed: 1, arbitrary: privateText },
            gates: {
              no_failures: false,
              choice_accuracy: privateText,
              noul_clear_accuracy: { prompt: privateText },
              noul_brier: false,
              normalized_score_mae: true,
              known_regressions: true,
              passed: false,
              arbitrary: true,
            },
            arbitrary: { prompt: privateText },
          },
          artifact_sha256: { file: privateText },
          sha256: privateText,
          completed_at: "not-an-ISO-date",
          artifact: { prompt: privateText },
          binding: { file: privateText },
          file: privateText,
          raw_results: [{ prompt: privateText }],
        },
        native_test: {
          artifact_sha256: "a".repeat(63),
          sha256: "z".repeat(64),
          completed_at: { prompt: privateText },
          artifact: privateText,
        },
        validation: {
          rows: { file: privateText },
          mean_loss: privateText,
          selected_label_accuracy: { prompt: privateText },
          completed_at: "2026-99-99T99:99:99Z",
          artifact: privateText,
        },
      },
    }).replace('"nonfinite-metric"', "1e400");
    await writeFile(join(directory, "manifest.json"), manifest);
    const backend = fake(),
      app = await createServer(
        config,
        new Classifier(config, backend),
        false,
        workspace,
      );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/inspector/rfdt/${runId}`,
      });
      expect(response.statusCode).toBe(200);
      const saved = response.json(),
        evaluation = saved.evaluation.native_validation;
      expect(evaluation.summary).toEqual({
        choice: { accuracy: null },
        noul: { clear_count: 3, uncertain_count: 0, uncertainty_mae: null },
        score: { count: 4 },
        regressions: { count: 2, passed: 1 },
        gates: {
          no_failures: false,
          noul_brier: false,
          normalized_score_mae: true,
          known_regressions: true,
          passed: false,
        },
      });
      for (const entry of Object.values(saved.evaluation))
        expect(entry).not.toHaveProperty("artifact");
      expect(evaluation).not.toHaveProperty("artifact_sha256");
      expect(evaluation).not.toHaveProperty("sha256");
      expect(evaluation).not.toHaveProperty("completed_at");
      expect(saved.evaluation.native_test).not.toHaveProperty(
        "artifact_sha256",
      );
      expect(saved.evaluation.native_test).not.toHaveProperty("sha256");
      expect(saved.evaluation.native_test).not.toHaveProperty("completed_at");
      expect(saved.evaluation.validation).not.toHaveProperty("rows");
      expect(saved.evaluation.validation).not.toHaveProperty("mean_loss");
      expect(saved.evaluation.validation).not.toHaveProperty(
        "selected_label_accuracy",
      );
      expect(saved.evaluation.validation).not.toHaveProperty("completed_at");
      expect(saved.prepared).toEqual({
        sha256: "d".repeat(64),
        branches: { train: 180 },
      });
      expect(response.body).not.toMatch(
        /\/private\/|prompt|file|binding|raw_results|predictions|arbitrary|nonfinite-metric/,
      );
      expect(backend.warmup).not.toHaveBeenCalled();
      expect(backend.compile).not.toHaveBeenCalled();
      expect(backend.evaluate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
