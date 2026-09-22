import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { verifyC9Q8Artifact } from "../scripts/guardrail-candidate9-artifact-provenance.mjs";
import { fixture, save, sha } from "./helpers/c9-artifact-fixture.mjs";

async function withFixture(action, arm = "B") {
  const inputs = await fixture(arm);
  try {
    await action(inputs);
  } finally {
    await rm(inputs.runDirectory, { recursive: true, force: true });
  }
}

test("C9 artifact verifier binds actual F16, Q8, run, FIT, and scorer bytes for both arms", async () => {
  for (const arm of ["A", "B"])
    await withFixture(async (inputs) => {
      const proof = await verifyC9Q8Artifact(inputs);
      assert.equal(proof.arm, arm);
      assert.equal(proof.modelId, inputs.expected.modelId);
      assert.equal(proof.modelSha256, inputs.modelSha256);
      assert.equal(proof.registrySha256, inputs.expected.registrySha256);
    }, arm);
});

test("C9 artifact verifier rejects changed F16, Q8, native, or scorer bytes", async () => {
  for (const kind of [
    "f16Model",
    "q8Model",
    "nativeBinary",
    "calScorerCli",
    "calScorerCore",
  ])
    await withFixture(async (inputs) => {
      await writeFile(inputs.paths[kind], "GGUFchanged");
      await assert.rejects(verifyC9Q8Artifact(inputs), /SHA-256|model bytes/);
    });
});

test("C9 artifact verifier rejects a forged scorer with a self-consistent score hash", async () => {
  await withFixture(async (inputs) => {
    const forged = Buffer.from("// forged synthetic CAL scorer\n");
    await writeFile(inputs.paths.calScorerCli, forged);
    inputs.expected.calScorerCliSha256 = sha(forged);
    await assert.rejects(
      verifyC9Q8Artifact(inputs),
      /pre-CAL frozen evaluator source/,
    );
  });
});

test("C9 artifact verifier rejects quantizer settings even when the manifest hash is repinned", async () => {
  for (const [field, changed] of [
    ["sourceRevision", "0".repeat(40)],
    ["binarySha256", "0".repeat(64)],
    ["leaveOutputTensorUnquantized", false],
  ])
    await withFixture(async (inputs) => {
      const value = JSON.parse(await readFile(inputs.files.quantization));
      value.quantizer[field] = changed;
      inputs.expected.quantizationManifestSha256 = await save(
        inputs.files.quantization,
        value,
      );
      await assert.rejects(verifyC9Q8Artifact(inputs), /Q8 quantizer/);
    });
});

test("C9 artifact verifier rejects VALID branches and schedule changes after repinning the run", async () => {
  for (const mutate of [
    (run) => {
      run.prepared.branches.validation = 1;
    },
    (run) => {
      run.training.steps = 512;
    },
  ])
    await withFixture(async (inputs) => {
      const run = JSON.parse(await readFile(inputs.files.run));
      mutate(run);
      inputs.expected.runManifestSha256 = await save(inputs.files.run, run);
      await assert.rejects(verifyC9Q8Artifact(inputs), /FIT-only|schedule/);
    });
});

test("C9 artifact verifier rejects a nonempty prepared VALID file without reading its contents", async () => {
  await withFixture(async (inputs) => {
    await writeFile(join(inputs.runDirectory, "validation.jsonl"), "synthetic");
    await assert.rejects(
      verifyC9Q8Artifact(inputs),
      /prepared branch is nonempty/,
    );
  });
});

test("C9 artifact verifier rejects changed FIT admission, family, and objective pins", async () => {
  for (const mutate of [
    (fit) => {
      fit.source.admissionSha256 = "0".repeat(64);
    },
    (fit) => {
      fit.source.familiesSha256 = "0".repeat(64);
    },
    (fit) => {
      fit.source.objectiveSha256 = "0".repeat(64);
    },
    (fit) => {
      fit.baseGguf.sha256 = "0".repeat(64);
    },
    (fit) => {
      fit.checkpoint = "/synthetic/unapproved-model";
    },
  ])
    await withFixture(async (inputs) => {
      const fit = JSON.parse(await readFile(inputs.files.fit));
      mutate(fit);
      inputs.expected.fitPlanSha256 = await save(inputs.files.fit, fit);
      await assert.rejects(
        verifyC9Q8Artifact(inputs),
        /FIT plan source pins|RFDT training used another schedule/,
      );
    });
});

test("C9 artifact verifier rejects a Q8 registry model ID mismatch despite matching hashes", async () => {
  await withFixture(async (inputs) => {
    const registry = JSON.parse(await readFile(inputs.files.registry));
    registry.artifacts[0].id = "jev/other-q8_0";
    inputs.expected.registrySha256 = await save(
      inputs.files.registry,
      registry,
    );
    const quantization = JSON.parse(await readFile(inputs.files.quantization));
    quantization.output.registrySha256 = inputs.expected.registrySha256;
    inputs.expected.quantizationManifestSha256 = await save(
      inputs.files.quantization,
      quantization,
    );
    await assert.rejects(verifyC9Q8Artifact(inputs), /Q8 registry descriptor/);
  });
});
