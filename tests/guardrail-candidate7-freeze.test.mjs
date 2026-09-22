import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCommittedCandidate7Freeze,
  candidate7LaneCoverage,
  readCandidate7HeldOutAfterFreeze,
  validateCandidate7Selection,
  verifyCandidate7HostProjectionEquivalence,
  verifyCommittedCandidate7FreezeDocument,
} from "../scripts/guardrail-candidate7-freeze.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts/guardrail-candidate7-freeze.mjs");
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
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function laneFixture() {
  const laneNames = [
    "shell",
    "herdr",
    "files",
    "salesforce_org",
    "apex",
    "agentscript",
    "data360",
    "soql",
    "slack_canvas",
    "browser_commit",
  ];
  const tools = [
    "bash",
    "herdr_pane",
    "read",
    "bash",
    "bash",
    "bash",
    "bash",
    "bash",
    "slack_canvas_update",
    "sf_browser_click",
  ];
  const rows = [];
  const records = [];
  for (let i = 1; i <= 65; i++) {
    const slot = (i - 1) % laneNames.length;
    const family = [7, 8, 9].includes(i) ? "files" : laneNames[slot];
    const tool = [7, 8, 9].includes(i) ? "read" : tools[slot];
    const id = `c7-valid-${String(i).padStart(3, "0")}`;
    const expected = i % 3 === 0 ? "allow" : "require_approval";
    const action = expected === "allow" ? "allow" : "confirm";
    const isFile = tool === "read";
    const isFloor = i === 20;
    rows.push({
      id,
      family,
      operation: { tool, input: {} },
      expected: { decision: expected },
    });
    records.push({
      id,
      family,
      expected: action,
      baseline: action,
      actual: action,
      gate: isFile ? "ineligible" : isFloor ? "policy_floor" : "prepared",
      source: isFloor ? "exact_policy" : isFile ? "rules_fallback" : "jev",
      modelCalls: isFile || isFloor ? 0 : 1,
      comparison: { source: isFile || isFloor ? "exact_policy" : "jev" },
    });
  }
  return { rows, records };
}

test("lane-aware selection counts semantic calls and verifies code-owned floors", () => {
  const { rows, records } = laneFixture();
  const coverage = candidate7LaneCoverage(rows, records);
  assert.equal(coverage.laneAwareCoverage, true);
  assert.equal(coverage.requiredFamiliesPresent, true);
  assert.ok(coverage.preparedSafeIds.length >= 1);
  assert.ok(coverage.preparedRiskyIds.length >= 8);
  const falseFloor = structuredClone(records);
  const floor = falseFloor.find((row) => row.gate === "policy_floor");
  floor.actual = "allow";
  assert.deepEqual(candidate7LaneCoverage(rows, falseFloor).floorGoldFailures, [
    floor.id,
  ]);
  const falseFile = structuredClone(records);
  falseFile.find((row) => row.id === "c7-valid-007").comparison.source =
    "rules_fallback";
  assert.deepEqual(candidate7LaneCoverage(rows, falseFile).filePolicyFailures, [
    "c7-valid-007",
  ]);
  const noSemanticRisk = structuredClone(records);
  for (const row of noSemanticRisk)
    if (row.gate === "prepared" && row.expected === "confirm")
      row.gate = "ineligible";
  assert.equal(
    candidate7LaneCoverage(rows, noSemanticRisk).laneAwareCoverage,
    false,
  );
});

test("fake or rejected VALID evidence cannot create a selection", () => {
  const { rows } = laneFixture();
  const metadata = { validCaseCount: 65 };
  const report = {
    version: 1,
    purpose: "candidate7_valid_bridge_model_selection",
    qualification: false,
    validationOnly: true,
    heldOutTestUsed: false,
    modelProvider: "real",
    executionSurface: "sf_guardrail_bridge_shadow",
    externalOperationsExecuted: 0,
    mockedHostFacts: true,
    syntheticBrowserSnapshots: true,
    cwdSubstitutedWithinBuild: true,
    candidateSelectionEligible: false,
  };
  assert.throws(
    () => validateCandidate7Selection(report, rows, metadata),
    /VALID did not select/,
  );
  report.candidateSelectionEligible = true;
  report.modelProvider = "fake";
  assert.throws(
    () => validateCandidate7Selection(report, rows, metadata),
    /VALID did not select/,
  );
  report.modelProvider = "real";
  assert.throws(
    () => validateCandidate7Selection(report, rows, metadata),
    /population or selection gates/,
  );
});

