import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonical } from "../src/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../src/guardrail.js";
import {
  C8_BASE_PROTOCOL_SHA256,
  selectC8Calibration,
  type C8CalibrationReceipt,
} from "../src/guardrail-calibration.js";
import {
  C8_QUALIFICATION_CRITERIA_SHA256,
  freezeC8Selection,
  qualifyC8Heldout,
  serializeC8ProvisionalStubReceipt,
  stageC8ProvisionalStubReceipt,
  verifyC8HeldoutQualification,
  type C8AgentAuditEvidence,
  type C8EnforcementEvidence,
  type C8QualificationRow,
  type C8SplitEvidence,
} from "../src/guardrail-c8-qualification.js";

const pin = (character: string) => character.repeat(64);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const model = pin("a");
const binary = pin("b");
const calReceiptSha = pin("c");
const families = [
  "shell",
  "herdr",
  "files",
  "salesforce",
  "apex",
  "agentscript",
  "data360",
  "soql",
  "canvas",
  "browser",
];

function calibration(): C8CalibrationReceipt {
  const fitGroups = Array.from(
    { length: 77 },
    (_unused, i) => "fit-group-" + (i + 1),
  );
  const cases = Array.from({ length: 47 }, (_unused, i) => ({
    id: "cal-" + (i + 1),
    groupId: "cal-group-" + ((i % 17) + 1),
    expected: (i % 2 === 0 ? "allow" : "confirm") as "allow" | "confirm",
  }));
  return selectC8Calibration({
    version: 1,
    purpose: "candidate8_train_calibration_only",
    modelSha256: model,
    nativeBinarySha256: binary,
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    baselineSha256: pin("d"),
    policySha256: pin("e"),
    baselineReceiptSha256: pin("f"),
    admissionSha256: pin("1"),
    fitSha256: pin("2"),
    calibrationCorpusSha256: pin("3"),
    fitGroups,
    cases,
    records: cases.map((item) => ({
      ...item,
      baseline: item.expected,
      gate: "prepared",
      modelAnswered: true,
      inputSha256: sha(item.id),
      allowScore: item.expected === "allow" ? 0.99 : 0.1,
      elapsedMs: 10,
    })),
  });
}

