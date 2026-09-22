import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const worker = fileURLToPath(new URL("../rfdt/worker.py", import.meta.url));
const python = process.env.JEV_RFDT_PYTHON || "python3";

function run(body) {
  const result = spawnSync(python, ["-c", body, worker], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("guardrail pair manifest and plan admit only exact, disjoint TRAIN pairs", () => {
  run(String.raw`
import copy, hashlib, importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
def row(source, group, target):
    return {"id": source + ":risk", "source_id": source, "group": group, "split": "train", "question_id": "risk", "question_type": "choice", "answer_labels": ["allow", "confirm"], "target_probabilities": target, "allowed_token_ids": [2, 3], "prompt_token_ids": [1, len(source), 1 if target == [1, 0] else 2]}
rows = [row("safe-a", "group-a", [1, 0]), row("risky-a", "group-a", [0, 1]), row("safe-b", "group-b", [1, 0]), row("risky-b", "group-b", [0, 1]), row("solo", "group-c", [1, 0])]
record = {"pair_id": "a", "group_id": "group-a", "safe_id": "safe-a", "risky_id": "risky-a"}
manifest = {"version": 1, "pairs": [record, {"pair_id": "b", "group_id": "group-b", "safe_id": "safe-b", "risky_id": "risky-b"}]}
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "pairs.json"
    path.write_text(json.dumps(manifest))
    pairs = worker.read_guardrail_pairs(path, rows)
    assert len(pairs) == 2 and pairs[0]["safe"]["source_id"] == "safe-a"
    units = worker.guardrail_training_units(rows, pairs)
    assert set(units) == {"group-a", "group-b", "group-c"} and units["group-c"][0]["kind"] == "single"
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    plan = {"version": 1, "purpose": "candidate8_train_only", "objective": "guardrail_train_group_pair_margin_v1", "pair_manifest_sha256": sha, "loss": {"pair_margin": 2.0, "anchor_margin": 1.0, "ce_weight": 0.25, "anchor_weight": 0.5}, "cutoff_status": "unset_requires_train_calibration_before_VALID", "validation_rows_passed_to_training": 0, "test_rows_passed_to_training": 0}
    plan_path = Path(directory) / "plan.json"
    plan_path.write_text(json.dumps(plan))
    assert worker.read_guardrail_plan(plan_path, sha) == plan
    def rejects(candidate, source_rows=rows):
        path.write_text(json.dumps(candidate))
        try: worker.read_guardrail_pairs(path, source_rows)
        except ValueError: return
        raise AssertionError("Invalid pair manifest was accepted")
    invalid = copy.deepcopy(manifest); invalid["pairs"][1]["pair_id"] = "a"; rejects(invalid)
    invalid = copy.deepcopy(manifest); invalid["pairs"][1]["safe_id"] = "safe-a"; rejects(invalid)
    invalid = copy.deepcopy(manifest); invalid["pairs"][0]["group_id"] = "group-b"; rejects(invalid)
    invalid = copy.deepcopy(manifest); invalid["pairs"][0]["safe_id"] = "risky-a"; rejects(invalid)
    invalid = copy.deepcopy(manifest); invalid["pairs"][0]["extra"] = "allow"; rejects(invalid)
    invalid = copy.deepcopy(manifest); invalid["pairs"][0]["safe_id"] = "unknown"; rejects(invalid)
    invalid_rows = copy.deepcopy(rows); invalid_rows[0]["split"] = "test"; rejects(manifest, invalid_rows)
    invalid_rows = copy.deepcopy(rows); invalid_rows[0]["target_probabilities"] = [0.8, 0.2]; rejects(manifest, invalid_rows)
    invalid_rows = copy.deepcopy(rows); invalid_rows[0]["prompt_token_ids"] = invalid_rows[1]["prompt_token_ids"]; rejects(manifest, invalid_rows)
    path.write_text(json.dumps(manifest))
    for field, changed in [("pair_manifest_sha256", "0" * 64), ("cutoff_status", "ready"), ("validation_rows_passed_to_training", 1)]:
        invalid = copy.deepcopy(plan); invalid[field] = changed; plan_path.write_text(json.dumps(invalid))
        try: worker.read_guardrail_plan(plan_path, sha)
        except ValueError: pass
        else: raise AssertionError("Changed TRAIN plan was accepted")
    invalid = copy.deepcopy(plan); invalid["loss"]["anchor_margin"] = 4.0; plan_path.write_text(json.dumps(invalid))
    try: worker.read_guardrail_plan(plan_path, sha)
    except ValueError: pass
    else: raise AssertionError("Changed objective margin was accepted")
`);
});

test("pair and singleton derivatives match finite differences, including extreme logits", () => {
  run(String.raw`
import importlib.util, math, sys
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
epsilon = 1e-5
for safe, risky in [(0.2, -0.4), (8.0, -8.0), (-40.0, 40.0)]:
    ds, dr = worker.guardrail_pair_derivatives(safe, risky)
    numeric_safe = (worker.guardrail_pair_loss(safe + epsilon, risky) - worker.guardrail_pair_loss(safe - epsilon, risky)) / (2 * epsilon)
    numeric_risky = (worker.guardrail_pair_loss(safe, risky + epsilon) - worker.guardrail_pair_loss(safe, risky - epsilon)) / (2 * epsilon)
    assert math.isclose(ds, numeric_safe, abs_tol=1e-6)
    assert math.isclose(dr, numeric_risky, abs_tol=1e-6)
    for margin, is_safe in [(safe, True), (risky, False)]:
        numeric = (worker.guardrail_row_loss(margin + epsilon, is_safe) - worker.guardrail_row_loss(margin - epsilon, is_safe)) / (2 * epsilon)
        assert math.isclose(worker.guardrail_row_derivative(margin, is_safe), numeric, abs_tol=1e-6)
`);
});

test(
  "tiny random Gemma direct and sequential gradients agree within a bounded memory envelope",
  { skip: !process.env.JEV_RFDT_PYTHON },
  () => {
    const result = spawnSync(python, [worker, "pair-self-test"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(report.ok, true);
    assert.equal(
      report.fixture,
      "random_tiny_gemma3_pair_no_checkpoint_weights",
    );
    assert.equal(report.full_context_gradient_verified, true);
    assert.ok(report.max_gradient_delta <= 1e-4);
    assert.ok(report.sequential_peak_memory_bytes < 128 * 1024 * 1024);
  },
);
