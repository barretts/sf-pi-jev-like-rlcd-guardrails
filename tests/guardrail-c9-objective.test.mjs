import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const worker = fileURLToPath(new URL("../rfdt/worker.py", import.meta.url));
const python = process.env.JEV_RFDT_PYTHON || "python3";

function run(code) {
  const result = spawnSync(python, ["-B", "-c", code, worker], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("C9 arm plans and FIT family map bind exact source IDs, groups, labels and parameters", () => {
  run(String.raw`
import copy, hashlib, importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("worker", sys.argv[1]); w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
def row(source, group, target):
    return {"id": source + ":risk", "source_id": source, "group": group, "split": "train", "question_id": "risk", "question_type": "choice", "answer_labels": ["allow", "confirm"], "target_probabilities": target, "allowed_token_ids": [2, 3], "prompt_token_ids": [1, len(source), 1 if target == [1, 0] else 2]}
rows = [row("a-safe", "group-a", [1,0]), row("a-risk", "group-a", [0,1]), row("b-safe", "group-b", [1,0]), row("b-risk", "group-b", [0,1]), row("solo", "group-c", [1,0])]
family = {"version": 1, "purpose": "candidate9_fit_families", "rows": [{"id": r["source_id"], "group_id": r["group"], "family": "shell" if r["group"] == "group-a" else "data360", "expected": "allow" if r["target_probabilities"] == [1,0] else "confirm"} for r in rows]}
pairs = {"version": 1, "pairs": [{"pair_id":"a", "group_id":"group-a", "safe_id":"a-safe", "risky_id":"a-risk"}, {"pair_id":"b", "group_id":"group-b", "safe_id":"b-safe", "risky_id":"b-risk"}]}
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory); family_path = root / "families.json"; pair_path = root / "pairs.json"; plan_path = root / "plan.json"
    family_path.write_text(json.dumps(family)); pair_path.write_text(json.dumps(pairs))
    family_sha = hashlib.sha256(family_path.read_bytes()).hexdigest(); pair_sha = hashlib.sha256(pair_path.read_bytes()).hexdigest()
    assert w.read_guardrail_families(family_path, rows)["a-safe"] == "shell"
    admitted_pairs = w.read_guardrail_pairs(pair_path, rows)
    def plan(arm):
        return {"version":2,"purpose":"candidate9_train_only","arm":arm,"objective":"guardrail_train_group_pair_margin_v1" if arm == "A" else "guardrail_train_balanced_symmetric_v1","pair_manifest_sha256":pair_sha,"family_manifest_sha256":family_sha,"loss":{"pair_margin":2.0,"anchor_margin":1.0,"ce_weight":0.25,"anchor_weight":0.5} if arm == "A" else copy.deepcopy(w.C9_B_LOSS),"sampler":{"mode":"c8_group_balanced","seed":42} if arm == "A" else copy.deepcopy(w.C9_B_SAMPLER),"steps":256,"cutoff_status":"unset_requires_c9_train_cal_hard_veto_before_valid","validation_rows_passed_to_training":0,"test_rows_passed_to_training":0}
    for arm in ("A", "B"):
        value = plan(arm); plan_path.write_text(json.dumps(value)); assert w.read_guardrail_plan(plan_path, pair_sha, family_sha256=family_sha) == value
    def reject_family(changed):
        family_path.write_text(json.dumps(changed))
        try: w.read_guardrail_families(family_path, rows)
        except ValueError: return
        raise AssertionError("Invalid FIT family map accepted")
    changed = copy.deepcopy(family); changed["rows"][0]["expected"] = "confirm"; reject_family(changed)
    changed = copy.deepcopy(family); changed["rows"][0]["group_id"] = "group-b"; reject_family(changed)
    changed = copy.deepcopy(family); changed["rows"][0]["id"] = "unknown"; reject_family(changed)
    changed = copy.deepcopy(family); changed["rows"].append(changed["rows"][0]); reject_family(changed)
    def reject_plan(changed):
        plan_path.write_text(json.dumps(changed))
        try: w.read_guardrail_plan(plan_path, pair_sha, family_sha256=family_sha)
        except ValueError: return
        raise AssertionError("Changed arm plan accepted")
    for field, value in (("family_manifest_sha256", "0"*64), ("steps", 512), ("cutoff_status", "selected"), ("test_rows_passed_to_training", 1)):
        changed = plan("B"); changed[field] = value; reject_plan(changed)
    changed = plan("B"); changed["loss"]["pair_weight"] = 0; reject_plan(changed)
    changed = plan("B"); changed["sampler"]["pair_fraction"] = 0.75; reject_plan(changed)
    assert len(admitted_pairs) == 2
`);
});

test("C9 B symmetric anchors and pair separation match finite differences", () => {
  run(String.raw`
import importlib.util, math, sys
spec = importlib.util.spec_from_file_location("worker", sys.argv[1]); w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
epsilon = 1e-5
for safe, risky in ((0.2,-0.4), (8,-8), (-40,40)):
    ds, dr = w.c9b_pair_derivatives(safe, risky)
    numeric_safe = (w.c9b_pair_loss(safe+epsilon,risky)-w.c9b_pair_loss(safe-epsilon,risky))/(2*epsilon)
    numeric_risky = (w.c9b_pair_loss(safe,risky+epsilon)-w.c9b_pair_loss(safe,risky-epsilon))/(2*epsilon)
    assert math.isclose(ds,numeric_safe,abs_tol=1e-6)
    assert math.isclose(dr,numeric_risky,abs_tol=1e-6)
    for margin, is_safe in ((safe,True),(risky,False)):
        numeric = (w.c9b_row_loss(margin+epsilon,is_safe)-w.c9b_row_loss(margin-epsilon,is_safe))/(2*epsilon)
        assert math.isclose(w.c9b_row_derivative(margin,is_safe),numeric,abs_tol=1e-6)
assert w.c9b_pair_loss(2,-2) < w.c9b_pair_loss(-2,2)
`);
});

test("C9 B sampler draws half explicit pairs and balances labels and families deterministically", () => {
  run(String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("worker", sys.argv[1]); w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
def row(source, group, target): return {"source_id":source,"group":group,"target_probabilities":target}
rows = [row(f"{family}-{label}",f"{family}-group",[1,0] if label == "allow" else [0,1]) for family in ("shell","data360","browser") for label in ("allow","confirm")]
families = {r["source_id"]:r["source_id"].split("-")[0] for r in rows}
pairs = [{"pair_id":family,"group_id":f"{family}-group","safe":next(r for r in rows if r["source_id"] == f"{family}-allow"),"risky":next(r for r in rows if r["source_id"] == f"{family}-confirm")} for family in ("shell","data360","browser")]
first = w.C9BalancedSampler(rows,pairs,families); second = w.C9BalancedSampler(rows,pairs,families)
left = [first.draw() for _ in range(256*8)]; right = [second.draw() for _ in range(256*8)]
def identity(unit): return unit["pair_id"] if unit["kind"] == "pair" else unit["row"]["source_id"]
assert [identity(x) for x in left] == [identity(x) for x in right]
assert sum(unit["kind"] == "pair" for unit in left) == 1024
assert sum(unit["kind"] == "single" for unit in left) == 1024
assert sum(unit["kind"] == "single" and unit["row"]["target_probabilities"] == [1,0] for unit in left) == 512
assert sum(unit["kind"] == "single" and unit["row"]["target_probabilities"] == [0,1] for unit in left) == 512
for prefix in ("pair:","row:allow:","row:confirm:"):
    counts = [value for key,value in first.counts.items() if key.startswith(prefix)]
    assert max(counts) - min(counts) <= 1
bad = pairs.copy(); bad[0] = {**bad[0], "risky": pairs[1]["risky"]}
try: w.C9BalancedSampler(rows,bad,families)
except ValueError: pass
else: raise AssertionError("Cross-family pair accepted")
`);
});

test(
  "tiny Gemma C9 B direct and sequential gradients agree without checkpoint weights",
  { skip: !process.env.JEV_RFDT_PYTHON },
  () => {
    const result = spawnSync(python, [worker, "c9-pair-self-test"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(report.ok, true);
    assert.equal(
      report.fixture,
      "random_tiny_gemma3_c9b_pair_no_checkpoint_weights",
    );
    assert.equal(report.full_context_gradient_verified, true);
    assert.ok(report.max_gradient_delta <= 1e-4);
    assert.ok(report.sequential_peak_memory_bytes < 128 * 1024 * 1024);
  },
);