function split(
  name: "validation" | "test",
  selected = calibration(),
): C8SplitEvidence {
  const rows: C8QualificationRow[] = Array.from(
    { length: 96 },
    (_unused, i) => {
      const id =
        "c8-" +
        (name === "validation" ? "valid" : "test") +
        "-" +
        String(i + 1).padStart(3, "0");
      const expected = i === 95 ? "block" : i % 2 === 0 ? "allow" : "confirm";
      const modelEligible = i < 59;
      return {
        id,
        groupId: name + "-group-" + (Math.floor(i / 2) + 1),
        family: families[i % families.length],
        expected,
        baseline: expected,
        actual: expected,
        modelEligible,
        modelAnswered: modelEligible,
        modelCalls: modelEligible ? 1 : 0,
        policyFloor: !modelEligible,
        inputSha256: modelEligible ? sha("prepared-" + id) : null,
        operationSha256: sha(
          canonical({
            toolName: "bash",
            input: { command: `echo ${id}` },
            cwd: `/workspace/${name}`,
          }),
        ),
        elapsedMs: modelEligible ? 100 : 1,
        source: modelEligible ? "jev" : "exact_policy",
        ...(modelEligible
          ? {
              prediction: expected as "allow" | "confirm",
              allowScore: expected === "allow" ? 0.99 : 0.1,
              modelSha256: model,
              protocolSha256: selected.scoringProtocolSha256!,
              calibrationSha256: calReceiptSha,
              minimumAllowScore: selected.minimumAllowScore!,
              policySha256: pin("e"),
            }
          : {}),
      };
    },
  );
  const testCorpusJson =
    name === "test"
      ? JSON.stringify({
          schema_version: "c8.2",
          split: "test",
          cases: rows.map((row) => ({
            id: row.id,
            family: row.family,
            group_id: row.groupId,
            fixture: { cwd: `/workspace/${name}` },
            operation: { tool: "bash", input: { command: `echo ${row.id}` } },
            expected: {
              decision:
                row.expected === "confirm"
                  ? "require_approval"
                  : row.expected === "block"
                    ? "hard_block"
                    : "allow",
            },
          })),
        })
      : undefined;
  const corpusSha256 = testCorpusJson ? sha(testCorpusJson) : pin("8");
  const preflight = {
    source_sha256: corpusSha256,
    host_baseline_sha256: pin("d"),
    host_commit: "bdbf6292f383a8b2e12cd236aafb2be9c335f463",
    jev_runtime_commit: "b".repeat(40),
    preflight_script_sha256: pin("4"),
    rubric_sha256: pin("5"),
    decision_base_protocol_sha256: C8_BASE_PROTOCOL_SHA256,
    scorer_prompt_sha256: GUARDRAIL_PROTOCOL_SHA256,
    status: rows.map((row) => ({
      id: row.id,
      family: row.family,
      group_id: row.groupId,
      expected: row.expected,
      operation_sha256: row.operationSha256,
      routing: row.modelEligible ? "model_prepared" : "rules_fallback",
      baseline_action: row.baseline,
      risk_input_sha256: row.inputSha256,
    })),
  };
  const preflightJson = JSON.stringify(preflight);
  const preflightSha256 = sha(preflightJson);
  const hostReportJson = JSON.stringify({
    providerKind: "real",
    elapsedBasis: "host_total_including_preparation_queue",
    source: {
      [name === "validation" ? "valid" : "test"]: corpusSha256,
      preflight: preflightSha256,
    },
    records: rows.map((row) => ({
      ...row,
      ...(row.source === "jev"
        ? {
            effectivePolicySha256: row.policySha256,
            comparison: {
              modelSha256: row.modelSha256,
              protocolSha256: row.protocolSha256,
              calibrationSha256: row.calibrationSha256,
              minimumAllowScore: row.minimumAllowScore,
            },
          }
        : {}),
    })),
  });
  return {
    split: name,
    corpusSha256,
    ...(testCorpusJson ? { testCorpusJson } : {}),
    hostReportSha256: sha(hostReportJson),
    hostReportJson,
    preflightJson,
    preflightSha256,
    elapsedBasis: "host_total_including_preparation_queue",
    records: rows,
  };
}

const testSeal = (selected: C8CalibrationReceipt) =>
  split("test", selected).corpusSha256;

function audits(
  selected: C8CalibrationReceipt,
  valid: C8SplitEvidence,
): C8AgentAuditEvidence {
  const rubricSha256 = pin("5");
  const fitRows = Array.from({ length: 226 }, (_unused, i) => ({
    id: "fit-" + (i + 1),
    partition: "fit",
    groupId: selected.input.fitGroups[i % 77],
    expected: i % 2 === 0 ? "allow" : "confirm",
    disposition: "agree",
    rowSha256: sha("fit-" + (i + 1)),
  }));
  const calRows = selected.input.cases.map((item) => ({
    id: item.id,
    partition: "calibration",
    groupId: item.groupId,
    expected: item.expected,
    disposition: "agree",
    rowSha256: sha(item.id),
  }));
  const trainJson = JSON.stringify({
    version: 1,
    purpose: "candidate8_independent_label_audit",
    qualification: false,
    heldOutValidRead: false,
    heldOutTestRead: false,
    independentLabelAudit: {
      status: "agent_reviewed",
      humanSignoff: false,
      allAdmittedRowsReviewed: true,
      unresolvedSuspectedMislabels: 0,
    },
    source: {
      fit: { sha256: selected.input.fitSha256, rows: 226, groups: 77 },
      calibration: {
        sha256: selected.input.calibrationCorpusSha256,
        rows: 47,
        groups: 17,
      },
      admissionSha256: selected.input.admissionSha256,
      rubricSha256,
      sfPiCommit: "a".repeat(40),
      sfPiBaselineIdentitySha256: pin("d"),
    },
    summary: {
      reviewedRows: 273,
      fitRows: 226,
      calibrationRows: 47,
      agreeRows: 273,
      limitRows: 0,
      suspectedMislabelRows: 0,
    },
    reviewedRows: [...fitRows, ...calRows],
  });
  const validationJson = JSON.stringify({
    version: 1,
    purpose: "candidate8_valid_agent_label_audit",
    split: "validation",
    validCorpusSha256: valid.corpusSha256,
    rubricSha256,
    reviewer: "codex_agent",
    humanSignoff: false,
    reviewedCases: 96,
    reviewedGroups: 48,
    unresolvedSuspectedMislabels: 0,
    limitsRequireHumanAdjudication: 0,
    records: valid.records.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      disposition: "agree",
    })),
  });
  return {
    trainJson,
    trainSha256: sha(trainJson),
    validationJson,
    validationSha256: sha(validationJson),
  };
}

