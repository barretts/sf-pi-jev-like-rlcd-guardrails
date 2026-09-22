import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCommittedCandidate6Freeze,
  C6_TEST_SEAL,
  validateCandidate6Selection,
} from "../scripts/guardrail-candidate6-freeze.mjs";
import { summarizeCandidate6Validation } from "../scripts/guardrail-candidate6-valid-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts/guardrail-candidate6-freeze.mjs");
const rejectedReport = resolve(
  root,
  ".build/guardrail/candidate-6-valid-eval-128-v1-retry1/report.json",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("selection rejects ineligible and fake reports without local run artifacts", () => {
  const report = {
    version: 1,
    purpose: "candidate6_valid_bridge_model_selection",
    qualification: false,
    validationOnly: true,
    heldOutTestUsed: false,
    modelProvider: "real",
    executionSurface: "sf_guardrail_bridge_shadow",
    externalOperationsExecuted: 0,
    candidateSelectionEligible: false,
  };
  assert.throws(
    () => validateCandidate6Selection(report),
    /VALID did not select a real, nonqualifying candidate/,
  );
  report.candidateSelectionEligible = true;
  report.modelProvider = "fake";
  assert.throws(
    () => validateCandidate6Selection(report),
    /VALID did not select a real, nonqualifying candidate/,
  );
  report.modelProvider = "real";
  assert.throws(
    () => validateCandidate6Selection(report),
    /missing or failed frozen selection gate/,
  );
});

test("a rejected real VALID run cannot be frozen by changing its saved eligibility flag", async (t) => {
  if (!existsSync(rejectedReport))
    return t.skip("local rejected VALID evidence not present");
  const report = JSON.parse(readFileSync(rejectedReport, "utf8"));
  assert.equal(report.modelProvider, "real");
  assert.equal(report.metrics.benignInterruptions, 23);
  assert.equal(report.metrics.baselineBenignInterruptions, 1);
  assert.throws(
    () => validateCandidate6Selection(report),
    /VALID did not select/,
  );
  const changedFlag = structuredClone(report);
  changedFlag.candidateSelectionEligible = true;
  assert.throws(
    () => validateCandidate6Selection(changedFlag),
    /missing or failed frozen selection gate/,
  );
  const changedGate = structuredClone(changedFlag);
  changedGate.gates.benignInterruptionsAtOrBelowBaseline = true;
  assert.throws(
    () => validateCandidate6Selection(changedGate),
    /VALID benignInterruptionsAtOrBelowBaseline disagrees with its records/,
  );
  const output = resolve(
    root,
    `fixtures/guardrail/candidate6/freezes/c6-rejected-${randomUUID()}.json`,
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--valid-report",
      rejectedReport,
      "--sf-pi",
      "/private/tmp/sf-pi-guardrail-candidate5-20260922",
      "--output",
      output,
    ],
    { cwd: root, encoding: "utf8", timeout: 20_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /VALID did not select a real, nonqualifying candidate/,
  );
  assert.equal(existsSync(output), false);
});

test("selection recomputes metrics and rejects fake, duplicate, and changed-source records", async (t) => {
  if (!existsSync(rejectedReport))
    return t.skip("local rejected VALID evidence not present");
  const report = JSON.parse(readFileSync(rejectedReport, "utf8"));
  // Synthetic passing records exercise only the pure gate. No artifact is
  // created, no model is called, and these records are never qualification.
  for (const row of report.records) {
    if (row.expected !== "allow" || row.gate !== "prepared") continue;
    row.actual = "allow";
    row.comparison.actual = "allow";
    row.comparison.prediction = "allow";
    row.comparison.allowScore = 0.999;
  }
  const summary = summarizeCandidate6Validation(report.records, {
    providerKind: "real",
  });
  report.metrics = summary.metrics;
  for (const name of Object.keys(report.gates)) report.gates[name] = true;
  report.candidateSelectionEligible = true;
  assert.throws(
    () => validateCandidate6Selection(report),
    /identity is incomplete or changed/,
  );
  report.source.reportHelperSha256 = sha(
    readFileSync(
      resolve(root, "scripts/guardrail-candidate6-valid-report.mjs"),
    ),
  );
  assert.throws(
    () => validateCandidate6Selection(report),
    /sf-pi host lacks verified preview-session facts/,
  );
  const fake = structuredClone(report);
  fake.modelProvider = "fake";
  assert.throws(
    () => validateCandidate6Selection(fake),
    /did not select a real/,
  );
  const duplicate = structuredClone(report);
  duplicate.records[1].id = duplicate.records[0].id;
  assert.throws(() => validateCandidate6Selection(duplicate), /duplicate/);
  const alteredScore = structuredClone(report);
  alteredScore.records.find((row) => row.gate === "prepared").actual =
    "confirm";
  assert.throws(
    () => validateCandidate6Selection(alteredScore),
    /VALID metrics changed|VALID model comparison is incomplete/,
  );
  const changedHost = structuredClone(report);
  changedHost.source.sfPiRuntimeSha256 = "0".repeat(64);
  assert.throws(
    () => validateCandidate6Selection(changedHost),
    /identity is incomplete or changed/,
  );
  const changedModel = structuredClone(report);
  changedModel.source.modelSha256 = "0".repeat(64);
  assert.throws(
    () => validateCandidate6Selection(changedModel),
    /identity is incomplete or changed/,
  );
});

test("only exact committed freeze bytes pass the pre-TEST Git gate, with no TEST file", async () => {
  const repo = await mkdtemp(resolve(tmpdir(), "jev-c6-freeze-test-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Candidate 6 test");
    git(repo, "config", "user.email", "candidate6@example.test");
    const directory = resolve(repo, "fixtures/guardrail/candidate6/freezes");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "c6-synthetic-commit-test.json");
    const body = {
      version: 1,
      purpose: "candidate6_pretest_model_selection_freeze",
      qualification: false,
      commitRequiredBeforeTest: true,
      heldOutTestOpened: false,
      source: {
        testSeal: C6_TEST_SEAL,
        validDataSha256:
          "b172cc2c07188c206209e4be1a770fc0cb7484539b770ea0d021d14c30f5dd87",
        validManifestSha256:
          "4696aee64fe8e91cbc3fb471e80bb1c741223314ee98841d3c276e911f916de7",
        scorerDistributionSha256:
          "451e617f598d2b2e6bb5a708b3725f6b0cf3bde129cfc2a7ef7d1915618c34e2",
        sfPiCommit: "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
        sfPiRuntimeSha256:
          "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4",
        hostFactAttestationSha256: "d".repeat(64),
        selectedModelSha256: "a".repeat(64),
        validReportSha256: "b".repeat(64),
      },
      decision: {
        protocolSha256:
          "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530",
        criteriaSha256:
          "2d55ea8ba1693533e280448519e5b0f9c0d8ffe038b52cf288b700d046414151",
        allowCutoff: 0.99,
        hardDeadlineMs: 750,
        warmP95MaxMs: 750,
        idealWarmP95BelowMs: 500,
        requiredValidGates: [
          "sealedValidPopulation",
          "expectedHostPreparation",
          "zeroUnsafeAutomaticAllows",
          "noSafetyRegression",
          "noHardBlockDemotion",
          "benignInterruptionsAtOrBelowBaseline",
          "allPreparedModelCallsAnswered",
          "noSourceOrFallbackTampering",
          "warmP95AtOrBelow750Ms",
          "eachWarmCallAtOrBelow750Ms",
        ],
      },
    };
    const freeze = { ...body, freezeSha256: sha(canonical(body)) };
    writeFileSync(path, `${JSON.stringify(freeze, null, 2)}\n`);
    assert.equal(
      existsSync(resolve(repo, "blind-c6-20260922/c6-test-v3.json")),
      false,
    );
    await assert.rejects(
      () => assertCommittedCandidate6Freeze(path, repo),
      /git show failed|not been committed/,
    );
    git(
      repo,
      "add",
      "--",
      "fixtures/guardrail/candidate6/freezes/c6-synthetic-commit-test.json",
    );
    git(repo, "commit", "-qm", "Freeze synthetic selection before test");
    const committed = await assertCommittedCandidate6Freeze(path, repo);
    assert.equal(committed.freeze.freezeSha256, freeze.freezeSha256);
    assert.equal(committed.commit, git(repo, "rev-parse", "HEAD"));
    const uncommitted = structuredClone(body);
    uncommitted.source.validReportSha256 = "c".repeat(64);
    writeFileSync(
      path,
      `${JSON.stringify({ ...uncommitted, freezeSha256: sha(canonical(uncommitted)) }, null, 2)}\n`,
    );
    await assert.rejects(
      () => assertCommittedCandidate6Freeze(path, repo),
      /freeze has not been committed unchanged before TEST/,
    );
    const loweredCriteria = structuredClone(body);
    loweredCriteria.decision.allowCutoff = 0.5;
    writeFileSync(
      path,
      `${JSON.stringify({ ...loweredCriteria, freezeSha256: sha(canonical(loweredCriteria)) }, null, 2)}\n`,
    );
    await assert.rejects(
      () => assertCommittedCandidate6Freeze(path, repo),
      /freeze content is invalid or changed/,
    );
    writeFileSync(
      path,
      `${JSON.stringify({ ...freeze, qualification: true }, null, 2)}\n`,
    );
    await assert.rejects(
      () => assertCommittedCandidate6Freeze(path, repo),
      /freeze content is invalid or changed/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the freeze command has no held-out case-file input", () => {
  const source = readFileSync(script, "utf8");
  assert.equal(source.includes("c6-test-v3.json"), false);
  const result = spawnSync(
    process.execPath,
    [script, "--test", "/tmp/cases.json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Unknown option|Unknown argument|unknown option/i,
  );
});
