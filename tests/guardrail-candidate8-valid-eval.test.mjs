import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  C8_VALID_SEAL,
  summarizeCandidate8Valid,
  verifyCandidate8ValidPopulation,
} from "../scripts/guardrail-candidate8-valid-eval.mjs";
import {
  assertCandidate8PreparedCall,
  createCandidate8Recorder,
} from "../scripts/guardrail-candidate8-host-core.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (name) =>
  JSON.parse(await readFile(resolve(root, "blind-c8-20260922", name), "utf8"));

test("VALID wrapper accepts only the corrected host-pinned population", async () => {
  const source = await readJson("valid.json");
  const receipt = await readJson("valid-host-preflight.json");
  const byId = verifyCandidate8ValidPopulation(source, receipt);
  assert.equal(byId.size, C8_VALID_SEAL.cases);
  assert.equal(
    [...byId.values()].filter((row) => row.routing === "model_prepared").length,
    C8_VALID_SEAL.modelPrepared,
  );
  assert.equal(
    [...byId.values()].filter((row) => row.routing === "pre_model_fallback")
      .length,
    C8_VALID_SEAL.preModelFallbacks,
  );
  assert.throws(
    () =>
      verifyCandidate8ValidPopulation(source, {
        ...receipt,
        host_commit: "0".repeat(40),
      }),
    /host identity/,
  );
  assert.throws(
    () =>
      verifyCandidate8ValidPopulation(source, {
        ...receipt,
        status: [...receipt.status].reverse(),
      }),
    /case\/preflight/,
  );
  assert.throws(
    () =>
      verifyCandidate8ValidPopulation({ ...source, split: "train" }, receipt),
    /source, receipt/,
  );
});

test("prepared request must preserve original operation and independent facts", async () => {
  const source = await readJson("valid.json");
  const receipt = await readJson("valid-host-preflight.json");
  const row = source.cases.find((item) => item.id === "c8-valid-001");
  const status = receipt.status.find((item) => item.id === row.id);
  const input = {
    version: 2,
    toolName: row.operation.tool,
    input: row.operation.input,
    facts: {},
  };
  assert.throws(
    () =>
      assertCandidate8PreparedCall(
        row,
        { input, inputSha256: "0".repeat(64) },
        status,
      ),
    /differs/,
  );
  assert.throws(
    () =>
      assertCandidate8PreparedCall(
        row,
        {
          input: { ...input, input: { command: "rm -rf /" } },
          inputSha256: status.risk_input_sha256,
        },
        status,
      ),
    /differs/,
  );
  assert.throws(
    () =>
      assertCandidate8PreparedCall(
        row,
        {
          input: { ...input, classification: "allow" },
          inputSha256: status.risk_input_sha256,
        },
        status,
      ),
    /differs/,
  );
});

test("recorder is an event seam with no tool execution surface", () => {
  const recorder = createCandidate8Recorder();
  const seen = [];
  recorder.events.on("provider", (request) => seen.push(request));
  recorder.events.emit("provider", { id: 1 });
  assert.deepEqual(seen, [{ id: 1 }]);
  assert.equal("registerTool" in recorder, false);
});

test("VALID summary rejects incomplete replay and counts attempted fallback", () => {
  assert.throws(() => summarizeCandidate8Valid([], "fake"), /Incomplete/);
  const rows = Array.from({ length: C8_VALID_SEAL.cases }, (_, index) => ({
    id: `c8-valid-${String(index + 1).padStart(3, "0")}`,
    groupId: `g-${Math.floor(index / 2)}`,
    family: "shell",
    expected: "allow",
    baseline: "allow",
    actual: "allow",
    routing:
      index < C8_VALID_SEAL.modelPrepared ? "model_prepared" : "rules_fallback",
    modelAnswered: index !== 0,
    elapsedMs: 1,
    ...(index === 0 ? { error: "provider failed" } : {}),
  }));
  const result = summarizeCandidate8Valid(rows, "fake");
  assert.equal(result.metrics.attemptedModelFallbacks, 1);
  assert.equal(result.gates.allPreparedModelCallsAnswered, false);
  assert.equal(result.gates.humanLabelReviewComplete, false);
});