function enforcement(
  freeze: ReturnType<typeof freezeC8Selection>,
  test: C8SplitEvidence,
): C8EnforcementEvidence {
  const provisional = stageC8ProvisionalStubReceipt(freeze, test);
  const report = {
    version: 1,
    purpose: "candidate8_real_model_stubbed_enforce_workflow" as const,
    mode: "enforce" as const,
    elapsedBasis:
      "host_risk_check_including_preparation_queue_and_receipt_verification" as const,
    hostBaselineSha256: freeze.identity.hostBaselineSha256,
    hostCommit: "bdbf6292f383a8b2e12cd236aafb2be9c335f463",
    policySha256: freeze.identity.policySha256,
    modelSha256: freeze.identity.modelSha256,
    scoringProtocolSha256: freeze.identity.scoringProtocolSha256,
    calibrationReceiptSha256: freeze.identity.calibrationReceiptSha256,
    freezeSha256: freeze.sha256,
    testCorpusSha256: test.corpusSha256,
    runnerSha256: pin("6"),
    provisionalReceiptSha256: sha(
      serializeC8ProvisionalStubReceipt(provisional),
    ),
    nativeBinarySha256: freeze.identity.nativeBinarySha256,
    providerKind: "real_jev_native_delegate" as const,
    delegatedModelCalls: test.records.filter((row) => row.modelEligible).length,
    externalToolExecutions: 0 as const,
    records: test.records.map((row) => ({
      id: row.id,
      operationSha256: row.operationSha256,
      baseline: row.baseline,
      actual: row.actual,
      modelEligible: row.modelEligible,
      modelAnswered: row.modelAnswered,
      modelCalls: row.modelCalls,
      modelDelegated: row.modelEligible,
      source: row.source,
      warmRiskCheckMs: row.modelEligible ? 110 : 1,
      stubOnly: true,
    })),
  };
  const hostReportJson = JSON.stringify(report) + "\n";
  return { ...report, hostReportJson, hostReportSha256: sha(hostReportJson) };
}

function rebindEnforcementReport(value: C8EnforcementEvidence) {
  const { hostReportJson: _raw, hostReportSha256: _sha, ...report } = value;
  value.hostReportJson = JSON.stringify(report) + "\n";
  value.hostReportSha256 = sha(value.hostReportJson);
}

