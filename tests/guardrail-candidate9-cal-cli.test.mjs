import { strict as assert } from "node:assert";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSameScoringIdentity,
  capturePinnedFileIdentities,
  loadCandidate9Calibration,
  verifyInferenceFormat,
  verifyQuantizerRuntime,
} from "../scripts/guardrail-candidate9-cal-cli.mjs";

test("C9 scorer rejects source or artifact replacement during a long scoring run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c9-cal-identity-"));
  try {
    const source = join(dir, "source.json");
    const model = join(dir, "model.gguf");
    await writeFile(source, "frozen source");
    await writeFile(model, "frozen model");
    const paths = { source, model };
    const before = await capturePinnedFileIdentities(paths);
    assert.doesNotThrow(() => assertSameScoringIdentity(before, before));
    await writeFile(model, "replacement model");
    const after = await capturePinnedFileIdentities(paths);
    assert.throws(
      () => assertSameScoringIdentity(before, after),
      /source, model, native scorer, or host changed during CAL scoring/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C9 Q8 derivation binds every adjacent payload and loader alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c9-quantizer-runtime-"));
  try {
    const libraries = {};
    for (let index = 0; index < 8; index++) {
      const name = `lib${index}.dylib`;
      const path = join(dir, name);
      await writeFile(path, `library-${index}`);
      libraries[name] = (
        await capturePinnedFileIdentities({ library: path })
      ).library;
    }
    const alias = "libalias.dylib";
    await symlink("lib0.dylib", join(dir, alias));
    const binary = join(dir, "llama-quantize");
    const links = { [alias]: "lib0.dylib" };
    await verifyQuantizerRuntime(binary, libraries, links);
    await rm(join(dir, alias));
    await symlink("lib1.dylib", join(dir, alias));
    await assert.rejects(
      verifyQuantizerRuntime(binary, libraries, links),
      /source, model, native scorer, or host changed during CAL scoring/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C9 native scorer cannot load TRAIN-CAL before the exact admission pin is committed", async () => {
  await assert.rejects(
    loadCandidate9Calibration({
      admissionSha256: "a".repeat(64),
      arm: "A",
      admission: "/nonexistent/admission.json",
      fit: "/nonexistent/fit.jsonl",
      cal: "/nonexistent/cal.jsonl",
      pairs: "/nonexistent/pairs.json",
      families: "/nonexistent/families.json",
      objectivePlan: "/nonexistent/objective.json",
      fitPlan: "/nonexistent/fit-plan.json",
      run: "/nonexistent/run",
      sfPi: "/nonexistent/sf-pi",
    }),
    /pinned admission and absolute TRAIN-only paths are required/,
  );
});

test("C9 scorer requires explicit F16 or separately pinned Q8_0 format", async () => {
  const artifact = {
    id: "jev/c9-a",
    sha256: "b".repeat(64),
    training_run: "run-a",
    file: "/tmp/c9-a-f16.gguf",
  };
  assert.deepEqual(
    await verifyInferenceFormat({ artifactFormat: "f16" }, artifact, artifact),
    { format: "f16", artifactSha256: artifact.sha256 },
  );
  await assert.rejects(
    verifyInferenceFormat(
      { artifactFormat: "f16" },
      { ...artifact, sha256: "c".repeat(64) },
      artifact,
    ),
    /F16 registry differs/,
  );
  await assert.rejects(
    verifyInferenceFormat({ artifactFormat: "q8_0" }, artifact, artifact),
    /Q8_0 requires an exact pinned quantization manifest/,
  );
  await assert.rejects(
    verifyInferenceFormat({ artifactFormat: "unknown" }, artifact, artifact),
    /explicit --artifact-format/,
  );
});
