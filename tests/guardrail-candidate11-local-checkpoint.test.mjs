import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  parseCandidate11CheckpointArgs,
  validateCandidate11CheckpointInputs,
  runCandidate11LocalCheckpoint,
} from "../scripts/guardrail-candidate11-local-checkpoint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(directory, step = 128) {
  const campaignBytes = await readFile(
    resolve(root, "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json"),
  );
  const receipt = {
    mode: "train",
    steps: step,
    checkpoint_step: step,
    qualified: false,
    source: {
      experiment: "candidate11",
      steps: step,
      campaign_steps: 1024,
      campaign: JSON.parse(campaignBytes),
      campaign_sha256: sha(campaignBytes),
    },
  };
  const source = resolve(directory, "source");
  await mkdir(resolve(source, "run"), { recursive: true });
  const bytes = JSON.stringify(receipt);
  await writeFile(resolve(source, "run/receipt.json"), bytes);
  const values = {
    run: resolve(directory, "local"),
    fit: resolve(
      root,
      "reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/fit.jsonl",
    ),
    "cuda-run": source,
    "receipt-sha256": sha(bytes),
    "base-hf": resolve(directory, "base-hf"),
    "base-gguf": resolve(directory, "base.gguf"),
    "native-binary": resolve(directory, "native"),
    python: resolve(directory, "python"),
    checkpoint: String(step),
    "model-id": "jev/c11-cpu-fixture",
  };
  return {
    receipt,
    values,
    args: Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]),
  };
}

test("C11 selected checkpoints validate with pinned admitted FIT and receipt", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "c11-local-checkpoint-"));
  try {
    for (const step of [128, 256, 512, 1024]) {
      const data = await fixture(directory, step);
      const values = parseCandidate11CheckpointArgs(data.args);
      assert.equal(
        (await validateCandidate11CheckpointInputs(values)).receipt.steps,
        step,
      );
    }
    const { args } = await fixture(directory);
    assert.throws(
      () => parseCandidate11CheckpointArgs(args.slice(0, -2)),
      /Required/,
    );
    assert.throws(
      () =>
        parseCandidate11CheckpointArgs(
          args.map((arg) => (arg === "128" ? "1" : arg)),
        ),
      /Required/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("C11 entry refuses C10, changed source, and existing output before preparation", async () => {
  for (const defect of [
    "candidate",
    "pin",
    "fit",
    "output",
    "campaign",
    "checkpoint",
  ]) {
    const directory = await mkdtemp(resolve(tmpdir(), "c11-local-checkpoint-"));
    try {
      const data = await fixture(directory);
      if (defect === "candidate")
        data.receipt.source.experiment = "candidate10";
      if (defect === "campaign")
        data.receipt.source.campaign_sha256 = "f".repeat(64);
      if (defect === "checkpoint") data.receipt.checkpoint_step = 256;
      if (["candidate", "campaign", "checkpoint"].includes(defect)) {
        const bytes = JSON.stringify(data.receipt);
        await writeFile(
          resolve(data.values["cuda-run"], "run/receipt.json"),
          bytes,
        );
        data.values["receipt-sha256"] = sha(bytes);
      }
      if (defect === "pin") data.values["receipt-sha256"] = "f".repeat(64);
      if (defect === "fit") {
        data.values.fit = resolve(directory, "changed-fit.jsonl");
        await writeFile(data.values.fit, "{}\n");
      }
      if (defect === "output") await mkdir(data.values.run);
      const args = Object.entries(data.values).flatMap(([key, value]) => [
        `--${key}`,
        value,
      ]);
      let prepared = false;
      await assert.rejects(
        runCandidate11LocalCheckpoint(args, {
          prepareRfdt: () => {
            prepared = true;
          },
        }),
      );
      assert.equal(prepared, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("mock C11 local path prepares, imports, exports and checks F16 using existing APIs", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "c11-local-checkpoint-"));
  try {
    const { args, values } = await fixture(directory, 256);
    const calls = [];
    const descriptor = {
      id: values["model-id"],
      file: resolve(values.run, "model-f16.gguf"),
      sha256: "a".repeat(64),
    };
    const result = await runCandidate11LocalCheckpoint(args, {
      configFromEnv: (environment) => {
        assert.equal(environment.JEV_MODEL_ID, "google/gemma-3-1b-it");
        return {};
      },
      prepareRfdt: async (fit, options) => {
        calls.push("prepare");
        assert.equal(fit, values.fit);
        assert.equal(options.templateVersion, "v2");
        assert.equal(options.config.maxModelLen, 2048);
        await mkdir(options.outputDir);
      },
      importCudaRfdt: async (run, options) => {
        calls.push("import");
        assert.equal(run, values.run);
        assert.equal(options.receiptSha256, values["receipt-sha256"]);
        assert.equal(options.cudaRun, values["cuda-run"]);
      },
      exportRfdt: async (run, options) => {
        calls.push("export");
        assert.equal(options.outputFile, descriptor.file);
        await writeFile(
          resolve(run, "artifact.json"),
          JSON.stringify(descriptor),
        );
        return descriptor;
      },
      verifyTrainedArtifactExport: async (artifact) => {
        calls.push("verify");
        assert.equal(artifact, descriptor);
        return artifact;
      },
      precisionCheck: async (precisionArgs) => {
        calls.push("precision");
        assert.ok(precisionArgs[0].endsWith("guardrail-cuda-export-check.mjs"));
        assert.equal(
          precisionArgs[precisionArgs.indexOf("--model-file") + 1],
          descriptor.file,
        );
        await writeFile(
          resolve(values.run, "precision-f16.json"),
          JSON.stringify({ qualified: false, ok: true }),
        );
      },
    });
    assert.deepEqual(calls, [
      "prepare",
      "import",
      "export",
      "verify",
      "precision",
    ]);
    assert.equal(result.qualified, false);
    const handoff = JSON.parse(await readFile(result.handoff));
    assert.equal(handoff.purpose, "candidate11_local_checkpoint_handoff");
    assert.equal(handoff.checkpoint, 256);
    assert.equal(handoff.model, descriptor.file);
    assert.deepEqual(JSON.parse(await readFile(handoff.registry)), {
      version: 1,
      artifacts: [descriptor],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed F16 precision retains attempt and produces no handoff", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "c11-local-checkpoint-"));
  try {
    const { args, values } = await fixture(directory);
    const artifact = {
      id: values["model-id"],
      file: resolve(values.run, "model-f16.gguf"),
      sha256: "a".repeat(64),
    };
    await assert.rejects(
      runCandidate11LocalCheckpoint(args, {
        configFromEnv: () => ({}),
        prepareRfdt: async (_, options) => mkdir(options.outputDir),
        importCudaRfdt: async () => ({}),
        exportRfdt: async () => artifact,
        verifyTrainedArtifactExport: async (value) => value,
        precisionCheck: async () => {
          throw new Error("retained precision failure");
        },
      }),
      /retained precision failure/,
    );
    await access(resolve(values.run, "f16-registry.json"));
    await assert.rejects(
      access(resolve(values.run, "local-checkpoint-handoff.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
