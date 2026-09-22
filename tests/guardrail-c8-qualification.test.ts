import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
        operationSha256: sha("operation-" + id),
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
  const corpusSha256 = name === "test" ? pin("7") : pin("8");
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
  return {
    split: name,
    corpusSha256,
    hostReportSha256: name === "test" ? pin("9") : pin("0"),
    preflightJson,
    preflightSha256: sha(preflightJson),
    elapsedBasis: "host_total_including_preparation_queue",
    records: rows,
  };
}

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
  return {
    version: 1,
    purpose: "candidate8_real_model_stubbed_enforce_workflow",
    mode: "enforce",
    elapsedBasis:
      "host_risk_check_including_preparation_queue_and_receipt_verification",
    hostBaselineSha256: freeze.identity.hostBaselineSha256,
    hostCommit: "bdbf6292f383a8b2e12cd236aafb2be9c335f463",
    policySha256: freeze.identity.policySha256,
    modelSha256: freeze.identity.modelSha256,
    scoringProtocolSha256: freeze.identity.scoringProtocolSha256,
    calibrationReceiptSha256: freeze.identity.calibrationReceiptSha256,
    freezeSha256: freeze.sha256,
    testCorpusSha256: test.corpusSha256,
    runnerSha256: pin("6"),
    externalToolExecutions: 0,
    records: test.records.map((row) => ({
      id: row.id,
      operationSha256: row.operationSha256,
      baseline: row.baseline,
      actual: row.actual,
      modelEligible: row.modelEligible,
      modelAnswered: row.modelAnswered,
      modelCalls: row.modelCalls,
      source: row.source,
      warmRiskCheckMs: row.modelEligible ? 110 : 1,
      stubOnly: true,
    })),
  };
}

describe("C8 pre-TEST freeze and held-out verifier", () => {
  it("recomputes passing VALID and TEST gates and binds the TRAIN cutoff", () => {
    const selected = calibration();
    const valid = split("validation", selected);
    const freeze = freezeC8Selection(
      selected,
      calReceiptSha,
      valid,
      audits(selected, valid),
      pin("7"),
    );
    expect(freeze.testOpened).toBe(false);
    expect(freeze.identity.criteriaSha256).toBe(
      C8_QUALIFICATION_CRITERIA_SHA256,
    );
    const test = split("test", selected);
    const qualified = qualifyC8Heldout(freeze, test, enforcement(freeze, test));
    expect(qualified.qualified).toBe(true);
    expect(
      verifyC8HeldoutQualification(
        qualified,
        freeze,
        selected,
        calReceiptSha,
        model,
        binary,
      ),
    ).toEqual(qualified);
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
      freezeC8Selection(selected, calReceiptSha, valid, evidence, pin("7")),
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
        pin("7"),
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
        pin("7"),
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
        pin("7"),
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
      pin("7"),
    );
    const test = split("test", selected);
    expect(() => qualifyC8Heldout(freeze, test, undefined as never)).toThrow(
      /enforce workflow/,
    );
    const late = enforcement(freeze, test);
    late.records[0].warmRiskCheckMs = 751;
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
      pin("7"),
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
});
