#!/usr/bin/env node
/** Preserve C7 TRAIN and real VALID receipts without copying model weights or TEST. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputParent = resolve(repo, "reports/guardrail-risk-2026-09-21");
const source = Object.freeze({
  trainHead: "845b67913f099897241b88451bf463d1d98c6312",
  evaluatorHead: "d064f7402d9e8eebf0cc9bdb811dee7a59210976",
  manifestSha256:
    "868dac2146b72e732b07017c451f88f1066c2faea3c46300f5fba75545e76200",
  admissionSha256:
    "c2b28715646020ceb60193469d5fbb9fe34acce309e528b81c05b6537e5330de",
  preflightSha256:
    "6a6181facc00f8f1b5503f467a339079bdedffb3cd011c5376abff968c05a23b",
  sfPiHead: "bc7862b078997d2c60aa908979b5cbf59f83db80",
  sfPiRuntimeSha256:
    "6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e",
  sfPiPatchSha256:
    "b1a6e9cbaa436b803fe43b88cc4472f08e1df4261b5ce22001486ca8caeb4bae",
  evaluatorScriptSha256:
    "b3bdbd780a99133ce2406a2efa94c72534218a5a1c51e9ea95b10c0dbd0cdf5c",
  modelIds: Object.freeze({
    128: "jev/gemma-3-1b-guardrail-c7-128-v1",
    256: "jev/gemma-3-1b-guardrail-c7-256-v1",
  }),
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (reason) => {
  throw new Error(`Candidate 7 evidence: ${reason}`);
};
const inDirectory = (parent, file) => {
  const child = relative(parent, file);
  return (
    child &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
};
async function regularBytes(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${path} is not a regular file`);
  if (entry.size > 25_000_000) fail(`${path} exceeds the receipt size bound`);
  return readFile(path);
}
async function largeFileHash(path, expectedSize) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== expectedSize)
    fail(`${path} is not the expected regular model artifact`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function head(path) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path,
    encoding: "utf8",
  }).trim();
}
async function main() {
  const { values } = parseArgs({
    options: {
      "train-root": { type: "string" },
      "evaluator-root": { type: "string" },
      "valid-128": { type: "string" },
      "valid-256": { type: "string" },
    },
  });
  if (
    Object.values(values).length !== 4 ||
    Object.values(values).some((v) => !v)
  )
    fail(
      "required: --train-root DIR --evaluator-root DIR --valid-128 REPORT --valid-256 REPORT",
    );
  const trainRoot = resolve(values["train-root"]);
  const evaluatorRoot = resolve(values["evaluator-root"]);
  if (
    head(trainRoot) !== source.trainHead ||
    head(evaluatorRoot) !== source.evaluatorHead
  )
    fail("TRAIN or evaluator checkout changed from the scored source");
  const patch = await regularBytes(
    resolve(
      repo,
      "integrations/sf-pi-guardrail/candidate7-sf-pi-from-4f901db9.patch",
    ),
  );
  if (sha(patch) !== source.sfPiPatchSha256)
    fail("baseline-bound sf-pi patch changed");
  const fakePreflight = await regularBytes(
    resolve(
      evaluatorRoot,
      ".build/guardrail/candidate-7-valid-eval-fake-bc-v4/report.json",
    ),
  );
  if (sha(fakePreflight) !== source.preflightSha256)
    fail("frozen fake-provider host preflight changed");
  const admission = await regularBytes(
    resolve(
      trainRoot,
      ".build/guardrail/candidate-7-train-admission-final-v1/receipt.json",
    ),
  );
  if (sha(admission) !== source.admissionSha256)
    fail("frozen TRAIN admission changed");

  const reports = {};
  for (const steps of [128, 256]) {
    const path = resolve(values[`valid-${steps}`]);
    if (
      !inDirectory(resolve(evaluatorRoot, ".build/guardrail"), path) ||
      basename(path) !== "report.json"
    )
      fail(`${steps}-step VALID report is outside the frozen evaluator build`);
    const bytes = await regularBytes(path);
    const report = JSON.parse(bytes);
    if (
      report.purpose !== "candidate7_valid_bridge_model_selection" ||
      report.modelProvider !== "real" ||
      report.validationOnly !== true ||
      report.heldOutTestUsed !== false ||
      report.qualification !== false ||
      report.source?.evaluatorGitHead !== source.evaluatorHead ||
      report.source?.manifestSha256 !== source.manifestSha256 ||
      report.source?.sfPiCommit !== source.sfPiHead ||
      report.source?.sfPiRuntimeSha256 !== source.sfPiRuntimeSha256 ||
      report.source?.evaluatorScriptSha256 !== source.evaluatorScriptSha256 ||
      report.source?.preflightSha256 !== source.preflightSha256 ||
      report.source?.modelId !== source.modelIds[steps] ||
      report.metrics?.cases !== 65 ||
      report.metrics?.preparedModelCalls !== 36 ||
      !Array.isArray(report.records) ||
      report.records.length !== 65
    )
      fail(`${steps}-step report is not the pinned real C7 VALID replay`);
    const run = resolve(
      trainRoot,
      `.build/guardrail/candidate-7-rfdt-${steps}step-finalhost-v${steps === 128 ? 2 : 1}`,
    );
    const artifact = JSON.parse(
      await regularBytes(resolve(run, "artifact.json")),
    );
    if (
      artifact.id !== source.modelIds[steps] ||
      artifact.sha256 !== report.source.modelSha256 ||
      artifact.file !== resolve(run, "gemma-3-1b-rfdt-f16.gguf")
    )
      fail(`${steps}-step artifact and VALID report disagree`);
    const registry = JSON.parse(
      await regularBytes(resolve(run, "candidate-registry.json")),
    );
    const entry = registry.artifacts?.find((item) => item.id === artifact.id);
    if (
      entry?.sha256 !== artifact.sha256 ||
      entry?.size !== artifact.size ||
      entry?.file !== artifact.file
    )
      fail(`${steps}-step registry and artifact disagree`);
    if ((await largeFileHash(artifact.file, artifact.size)) !== artifact.sha256)
      fail(`${steps}-step local model bytes changed since scoring`);
    reports[steps] = { path, bytes, report, run };
  }

  const output = resolve(outputParent, "candidate-7-evidence");
  try {
    await lstat(output);
    fail("output already exists; preserve the previous evidence bundle");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(join(outputParent, ".candidate-7-evidence-"));
  const entries = [];
  async function copyFrom(path, destination, bytes) {
    if (
      destination
        .split(sep)
        .some(
          (component) =>
            component.toLowerCase() === "test.json" ||
            component.toLowerCase() === "test.jsonl",
        )
    )
      fail("held-out TEST material cannot be packaged");
    const value = bytes ?? (await regularBytes(path));
    const target = resolve(staging, destination);
    if (!inDirectory(staging, target)) fail("invalid evidence destination");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, { flag: "wx", mode: 0o644 });
    entries.push({
      path: destination,
      sha256: sha(value),
      bytes: value.length,
    });
  }
  try {
    await copyFrom(
      resolve(
        trainRoot,
        ".build/guardrail/candidate-7-train-source-screen-final-v1/receipt.json",
      ),
      "train/source-screen.json",
    );
    await copyFrom("", "train/admission.json", admission);
    await copyFrom(
      resolve(
        trainRoot,
        ".build/guardrail/candidate-7-train-admission-final-v1/train.jsonl",
      ),
      "train/admitted-train.jsonl",
    );
    for (const [name, directory] of [
      ["final-host", "candidate-7-host-preflight-final-v1"],
      ["preview-help-host", "candidate-7-host-preflight-previewhelp-v1"],
    ]) {
      await copyFrom(
        resolve(trainRoot, `.build/guardrail/${directory}/receipt.json`),
        `train/${name}-receipt.json`,
      );
      await copyFrom(
        resolve(
          trainRoot,
          `.build/guardrail/${directory}/projected-train.jsonl`,
        ),
        `train/${name}-projected-train.jsonl`,
      );
    }
    await copyFrom("", "valid/fake-host-preflight.json", fakePreflight);
    for (const steps of [128, 256]) {
      const { run, bytes } = reports[steps];
      const names = (await readdir(run)).filter(
        (name) =>
          /\.jsonl?$/.test(name) &&
          ![
            "dataset.jsonl",
            "train.jsonl",
            "validation.jsonl",
            "test.jsonl",
          ].includes(name),
      );
      for (const name of names.sort())
        await copyFrom(resolve(run, name), `runs/${steps}/${name}`);
      for (const [subdir, name] of [
        ["adapter", "adapter_config.json"],
        ["adapter", "rfdt-manifest.json"],
        ["fused", "rfdt-fused-manifest.json"],
      ]) {
        const path = resolve(run, subdir, name);
        try {
          await copyFrom(path, `runs/${steps}/${subdir}/${name}`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await copyFrom("", `valid/model-${steps}.json`, bytes);
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(
      join(staging, "SHA256SUMS"),
      entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") +
        "\n",
      { flag: "wx" },
    );
    const manifest = {
      version: 1,
      purpose: "candidate7_train_and_real_valid_evidence",
      qualification: false,
      heldOutTestUsed: false,
      source,
      trainRoot,
      evaluatorRoot,
      sfPiPatchSha256: sha(patch),
      reports: Object.fromEntries(
        [128, 256].map((steps) => [
          steps,
          {
            source: reports[steps].path,
            sha256: sha(reports[steps].bytes),
            candidateSelectionEligible:
              reports[steps].report.candidateSelectionEligible,
          },
        ]),
      ),
      entries,
    };
    await writeFile(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(staging, output);
    console.log(
      JSON.stringify({
        output,
        files: entries.length,
        manifest: join(output, "manifest.json"),
      }),
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
