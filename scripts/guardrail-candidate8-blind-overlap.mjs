#!/usr/bin/env node
/** Aggregate-only C8 VALID overlap screen after TRAIN source is frozen. No TEST access. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frozenCommit = "7d6b05b43b630cd9a897ea05f98065c125188ea2";
const sourceRel = "fixtures/guardrail/candidate8/train-recovery.json";
const baseRel =
  "reports/guardrail-risk-2026-09-21/candidate-7-evidence/train/admitted-train.jsonl";
const sourceFile = resolve(root, sourceRel);
const baseFile = resolve(root, baseRel);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => {
  if (!ok) throw new Error("C8 overlap: " + why);
};
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
const op = (tool, input) => JSON.stringify(canonical([tool, input]));
const { values } = parseArgs({
  options: {
    valid: { type: "string" },
    manifest: { type: "string" },
    "blind-root": { type: "string" },
    "blind-commit": { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["valid", "manifest", "blind-root", "blind-commit"])
  need(values[key], "Missing --" + key);
const blindRoot = resolve(values["blind-root"]);
const validFile = resolve(values.valid),
  manifestFile = resolve(values.manifest);
need(
  validFile === resolve(blindRoot, "blind-c8-20260922/valid.json"),
  "Only independent C8 VALID source is permitted",
);
need(
  manifestFile === resolve(blindRoot, "blind-c8-20260922/manifest.json"),
  "Only opaque C8 blind manifest is permitted",
);
need(
  git(blindRoot, "rev-parse", "HEAD") === values["blind-commit"],
  "Blind checkout HEAD changed",
);
const frozenSource = execFileSync(
  "git",
  ["show", frozenCommit + ":" + sourceRel],
  { cwd: root },
);
const [sourceBytes, baseBytes, validBytes, manifestBytes] = await Promise.all([
  readFile(sourceFile),
  readFile(baseFile),
  readFile(validFile),
  readFile(manifestFile),
]);
need(sha(sourceBytes) === sha(frozenSource), "Frozen C8 source bytes changed");
const source = JSON.parse(sourceBytes),
  base = baseBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
const valid = JSON.parse(validBytes),
  manifest = JSON.parse(manifestBytes);
const validSeal = manifest.splits?.valid ?? manifest.valid;
need(
  validSeal?.path === "blind-c8-20260922/valid.json" &&
    validSeal?.sha256 === sha(validBytes),
  "C8 VALID does not match final manifest",
);
need(
  source.cases?.length === 48 &&
    base.length === 227 &&
    valid.split === "valid" &&
    valid.cases?.length >= 90 &&
    validSeal.case_count === valid.cases.length,
  "Unexpected frozen TRAIN or independent VALID shape",
);
const trainOps = new Set([
  ...base.map((row) => op(row.request.state.toolName, row.request.state.input)),
  ...source.cases.map((row) => op(row.toolName, row.input)),
]);
const trainCommands = new Set([
  ...base.map((row) => row.request.state.input.command).filter(Boolean),
  ...source.cases.map((row) => row.input.command).filter(Boolean),
]);
let exactOperationOverlap = 0,
  exactCommandOverlap = 0;
const validIds = new Set(),
  validGroups = new Set(),
  validTemplates = new Set();
const trainIds = new Set([
  ...base.map((row) => row.id),
  ...source.cases.map((row) => row.id),
]);
const trainGroups = new Set([
  ...base.map((row) => row.group_id),
  ...source.cases.map((row) => row.groupId),
]);
for (const row of valid.cases) {
  need(
    row.operation?.tool &&
      row.operation.input &&
      row.id &&
      row.group_id &&
      row.template_id,
    "Incomplete C8 VALID row",
  );
  if (trainOps.has(op(row.operation.tool, row.operation.input)))
    exactOperationOverlap++;
  if (
    row.operation.input.command &&
    trainCommands.has(row.operation.input.command)
  )
    exactCommandOverlap++;
  validIds.add(row.id);
  validGroups.add(row.group_id);
  validTemplates.add(row.template_id);
}
need(
  validIds.size === valid.cases.length &&
    validGroups.size === validSeal.group_count &&
    validTemplates.size === validSeal.template_count,
  "C8 VALID identifiers do not match manifest counts",
);
const idOverlap = [...validIds].filter((id) => trainIds.has(id)).length;
const groupOverlap = [...validGroups].filter((id) =>
  trainGroups.has(id),
).length;
const receipt = {
  version: 1,
  purpose: "candidate8_postfreeze_valid_overlap",
  qualification: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestRead: false,
  validationCaseBodiesEmitted: false,
  source: {
    frozenTrainCommit: frozenCommit,
    frozenTrainSourceSha256: sha(sourceBytes),
    inheritedTrainSha256: sha(baseBytes),
    blindValidCommit: values["blind-commit"],
    blindValidSha256: sha(validBytes),
    blindManifestSha256: sha(manifestBytes),
    screenScriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  },
  counts: {
    trainRows: base.length + source.cases.length,
    trainGroups: trainGroups.size,
    validRows: valid.cases.length,
    validGroups: validGroups.size,
    validTemplates: validTemplates.size,
    exactOperationOverlap,
    exactCommandOverlap,
    idOverlap,
    groupOverlap,
  },
  proofLimit:
    "Exact aggregate overlap is a necessary check, not proof of semantic independence or generalization. C7 VALID outcomes informed C8 TRAIN; this separate C8 VALID was independently authored. TEST body remains sealed.",
};
if (values.output) {
  const output = resolve(values.output);
  need(
    output.startsWith(
      resolve(root, ".build/guardrail/candidate-8-blind-overlap-"),
    ) && output.endsWith("/receipt.json"),
    "Output must be a fresh C8 .build receipt path",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
console.log(JSON.stringify(receipt));
need(
  exactOperationOverlap === 0 &&
    exactCommandOverlap === 0 &&
    idOverlap === 0 &&
    groupOverlap === 0,
  "Independent C8 VALID overlaps frozen TRAIN",
);
