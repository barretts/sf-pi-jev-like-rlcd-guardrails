import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  AGENT_MODEL_ID,
  approveTrainedArtifact,
  approvedModels,
  fetchApprovedFile,
  fetchApprovedModel,
  modelDescriptor,
  verifyArtifact,
  verifyTrainedArtifactExport,
  type ModelFile,
} from "../src/models.js";
import { rfdtFixture } from "./rfdt-fixture.js";
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "jev-model-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
function fixture(bytes: Buffer): ModelFile {
  return {
    repository: "google/gemma-fixture",
    revision: "a".repeat(40),
    file: "gemma-fixture.gguf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
it("keeps roles separate and Google lineage explicit", async () => {
  const models = await approvedModels();
  expect(models.map((m) => [m.id, m.roles])).toEqual([
    ["google/gemma-3-1b-it", ["classifier"]],
    ["google/gemma-3-4b-it", ["classifier"]],
    [AGENT_MODEL_ID, ["agent", "teacher"]],
  ]);
  expect(models.every((m) => m.base_model.startsWith("google/gemma-"))).toBe(
    true,
  );
  expect((await modelDescriptor(AGENT_MODEL_ID)).chat_template?.revision).toBe(
    "842da3794eaa0b77d5f08bae87a17459d91ff475",
  );
  await expect(modelDescriptor("unapproved/model")).rejects.toThrow(
    "Unapproved model",
  );
});
it.each(["google/gemma-3-1b-it", "google/gemma-3-4b-it"])(
  "requires explicit Gemma terms before transport for %s",
  async (model) => {
    await expect(fetchApprovedModel(model)).rejects.toThrow(
      "explicitly accept",
    );
  },
);
it("reuses verified bytes without a network call", async () => {
  const directoryPath = await directory(),
    bytes = Buffer.from("GGUFfixture");
  const descriptor = fixture(bytes),
    file = join(directoryPath, descriptor.file);
  await writeFile(file, bytes);
  const result = await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    fetch: async () => {
      throw new Error("Unexpected transport");
    },
  });
  expect(result).toBe(file);
});
it("checks size and digest before atomic replacement and removes its part", async () => {
  const directoryPath = await directory(),
    bytes = Buffer.from("GGUFfixture"),
    descriptor = fixture(bytes),
    file = join(directoryPath, descriptor.file);
  await writeFile(file, "previous artifact");
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      fetch: async () => new Response("corrupt"),
    }),
  ).rejects.toThrow("checksum mismatch");
  expect(await readFile(file, "utf8")).toBe("previous artifact");
  expect(await readdir(directoryPath)).toEqual([descriptor.file]);
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    fetch: async () => new Response(bytes),
  });
  expect(await readFile(file)).toEqual(bytes);
});
it("uses distinct parts for concurrent callers", async () => {
  const directoryPath = await directory(),
    bytes = Buffer.from("GGUFfixture"),
    descriptor = fixture(bytes);
  await Promise.all(
    [1, 2].map(() =>
      fetchApprovedFile(descriptor, {
        directory: directoryPath,
        fetch: async () => new Response(bytes),
      }),
    ),
  );
  expect(await readdir(directoryPath)).toEqual([descriptor.file]);
});
it("rejects oversized bodies and an unhonored range", async () => {
  const directoryPath = await directory(),
    bytes = Buffer.from("GGUFfixture"),
    descriptor = fixture(bytes);
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      fetch: async () => new Response(Buffer.alloc(bytes.length + 1)),
    }),
  ).rejects.toThrow("exceeds approved size");
  await expect(
    fetchApprovedFile(
      { ...descriptor, size: 129 * 1024 * 1024 },
      { directory: directoryPath, fetch: async () => new Response(bytes) },
    ),
  ).rejects.toThrow("exact approved byte range");
  expect(await readdir(directoryPath)).toEqual([]);
});
it("bounds a stalled transport and cleans its own part", async () => {
  const directoryPath = await directory(),
    descriptor = fixture(Buffer.from("GGUFfixture"));
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      timeoutMs: 50,
      idleTimeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          ),
        ),
    }),
  ).rejects.toThrow(/deadline|stalled/);
  expect(await readdir(directoryPath)).toEqual([]);
});
it("retries an interrupted range without repeating completed ranges", async () => {
  const directoryPath = await directory();
  const bytes = Buffer.alloc(128 * 1024 * 1024 + 1);
  bytes.write("GGUF");
  const descriptor = fixture(bytes),
    calls = new Map<number, number>();
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 2,
    fetch: async (_input, init) => {
      const range = new Headers(init!.headers)
        .get("Range")!
        .match(/bytes=(\d+)-(\d+)/)!;
      const start = Number(range[1]),
        end = Number(range[2]);
      calls.set(start, (calls.get(start) ?? 0) + 1);
      if (start === 0 && calls.get(start) === 1)
        throw new TypeError("Interrupted fixture transport");
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    },
  });
  expect(calls.get(0)).toBe(2);
  expect(calls.get(64 * 1024 * 1024)).toBe(1);
  expect(
    (await readFile(join(directoryPath, descriptor.file))).equals(bytes),
  ).toBe(true);
});
async function trainingFixture() {
  const fixture = await rfdtFixture(await directory());
  return { ...fixture, manifest: fixture.artifact };
}
it("approves exported Google run provenance only with matching native acceptance and verifies the classifier role", async () => {
  const { manifest, registryPath } = await trainingFixture();
  await expect(
    verifyArtifact(manifest.file, "classifier", manifest.id, { registryPath }),
  ).rejects.toThrow("Unapproved model artifact");
  const approved = await approveTrainedArtifact(manifest, { registryPath });
  expect(approved.template_version).toBe("v2");
  expect(
    (
      await verifyArtifact(manifest.file, "classifier", manifest.id, {
        registryPath,
      })
    ).training_run,
  ).toBe(manifest.training_run);
  await expect(
    verifyArtifact(manifest.file, "teacher", manifest.id, { registryPath }),
  ).rejects.toThrow("Unapproved model artifact");
});
it("rejects wrong lineage, fabricated run identity, and post-export mutations", async () => {
  const { manifest, registryPath } = await trainingFixture();
  await expect(
    approveTrainedArtifact(
      { ...manifest, base_model: "other/gemma" },
      { registryPath },
    ),
  ).rejects.toThrow("pinned Google Gemma lineage");
  await expect(
    approveTrainedArtifact(
      { ...manifest, training_run: "other-run" },
      { registryPath },
    ),
  ).rejects.toThrow("provenance");
  await writeFile(manifest.file, "GGUFchanged");
  await expect(
    approveTrainedArtifact(manifest, { registryPath }),
  ).rejects.toThrow("checksum mismatch");
});

