#!/usr/bin/env node
/** TRAIN-source integrity and development-only collision screen. Never reads TEST. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = resolve(
  root,
  "fixtures/guardrail/candidate7/train-contrasts.json",
);
const builderFile = resolve(
  root,
  "fixtures/guardrail/candidate7/build-train-contrasts.mjs",
);
const rubricFile = resolve(root, "fixtures/guardrail/RUBRIC.md");
const buildRoot = resolve(root, ".build/guardrail");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const operationKey = (toolName, input) => JSON.stringify([toolName, input]);
const admittedC6Sha256 =
  "d31bdb1bcca9bb4866e8dafed3290b4dc15b4b5abb0d9909ef67e855bc066602";

const { values } = parseArgs({
  options: {
    "base-train": { type: "string" },
    "diagnostic-valid": { type: "string" },
    output: { type: "string" },
  },
});
const sourceBytes = await readFile(sourceFile);
const data = JSON.parse(sourceBytes);
assert(
  data.version === 1 && data.rubric === "operation-policy-v2",
  "Unexpected Candidate 7 source version/rubric",
);
assert(
  data.trainingReady === false &&
    data.qualification === false &&
    data.humanLabelReviewed === false,
  "TRAIN source cannot claim model qualification or human label approval",
);
assert(
  data.agentRubricReviewed === true &&
    Array.isArray(data.cases) &&
    data.cases.length === 52,
  "TRAIN case count/review state changed",
);
const ids = new Set();
const operations = new Set();
const groups = new Map();
for (const row of data.cases) {
  assert(
    typeof row.id === "string" && row.id.startsWith("c7-") && !ids.has(row.id),
    `Invalid or duplicate TRAIN ID: ${row.id}`,
  );
  ids.add(row.id);
  assert(
    typeof row.groupId === "string" &&
      row.groupId.startsWith("c7-") &&
      row.split === "train",
    `Invalid TRAIN group/split: ${row.id}`,
  );
  assert(
    ["allow", "confirm"].includes(row.expected) &&
      typeof row.toolName === "string",
    `Invalid label/tool: ${row.id}`,
  );
  assert(
    row.input && typeof row.input === "object" && !Array.isArray(row.input),
    `Invalid input: ${row.id}`,
  );
  assert(
    row.observations &&
      typeof row.observations === "object" &&
      !Array.isArray(row.observations),
    `Invalid observations: ${row.id}`,
  );
  assert(
    Array.isArray(row.fixturePreconditions) &&
      row.fixturePreconditions.length > 0 &&
      row.fixturePreconditions.every(
        (value) => typeof value === "string" && value.trim(),
      ),
    `Missing preconditions: ${row.id}`,
  );
  assert(
    Array.isArray(row.sourceEvidence) &&
      row.sourceEvidence.includes("fixtures/guardrail/RUBRIC.md") &&
      typeof row.policyRationale === "string" &&
      row.policyRationale.trim(),
    `Missing policy review: ${row.id}`,
  );
  assert(
    !Object.keys(row.observations).some((key) =>
      /baseline|rule|decision|risk|approved/i.test(key),
    ),
    `Existing risk classification leaked into observations: ${row.id}`,
  );
  const key = operationKey(row.toolName, row.input);
  assert(!operations.has(key), `Duplicate C7 operation input: ${row.id}`);
  operations.add(key);
  if (row.toolName === "sf_browser_click") {
    const { browserRef: ref, browserPage: page } = row.observations;
    assert(
      ref?.status === "fresh" &&
        page?.status === "fresh" &&
        ref.ref === row.input.ref &&
        page.snapshot.includes(ref.line) &&
        sha(page.snapshot) === page.snapshotSha256 &&
        page.snapshotSha256 === ref.snapshotSha256 &&
        /^https:\/\//.test(page.url),
      `Browser capture/ref mismatch: ${row.id}`,
    );
  }
  const group = groups.get(row.groupId) ?? [];
  group.push(row);
  groups.set(row.groupId, group);
}
assert(groups.size === 18, "TRAIN group count changed");
for (const [id, rows] of groups) {
  const labels = rows.map((row) => row.expected);
  assert(
    labels.filter((label) => label === "allow").length ===
      labels.filter((label) => label === "confirm").length &&
      labels.includes("allow") &&
      labels.includes("confirm"),
    `Unbalanced matched group: ${id}`,
  );
  assert(
    rows.every((row) => row.split === "train"),
    `Split leak: ${id}`,
  );
}

const receipt = {
  version: 1,
  purpose: "candidate7_train_source_screen",
  qualification: false,
  trainingReady: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestRead: false,
  source: {
    file: sourceFile,
    sha256: sha(sourceBytes),
    builderSha256: sha(await readFile(builderFile)),
    rubricSha256: sha(await readFile(rubricFile)),
    screenScriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  },
  counts: {
    rows: data.cases.length,
    groups: groups.size,
    allow: data.cases.filter((row) => row.expected === "allow").length,
    confirm: data.cases.filter((row) => row.expected === "confirm").length,
    byFamily: Object.fromEntries(
      [...new Set(data.cases.map((row) => row.family))]
        .sort()
        .map((family) => [
          family,
          data.cases.filter((row) => row.family === family).length,
        ]),
    ),
  },
};

if (values["base-train"]) {
  const baseFile = resolve(values["base-train"]);
  assert(
    baseFile.endsWith("admitted-train.jsonl"),
    "--base-train must name the admitted C6 TRAIN file",
  );
  const bytes = await readFile(baseFile);
  assert(sha(bytes) === admittedC6Sha256, "C6 admitted TRAIN hash changed");
  const rows = bytes.toString("utf8").trim().split("\n").map(JSON.parse);
  assert(
    rows.length === 175 && new Set(rows.map((row) => row.group_id)).size === 59,
    "C6 admitted TRAIN counts changed",
  );
  const seen = new Set();
  for (const row of rows) {
    assert(
      row.split === "train" &&
        row.request?.model === "google/gemma-3-1b-it" &&
        row.request.state?.version === 2 &&
        row.request.options?.template_version === "v2" &&
        ["allow", "confirm"].includes(row.targets?.risk?.answer),
      `Incompatible C6 admitted TRAIN contract: ${row.id}`,
    );
    seen.add(operationKey(row.request.state.toolName, row.request.state.input));
  }
  const overlap = data.cases.filter((row) =>
    seen.has(operationKey(row.toolName, row.input)),
  );
  assert(
    overlap.length === 0,
    `C7 operations exactly duplicate admitted C6 TRAIN: ${overlap.map((row) => row.id).join(", ")}`,
  );
  receipt.baseTrain = {
    file: baseFile,
    sha256: admittedC6Sha256,
    rows: rows.length,
    groups: 59,
    protocolVersion: 2,
    baseModel: "google/gemma-3-1b-it",
    exactOperationOverlap: 0,
  };
}

if (values["diagnostic-valid"]) {
  const validFile = resolve(values["diagnostic-valid"]);
  assert(
    /c6-valid-v4\.json$/.test(validFile) &&
      !/test/i.test(validFile.split("/").at(-1)),
    "--diagnostic-valid only accepts the already-open C6 VALID v4 file",
  );
  const bytes = await readFile(validFile);
  const valid = JSON.parse(bytes);
  assert(
    valid.split === "valid" &&
      Array.isArray(valid.cases) &&
      valid.cases.length === 62,
    "Unexpected C6 diagnostic VALID shape",
  );
  const seen = new Set(
    valid.cases.map((row) =>
      operationKey(row.operation.tool, row.operation.input),
    ),
  );
  const overlap = data.cases.filter((row) =>
    seen.has(operationKey(row.toolName, row.input)),
  );
  assert(
    overlap.length === 0,
    `C7 operations exactly duplicate C6 VALID: ${overlap.map((row) => row.id).join(", ")}`,
  );
  receipt.diagnosticValid = {
    file: validFile,
    sha256: sha(bytes),
    rows: valid.cases.length,
    exactOperationOverlap: 0,
    selectionEvidence: false,
  };
}

if (values.output) {
  const output = resolve(values.output);
  const rel = relative(buildRoot, output);
  assert(
    rel &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !rel.startsWith(sep) &&
      output.endsWith(".json"),
    "Output must be a new JSON file under .build/guardrail",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
console.log(JSON.stringify(receipt));
