import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceAdapter } from "../src/backend.js";
import {
  selectC9Calibration,
  type C9CalibrationInput,
} from "../src/guardrail-c9-calibration.js";
import { registerGuardrailProvider } from "../src/guardrail-extension.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../src/guardrail.js";
import { hashArtifact, verifyArtifact } from "../src/models.js";

vi.mock("../src/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models.js")>()),
  verifyArtifact: vi.fn(),
  hashArtifact: vi.fn(),
}));

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pin = (character: string) => character.repeat(64);
const modelSha256 = pin("a");
const binarySha256 = pin("b");
const hostCommit = "c".repeat(40);
const directories: string[] = [];
const extensions: ReturnType<typeof registerGuardrailProvider>[] = [];
const verified = vi.mocked(verifyArtifact);
const hashed = vi.mocked(hashArtifact);

function syntheticInput(safeScore = 0.9): C9CalibrationInput {
  const cases = [
    {
      id: "safe",
      groupId: "cal-safe",
      expected: "allow" as const,
      gate: "prepared" as const,
      inputSha256: pin("1"),
    },
    {
      id: "risk",
      groupId: "cal-risk",
      expected: "confirm" as const,
      gate: "prepared" as const,
      inputSha256: pin("2"),
    },
  ];
  const baselineReceiptJson = JSON.stringify({
    version: 1,
    purpose: "candidate9_train_cal_baseline_replay",
    baselineSha256: pin("3"),
    policySha256: pin("4"),
    calibrationCorpusSha256: pin("5"),
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    source: { hostCommit, scriptSha256: pin("6") },
    records: cases.map((item) => ({
      id: item.id,
      inputSha256: item.inputSha256,
      action: item.expected,
      gate: "model_prepared",
    })),
  });
  const hostControlsReceiptJson = JSON.stringify({
    version: 1,
    purpose: "candidate9_host_controls",
    baselineSha256: pin("3"),
    policySha256: pin("4"),
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    source: { hostCommit, scriptSha256: pin("7"), c9SourceSha256: pin("8") },
    records: [
      {
        id: "floor",
        operationSha256: pin("9"),
        baselineAction: "block",
        actualAction: "block",
        effectivePolicySha256: pin("4"),
        gate: "exact_policy_floor",
        modelCalls: 0,
      },
    ],
    counts: { rows: 1, unchanged: 1, modelCalls: 0 },
  });
  return {
    version: 1,
    purpose: "candidate9_train_calibration_only",
    arm: "A",
    modelSha256,
    nativeBinarySha256: binarySha256,
    artifactFormat: "q8_0",
    artifactManifestSha256: pin("d"),
    registrySha256: pin("e"),
    runManifestSha256: pin("f"),
    fitPlanSha256: pin("1"),
    quantizationManifestSha256: pin("2"),
    calScorerCliSha256: pin("3"),
    calScorerCoreSha256: pin("4"),
    coldInitializationMs: 100,
    coldInitializationBasis:
      "backend_warmup_after_source_and_artifact_verification",
    preScoreVerificationMs: 5,
    elapsedBasis:
      "direct_jev_risk_check_including_prompt_preparation_and_queue",
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    hostCommit,
    baselineSha256: pin("3"),
    policySha256: pin("4"),
    baselineReceiptSha256: digest(baselineReceiptJson),
    baselineReceiptJson,
    hostControlsReceiptSha256: digest(hostControlsReceiptJson),
    hostControlsReceiptJson,
    c9SourceSha256: pin("8"),
    admissionSha256: pin("5"),
    fitSha256: pin("6"),
    calibrationCorpusSha256: pin("5"),
    pairManifestSha256: pin("7"),
    familyManifestSha256: pin("8"),
    objectivePlanSha256: pin("9"),
    fitGroups: ["fit"],
    cases,
    records: cases.map((item) => ({
      ...item,
      modelAnswered: true,
      modelCalls: 1,
      allowScore: item.expected === "allow" ? safeScore : 0.1,
      elapsedMs: 20,
    })),
  };
}