test("training and corrected evaluation hosts preserve model-visible TRAIN projection", async (t) => {
  const trainRoot = "/private/tmp/simple-jev-ts-guardrail-c7-unified-20260922";
  const sf = "/private/tmp/sf-pi-guardrail-preview-help-20260922";
  const trainReceipt = resolve(
    trainRoot,
    ".build/guardrail/candidate-7-host-preflight-final-v1/receipt.json",
  );
  const evalReceipt = resolve(
    trainRoot,
    ".build/guardrail/candidate-7-host-preflight-previewhelp-v1/receipt.json",
  );
  if (![trainReceipt, evalReceipt].every(existsSync) || !existsSync(sf))
    return t.skip("local committed host projection receipts are unavailable");
  const source = {
    trainHostProjectionReceiptFile: trainReceipt,
    hostProjectionEquivalenceReceiptFile: evalReceipt,
  };
  await verifyCandidate7HostProjectionEquivalence(source, trainRoot, sf);
  await assert.rejects(
    () =>
      verifyCandidate7HostProjectionEquivalence(
        {
          ...source,
          hostProjectionEquivalenceReceiptFile: trainReceipt,
        },
        trainRoot,
        sf,
      ),
    /receipt path changed/,
  );
});

test("committed freeze bytes reject edits, symlinks, and changed criteria without TEST", async () => {
  const repo = await mkdtemp(resolve(tmpdir(), "jev-c7-freeze-test-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Candidate 7 test");
    git(repo, "config", "user.email", "candidate7@example.test");
    const directory = resolve(repo, "fixtures/guardrail/candidate7/freezes");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "c7-synthetic-freeze.json");
    const expected = {
      manifestSha256: "a".repeat(64),
      hostCommit: "b".repeat(40),
      hostRuntimeSha256: "c".repeat(64),
      coverageCriteriaSha256: "d".repeat(64),
      trainHead: "e".repeat(40),
      protocolSha256: "f".repeat(64),
      criteriaSha256: "1".repeat(64),
      requiredGates: [
        "sealedValidPopulation",
        "laneAwareCoverage",
        "noReplayErrors",
      ],
    };
    const source = {
      manifestSha256: expected.manifestSha256,
      sfPiCommit: expected.hostCommit,
      sfPiRuntimeSha256: expected.hostRuntimeSha256,
      coverageCriteriaSha256: expected.coverageCriteriaSha256,
      trainGitHead: expected.trainHead,
      testSeal: {
        path: "blind-c7-20260922/test.json",
        sha256: "2".repeat(64),
        caseCount: 65,
        groupCount: 22,
        templateCount: 22,
        groupIdsSha256: "3".repeat(64),
        templateIdsSha256: "4".repeat(64),
      },
      validReportSha256: "5".repeat(64),
      validDataSha256: "6".repeat(64),
      schemaSha256: "7".repeat(64),
      selectedModelId: "jev/c7-synthetic",
      selectedModelSha256: "8".repeat(64),
      selectedSteps: 128,
      admittedTrainSha256: "9".repeat(64),
      admissionReceiptSha256: "0".repeat(64),
      trainHostProjectionReceiptSha256:
        "f04bc38d11ae8e3862a4f2dfa7c604274993c390101c80b708c657d8fdde3493",
      evaluationHostProjectionReceiptSha256:
        "eb4dcf6425c105e0cc3afc1c6ed01bba5fe28ae232d8517e3729524a71bb613b",
      trainProjectionSha256:
        "9cb3793e417bc149fc58bed2ce4129d668b4c240a19c8fa64c78fe6513617755",
      inputBuilderSha256:
        "e1b24781e8cd39afe6256f36f9de7a3068d319cdfc83a1e45f73578a34d4a984",
      rfdtPlanSha256: "a".repeat(64),
      rfdtManifestSha256: "b".repeat(64),
      rfdtArtifactSha256: "c".repeat(64),
      rfdtRegistrySha256: "d".repeat(64),
      evaluatorScriptSha256: "e".repeat(64),
      runtimeDistributionSha256: "f".repeat(64),
      nativeBinarySha256: "1".repeat(64),
      hostPreflightSha256: "2".repeat(64),
      freezeGateScriptSha256: "3".repeat(64),
    };
    const body = {
      version: 1,
      purpose: "candidate7_pretest_model_selection_freeze",
      qualification: false,
      commitRequiredBeforeTest: true,
      heldOutTestOpened: false,
      source,
      decision: {
        protocolSha256: expected.protocolSha256,
        criteriaSha256: expected.criteriaSha256,
        allowCutoff: 0.99,
        hardDeadlineMs: 750,
        warmP95MaxMs: 750,
        idealWarmP95BelowMs: 500,
        requiredValidGates: expected.requiredGates,
        modelEvidenceScope: {
          rubricRiskyCases: 29,
          preparedRiskyCases: 8,
          unpreparedRiskyCases: 21,
          familiesWithoutPreparedRisky: [],
          conclusionLimit:
            "The model is measured only on prepared semantic-lane cases. Code-owned floors and ineligible cases test host protection, not model risk detection; this corpus does not establish model effectiveness in those lanes.",
        },
        latencyScope:
          "Serial isolated-host bridge-shadow replay after warmup; per-call elapsed includes host config preparation, Safety Kernel, bridge preparation, queueing, and inference. No concurrent-load or matched-workflow claim.",
      },
    };
    const freeze = { ...body, freezeSha256: sha(canonical(body)) };
    writeFileSync(path, `${JSON.stringify(freeze, null, 2)}\n`);
    assert.equal(
      existsSync(resolve(repo, "blind-c7-20260922/test.json")),
      false,
    );
    await assert.rejects(
      () => verifyCommittedCandidate7FreezeDocument(path, repo, expected),
      /git show failed/,
    );
    git(
      repo,
      "add",
      "--",
      "fixtures/guardrail/candidate7/freezes/c7-synthetic-freeze.json",
    );
    git(
      repo,
      "commit",
      "-qm",
      "Commit synthetic freeze before held-out access",
    );
    const committed = await verifyCommittedCandidate7FreezeDocument(
      path,
      repo,
      expected,
    );
    assert.equal(committed.freeze.freezeSha256, freeze.freezeSha256);
    await assert.rejects(
      () => assertCommittedCandidate7Freeze(path, repo),
      /freeze content is invalid/,
      "production pins must not accept synthetic fixtures",
    );
    const changed = structuredClone(body);
    changed.decision.allowCutoff = 0.5;
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ...changed,
          freezeSha256: sha(canonical(changed)),
        },
        null,
        2,
      )}\n`,
    );
    await assert.rejects(
      () => verifyCommittedCandidate7FreezeDocument(path, repo, expected),
      /freeze content is invalid/,
    );
    writeFileSync(path, `${JSON.stringify(freeze, null, 2)}\nchanged\n`);
    await assert.rejects(
      () => verifyCommittedCandidate7FreezeDocument(path, repo, expected),
      /Unexpected non-whitespace|Unexpected token|is not valid JSON/,
    );
    await rm(path);
    await symlink(resolve(repo, "missing-test-fixture"), path);
    await assert.rejects(
      () => verifyCommittedCandidate7FreezeDocument(path, repo, expected),
      /not a regular file/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("freeze CLI exposes no held-out case-file argument", () => {
  const source = readFileSync(script, "utf8");
  assert.equal(
    source.includes('readFile(resolve(root, "blind-c7-20260922/test.json")'),
    false,
  );
  const run = spawnSync(
    process.execPath,
    [script, "--test", "/tmp/cases.json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Unknown option|unknown option/i);
});

test("held-out opener refuses access before a named committed freeze", async () => {
  await assert.rejects(
    () =>
      readCandidate7HeldOutAfterFreeze(
        resolve(
          root,
          "fixtures/guardrail/candidate7/freezes/not-a-freeze.json",
        ),
        "/private/tmp/sf-pi-guardrail-preview-help-20260922",
      ),
    /freeze must be a named tracked|ENOENT/,
  );
});
