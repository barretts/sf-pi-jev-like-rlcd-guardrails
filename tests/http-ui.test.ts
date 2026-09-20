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
});