describe("C8 pre-TEST freeze and held-out verifier", () => {
  it("recomputes split gates but never qualifies rejected C8 without an independent TEST baseline seal", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    expect(freeze.testOpened).toBe(false);
    expect(freeze.identity.criteriaSha256).toBe(
      C8_QUALIFICATION_CRITERIA_SHA256,
    );
    const test = split("test", selected);
    const qualified = qualifyC8Heldout(freeze, test, enforcement(freeze, test));
    expect(qualified.testGates.unsafeAllows).toBe(true);
    expect(qualified.enforcementGates.independentBaseline).toBe(false);
    expect(qualified.qualified).toBe(false);
    expect(() =>
      verifyC8HeldoutQualification(
        qualified,
        freeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toThrow(/qualification changed|failed/);
  });

  it("rejects unresolved agent-label disputes without treating agent review as human signoff", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const evidence = audits(selected, valid);
    const changed = JSON.parse(evidence.validationJson);
    changed.unresolvedSuspectedMislabels = 1;
    changed.records[0].disposition = "suspected_mislabel";
    evidence.validationJson = JSON.stringify(changed);
    evidence.validationSha256 = sha(evidence.validationJson);
    expect(() =>
      freezeC8Selection(
        selected,
        calReceiptSha,
        valid,
        evidence,
        testSeal(selected),
      ),
    ).toThrow(/audit/);
  });

  it("rejects a same-ID operation mismatch in the independent model-free preflight", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const preflight = JSON.parse(valid.preflightJson);
    preflight.status[0].operation_sha256 = pin("f");
    valid.preflightJson = JSON.stringify(preflight);
    valid.preflightSha256 = sha(valid.preflightJson);
    expect(() =>
      freezeC8Selection(
        selected,
        calReceiptSha,
        valid,
        audits(selected, valid),
        testSeal(selected),
      ),
    ).toThrow(/preflight/);
  });

  it("rejects attempted fallback, missing model calls, and partial timing", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    valid.records[0].modelCalls = 0;
    expect(() =>
      freezeC8Selection(
        selected,
        calReceiptSha,
        valid,
        audits(selected, valid),
        testSeal(selected),
      ),
    ).toThrow(/model-eligible/);
    const partial = split("validation", selected);
    partial.elapsedBasis = "model_only" as C8SplitEvidence["elapsedBasis"];
    expect(() =>
      freezeC8Selection(
        selected,
        calReceiptSha,
        partial,
        audits(selected, partial),
        testSeal(selected),
      ),
    ).toThrow(/host split evidence/);
  });

  it("does not qualify from shadow latency without real-model stubbed enforce evidence", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    const test = split("test", selected);
    expect(() => qualifyC8Heldout(freeze, test, undefined as never)).toThrow(
      /enforce workflow/,
    );
    const late = enforcement(freeze, test);
    late.records[0].warmRiskCheckMs = 751;
    rebindEnforcementReport(late);
    const rejected = qualifyC8Heldout(freeze, test, late);
    expect(rejected.qualified).toBe(false);
    expect(rejected.enforcementGates.latency).toBe(false);
    expect(() =>
      verifyC8HeldoutQualification(
        rejected,
        freeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toThrow(/qualification changed|failed/);
  });

  it("rejects changed model, cutoff, operation, TEST inventory and group overlap", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    const test = split("test", selected);
    const qualified = qualifyC8Heldout(freeze, test, enforcement(freeze, test));
    expect(() =>
      verifyC8HeldoutQualification(
        qualified,
        freeze,
        selected,
        calReceiptSha,
        pin("9"),
        binary,
      ),
    ).toThrow(/changed|match/);
    const changedFreeze = structuredClone(freeze);
    changedFreeze.identity.minimumAllowScore = 0.6;
    expect(() =>
      verifyC8HeldoutQualification(
        qualified,
        changedFreeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toThrow(/changed/);
    const changedTest = structuredClone(qualified);
    changedTest.test.records[0].operationSha256 = pin("9");
    expect(() =>
      verifyC8HeldoutQualification(
        changedTest,
        freeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toThrow(/preflight/);
    const wrongInventory = split("test", selected);
    wrongInventory.records[0].id = "c8-test-unknown";
    expect(() =>
      qualifyC8Heldout(
        freeze,
        wrongInventory,
        enforcement(freeze, wrongInventory),
      ),
    ).toThrow(/inventory|preflight/);
    const overlap = split("test", selected);
    overlap.records[0].groupId = freeze.validation.records[0].groupId;
    expect(() =>
      qualifyC8Heldout(freeze, overlap, enforcement(freeze, overlap)),
    ).toThrow(/overlaps/);
  });

  it("binds TEST gold and original operations to the exact sealed corpus bytes", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    const test = split("test", selected);
    const risky = test.records[1];
    expect(risky.expected).toBe("confirm");
    risky.expected = "allow";
    risky.baseline = "allow";
    risky.actual = "allow";
    risky.prediction = "allow";
    risky.allowScore = 0.99;
    const preflight = JSON.parse(test.preflightJson);
    preflight.status[1].expected = "allow";
    preflight.status[1].baseline_action = "allow";
    test.preflightJson = JSON.stringify(preflight);
    test.preflightSha256 = sha(test.preflightJson);
    const report = JSON.parse(test.hostReportJson);
    report.source.preflight = test.preflightSha256;
    Object.assign(report.records[1], risky);
    test.hostReportJson = JSON.stringify(report);
    test.hostReportSha256 = sha(test.hostReportJson);
    expect(() => stageC8ProvisionalStubReceipt(freeze, test)).toThrow(
      /sealed gold/,
    );
  });

  it("binds scored outcomes, score and timing to exact host report bytes", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    const test = split("test", selected);
    test.records[1].actual = "allow";
    test.records[1].prediction = "allow";
    test.records[1].allowScore = 0.99;
    expect(() => stageC8ProvisionalStubReceipt(freeze, test)).toThrow(
      /raw host report/,
    );
    const unchanged = split("test", selected);
    unchanged.records[0].elapsedMs = 10;
    expect(() => stageC8ProvisionalStubReceipt(freeze, unchanged)).toThrow(
      /raw host report/,
    );
  });

  it("does not accept a self-consistent relabel of the TEST baseline", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    const test = split("test", selected);
    const safe = test.records[0];
    expect(safe.expected).toBe("allow");
    safe.actual = "confirm";
    safe.prediction = "confirm";
    safe.allowScore = 0.1;
    let report = JSON.parse(test.hostReportJson);
    Object.assign(report.records[0], safe);
    test.hostReportJson = JSON.stringify(report);
    test.hostReportSha256 = sha(test.hostReportJson);
    expect(() => stageC8ProvisionalStubReceipt(freeze, test)).toThrow(
      /shadow gates failed/,
    );

    safe.baseline = "confirm";
    const preflight = JSON.parse(test.preflightJson);
    preflight.status[0].baseline_action = "confirm";
    test.preflightJson = JSON.stringify(preflight);
    test.preflightSha256 = sha(test.preflightJson);
    report = JSON.parse(test.hostReportJson);
    report.source.preflight = test.preflightSha256;
    report.records[0].baseline = "confirm";
    test.hostReportJson = JSON.stringify(report);
    test.hostReportSha256 = sha(test.hostReportJson);
    const measured = qualifyC8Heldout(freeze, test, enforcement(freeze, test));
    expect(measured.testGates.benign).toBe(true);
    expect(measured.enforcementGates.independentBaseline).toBe(false);
    expect(measured.qualified).toBe(false);
    expect(() =>
      verifyC8HeldoutQualification(
        measured,
        freeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toThrow(/qualification changed|failed/);
  });

  it("requires actual delegated native calls and keeps a provisional receipt non-qualifying", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      testSeal(selected),
    );
    const test = split("test", selected);
    const provisional = stageC8ProvisionalStubReceipt(freeze, test);
    expect(provisional.provisionalStubOnly).toBe(true);
    expect(provisional.purpose).toBe("candidate8_stub_measurement_only");
    expect(provisional.qualified).toBe(false);
    expect(() =>
      verifyC8HeldoutQualification(
        provisional,
        freeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toThrow(/enforce workflow/);
    const missing = enforcement(freeze, test);
    missing.delegatedModelCalls = 0;
    rebindEnforcementReport(missing);
    expect(() => qualifyC8Heldout(freeze, test, missing)).toThrow(
      /enforce workflow/,
    );
    const forged = enforcement(freeze, test);
    forged.records[0].modelDelegated = false;
    rebindEnforcementReport(forged);
    const rejected = qualifyC8Heldout(freeze, test, forged);
    expect(rejected.qualified).toBe(false);
    expect(rejected.enforcementGates.complete).toBe(false);
    const wrongReceipt = enforcement(freeze, test);
    wrongReceipt.provisionalReceiptSha256 = pin("f");
    rebindEnforcementReport(wrongReceipt);
    expect(() => qualifyC8Heldout(freeze, test, wrongReceipt)).toThrow(
      /enforce workflow/,
    );
  });
});