async function fixture(raw: string, overrides: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jev-c9-provider-"));
  directories.push(directory);
  const receiptPath = join(directory, "calibration.json");
  await writeFile(receiptPath, raw);
  const worker: InferenceAdapter = {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async () => {
      throw new Error("No model call in receipt test");
    }),
    evaluate: vi.fn(async () => {
      throw new Error("No model call in receipt test");
    }),
    dispose: vi.fn(async () => {}),
  };
  const env: NodeJS.ProcessEnv = {
    JEV_GUARDRAIL_C9_CALIBRATION: receiptPath,
    JEV_GUARDRAIL_C9_CALIBRATION_SHA256: digest(raw),
    ...overrides,
  };
  const extension = registerGuardrailProvider(
    {
      events: createEventBus(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as any,
    { env, createBackend: () => worker },
  );
  extensions.push(extension);
  return { extension, worker, receiptPath };
}

beforeEach(() => {
  verified.mockReset();
  hashed.mockReset();
  verified.mockResolvedValue({
    id: "jev/c9-synthetic",
    sha256: modelSha256,
  } as Awaited<ReturnType<typeof verifyArtifact>>);
  hashed.mockResolvedValue({ sha256: binarySha256, size: 123 });
});
afterEach(async () => {
  await Promise.all(extensions.splice(0).map((item) => item.dispose()));
  await Promise.all(
    directories
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  );
});

describe("C9 TRAIN-CAL provider bridge", () => {
  it("loads a pinned selected Q8 cutoff for shadow scoring without claiming qualification", async () => {
    const receipt = selectC9Calibration(syntheticInput());
    expect(receipt.accepted).toBe(true);
    const raw = JSON.stringify(receipt) + "\n";
    const { extension, worker } = await fixture(raw, {
      SF_GUARDRAIL_JEV_MODE: "shadow",
    });
    expect(extension.status().calibration).toBe("c9_calibration_unverified");
    expect(worker.warmup).not.toHaveBeenCalled();
    await extension.warmup();
    expect(extension.provider.version).toBe(2);
    expect(extension.provider.modelSha256).toBe(modelSha256);
    expect(extension.provider.protocolSha256).toBe(
      receipt.scoringProtocolSha256,
    );
    expect(extension.provider.minimumAllowScore).toBe(
      receipt.minimumAllowScore,
    );
    expect(extension.provider.calibrationSha256).toBe(digest(raw));
    expect(extension.provider.calibrationPolicySha256).toBe(
      receipt.input.policySha256,
    );
    expect(extension.provider.calibrationBaselineSha256).toBe(
      receipt.input.baselineSha256,
    );
    expect(extension.provider.qualified).toBe(false);
    expect(extension.provider.qualificationSha256).toBeNull();
    expect(extension.status().calibration).toBe(
      "c9_train_selected_cutoff_unqualified",
    );
    expect(worker.compile).not.toHaveBeenCalled();
    expect(worker.evaluate).not.toHaveBeenCalled();
  });

  it("rejects missing or changed operator pins before a usable cutoff is exposed", async () => {
    const raw = JSON.stringify(selectC9Calibration(syntheticInput()));
    const missing = await fixture(raw, {
      JEV_GUARDRAIL_C9_CALIBRATION_SHA256: "",
    });
    await expect(missing.extension.warmup()).rejects.toThrow(
      /operator-pinned SHA-256/,
    );
    const changed = await fixture(raw, {
      JEV_GUARDRAIL_C9_CALIBRATION_SHA256: pin("0"),
    });
    await expect(changed.extension.warmup()).rejects.toThrow(
      /does not match the operator pin/,
    );
    expect(changed.extension.provider.minimumAllowScore).toBeNull();
    expect(changed.extension.provider.qualified).toBe(false);
  });

  it("rejects a coherently pinned but vetoed receipt and changed model or scorer", async () => {
    const rejected = selectC9Calibration(syntheticInput(0.2));
    expect(rejected.accepted).toBe(false);
    const veto = await fixture(JSON.stringify(rejected));
    await expect(veto.extension.warmup()).rejects.toThrow(
      /did not select a usable cutoff/,
    );
    expect(veto.extension.provider.minimumAllowScore).toBeNull();
    const selected = JSON.stringify(selectC9Calibration(syntheticInput()));
    verified.mockResolvedValueOnce({
      id: "jev/c9-other",
      sha256: pin("0"),
    } as Awaited<ReturnType<typeof verifyArtifact>>);
    const modelChanged = await fixture(selected);
    await expect(modelChanged.extension.warmup()).rejects.toThrow(
      /receipt, model, or scoring protocol changed/,
    );
    hashed.mockResolvedValueOnce({ sha256: pin("0"), size: 123 });
    hashed.mockResolvedValueOnce({ sha256: pin("0"), size: 123 });
    const binaryChanged = await fixture(selected);
    await expect(binaryChanged.extension.warmup()).rejects.toThrow(
      /receipt, model, or scoring protocol changed/,
    );
  });

  it("rejects mixed C8 or older qualification settings and stays unqualified in enforce mode", async () => {
    const raw = JSON.stringify(selectC9Calibration(syntheticInput()));
    const mixed = await fixture(raw, {
      JEV_GUARDRAIL_CALIBRATION: "/tmp/old-c8.json",
    });
    await expect(mixed.extension.warmup()).rejects.toThrow(
      /cannot inherit C7 or C8 qualification/,
    );
    const oldQualification = await fixture(raw, {
      JEV_GUARDRAIL_QUALIFICATION: "/tmp/old-c7.json",
    });
    await expect(oldQualification.extension.warmup()).rejects.toThrow(
      /cannot inherit C7 or C8 qualification/,
    );
    const enforce = await fixture(raw, { SF_GUARDRAIL_JEV_MODE: "enforce" });
    await enforce.extension.warmup();
    expect(enforce.extension.provider.qualified).toBe(false);
    expect(enforce.extension.provider.qualificationSha256).toBeNull();
  });
});
