import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { NativeBackend, type InferenceAdapter } from "../src/backend.js";
import type { Plan } from "../src/core.js";
import { canonical } from "../src/core.js";
import {
  GUARDRAIL_REQUIRED_FAMILIES,
  freezeGuardrailCandidate,
  qualifyGuardrail,
  verifyGuardrailQualification,
  type GuardrailEvaluationRecord,
  type GuardrailInventoryRecord,
  type GuardrailQualification,
} from "../src/guardrail-evaluation.js";
import {
  guardrailConfig,
  registerGuardrailProvider,
} from "../src/guardrail-extension.js";
import {
  GUARDRAIL_PROTOCOL_SHA256,
  GUARDRAIL_PROVIDER_EVENT,
  type GuardrailRiskProvider,
} from "../src/guardrail.js";
import { hashArtifact, verifyArtifact } from "../src/models.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock("../src/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/models.js")>();
  return {
    ...actual,
    verifyArtifact: vi.fn(),
    // Hash the actual native binary on CPU; model weights never load in these tests.
    hashArtifact: vi.fn(actual.hashArtifact),
  };
});

const modelSha256 = "a".repeat(64);
const baselineSourceSha256 = "c".repeat(64);
const nativeBinary = guardrailConfig({}).binary;
const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const shaBytes = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const verified = vi.mocked(verifyArtifact);
const hashed = vi.mocked(hashArtifact);
const directories: string[] = [];
const extensions: ReturnType<typeof registerGuardrailProvider>[] = [];
let nativeBinarySha256: string;