it.each(["missing", "mlx_only", "no_validation"])(
  "rejects direct approval with %s native acceptance",
  async (state) => {
    const fixture = await trainingFixture();
    if (state === "missing") fixture.run.evaluation = {};
    else if (state === "mlx_only")
      fixture.run.evaluation = {
        validation: {
          artifact: "mlx_adapter",
          summary: { gates: { passed: true } },
        },
      };
    else delete fixture.run.evaluation!.native_validation;
    await fixture.writeRun();
    await expect(
      approveTrainedArtifact(fixture.manifest, {
        registryPath: fixture.registryPath,
      }),
    ).rejects.toThrow(/matching native validation evidence/);
    await expect(readFile(fixture.registryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("recomputes quality from frozen targets and predictions instead of copied passing scores", async () => {
  const fixture = await trainingFixture();
  const answer = fixture.reports.test!.results[0].answers[0];
  if (answer.prediction.type !== "choice")
    throw new Error("Expected choice fixture");
  answer.prediction.choice = "product";
  // The copied report and manifest summaries, and answer.correct, still say passed.
  expect(answer.correct).toBe(true);
  expect(fixture.reports.test!.summary.gates.passed).toBe(true);
  await fixture.writeReport("test");
  await expect(
    approveTrainedArtifact(fixture.manifest, {
      registryPath: fixture.registryPath,
    }),
  ).rejects.toThrow(/quality gates or derived scores/);
});

it.each([
  [
    "split",
    (report: any) => {
      report.splits = ["validation"];
    },
  ],
  [
    "template",
    (report: any) => {
      report.template_version = "v1";
    },
  ],
  [
    "dataset",
    (report: any) => {
      report.dataset_sha256 = "0".repeat(64);
    },
  ],
  [
    "prompts",
    (report: any) => {
      report.prompt_manifest_sha256 = "0".repeat(64);
    },
  ],
  [
    "run",
    (report: any) => {
      report.rfdt.training_run = "other-run";
    },
  ],
  [
    "artifact",
    (report: any) => {
      report.results[0].metadata.artifact.sha256 = "0".repeat(64);
    },
  ],
  [
    "coverage",
    (report: any) => {
      report.results = [];
    },
  ],
  [
    "targets",
    (report: any) => {
      report.results[0].answers[0].target.answer = "product";
    },
  ],
  [
    "derived scores",
    (report: any) => {
      report.results.find(
        (result: any) => result.answers[0].type === "score",
      ).answers[0].normalized_absolute_error = 0.01;
    },
  ],
  [
    "tiny custom corpus",
    (report: any) => {
      report.results = report.results.slice(0, 4);
      report.dataset_sha256 = "0".repeat(64);
    },
  ],
] as const)(
  "rejects a rehashed native report with mismatched %s",
  async (_name, mutate) => {
    const fixture = await trainingFixture();
    mutate(fixture.reports.test!);
    await fixture.writeReport("test");
    await expect(
      approveTrainedArtifact(fixture.manifest, {
        registryPath: fixture.registryPath,
      }),
    ).rejects.toThrow(/Native RFDT acceptance/);
  },
);

it.each(["report", "dataset", "prompts"])(
  "rejects a post-freeze %s mutation",
  async (target) => {
    const fixture = await trainingFixture();
    const file =
      target === "report"
        ? (fixture.run.evaluation!.native_test as any).file
        : target === "dataset"
          ? fixture.run.prepared.dataset_file!
          : fixture.run.prepared.files.train;
    await writeFile(file, (await readFile(file, "utf8")) + "\n");
    await expect(
      approveTrainedArtifact(fixture.manifest, {
        registryPath: fixture.registryPath,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  },
);

it.each([
  ["official model spoof", { id: "google/gemma-3-1b-it" }],
  ["agent identity spoof", { id: AGENT_MODEL_ID }],
  ["teacher role escalation", { roles: ["classifier", "teacher"] }],
  ["agent role escalation", { roles: ["agent"] }],
  ["unapproved lineage", { base_model: "google/gemma-other" }],
  ["unapproved revision", { revision: "a".repeat(40) }],
  ["missing template", { template_version: undefined }],
  ["missing run", { training_run: undefined }],
  ["numeric run", { training_run: 1 }],
  ["relative file", { file: "trained.gguf" }],
  ["malformed digest", { sha256: "a" }],
  ["invalid size", { size: 0 }],
] as const)(
  "rejects malformed local registry entries: %s",
  async (_name, change) => {
    const fixture = await trainingFixture();
    const descriptor = await verifyTrainedArtifactExport(fixture.manifest);
    await writeFile(
      fixture.registryPath,
      JSON.stringify({ version: 1, artifacts: [{ ...descriptor, ...change }] }),
    );
    await expect(
      verifyArtifact(fixture.manifest.file, "classifier", undefined, {
        registryPath: fixture.registryPath,
      }),
    ).rejects.toThrow(/Invalid local artifact/);
  },
);
