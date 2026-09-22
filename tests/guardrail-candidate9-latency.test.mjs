import assert from "node:assert/strict";
import test from "node:test";
import { guardrailRequest } from "../dist/guardrail.js";
import { candidate8OperationSha256 } from "../scripts/guardrail-candidate8-host-core.mjs";
import {
  nearestRankP95,
  summarizeWarmSamples,
  syntheticWorkloads,
} from "../scripts/guardrail-candidate9-latency.mjs";

test("synthetic long request reaches the full guardrail prompt without truncation", () => {
  const { fixedLong, short, long } = syntheticWorkloads();
  assert.ok(short.commandBytes < 100);
  assert.ok(long.commandBytes > 4_096 && long.commandBytes < 8_192);
  assert.ok(fixedLong.commandBytes > 4_096 && fixedLong.commandBytes < 8_192);
  assert.notEqual(fixedLong.operationSha256, long.operationSha256);
  for (const workload of [fixedLong, short, long]) {
    assert.equal(workload.operationSha256, candidate8OperationSha256(workload));
    const request = guardrailRequest(
      {
        version: 2,
        toolName: workload.operation.tool,
        input: workload.operation.input,
        facts: {},
      },
      "jev/guardrail-c8-256",
    );
    assert.equal(request.state.input.command, workload.operation.input.command);
    assert.equal(request.options.template_version, "v2");
    assert.deepEqual(
      request.questions[0].criteria.map((criterion) => criterion.id),
      ["allow", "confirm"],
    );
  }
});

test("warm latency summary retains failures and contended queue time", () => {
  const samples = [
    {
      scenario: "cold_probe",
      status: "answered",
      fullDirectMs: 2_100,
      classifierQueueMs: 0,
    },
    {
      scenario: "sequential",
      status: "answered",
      fullDirectMs: 101,
      classifierQueueMs: 2,
    },
    {
      scenario: "sequential",
      status: "failed",
      fullDirectMs: 751,
      classifierQueueMs: null,
    },
    {
      scenario: "contended",
      status: "answered",
      fullDirectMs: 200,
      classifierQueueMs: 88,
    },
  ];
  const summary = summarizeWarmSamples(samples);
  assert.equal(nearestRankP95([]), null);
  assert.equal(summary.allWarm.calls, 3);
  assert.equal(summary.allWarm.answered, 2);
  assert.equal(summary.allWarm.deadlineMisses, 1);
  assert.equal(summary.allWarm.fullDirectP95Ms, 751);
  assert.equal(summary.contended.queueP95Ms, 88);
  assert.equal(summary.hard750Ms, false);
  assert.equal(summary.idealSub500Ms, false);
});