beforeEach(async () => {
  verified.mockReset();
  verified.mockResolvedValue({
    id: "google/gemma-3-1b-it",
    sha256: modelSha256,
  } as Awaited<ReturnType<typeof verifyArtifact>>);
  hashed.mockClear();
  vi.mocked(readFile).mockClear();
  nativeBinarySha256 = createHash("sha256")
    .update(await readFile(nativeBinary))
    .digest("hex");
});
afterEach(async () => {
  await Promise.all(
    extensions.splice(0).map((extension) => extension.dispose()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function rows(split: "validation" | "test"): GuardrailEvaluationRecord[] {
  return GUARDRAIL_REQUIRED_FAMILIES.flatMap((family) =>
    [false, true].map((risky) => {
      const actual = risky
        ? family === "files"
          ? "block"
          : "confirm"
        : "allow";
      const inputSha256 = sha(`${split}-${family}-${risky}`);
      return {
        id: `${split}-${family}-${risky}`,
        groupId: `${split}-${family}-${risky}`,
        family,
        expected: actual,
        baseline: actual,
        actual,
        modelEligible: family !== "files",
        modelAnswered: family !== "files",
        policyFloor: family === "files",
        inputSha256,
        elapsedMs: 120,
        evidence:
          family === "files"
            ? { source: "exact_policy", actual, elapsedMs: 120 }
            : {
                source: "jev",
                actual,
                prediction: risky ? "confirm" : "allow",
                inputSha256,
                modelSha256,
                protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
                allowScore: risky ? 0.01 : 0.999,
                elapsedMs: 120,
              },
      };
    }),
  );
}

function passingReport(
  binarySha256 = nativeBinarySha256,
  baselineSha256 = baselineSourceSha256,
): GuardrailQualification {
  // Synthetic measurements exercise receipt validation, not model effectiveness.
  const identity = {
    modelSha256,
    corpusSha256: "b".repeat(64),
    baselineSourceSha256: baselineSha256,
    bridgeProvenance: {
      exporterSha256: "e".repeat(64),
      provenanceSourceSha256: "f".repeat(64),
    },
    nativeBinarySha256: binarySha256,
    executionSurface: "sf_guardrail_bridge" as const,
  };
  const validationRows = rows("validation");
  const testRows = rows("test");
  const inventory: GuardrailInventoryRecord[] = [
    {
      id: "train-shell-original",
      groupId: "train-shell-original",
      family: "shell",
      split: "train",
      expected: "allow",
      baseline: "allow",
      policyFloor: false,
      modelEligible: true,
      inputSha256: sha("train-shell-original"),
    },
    ...(["validation", "test"] as const).flatMap((split) =>
      (split === "validation" ? validationRows : testRows).map(
        ({ actual, modelAnswered, elapsedMs, evidence, ...record }) => ({
          ...record,
          split,
          inputSha256: record.inputSha256!,
        }),
      ),
    ),
  ];
  const validation = qualifyGuardrail(validationRows, {
    ...identity,
    split: "validation",
  });
  const freeze = freezeGuardrailCandidate(
    validation,
    inventory,
    identity.bridgeProvenance,
  );
  return qualifyGuardrail(testRows, { ...identity, split: "test", freeze });
}

async function fixture(
  report: GuardrailQualification,
  suppliedWorker?: InferenceAdapter,
  qualificationPin: string | null = shaBytes(JSON.stringify(report)),
) {
  const directory = await mkdtemp(join(tmpdir(), "jev-risk-qualification-"));
  directories.push(directory);
  const qualificationFile = join(directory, "qualification.json");
  await writeFile(qualificationFile, JSON.stringify(report));
  const worker: InferenceAdapter = suppliedWorker ?? {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async () => {
      throw new Error("Model inference must not run in receipt tests");
    }),
    evaluate: vi.fn(async () => {
      throw new Error("Model inference must not run in receipt tests");
    }),
    dispose: vi.fn(async () => {}),
  };
  const commands = new Map<string, any>();
  const events = createEventBus();
  const pi: any = {
    events,
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    on: vi.fn(),
  };
  const createBackend = vi.fn(() => worker);
  const env: NodeJS.ProcessEnv = {
    JEV_GUARDRAIL_QUALIFICATION: qualificationFile,
    JEV_GUARDRAIL_ARTIFACT_REGISTRY: join(directory, "guard-artifacts.json"),
  };
  if (qualificationPin !== null)
    env.JEV_GUARDRAIL_QUALIFICATION_SHA256 = qualificationPin;
  const extension = registerGuardrailProvider(pi, {
    env,
    createBackend,
  });
  extensions.push(extension);
  const discover = () => {
    const request = { version: 1, providers: [] as GuardrailRiskProvider[] };
    events.emit(GUARDRAIL_PROVIDER_EVENT, request);
    return request.providers;
  };
  const statusCommand = () =>
    commands.get("jev-risk").handler("status", { ui: { notify: vi.fn() } });
  return {
    extension,
    worker,
    createBackend,
    discover,
    statusCommand,
    qualificationFile,
    env,
  };
}

describe("provider qualification receipt loading", () => {
  it("requires an operator SHA-256 pin when a qualification path is configured", async () => {
    const f = await fixture(passingReport(), undefined, null);
    await expect(f.extension.warmup()).rejects.toThrow(
      "requires an operator-pinned 64-character lowercase SHA-256",
    );
    expect(f.extension.provider.qualified).toBe(false);
    expect(f.worker.compile).not.toHaveBeenCalled();
    expect(f.worker.evaluate).not.toHaveBeenCalled();
  });

  it("does not treat an empty configured qualification path as an absent path", async () => {
    const f = await fixture(passingReport(), undefined, null);
    f.env.JEV_GUARDRAIL_QUALIFICATION = "";
    await expect(f.extension.warmup()).rejects.toThrow(
      "requires an operator-pinned 64-character lowercase SHA-256",
    );
    expect(f.extension.provider.qualified).toBe(false);
  });

  it("rejects a malformed operator SHA-256 pin", async () => {
    const f = await fixture(passingReport(), undefined, "not-a-sha256");
    await expect(f.extension.warmup()).rejects.toThrow(
      "requires an operator-pinned 64-character lowercase SHA-256",
    );
    expect(f.extension.provider.qualified).toBe(false);
  });

  it("rejects a changed receipt before parsing it", async () => {
    const f = await fixture(passingReport());
    await writeFile(f.qualificationFile, "not JSON");
    await expect(f.extension.warmup()).rejects.toThrow(
      "SHA-256 does not match the operator pin",
    );
    expect(f.extension.provider.qualified).toBe(false);
  });

  it("pins exact receipt bytes even when JSON formatting changes only", async () => {
    const report = passingReport();
    const f = await fixture(report);
    await writeFile(f.qualificationFile, JSON.stringify(report, null, 2));
    await expect(f.extension.warmup()).rejects.toThrow(
      "SHA-256 does not match the operator pin",
    );
    expect(f.extension.provider.qualified).toBe(false);
  });

  it("rejects a coherently rehashed forged receipt without an updated operator pin", async () => {
    const f = await fixture(passingReport());
    const forged = passingReport(nativeBinarySha256, "d".repeat(64));
    expect(
      verifyGuardrailQualification(forged, modelSha256, nativeBinarySha256)
        .qualified,
    ).toBe(true);
    await writeFile(f.qualificationFile, JSON.stringify(forged));
    await expect(f.extension.warmup()).rejects.toThrow(
      "SHA-256 does not match the operator pin",
    );
    expect(f.extension.provider.qualified).toBe(false);
  });

  it("keeps warmup unqualified when no receipt path is configured", async () => {
    const f = await fixture(passingReport(), undefined, null);
    delete f.env.JEV_GUARDRAIL_QUALIFICATION;
    await f.extension.warmup();
    expect(f.extension.provider.qualified).toBe(false);
    expect(hashed).not.toHaveBeenCalled();
    expect(f.worker.warmup).toHaveBeenCalledOnce();
  });

  it("loads sealed held-out evidence and caches its baseline identity without work during status or discovery", async () => {
    const report = passingReport();
    expect(report.qualified).toBe(true);
    const f = await fixture(report);
    expect(f.discover()).toEqual([f.extension.provider]);
    await f.statusCommand();
    expect(f.extension.status()).toMatchObject({
      state: "cold",
      qualified: false,
      modelSha256: null,
      qualificationBaselineSha256: null,
    });
    expect(verified).not.toHaveBeenCalled();
    expect(hashed).not.toHaveBeenCalled();
    expect(f.createBackend).not.toHaveBeenCalled();

    await f.extension.warmup();
    expect(f.extension.provider.qualified).toBe(true);
    expect(f.extension.provider.qualificationBaselineSha256).toBe(
      baselineSourceSha256,
    );
    expect(f.extension.status()).toMatchObject({
      modelSha256,
      qualified: true,
      qualificationBaselineSha256: baselineSourceSha256,
    });
    expect(verified).toHaveBeenCalledOnce();
    expect(hashed).toHaveBeenCalledTimes(2);
    expect(hashed.mock.calls[0][0]).toBe(nativeBinary);
    expect(f.worker.warmup).toHaveBeenCalledOnce();

    expect(f.discover()).toEqual([f.extension.provider]);
    await f.statusCommand();
    await f.extension.warmup();
    expect(verified).toHaveBeenCalledOnce();
    expect(hashed).toHaveBeenCalledTimes(2);
    expect(f.worker.compile).not.toHaveBeenCalled();
    expect(f.worker.evaluate).not.toHaveBeenCalled();
  });

  it("rejects an edited held-out outcome even when its saved qualified marker remains true", async () => {
    const report = passingReport();
    report.records.find((record) => record.expected === "confirm")!.actual =
      "allow";
    const f = await fixture(report);
    await expect(f.extension.warmup()).rejects.toThrow("measurement changed");
    expect(f.extension.provider.qualified).toBe(false);
    expect(f.extension.provider.qualificationBaselineSha256).toBeNull();
    expect(f.worker.compile).not.toHaveBeenCalled();
    expect(f.worker.evaluate).not.toHaveBeenCalled();
  });

  it("rejects a valid sealed report bound to a different native scoring binary", async () => {
    const report = passingReport("d".repeat(64));
    expect(report.qualified).toBe(true);
    const f = await fixture(report);
    await expect(f.extension.warmup()).rejects.toThrow(
      "does not match this model and protocol",
    );
    expect(f.extension.provider.qualified).toBe(false);
    expect(f.extension.provider.qualificationBaselineSha256).toBeNull();
    expect(hashed).toHaveBeenCalledTimes(2);
  });
  it("rejects a scoring binary replaced while the worker warms", async () => {
    const f = await fixture(passingReport());
    hashed.mockResolvedValueOnce({ sha256: nativeBinarySha256, size: 1 });
    hashed.mockResolvedValueOnce({ sha256: "f".repeat(64), size: 1 });
    await expect(f.extension.warmup()).rejects.toThrow(
      "scoring binary changed during worker warmup",
    );
    expect(f.extension.provider.qualified).toBe(false);
    expect(f.extension.provider.qualificationBaselineSha256).toBeNull();
  });

  it("rejects a valid report when the verified model artifact changed", async () => {
    const report = passingReport();
    const f = await fixture(report);
    verified.mockResolvedValue({
      id: "google/gemma-3-1b-it",
      sha256: "e".repeat(64),
    } as Awaited<ReturnType<typeof verifyArtifact>>);
    await expect(f.extension.warmup()).rejects.toThrow(
      "does not match this model and protocol",
    );
    expect(f.extension.provider.modelSha256).toBeNull();
    expect(f.extension.provider.qualified).toBe(false);
    expect(f.extension.provider.qualificationBaselineSha256).toBeNull();
  });
  it("a recovered native generation cannot inherit qualification even with unchanged weights", async () => {
    const config = guardrailConfig({});
    const worker = new NativeBackend(config);
    const initial = worker.status;
    let generation = 1;
    let recoverDuringScoring = false;
    vi.spyOn(worker, "isReady", "get").mockReturnValue(true);
    vi.spyOn(worker, "warmup").mockResolvedValue();
    vi.spyOn(worker, "compile").mockImplementation(async (plan) => plan);
    vi.spyOn(worker, "evaluate").mockImplementation(async (compiled) => {
      if (recoverDuringScoring) generation++;
      return {
        logits: Object.fromEntries(
          (compiled as Plan).questions.map((branch) => [
            branch.branch_id,
            Object.fromEntries(
              branch.output_labels.map((label, index) => [
                label,
                index === 0 ? 10 : 0,
              ]),
            ),
          ]),
        ),
        input_tokens: 100,
        metrics: {},
      };
    });
    vi.spyOn(worker, "dispose").mockResolvedValue();
    vi.spyOn(worker, "status", "get").mockImplementation(() => ({
      ...initial,
      ready: true,
      state: "ready",
      generation,
      artifact: {
        id: config.modelId,
        revision: "fixture",
        sha256: modelSha256,
        size: 1,
        base_model: "google/gemma-3-1b-it",
        template_version: "v2",
      },
    }));
    const f = await fixture(passingReport(), worker);
    const input = {
      version: 2 as const,
      toolName: "bash",
      input: { command: "git status" },
      facts: {},
    };
    await f.extension.warmup();
    expect(f.extension.provider.qualified).toBe(true);
    expect(hashed).toHaveBeenCalledTimes(2);
    recoverDuringScoring = true;
    await expect(f.extension.provider.evaluate(input)).rejects.toThrow(
      "worker generation changed",
    );
    expect(f.extension.provider.qualified).toBe(false);
    expect(f.extension.provider.qualificationBaselineSha256).toBeNull();
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(hashed).toHaveBeenCalledTimes(2);
    recoverDuringScoring = false;
    await f.extension.warmup();
    expect(hashed).toHaveBeenCalledTimes(4);
    expect(f.extension.provider.qualified).toBe(true);
    expect((await f.extension.provider.evaluate(input)).action).toBe("allow");
  });

  it("retires a ready worker after failed qualification before a replacement binary can qualify", async () => {
    const config = guardrailConfig({});
    let activeBinarySha256 = nativeBinarySha256;
    const loadedBinaries: string[] = [];
    function worker() {
      const native = new NativeBackend(config);
      const initial = native.status;
      let ready = false;
      let disposed = false;
      vi.spyOn(native, "isReady", "get").mockImplementation(() => ready);
      vi.spyOn(native, "warmup").mockImplementation(async () => {
        if (disposed) throw new Error("Disposed worker must not be reused");
        if (ready) return;
        loadedBinaries.push(activeBinarySha256);
        ready = true;
      });
      vi.spyOn(native, "dispose").mockImplementation(async () => {
        disposed = true;
        ready = false;
      });
      vi.spyOn(native, "compile").mockRejectedValue(
        new Error("No model inference in this test"),
      );
      vi.spyOn(native, "evaluate").mockRejectedValue(
        new Error("No model inference in this test"),
      );
      vi.spyOn(native, "status", "get").mockImplementation(() => ({
        ...initial,
        ready,
        state: ready ? "ready" : "disposed",
        generation: ready ? 1 : null,
        artifact: {
          id: config.modelId,
          revision: "fixture",
          sha256: modelSha256,
          size: 1,
          base_model: "google/gemma-3-1b-it",
          template_version: "v2",
        },
      }));
      return native;
    }
    const original = worker(),
      replacement = worker();
    const invalid = passingReport();
    invalid.records.find((row) => row.expected === "confirm")!.actual = "allow";
    const f = await fixture(invalid, original);
    f.createBackend
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(replacement);
    const replacementSha256 = "e".repeat(64);
    for (const sha256 of [
      nativeBinarySha256,
      nativeBinarySha256,
      replacementSha256,
      replacementSha256,
    ])
      hashed.mockResolvedValueOnce({ sha256, size: 1 });

    await expect(f.extension.warmup()).rejects.toThrow("measurement changed");
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(f.extension.status()).toMatchObject({
      state: "cold",
      modelSha256: null,
      qualified: false,
    });
    activeBinarySha256 = replacementSha256;
    const replacementReport = JSON.stringify(passingReport(replacementSha256));
    await writeFile(f.qualificationFile, replacementReport);
    f.env.JEV_GUARDRAIL_QUALIFICATION_SHA256 = shaBytes(replacementReport);
    await f.extension.warmup();

    expect(f.createBackend).toHaveBeenCalledTimes(2);
    expect(original.warmup).toHaveBeenCalledOnce();
    expect(replacement.warmup).toHaveBeenCalledOnce();
    expect(loadedBinaries).toEqual([nativeBinarySha256, replacementSha256]);
    expect(f.extension.provider.qualified).toBe(true);
    for (const native of [original, replacement]) {
      expect(native.compile).not.toHaveBeenCalled();
      expect(native.evaluate).not.toHaveBeenCalled();
    }
  });

  it.each(["materialized", "sparse"])(
    "rejects a real oversized %s receipt before parsing or an unbounded read",
    async (kind) => {
      const f = await fixture(passingReport());
      const size = 4 * 1024 * 1024 + 1;
      if (kind === "materialized")
        await writeFile(f.qualificationFile, Buffer.alloc(size, "#"));
      else {
        const handle = await open(f.qualificationFile, "r+");
        try {
          await handle.truncate(size);
        } finally {
          await handle.close();
        }
      }
      await expect(f.extension.warmup()).rejects.toThrow(
        "qualification exceeds 4 MiB",
      );
      expect(
        vi
          .mocked(readFile)
          .mock.calls.filter(([path]) => path === f.qualificationFile),
      ).toHaveLength(0);
      expect(f.worker.dispose).toHaveBeenCalledOnce();
      expect(f.extension.status()).toMatchObject({
        state: "cold",
        modelSha256: null,
        qualified: false,
      });
      expect(f.worker.compile).not.toHaveBeenCalled();
      expect(f.worker.evaluate).not.toHaveBeenCalled();
    },
  );

  it("rejects a qualification directory and retires its worker", async () => {
    const f = await fixture(passingReport());
    await rm(f.qualificationFile);
    await mkdir(f.qualificationFile);
    await expect(f.extension.warmup()).rejects.toThrow(
      "qualification must be a regular file",
    );
    expect(f.worker.dispose).toHaveBeenCalledOnce();
    expect(f.extension.provider.modelSha256).toBeNull();
  });
});
