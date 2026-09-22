import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type InferenceAdapter } from "../src/backend.js";
import { prepareRfdt, rfdtDoctor, trainRfdt } from "../src/rfdt.js";

const directories: string[] = [];
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];

function observe<T>(operation: Promise<T>) {
  const result = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  pending.push(result);
  return result;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const directory of directories) {
    const pid = Number(
      await readFile(join(directory, "pid"), "utf8").catch(() => ""),
    );
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
  await Promise.all(pending.splice(0));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakePython(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "jev-rfdt-process-"));
  directories.push(directory);
  const python = join(directory, "fake-python.mjs"),
    pidFile = join(directory, "pid"),
    eventsFile = join(directory, "events");
  await writeFile(
    python,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const record = event => appendFileSync(${JSON.stringify(eventsFile)}, event + '\\n');
const ready = () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  record('started');
};
${body}
`,
  );
  await chmod(python, 0o755);
  const waitForPid = async () => {
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number(await readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    return pid;
  };
  return { directory, python, pidFile, eventsFile, waitForPid };
}

async function preparedRun(directory: string) {
  const input = join(directory, "input.jsonl");
  await writeFile(
    input,
    JSON.stringify({
      id: "cleanup",
      group_id: "cleanup",
      split: "train",
      request: {
        model: "google/gemma-3-1b-it",
        state: "Synthetic process cleanup fixture",
        questions: [
          { id: "ready", type: "noul", instructions: "Is this ready?" },
        ],
      },
      targets: { ready: { answer: true } },
    }) + "\n",
  );
  const backend: InferenceAdapter = {
    warmup: async () => {},
    compile: async (plan) =>
      plan.questions.map((question) => ({
        branch_id: question.branch_id,
        rendered: "Synthetic tokenizer output",
        tokens: [2, 11, 12],
        token_ids: Object.fromEntries(
          question.output_labels.map((label, index) => [label, 20 + index]),
        ),
      })),
    evaluate: async () => {
      throw new Error("Process cleanup fixtures must not infer");
    },
    dispose: async () => {},
  };
  return prepareRfdt(input, {
    outputDir: join(directory, "run"),
    backend,
    config: configFromEnv({}),
  });
}

describe("RFDT subprocess cleanup without model weights", () => {
  it("kills an ignored-TERM worker before rejecting cancellation and does not replay it", async () => {
    const fake = await fakePython(`
process.on('SIGTERM', () => record('term'));
ready();
setInterval(() => {}, 1000);
`);
    const run = await preparedRun(fake.directory),
      controller = new AbortController(),
      reason = new Error("Explicit fixture cancellation");
    controllers.push(controller);
    const result = observe(
      trainRfdt(run.directory, {
        python: fake.python,
        signal: controller.signal,
      }),
    );
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    const pid = await fake.waitForPid(),
      started = Date.now();
    controller.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(alive(pid)).toBe(true);
    expect(await result).toEqual({ error: reason });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(pid)).toBe(false);
    expect(await readFile(fake.eventsFile, "utf8")).toBe("started\nterm\n");
    expect(
      JSON.parse(await readFile(join(run.directory, "manifest.json"), "utf8"))
        .status,
    ).toBe("prepared");
  });

  it("bounds cleanup after stdout overflow even when the worker ignores TERM", async () => {
    const fake = await fakePython(`
process.on('SIGTERM', () => record('term'));
ready();
process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120));
setInterval(() => {}, 1000);
`);
    const started = Date.now(),
      result = await observe(rfdtDoctor({ python: fake.python })),
      pid = await fake.waitForPid();
    expect(result).toEqual({
      error: expect.objectContaining({
        message: "RFDT process stdout exceeded the 8 MiB output limit",
      }),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(pid)).toBe(false);
    expect(await readFile(fake.eventsFile, "utf8")).toBe("started\nterm\n");
  });

  it("counts multibyte stdout in bytes and preserves overflow despite exit zero", async () => {
    const fake = await fakePython(`
process.on('SIGTERM', () => { record('term'); process.exit(0); });
ready();
process.stdout.write('é'.repeat(4 * 1024 * 1024 + 1));
setInterval(() => {}, 1000);
`);
    expect(await observe(rfdtDoctor({ python: fake.python }))).toEqual({
      error: expect.objectContaining({
        message: "RFDT process stdout exceeded the 8 MiB output limit",
      }),
    });
    expect(alive(await fake.waitForPid())).toBe(false);
  });

  it("retains only the bounded stderr tail on failure", async () => {
    const fake = await fakePython(`
ready();
process.stderr.write('DISCARDED-PREFIX' + 'x'.repeat(64 * 1024) + 'FINAL-DIAGNOSTIC');
process.exitCode = 7;
`);
    const result = await observe(rfdtDoctor({ python: fake.python }));
    expect(result).toHaveProperty("error");
    const error = (result as { error: Error }).error;
    expect(error.message).toMatch(/^RFDT process failed \(7\): /);
    expect(error.message).toMatch(/FINAL-DIAGNOSTIC$/);
    expect(error.message).not.toContain("DISCARDED-PREFIX");
    expect(Buffer.byteLength(error.message)).toBeLessThan(16_384 + 100);
    expect(alive(await fake.waitForPid())).toBe(false);
  });

  it("does not start a worker for an already aborted training request", async () => {
    const fake = await fakePython("ready(); console.log('{}');"),
      run = await preparedRun(fake.directory),
      reason = new Error("Cancelled before spawn");
    expect(
      await observe(
        trainRfdt(run.directory, {
          python: fake.python,
          signal: AbortSignal.abort(reason),
        }),
      ),
    ).toEqual({ error: reason });
    await expect(readFile(fake.pidFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects paired training before inspecting a reserved validation split", async () => {
    const fake = await fakePython("ready(); console.log('{}');"),
      run = await preparedRun(fake.directory),
      file = join(run.directory, "manifest.json"),
      manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.prepared.branches.validation = 1;
    await writeFile(file, JSON.stringify(manifest));
    await rm(run.prepared.files.validation);
    const result = await observe(
      trainRfdt(run.directory, {
        python: fake.python,
        guardrailPairsPath: join(fake.directory, "pairs.json"),
        guardrailPlanPath: join(fake.directory, "plan.json"),
      }),
    );
    expect(result).toEqual({
      error: expect.objectContaining({
        message: "Guardrail pair training requires a TRAIN-only RFDT run",
      }),
    });
    await expect(readFile(fake.pidFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lets ordinary training run longer than the cleanup grace period", async () => {
    const fake = await fakePython(`
process.on('SIGTERM', () => { record('term'); process.exit(1); });
ready();
setTimeout(() => console.log(JSON.stringify({
  adapter_changed: true,
  reload_verified: true,
  training_loss_decreased: true,
  initial_loss: 2,
  final_loss: 1,
  adapter_dir: 'synthetic'
})), 750);
`);
    const run = await preparedRun(fake.directory),
      result = await observe(trainRfdt(run.directory, { python: fake.python }));
    expect(result).toMatchObject({ value: { status: "trained" } });
    expect(await readFile(fake.eventsFile, "utf8")).toBe("started\n");
    expect(alive(await fake.waitForPid())).toBe(false);
  });

  it("reports executable spawn errors after cleanup", async () => {
    expect(
      await observe(rfdtDoctor({ python: "/jev-fixture-missing-python" })),
    ).toEqual({
      error: expect.objectContaining({ code: "ENOENT" }),
    });
  });
});
