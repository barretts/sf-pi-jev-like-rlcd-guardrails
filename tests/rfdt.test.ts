import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Classifier,
  configFromEnv,
  type InferenceAdapter,
} from "../src/backend.js";
import { type Plan, type Question } from "../src/core.js";
import { AGENT_MODEL_ID, modelDescriptor } from "../src/models.js";
import {
  assignRfdtSplits,
  approveRfdt,
  evaluateRfdt,
  normalizeRfdtTarget,
  prepareRfdt,
  labelRfdt,
  validateRfdtExample,
  type RfdtExample,
} from "../src/rfdt.js";
import { rfdtFixture } from "./rfdt-fixture.js";

const choice: Question = {
  id: "route",
  type: "choice",
  instructions: "Select a team",
  criteria: [
    { id: "billing", description: "Payments" },
    { id: "product", description: "Product" },
  ],
};
const score: Question = {
  id: "support",
  type: "score",
  instructions: "How much?",
  criteria: ["None", "Some", "All"],
};
const truth: Question = {
  id: "refund",
  type: "noul",
  instructions: "Was a refund requested?",
};
function example(
  id = "a",
  group = "g",
  split?: "train" | "validation" | "test",
): RfdtExample {
  return {
    id,
    group_id: group,
    ...(split ? { split } : {}),
    request: {
      model: "google/gemma-3-1b-it",
      state: `Context ${group}`,
      questions: [choice, score, truth],
    },
    targets: {
      route: { answer: "billing" },
      support: { answer: 1.25 },
      refund: { answer: null },
    },
  };
}
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("RFDT native acceptance", () => {
  async function fixture(nativeEvidence = true, trainOnly = false) {
    const dir = await mkdtemp(join(tmpdir(), "jev-rfdt-acceptance-"));
    dirs.push(dir);
    return rfdtFixture(dir, nativeEvidence, trainOnly);
  }

  it("evaluates a verified export through a temporary registry without promoting it", async () => {
    const f = await fixture(false, true);
    expect(f.run.prepared.branches).toEqual({
      train: 3,
      validation: 0,
      test: 0,
    });
    vi.spyOn(Classifier.prototype, "classify").mockImplementation(
      async (request) => f.response(request as any),
    );
    vi.spyOn(Classifier.prototype, "dispose").mockResolvedValue();
    const report = await evaluateRfdt(f.run.directory, {
      split: "validation",
      config: configFromEnv({}),
    });
    expect((report.summary as any).gates.passed).toBe(true);
    expect((report.summary as any).records).toBe(60);
    expect((report.summary as any).choice.count).toBe(20);
    expect((report.summary as any).score.count).toBe(20);
    expect(report.rfdt).toMatchObject({
      training_run: f.run.id,
      artifact_sha256: f.artifact.sha256,
    });
    expect(
      (await readdir(f.run.directory)).filter((file) =>
        file.startsWith("candidate-"),
      ),
    ).toEqual([]);
    await expect(readFile(f.registryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects changed validation evidence before consuming the reserved test split", async () => {
    const f = await fixture();
    delete f.run.evaluation!.native_test;
    await f.writeRun();
    const acceptance = f.run.evaluation!.native_validation as any;
    await writeFile(
      acceptance.file,
      (await readFile(acceptance.file, "utf8")) + "\n",
    );
    const classify = vi.spyOn(Classifier.prototype, "classify");
    await expect(
      evaluateRfdt(f.run.directory, { split: "test" }),
    ).rejects.toThrow(/report checksum mismatch/);
    expect(classify).not.toHaveBeenCalled();
    expect(
      (await readdir(f.run.directory)).filter((file) =>
        file.includes("reservation"),
      ),
    ).toEqual([]);
  });

  it("allows one concurrent claim of the reserved native test split", async () => {
    const f = await fixture();
    delete f.run.evaluation!.native_test;
    await f.writeRun();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const classify = vi
      .spyOn(Classifier.prototype, "classify")
      .mockImplementation(async (request) => {
        entered();
        await gate;
        return f.response(request as any);
      });
    vi.spyOn(Classifier.prototype, "dispose").mockResolvedValue();
    const first = evaluateRfdt(f.run.directory, {
      split: "test",
      config: configFromEnv({}),
    });
    await started;
    try {
      await expect(
        evaluateRfdt(f.run.directory, {
          split: "test",
          config: configFromEnv({}),
        }),
      ).rejects.toThrow(/already been claimed/);
      expect(classify).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await first).artifact).toBe("native_gguf");
    await expect(
      evaluateRfdt(f.run.directory, { split: "test" }),
    ).rejects.toThrow(/already been evaluated/);
    expect(
      (await readdir(f.run.directory)).filter((file) =>
        file.startsWith("candidate-"),
      ),
    ).toEqual([]);
  });

  it("binds wrapper approval to the requested run instead of a substituted artifact manifest", async () => {
    const first = await fixture();
    const other = await fixture();
    await writeFile(
      join(first.run.directory, "artifact.json"),
      JSON.stringify(other.artifact),
    );
    await expect(
      approveRfdt(first.run.directory, { registryPath: first.registryPath }),
    ).rejects.toThrow(/refer to this run manifest/);
    await expect(readFile(first.registryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("RFDT teacher labeling", () => {
  it("uses supplied labels, marks estimates, and reuses an identity-bound cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-rfdt-teacher-"));
    dirs.push(dir);
    const input = join(dir, "input.jsonl"),
      output = join(dir, "output.jsonl");
    const row = example();
    delete row.targets.refund;
    await writeFile(input, JSON.stringify(row) + "\n");
    let calls = 0;
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      calls++;
      expect(request.url).toBe("/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ refund: { answer: true } }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Invalid server address");
      const options = {
        outputPath: output,
        teacherUrl: `http://127.0.0.1:${address.port}/v1`,
        teacherModel: AGENT_MODEL_ID,
        cacheDir: join(dir, "cache"),
      };
      expect(await labelRfdt(input, options)).toMatchObject({
        teacher_estimates: 1,
        cache_hits: 0,
      });
      expect(await labelRfdt(input, options)).toMatchObject({
        teacher_estimates: 1,
        cache_hits: 1,
      });
      expect(calls).toBe(1);
      expect(bodies[0].model).toBe(AGENT_MODEL_ID);
      const labeled = JSON.parse(await readFile(output, "utf8"));
      expect(labeled.targets.route).toEqual({ answer: "billing" });
      expect(labeled.targets.refund).toEqual({ answer: true });
      expect(labeled.target_provenance.refund).toMatchObject({
        source: "teacher_estimate",
        model: AGENT_MODEL_ID,
        revision: (await modelDescriptor(AGENT_MODEL_ID)).revision,
      });
      expect(labeled.target_provenance.route.source).toBe("supplied");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
  it("does not call the teacher for complete labels and rejects an unapproved teacher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-rfdt-teacher-"));
    dirs.push(dir);
    const input = join(dir, "input.jsonl");
    await writeFile(input, JSON.stringify(example()) + "\n");
    const options = {
      outputPath: join(dir, "output.jsonl"),
      teacherUrl: "http://127.0.0.1:1/v1",
      teacherModel: AGENT_MODEL_ID,
      cacheDir: join(dir, "cache"),
    };
    expect(await labelRfdt(input, options)).toMatchObject({
      teacher_estimates: 0,
    });
    await expect(
      labelRfdt(input, { ...options, teacherModel: "unapproved/model" }),
    ).rejects.toThrow(/approved Google/);
    await expect(
      labelRfdt(input, {
        ...options,
        teacherModel: (await modelDescriptor(AGENT_MODEL_ID)).repository,
      }),
    ).rejects.toThrow(/approved Google/);
  });
});

describe("RFDT supervision", () => {
  it("normalizes ordered hard, interpolated, and uncertain targets", () => {
    expect(normalizeRfdtTarget(choice, { answer: "product" })).toEqual([0, 1]);
    expect(normalizeRfdtTarget(score, { answer: 1.25 })).toEqual([
      0, 0.75, 0.25,
    ]);
    expect(normalizeRfdtTarget(truth, { answer: null })).toEqual([
      0, 0, 0, 0, 1, 0, 0, 0, 0,
    ]);
    expect(normalizeRfdtTarget(truth, { answer: false })).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(normalizeRfdtTarget(truth, { answer: true })).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });
  it("retains supplied distributions in question order", () => {
    expect(
      normalizeRfdtTarget(choice, {
        probabilities: { product: 0.25, billing: 0.75 },
      }),
    ).toEqual([0.75, 0.25]);
    expect(() =>
      normalizeRfdtTarget(choice, { probabilities: { billing: 1 } }),
    ).toThrow(/every answer label/);
    expect(() => normalizeRfdtTarget(score, { answer: 3 })).toThrow(/outside/);
    expect(() => normalizeRfdtTarget(truth, { answer: "yes" })).toThrow(/Noul/);
    expect(() =>
      normalizeRfdtTarget(choice, {
        probabilities: { billing: 0.75, product: 0.75 },
      }),
    ).toThrow(/sum/);
  });
  it("requires complete labels for training while allowing preparation for a teacher", () => {
    const row = example();
    delete row.targets.refund;
    expect(() => validateRfdtExample(row)).toThrow(/Missing target refund/);
    expect(validateRfdtExample(row, true).targets).not.toHaveProperty("refund");
    expect(() =>
      validateRfdtExample({ ...row, unexpected: true }, true),
    ).toThrow(/unknown field/);
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => validateRfdtExample(cycle)).toThrow();
  });
});

describe("RFDT grouped split", () => {
  it("is deterministic and keeps candidate-order variants together", () => {
    const rows = [example("a", "g"), example("b", "g"), example("c", "h")];
    expect(assignRfdtSplits(rows)).toEqual(
      assignRfdtSplits([...rows].reverse()),
    );
    expect(assignRfdtSplits(rows).size).toBe(2);
  });
  it("rejects conflicting explicit splits and context leakage", () => {
    expect(() =>
      assignRfdtSplits([example("a", "g", "train"), example("b", "g", "test")]),
    ).toThrow(/multiple splits/);
    const duplicate = example("b", "different");
    duplicate.request.state = "Context g";
    expect(() => assignRfdtSplits([example(), duplicate])).toThrow(
      /Identical contexts/,
    );
  });
});

describe("RFDT native preparation", () => {
  it("freezes authoritative prompts, label token ids, labels, splits, and provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-rfdt-test-"));
    dirs.push(dir);
    const input = join(dir, "input.jsonl"),
      run = join(dir, "run");
    await writeFile(
      input,
      [
        example("train", "a", "train"),
        example("validation", "b", "validation"),
        example("test", "c", "test"),
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    let disposed = false;
    const backend: InferenceAdapter = {
      warmup: async () => {},
      compile: async (plan: Plan) =>
        plan.questions.map((q) => ({
          branch_id: q.branch_id,
          rendered: `<bos>${plan.template_version}:${q.question_id}`,
          tokens: [2, 11, 12],
          token_ids: Object.fromEntries(
            q.output_labels.map((label, i) => [label, 20 + i]),
          ),
        })),
      evaluate: async () => {
        throw new Error("must not infer during preparation");
      },
      dispose: async () => {
        disposed = true;
      },
    };
    const manifest = await prepareRfdt(input, {
      outputDir: run,
      backend,
      config: configFromEnv({}),
      templateVersion: "v2",
    });
    expect(manifest.status).toBe("prepared");
    expect(manifest.prepared.branches).toEqual({
      train: 3,
      validation: 3,
      test: 3,
    });
    const rows = (await readFile(manifest.prepared.files.train, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({
      prompt: "<bos>v2:route",
      prompt_token_ids: [2, 11, 12],
      allowed_token_ids: [20, 21],
      target_probabilities: [1, 0],
      template_version: "v2",
      target_provenance: { route: { source: "supplied" } },
    });
    expect(disposed).toBe(false);
    await expect(
      prepareRfdt(input, { outputDir: run, backend }),
    ).rejects.toThrow(/already has a manifest/);
  });
  it("rejects prompts above the training limit instead of truncating", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-rfdt-test-"));
    dirs.push(dir);
    const input = join(dir, "input.jsonl");
    await writeFile(input, JSON.stringify(example()) + "\n");
    const backend: InferenceAdapter = {
      warmup: async () => {},
      compile: async (plan: Plan) =>
        plan.questions.map((q) => ({
          branch_id: q.branch_id,
          rendered: "x",
          tokens: Array(2049).fill(2),
          token_ids: {},
        })),
      evaluate: async () => {
        throw new Error("not executed");
      },
      dispose: async () => {},
    };
    await expect(
      prepareRfdt(input, { outputDir: join(dir, "run"), backend }),
    ).rejects.toThrow(/truncation is forbidden/);
  });
});
