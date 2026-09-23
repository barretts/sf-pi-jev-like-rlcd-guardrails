import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { candidate8OperationSha256 } from "../scripts/guardrail-candidate8-host-core.mjs";
import {
  createCandidate9ShadowProvider,
  verifyCandidate9NonModelRoutes,
  verifyCandidate9ValidPopulation,
} from "../scripts/guardrail-candidate9-valid-eval.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pinned = {
  source: "d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f",
  manifest: "b878ada2dde3d6b594b275f69e0dc372586bd8ba370c1ba03d33b0199ea502cc",
  host: "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a",
  baseline: "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421",
  policy: "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
};

// Synthetic requests exercise the join; this test never opens blind VALID.
function population() {
  const cases = Array.from({ length: 160 }, (_, index) => ({
    id: `c9-valid-${String(index + 1).padStart(3, "0")}`,
    group_id: `synthetic-group-${Math.floor(index / 2)}`,
    family: "synthetic",
    fixture: { cwd: "/workspace/synthetic", facts: ["test fixture"] },
    operation: { tool: "bash", input: { command: `printf '%s' ${index}` } },
    expected: { decision: index >= 158 ? "hard_block" : "allow" },
  }));
  const status = cases.map((row, index) => ({
    id: row.id,
    group_id: row.group_id,
    family: row.family,
    expected: row.expected.decision,
    baseline_action: index >= 158 ? "block" : "allow",
    operation_sha256: candidate8OperationSha256(row),
    routing:
      index < 116
        ? "model_prepared"
        : index < 155
          ? "rules_fallback"
          : "pre_model_fallback",
    risk_input_sha256: index < 116 ? "a".repeat(64) : null,
    policy_sha256: pinned.policy,
  }));
  // Exact hard blocks are code-owned floors in the sealed C9 contract.
  for (const row of status.slice(158)) row.routing = "rules_fallback";
  status[152].routing = "pre_model_fallback";
  status[153].routing = "pre_model_fallback";
  return {
    source: { schema_version: "c9.1", split: "valid", cases },
    manifest: {
      source: { case_count: 160, group_count: 80 },
      inventory: { ids: cases.map((row) => row.id) },
    },
    preflight: {
      version: 1,
      mode: "fake-facts-no-model-no-execution",
      source_sha256: pinned.source,
      manifest_sha256: pinned.manifest,
      host_commit: pinned.host,
      host_baseline_sha256: pinned.baseline,
      default_policy_sha256: pinned.policy,
      status,
    },
  };
}

test("C9 replay joins a complete 160-row source to frozen host preparation", () => {
  const { source, manifest, preflight } = population();
  const byId = verifyCandidate9ValidPopulation(source, manifest, preflight);
  assert.equal(byId.size, 160);
  assert.equal(
    [...byId.values()].filter((row) => row.routing === "model_prepared").length,
    116,
  );
});

test("C9 replay rejects changed operation, prepared input, policy, or row count", () => {
  for (const defect of ["operation", "prepared", "policy", "count"]) {
    const { source, manifest, preflight } = population();
    if (defect === "operation")
      source.cases[0].operation.input.command = "different";
    if (defect === "prepared") preflight.status[0].risk_input_sha256 = null;
    if (defect === "policy") preflight.status[0].policy_sha256 = "f".repeat(64);
    if (defect === "count") source.cases.pop();
    assert.throws(
      () => verifyCandidate9ValidPopulation(source, manifest, preflight),
      /C9 VALID replay:/,
      defect,
    );
  }
});

