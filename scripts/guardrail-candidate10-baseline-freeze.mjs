#!/usr/bin/env node
/** Freeze C10's independently replayed baseline prospectively; never alter C9 pins. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    "host-commit": { type: "string" },
    "baseline-sha256": { type: "string" },
    "output-dir": { type: "string" },
  },
});
for (const key of [
  "sf-pi",
  "sf-deps",
  "host-commit",
  "baseline-sha256",
  "output-dir",
])
  if (!values[key]) throw new Error(`Required --${key}`);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = async (p) => JSON.parse(await readFile(p));
const need = (v, why) => {
  if (!v) throw new Error(`C10 baseline freeze: ${why}`);
};
const trainRoot = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-9-evidence/train",
);
const validOldPath = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-9-evidence/valid/preflight-4f7fae0.json",
);
const sourcePath = resolve(trainRoot, "source.json");
const calPath = resolve(trainRoot, "calibration.jsonl");
const calOldPath = resolve(trainRoot, "calibration-baseline.json");
const output = resolve(values["output-dir"]);
need(
  output.startsWith(
    resolve(root, "reports/guardrail-risk-2026-09-21/candidate-10-evidence/"),
  ),
  "Output must be new C10 evidence directory",
);
need(
  execFileSync("git", ["status", "--porcelain"], {
    cwd: values["sf-pi"],
    encoding: "utf8",
  }).trim() === "",
  "Host must be clean and committed",
);
const sourceBytes = await readFile(sourcePath);
need(
  sha(sourceBytes) ===
    "c19cfc20cb13e80e8fe05c3c01ea9085078b9b38ba887f9f60033db0409e3434",
  "Authored TRAIN source changed",
);
const calBytes = await readFile(calPath);
need(
  sha(calBytes) ===
    "84dfedfb0a1aea2b5e39fd33bd40a913edf96daf89129accdc59e622ce7d57bd",
  "CAL source changed",
);
const tag = `${Date.now()}-${process.pid}`;
const hostReplayDir = resolve(
  root,
  `.build/guardrail/candidate-10-host-${tag}`,
);
const validReplayPath = resolve(
  root,
  `.build/guardrail/candidate-10-valid-preflight-${tag}.json`,
);
const common = [
  "--sf-pi",
  values["sf-pi"],
  "--sf-deps",
  values["sf-deps"],
  "--host-commit",
  values["host-commit"],
  "--baseline-sha256",
  values["baseline-sha256"],
];
const run = (script, args) =>
  execFileSync(
    process.execPath,
    [resolve(root, "scripts", script), ...common, ...args],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
  );
run("guardrail-candidate10-baseline-host-project.mjs", [
  "--source",
  sourcePath,
  "--source-sha256",
  sha(sourceBytes),
  "--output-dir",
  hostReplayDir,
]);
run("guardrail-candidate10-baseline-valid-preflight.mjs", [
  "--output",
  validReplayPath,
]);
const host = await json(resolve(hostReplayDir, "receipt.json"));
const valid = await json(validReplayPath);
const oldValid = await json(validOldPath);
const oldCal = await json(calOldPath);
const calRows = calBytes.toString("utf8").trim().split("\n").map(JSON.parse);
const projected = new Map(host.statuses.map((row) => [row.id, row]));
const records = calRows.map((row) => {
  const status = projected.get(row.id);
  need(
    status && status.gate === "model_prepared",
    "CAL operation no longer model eligible",
  );
  return {
    id: row.id,
    inputSha256: status.inputSha256,
    action: status.baselineAction,
    gate: status.gate,
    route: status.route,
    ruleId: status.ruleId,
    factRoute: status.factRoute,
  };
});
const compare = (oldRows, newRows, keys) => {
  need(oldRows.length === newRows.length, "Baseline inventory count changed");
  const byId = new Map(oldRows.map((row) => [row.id, row]));
  need(
    byId.size === oldRows.length &&
      new Set(newRows.map((row) => row.id)).size === newRows.length,
    "Duplicate baseline case",
  );
  const differences = [];
  for (const row of newRows) {
    const old = byId.get(row.id);
    need(old, "Baseline case identity changed");
    for (const key of keys)
      if (JSON.stringify(old[key]) !== JSON.stringify(row[key]))
        differences.push({ id: row.id, field: key });
  }
  need(
    differences.length === 0,
    `Baseline semantics changed (${differences.length} fields)`,
  );
  return {
    casesCompared: newRows.length,
    fieldsCompared: keys,
    differingCases: 0,
    differingFields: 0,
  };
};
const calEquivalence = compare(oldCal.records, records, [
  "inputSha256",
  "action",
  "gate",
  "route",
  "ruleId",
  "factRoute",
]);
const validEquivalence = compare(oldValid.status, valid.status, [
  "family",
  "group_id",
  "expected",
  "operation_sha256",
  "policy_sha256",
  "routing",
  "reason",
  "baseline_action",
  "risk_input_sha256",
]);
const calBaseline = {
  version: 1,
  purpose: "candidate10_train_cal_baseline_replay",
  baselineSha256: values["baseline-sha256"],
  policySha256: oldCal.policySha256,
  calibrationCorpusSha256: sha(calBytes),
  qualification: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestRead: false,
  source: {
    hostCommit: values["host-commit"],
    authoredC9BaselineReceiptSha256: sha(await readFile(calOldPath)),
    prospectiveHostProjectionSha256: sha(
      await readFile(resolve(hostReplayDir, "receipt.json")),
    ),
  },
  records,
};
const counts = (rows) =>
  Object.fromEntries(
    ["allow", "confirm", "block"].map((action) => [
      action,
      rows.filter((row) => (row.action ?? row.baseline_action) === action)
        .length,
    ]),
  );
const files = {
  "calibration-baseline.json": Buffer.from(
    `${JSON.stringify(calBaseline, null, 2)}\n`,
  ),
  "valid-preflight.json": await readFile(validReplayPath),
  "host-projection.json": await readFile(
    resolve(hostReplayDir, "receipt.json"),
  ),
};
const manifest = {
  version: 1,
  purpose: "candidate10_prospective_baseline_freeze",
  frozenBeforeModelCalibrationAndValidation: true,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestRead: false,
  qualification: false,
  host: {
    path: resolve(values["sf-pi"]),
    commit: values["host-commit"],
    baselineSha256: values["baseline-sha256"],
    policySha256: oldCal.policySha256,
  },
  authoredC9: {
    hostCommit: oldValid.host_commit,
    baselineSha256: oldCal.baselineSha256,
    policySha256: oldCal.policySha256,
    calSourceSha256: sha(calBytes),
    validSourceSha256: valid.source_sha256,
    validManifestSha256: valid.manifest_sha256,
    calBaselineReceiptSha256: sha(await readFile(calOldPath)),
    validPreflightReceiptSha256: sha(await readFile(validOldPath)),
  },
  rubricSha256: valid.rubric_sha256,
  promptProtocolSha256: valid.model_protocol_sha256,
  decisionBaseProtocolSha256: valid.decision_base_protocol_sha256,
  equivalence: { calibration: calEquivalence, validation: validEquivalence },
  summaries: {
    calibration: { cases: 42, decisions: counts(records) },
    validation: {
      cases: 160,
      decisions: counts(valid.status),
      families: valid.summary,
    },
  },
  evidence: Object.fromEntries(
    Object.entries(files).map(([file, bytes]) => [
      file,
      { file, sha256: sha(bytes) },
    ]),
  ),
  producer: {
    scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    jevCommitAtReplay: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    scope:
      "Baseline-only replay of pre-authored CAL and sealed VALID; no candidate predictions or TEST body. Reuses existing independent fixture facts with environment detection stubbed; invokes Safety Kernel directly with no provider or execution.",
  },
};
need(
  manifest.host.policySha256 ===
    "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347" &&
    valid.default_policy_sha256 === manifest.host.policySha256,
  "Exact default policy changed",
);
await mkdir(output, { recursive: true });
for (const [file, bytes] of Object.entries(files))
  await writeFile(resolve(output, file), bytes, { flag: "wx" });
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, "manifest.json"), manifestBytes, {
  flag: "wx",
});
console.log(
  JSON.stringify(
    {
      output,
      manifestSha256: sha(manifestBytes),
      host: manifest.host,
      equivalence: manifest.equivalence,
      summaries: manifest.summaries,
    },
    null,
    2,
  ),
);
