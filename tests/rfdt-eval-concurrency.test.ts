import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Classifier, configFromEnv } from "../src/backend.js";
import { evaluateRfdt } from "../src/rfdt.js";
import { rfdtFixture } from "./rfdt-fixture.js";

const lockHook = vi.hoisted(() => ({
  run: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith("native-evaluation.lock") && lockHook.run) {
        const hook = lockHook.run;
        lockHook.run = undefined;
        await hook();
      }
      return handle;
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  lockHook.run = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(nativeEvidence = false) {
  const directory = await mkdtemp(join(tmpdir(), "jev-rfdt-eval-lock-"));
  directories.push(directory);
  return rfdtFixture(directory, nativeEvidence);
}

async function expectTransientCleanup(directory: string) {
  const files = await readdir(directory);
  expect(files).not.toContain("native-evaluation.lock");
  expect(files.filter((file) => file.startsWith("candidate-"))).toEqual([]);
}

describe("RFDT native evaluation serialization without model weights", () => {
  it("blocks both evaluation splits while validation runs", async () => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    const classify = vi
      .spyOn(Classifier.prototype, "classify")
      .mockImplementation(async (request) => {
        entered.resolve();
        await release.promise;
        return f.response(request as any);
      });
    vi.spyOn(Classifier.prototype, "dispose").mockResolvedValue();
    const first = evaluateRfdt(f.run.directory, {
      split: "validation",
      config: configFromEnv({}),
    });
    await entered.promise;
    try {
      for (const split of ["validation", "test"] as const) {
        await expect(evaluateRfdt(f.run.directory, { split })).rejects.toThrow(
          /busy.*already been claimed/,
        );
      }
      expect(classify).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect((await first).summary).toMatchObject({
      records: 60,
      gates: { passed: true },
    });
    await expectTransientCleanup(f.run.directory);
  });

  it("holds the lock until classifier disposal finishes", async () => {
    const f = await fixture(),
      disposing = deferred(),
      release = deferred();
    vi.spyOn(Classifier.prototype, "classify").mockImplementation(
      async (request) => f.response(request as any),
    );
    vi.spyOn(Classifier.prototype, "dispose").mockImplementation(async () => {
      disposing.resolve();
      await release.promise;
    });
    const first = evaluateRfdt(f.run.directory, {
      split: "validation",
      config: configFromEnv({}),
    });
    await disposing.promise;
    try {
      expect(await readdir(f.run.directory)).toContain(
        "native-evaluation.lock",
      );
      await expect(
        evaluateRfdt(f.run.directory, { split: "validation" }),
      ).rejects.toThrow(/busy/);
      await expect(
        readFile(join(f.run.directory, "native-validation-report.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
    }
    await first;
    await expectTransientCleanup(f.run.directory);
  });

  it("rereads the manifest under the lock and preserves newer evidence", async () => {
    const f = await fixture();
    lockHook.run = async () => {
      f.run.evaluation = { preserved: { identity: "newer than initial read" } };
      await f.writeRun();
    };
    vi.spyOn(Classifier.prototype, "classify").mockImplementation(
      async (request) => f.response(request as any),
    );
    vi.spyOn(Classifier.prototype, "dispose").mockResolvedValue();
    await evaluateRfdt(f.run.directory, {
      split: "validation",
      config: configFromEnv({}),
    });
    const latest = JSON.parse(
      await readFile(join(f.run.directory, "manifest.json"), "utf8"),
    );
    expect(latest.evaluation).toMatchObject({
      preserved: { identity: "newer than initial read" },
      native_validation: { artifact_sha256: f.artifact.sha256 },
    });
    await expectTransientCleanup(f.run.directory);
  });

  it.each(["claimed", "completed"] as const)(
    "preserves selected validation after final test is %s",
    async (state) => {
      const f = await fixture(true);
      if (state === "claimed") {
        delete f.run.evaluation!.native_test;
        await f.writeRun();
        await writeFile(
          join(
            f.run.directory,
            `native-test-${f.artifact.sha256}.reservation.json`,
          ),
          "claimed\n",
        );
      }
      const validationFile = join(
          f.run.directory,
          "native-validation-report.json",
        ),
        before = await readFile(validationFile);
      const classify = vi.spyOn(Classifier.prototype, "classify");
      await expect(
        evaluateRfdt(f.run.directory, { split: "validation" }),
      ).rejects.toThrow(/already been claimed or evaluated/);
      expect(classify).not.toHaveBeenCalled();
      expect(await readFile(validationFile)).toEqual(before);
      await expectTransientCleanup(f.run.directory);
    },
  );

  it("releases transient state after cancelled test while retaining the permanent claim", async () => {
    const f = await fixture(true);
    delete f.run.evaluation!.native_test;
    await f.writeRun();
    const reason = new Error("Synthetic final test cancellation"),
      dispose = vi.spyOn(Classifier.prototype, "dispose").mockResolvedValue(),
      classify = vi.spyOn(Classifier.prototype, "classify");
    await expect(
      evaluateRfdt(f.run.directory, {
        split: "test",
        config: configFromEnv({}),
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(classify).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expectTransientCleanup(f.run.directory);
    expect(
      await readFile(
        join(
          f.run.directory,
          `native-test-${f.artifact.sha256}.reservation.json`,
        ),
        "utf8",
      ),
    ).toContain(f.artifact.sha256);
    await expect(
      evaluateRfdt(f.run.directory, { split: "validation" }),
    ).rejects.toThrow(/already been claimed/);
    await expect(
      evaluateRfdt(f.run.directory, { split: "test" }),
    ).rejects.toThrow(/already been claimed/);
    await expectTransientCleanup(f.run.directory);
  });

  it("rechecks export identity under the lock before inference", async () => {
    const f = await fixture();
    lockHook.run = async () => {
      f.run.exports!.id = "jev/replaced-export";
      await f.writeRun();
    };
    const classify = vi.spyOn(Classifier.prototype, "classify");
    await expect(
      evaluateRfdt(f.run.directory, { split: "validation" }),
    ).rejects.toThrow(/Artifact provenance/);
    expect(classify).not.toHaveBeenCalled();
    await expectTransientCleanup(f.run.directory);
  });
});