test("C9 replay rejects unexpected errors hidden as code-owned fallbacks", () => {
  const preflight = {
    status: [
      { id: "floor", routing: "rules_fallback", reason: "host_policy_floor" },
      { id: "file", routing: "rules_fallback", reason: "ineligible" },
      {
        id: "org",
        routing: "pre_model_fallback",
        reason: "org_fact_unavailable",
      },
      {
        id: "browser",
        routing: "pre_model_fallback",
        reason: "browser_evidence_unavailable",
      },
    ],
  };
  const rows = [
    {
      id: "floor",
      routing: "rules_fallback",
      modelCalls: 0,
      modelAnswered: false,
      comparison: { source: "exact_policy", reason: "exact_policy_constraint" },
    },
    {
      id: "file",
      routing: "rules_fallback",
      modelCalls: 0,
      modelAnswered: false,
      comparison: { source: "exact_policy", reason: "exact_policy_constraint" },
    },
    {
      id: "org",
      routing: "pre_model_fallback",
      modelCalls: 0,
      modelAnswered: false,
      fallbackReason: "org_fact_unavailable",
      hostReason:
        "Jev Salesforce org identity unverified; using Safety Kernel fallback",
      comparison: {
        source: "rules_fallback",
        reason:
          "Jev Salesforce org identity unverified; using Safety Kernel fallback",
      },
    },
    {
      id: "browser",
      routing: "pre_model_fallback",
      modelCalls: 0,
      modelAnswered: false,
      fallbackReason: "browser_evidence_unavailable",
      hostReason: "Browser reference evidence unavailable before model check",
      comparison: {
        source: "rules_fallback",
        reason: "Browser reference evidence unavailable before model check",
      },
    },
  ];
  assert.doesNotThrow(() => verifyCandidate9NonModelRoutes(rows, preflight));
  for (const index of [0, 1, 2, 3]) {
    const changed = structuredClone(rows);
    changed[index].comparison.reason = "Jev risk evaluation unavailable";
    if (index < 2) changed[index].comparison.source = "rules_fallback";
    if (index >= 2)
      changed[index].hostReason = changed[index].comparison.reason;
    assert.throws(
      () => verifyCandidate9NonModelRoutes(changed, preflight),
      /code-owned fallback route or reason changed/,
    );
  }
});

test("C9 real replay refuses an incomplete model and cutoff invocation before opening VALID", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/guardrail-candidate9-valid-eval.mjs")],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required absolute paths and pins/);
});

test("C9 shadow provider recovers after failure but rejects unexplained worker drift", async () => {
  const pins = {
    scoringProtocolSha256: "a".repeat(64),
    modelSha256: "b".repeat(64),
    calibrationSha256: "c".repeat(64),
    minimumAllowScore: 0.997,
    policySha256: pinned.policy,
    hostBaselineSha256: pinned.baseline,
  };
  const status = {
    ready: false,
    state: "cold",
    generation: 1,
    artifact: { sha256: pins.modelSha256 },
  };
  let disposed = false;
  let classified;
  let failNext = false;
  const backendModule = {
    NativeBackend: class {
      status = status;
      async warmup() {
        status.ready = true;
        status.state = "ready";
      }
    },
    Classifier: class {
      async dispose() {
        disposed = true;
      }
    },
  };
  const guardrail = {
    async classifyGuardrailRisk(...args) {
      classified = args;
      if (failNext) {
        failNext = false;
        status.ready = false;
        status.state = "failed";
        throw new Error("native request deadline");
      }
      if (status.state === "failed") {
        status.generation++;
        status.ready = true;
        status.state = "ready";
      }
      return { action: "abstain", allowScore: 0.8 };
    },
  };
  const listeners = new Map();
  const pi = {
    events: { on: (event, handler) => listeners.set(event, handler) },
  };
  const runtime = await createCandidate9ShadowProvider({
    backendModule,
    guardrail,
    config: {},
    pins,
    modelId: "jev/synthetic-q8_0",
  })(pi, "risk");
  await runtime.warmup();
  const request = { providers: [] };
  listeners.get("risk")(request);
  assert.equal(request.providers.length, 1);
  const provider = request.providers[0];
  assert.equal(provider.version, 2);
  assert.equal(provider.qualified, false);
  assert.equal(provider.protocolSha256, pins.scoringProtocolSha256);
  assert.equal(provider.modelSha256, pins.modelSha256);
  assert.equal(provider.calibrationSha256, pins.calibrationSha256);
  assert.equal(provider.minimumAllowScore, pins.minimumAllowScore);
  assert.equal(provider.calibrationPolicySha256, pins.policySha256);
  assert.equal(provider.calibrationBaselineSha256, pins.hostBaselineSha256);
  const input = { version: 2, toolName: "bash", input: {}, facts: {} };
  const prediction = await provider.evaluate(input);
  assert.equal(prediction.action, "abstain");
  assert.equal(classified[1], input);
  assert.equal(classified[2], "jev/synthetic-q8_0");
  assert.equal(classified[4], pins.minimumAllowScore);
  failNext = true;
  await assert.rejects(() => provider.evaluate(input), /native request deadline/);
  assert.equal(status.ready, false);
  assert.equal((await provider.evaluate(input)).action, "abstain");
  assert.equal(status.generation, 2);
  status.generation = 3;
  await assert.rejects(
    () => provider.evaluate(input),
    /worker or model changed/,
  );
  await runtime.dispose();
  assert.equal(disposed, true);
});
