import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";
import { canonical } from "../dist/core.js";
import {
  GUARDRAIL_PROTOCOL_SHA256,
  guardrailRequest,
} from "../dist/guardrail.js";
import {
  prepareCandidate9CalibrationRows,
  scoreCandidate9Calibration,
} from "../scripts/guardrail-candidate9-cal-score.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = {
  arm: "A",
  promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
  hostCommit: "a".repeat(40),
  baselineSha256: "b".repeat(64),
  policySha256: "c".repeat(64),
  admissionSha256: "d".repeat(64),
  fitSha256: "e".repeat(64),
  calibrationCorpusSha256: "f".repeat(64),
  pairManifestSha256: "1".repeat(64),
  familyManifestSha256: "2".repeat(64),
  objectivePlanSha256: "3".repeat(64),
};
const modelId = "jev/c9-fake";
const baseModel = "google/gemma-3-1b-it";
function row(id, groupId, command, expected) {
  const state = { version: 2, toolName: "bash", input: { command }, facts: {} };
  return {
    id,
    group_id: groupId,
    split: "calibration",
    request: guardrailRequest(state, baseModel),
    targets: { risk: { answer: expected } },
  };
}
function source() {
  return {
    identity,
    fitGroups: ["fit-1", "fit-2"],
    rows: [
      row("cal-2", "cal-risk", "rm -rf /tmp/example", "confirm"),
      row("cal-1", "cal-safe", "git status --short", "allow"),
    ],
  };
}
function fakeClassifier({ failAt = -1, malformedAt = -1 } = {}) {
  const seen = [];
  return {
    seen,
    async classify(request) {
      assert.equal(request.model, modelId);
      assert.equal(Object.hasOwn(request.state, "baseline"), false);
      assert.equal(Object.hasOwn(request, "targets"), false);
      seen.push(request.state);
      if (seen.length - 1 === failAt) throw new Error("mock worker failure");
      return {
        model: request.model,
        answers: {
          risk: {
            type: "choice",
            choice: "allow",
            probabilities:
              seen.length - 1 === malformedAt
                ? { allow: 2, confirm: -1 }
                : { allow: 0.995, confirm: 0.005 },
          },
        },
        usage: { input_tokens: 32, output_tokens: 0 },
      };
    },
  };
}
const model = {
  modelId,
  modelSha256: "4".repeat(64),
  nativeBinarySha256: "5".repeat(64),
};

test("C9 scorer emits the exact selector case and record contract for every admitted row", async () => {
  const classifier = fakeClassifier();
  const report = await scoreCandidate9Calibration(source(), {
    classifier,
    ...model,
  });
  assert.equal(report.purpose, "candidate9_train_calibration_only");
  assert.deepEqual(
    report.cases.map((item) => item.id),
    ["cal-1", "cal-2"],
  );
  assert.equal(classifier.seen.length, 2);
  assert.deepEqual(
    report.cases.map((item) => item.inputSha256),
    classifier.seen.map((state) => sha(canonical(state))),
  );
  assert.ok(
    report.records.every(
      (item) =>
        item.gate === "prepared" &&
        item.modelAnswered === true &&
        item.modelCalls === 1 &&
        item.allowScore === 0.995 &&
        item.elapsedMs >= 0 &&
        item.elapsedMs < 750,
    ),
  );
  assert.deepEqual(Object.keys(report.records[0]).sort(), [
    "allowScore",
    "elapsedMs",
    "expected",
    "gate",
    "groupId",
    "id",
    "inputSha256",
    "modelAnswered",
    "modelCalls",
  ]);
  assert.equal(Object.hasOwn(report, "failures"), false);
});

test("C9 scorer preserves failed and malformed calls and keeps scoring the inventory", async () => {
  for (const classifier of [
    fakeClassifier({ failAt: 0 }),
    fakeClassifier({ malformedAt: 0 }),
  ]) {
    const report = await scoreCandidate9Calibration(source(), {
      classifier,
      ...model,
    });
    assert.equal(report.purpose, "candidate9_train_calibration_attempt");
    assert.equal(report.records.length, 2);
    assert.equal(classifier.seen.length, 2);
    assert.equal(report.records[0].modelAnswered, false);
    assert.equal(report.records[0].modelCalls, 1);
    assert.equal(report.records[0].allowScore, null);
    assert.equal(report.records[0].elapsedMs, null);
    assert.equal(report.records[1].modelAnswered, true);
    assert.equal(report.failures.length, 1);
  }
});

test("C9 scorer rejects a late direct check without dropping its attempted call", async () => {
  const classifier = fakeClassifier();
  let tick = 0;
  const report = await scoreCandidate9Calibration(source(), {
    classifier,
    ...model,
    now: () => (tick++ % 3 === 0 ? 0 : 751),
  });
  assert.equal(classifier.seen.length, 2);
  assert.equal(report.purpose, "candidate9_train_calibration_attempt");
  assert.ok(report.records.some((item) => !item.modelAnswered));
  assert.ok(report.failures.some((item) => /late/.test(item.reason)));
});

test("C9 scorer refuses FIT overlap and a changed direct scoring request", () => {
  const overlap = source();
  overlap.rows[0].group_id = "fit-1";
  assert.throws(
    () => prepareCandidate9CalibrationRows(overlap.rows, overlap.fitGroups),
    /overlaps FIT/,
  );
  const changed = source();
  changed.rows[0].request.questions[0].instructions = "changed rubric";
  assert.throws(
    () => prepareCandidate9CalibrationRows(changed.rows, changed.fitGroups),
    /direct Jev protocol/,
  );
});
