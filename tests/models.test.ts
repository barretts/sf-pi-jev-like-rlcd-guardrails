import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  AGENT_MODEL_ID,
  approveTrainedArtifact,
  approvedModels,
  fetchApprovedFile,
  fetchApprovedModel,
  hashArtifact,
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
const rangeSize = 64 * 1024 * 1024;
function requestedRange(init?: RequestInit) {
  const match = new Headers(init!.headers)
    .get("Range")!
    .match(/^bytes=(\d+)-(\d+)$/)!;
  return { start: Number(match[1]), end: Number(match[2]) };
}
function rangeResponse(bytes: Buffer, init?: RequestInit) {
  const { start, end } = requestedRange(init);
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
  });
}
async function interruptedDownload(directoryPath: string, bytes: Buffer) {
  const descriptor = fixture(bytes);
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      concurrency: 1,
      fetch: async (_input, init) => {
        if (requestedRange(init).start === 2 * rangeSize)
          throw new TypeError("Interrupted final range");
        return rangeResponse(bytes, init);
      },
    }),
  ).rejects.toThrow("Interrupted final range");
  const name = (await readdir(directoryPath)).find((name) =>
    name.includes(".resume.paused-"),
  )!;
  const state = join(directoryPath, name);
  return { descriptor, state };
}
it("retains completed ranges after failure and rechecks them before restart reuse", async () => {
  const directoryPath = await directory();
  const bytes = Buffer.alloc(2 * rangeSize + 1, 3);
  const unrelated = join(directoryPath, "another-download.part");
  await writeFile(unrelated, "untouched");
  const { descriptor, state } = await interruptedDownload(directoryPath, bytes);
  const journal = JSON.parse(
    await readFile(join(state, "journal.json"), "utf8"),
  );
  expect(journal.ranges.map((range: { start: number }) => range.start)).toEqual(
    [0, rangeSize],
  );
  const calls: number[] = [];
  const progress: number[] = [];
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    onProgress: (completed) => progress.push(completed),
    fetch: async (_input, init) => {
      calls.push(requestedRange(init).start);
      return rangeResponse(bytes, init);
    },
  });
  expect(calls).toEqual([2 * rangeSize]);
  expect(progress[0]).toBe(2 * rangeSize);
  expect(await hashArtifact(join(directoryPath, descriptor.file))).toEqual({
    sha256: descriptor.sha256,
    size: descriptor.size,
  });
  expect(await readFile(unrelated, "utf8")).toBe("untouched");
  expect((await readdir(directoryPath)).sort()).toEqual([
    "another-download.part",
    descriptor.file,
  ]);
});
it("refetches a saved range whose bytes no longer match its checkpoint", async () => {
  const directoryPath = await directory();
  const bytes = Buffer.alloc(2 * rangeSize + 1, 4);
  const { descriptor, state } = await interruptedDownload(directoryPath, bytes);
  const handle = await open(join(state, "artifact.part"), "r+");
  await handle.write(Buffer.from([9]), 0, 1, 0);
  await handle.close();
  const calls: number[] = [];
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    fetch: async (_input, init) => {
      calls.push(requestedRange(init).start);
      return rangeResponse(bytes, init);
    },
  });
  expect(calls).toEqual([0, 2 * rangeSize]);
  expect(
    (await hashArtifact(join(directoryPath, descriptor.file))).sha256,
  ).toBe(descriptor.sha256);
});
it("requires the full pinned digest even when modified saved bytes match a journal hash", async () => {
  const directoryPath = await directory();
  const bytes = Buffer.alloc(2 * rangeSize + 1, 5);
  const { descriptor, state } = await interruptedDownload(directoryPath, bytes);
  const destination = join(directoryPath, descriptor.file);
  await writeFile(destination, "previous artifact");
  bytes[0] = 9;
  const handle = await open(join(state, "artifact.part"), "r+");
  await handle.write(bytes.subarray(0, 1), 0, 1, 0);
  await handle.close();
  const journalPath = join(state, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.ranges[0].sha256 = createHash("sha256")
    .update(bytes.subarray(0, rangeSize))
    .digest("hex");
  await writeFile(journalPath, JSON.stringify(journal));
  const calls: number[] = [];
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      concurrency: 1,
      fetch: async (_input, init) => {
        calls.push(requestedRange(init).start);
        return rangeResponse(bytes, init);
      },
    }),
  ).rejects.toThrow("checksum mismatch");
  expect(calls).toEqual([2 * rangeSize]);
  expect(await readFile(destination, "utf8")).toBe("previous artifact");
  expect(await readdir(directoryPath)).toEqual([descriptor.file]);
});
it("preserves live ownership and recovers an exact journal only after its recorded PID exits", async () => {
  const directoryPath = await directory();
  const bytes = Buffer.alloc(2 * rangeSize + 1, 6);
  const { descriptor, state } = await interruptedDownload(directoryPath, bytes);
  const unknown = join(state, "unrelated-notes.txt");
  await writeFile(unknown, "keep unrelated state");
  let callsForUnknown = 0;
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    fetch: async (_input, init) => {
      callsForUnknown++;
      return rangeResponse(bytes, init);
    },
  });
  expect(callsForUnknown).toBe(3);
  expect(await readFile(unknown, "utf8")).toBe("keep unrelated state");
  await rm(unknown);
  await rm(join(directoryPath, descriptor.file));
  const linked = join(directoryPath, "unrelated-linked-artifact.bin");
  await link(join(state, "artifact.part"), linked);
  const linkedIdentity = await hashArtifact(linked);
  let callsForLinked = 0;
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    fetch: async (_input, init) => {
      callsForLinked++;
      return rangeResponse(bytes, init);
    },
  });
  expect(callsForLinked).toBe(3);
  expect(await hashArtifact(linked)).toEqual(linkedIdentity);
  await rm(linked);
  await rm(join(directoryPath, descriptor.file));
  const owner = JSON.parse(await readFile(join(state, "owner.json"), "utf8"));
  const liveState = state.replace(
    /paused-[a-f0-9-]{36}$/,
    `active-${process.pid}-${randomUUID()}`,
  );
  await rename(state, liveState);
  const liveOwner = { ...owner, state: "active", pid: process.pid };
  await writeFile(join(liveState, "owner.json"), JSON.stringify(liveOwner));
  const liveCalls: number[] = [];
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    fetch: async (_input, init) => {
      liveCalls.push(requestedRange(init).start);
      return rangeResponse(bytes, init);
    },
  });
  expect(liveCalls).toEqual([0, rangeSize, 2 * rangeSize]);
  expect(
    JSON.parse(await readFile(join(liveState, "owner.json"), "utf8")),
  ).toEqual(liveOwner);
  await rm(join(directoryPath, descriptor.file));
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(child.status).toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrow();
  const deadState = liveState.replace(
    /active-[1-9][0-9]*-[a-f0-9-]{36}$/,
    `active-${child.pid}-${randomUUID()}`,
  );
  await rename(liveState, deadState);
  await writeFile(
    join(deadState, "owner.json"),
    JSON.stringify({ ...liveOwner, pid: child.pid }),
  );
  const calls: number[] = [];
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    fetch: async (_input, init) => {
      calls.push(requestedRange(init).start);
      return rangeResponse(bytes, init);
    },
  });
  expect(calls).toEqual([2 * rangeSize]);
  expect(await readdir(directoryPath)).toEqual([descriptor.file]);
});
it("bounds stalled range retries and cache-busts only the immutable revision URL", async () => {
  const directoryPath = await directory();
  const bytes = Buffer.alloc(2 * rangeSize + 1, 7);
  const descriptor = fixture(bytes);
  const urls: URL[] = [];
  await fetchApprovedFile(descriptor, {
    directory: directoryPath,
    concurrency: 1,
    idleTimeoutMs: 100,
    fetch: async (input, init) => {
      urls.push(new URL(String(input)));
      if (urls.length === 1) return await new Promise<Response>(() => {});
      return rangeResponse(bytes, init);
    },
  });
  expect(urls).toHaveLength(4);
  expect(urls[0].search).toBe("");
  expect(urls[1].searchParams.get("jev_range_retry")).toMatch(
    /^[a-f0-9-]{36}$/,
  );
  expect(
    urls.every(
      (url) =>
        url.pathname ===
        `/google/gemma-fixture/resolve/${descriptor.revision}/${descriptor.file}`,
    ),
  ).toBe(true);
  expect(
    (await hashArtifact(join(directoryPath, descriptor.file))).sha256,
  ).toBe(descriptor.sha256);
});
it("settles stalled range readers even when their source cancellation never resolves", async () => {
  const directoryPath = await directory();
  const descriptor = fixture(Buffer.from("GGUFfixture"));
  descriptor.size = 2 * rangeSize + 1;
  const streams: ReadableStream<Uint8Array>[] = [];
  let calls = 0;
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      concurrency: 1,
      idleTimeoutMs: 10,
      fetch: async (_input, init) => {
        calls++;
        const { start, end } = requestedRange(init);
        const body = new ReadableStream<Uint8Array>({
          cancel: () => new Promise<void>(() => {}),
        });
        streams.push(body);
        return new Response(body, {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${descriptor.size}`,
          },
        });
      },
    }),
  ).rejects.toThrow("stalled");
  expect(calls).toBe(3);
  expect(streams.every((stream) => !stream.locked)).toBe(true);
  expect(await readdir(directoryPath)).toEqual([]);
});
it("does not retry a public range AbortError", async () => {
  const directoryPath = await directory();
  const descriptor = fixture(Buffer.from("GGUFfixture"));
  descriptor.size = 2 * rangeSize + 1;
  let calls = 0;
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      fetch: async () => {
        calls++;
        throw new DOMException("Fixture canceled", "AbortError");
      },
      concurrency: 1,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
  expect(await readdir(directoryPath)).toEqual([]);
});
it("bounds small-file transports and releases a stalled reader without waiting on cancellation", async () => {
  const directoryPath = await directory();
  const descriptor = fixture(Buffer.from("GGUFfixture"));
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      idleTimeoutMs: 10,
      fetch: async () => await new Promise<Response>(() => {}),
    }),
  ).rejects.toThrow("stalled");
  const body = new ReadableStream<Uint8Array>({
    cancel: () => new Promise<void>(() => {}),
  });
  await expect(
    fetchApprovedFile(descriptor, {
      directory: directoryPath,
      idleTimeoutMs: 10,
      fetch: async () => new Response(body),
    }),
  ).rejects.toThrow("stalled");
  expect(body.locked).toBe(false);
  expect(await readdir(directoryPath)).toEqual([]);
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
