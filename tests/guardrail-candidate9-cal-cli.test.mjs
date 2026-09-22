import { strict as assert } from "node:assert";
import test from "node:test";
import {
  loadCandidate9Calibration,
  verifyInferenceFormat,
} from "../scripts/guardrail-candidate9-cal-cli.mjs";

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
