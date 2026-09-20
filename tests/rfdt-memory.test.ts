import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerPath = fileURLToPath(new URL("../rfdt/worker.py", import.meta.url));
const setup = String.raw`
import argparse, importlib.util, json, math, os, stat, sys, tempfile, types, weakref
from pathlib import Path
spec = importlib.util.spec_from_file_location("rfdt_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
temporary = tempfile.TemporaryDirectory(prefix="rfdt-memory-fixture-")
root = Path(temporary.name).resolve()
core = types.ModuleType("mlx.core")
core.calls = []
core.cache = 12345
core.require_empty = True
core.float32 = "float32"
core.int32 = "int32"
class Array:
    instances = weakref.WeakSet()
    def __init__(self, value):
        self.value = value
        self.evaluated = False
        Array.instances.add(self)
        core.cache += 32
    def astype(self, dtype):
        return self
    def __getitem__(self, index):
        return Array(self.value[index])
    def __sub__(self, other):
        return Array(apply(self.value, other.value, lambda left, right: left - right))
    def __mul__(self, other):
        return Array(apply(self.value, other.value, lambda left, right: left * right))
    def __neg__(self):
        return Array(-self.value)
    def tolist(self):
        assert self.evaluated, "Array converted before materialization"
        return list(self.value)
    def item(self):
        assert self.evaluated, "Scalar converted before materialization"
        return self.value
def apply(left, right, function):
    if isinstance(left, list):
        return [function(value, right[index] if isinstance(right, list) else right) for index, value in enumerate(left)]
    return function(left, right)
def evaluate(*arrays):
    core.calls.append("eval")
    for array in arrays:
        array.evaluated = True
def clear_cache():
    core.calls.append("clear")
    if core.require_empty:
        assert not Array.instances, "Evaluated row arrays retained at cleanup"
    core.cache = 0
def set_cache_limit(limit):
    core.calls.append(("set_cache_limit", limit))
    return 987654321
core.set_cache_limit = set_cache_limit
core.reset_peak_memory = lambda: core.calls.append("reset_peak")
core.get_active_memory = lambda: 32 * len(Array.instances)
core.get_cache_memory = lambda: core.cache
core.get_peak_memory = lambda: 333333
core.clear_cache = clear_cache
core.array = lambda value, dtype=None: Array(value)
core.take = lambda values, indices: Array([values.value[index] for index in indices.value])
def softmax(values):
    exponentials = [math.exp(value) for value in values.value]
    return Array([value / sum(exponentials) for value in exponentials])
core.softmax = softmax
core.logsumexp = lambda values: Array(math.log(sum(math.exp(value) for value in values.value)))
core.sum = lambda values: Array(sum(values.value))
core.eval = evaluate
package = types.ModuleType("mlx")
package.core = core
sys.modules["mlx"] = package
sys.modules["mlx.core"] = core
class Model:
    def eval(self):
        pass
worker.final_logits = lambda model, tokens: Array([[math.log(.1), math.log(.8), math.log(.1)]])
def rows(count):
    return [{"id": f"row-{index}", "group": f"group-{index}", "split": "train", "prompt_token_ids": list(range(index % 13 + 1)), "allowed_token_ids": [0, 1, 2], "target_probabilities": [.1, .8, .1]} for index in range(count)]
`;

function runPython(body: string) {
  const result = spawnSync("python3", ["-c", setup + "\n" + body, workerPath], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("RFDT free-buffer cleanup and owned progress without weights", () => {
  it("configures the limit before model work and flushes readable private progress", () => {
    runPython(String.raw`
output = root / "run"
def train_fixture(args, actual_output, adapter, progress):
    assert core.calls[:2] == [("set_cache_limit", 268435456), "reset_peak"]
    assert actual_output == output and adapter == output / "adapter"
    progress.emit("phase_begin", phase="model_load")
    # Read while the writer remains open: buffering cannot hide this phase.
    events = [json.loads(line) for line in progress.path.read_text().splitlines()]
    assert [event["event"] for event in events] == ["worker_start", "phase_begin"]
    assert events[-1]["cache_memory_bytes"] == 12345
    assert events[-1]["peak_memory_bytes"] == 333333
    assert stat.S_IMODE(progress.path.stat().st_mode) == 0o600
    summary = progress.summary()
    assert summary["free_cache_limit_bytes"] == 268435456
    assert summary["previous_free_cache_limit_bytes"] == 987654321
    return summary
worker.train_with_progress = train_fixture
result = worker.train(argparse.Namespace(output=str(output)))
assert result["progress_file"] == str(output / "worker-progress.jsonl")
`);
  });

  it("materializes and releases every row while preserving the selected loss and predictions", () => {
    runPython(String.raw`
data = rows(100)
path = root / "worker-progress.jsonl"
with worker.MemoryProgress(path) as progress:
    report = worker.evaluate_rows(Model(), data, progress, "initial_evaluation")
    assert not Array.instances
    assert core.calls.count("eval") == 100 and core.calls.count("clear") == 100
    assert report["rows"] == 100 and report["selected_label_accuracy"] == 1
    expected_loss = -sum(value * math.log(value) for value in [.1, .8, .1])
    assert math.isclose(report["mean_loss"], expected_loss, abs_tol=1e-12)
    assert all(prediction["selected_index"] == 1 for prediction in report["predictions"])
    assert all(all(type(value) is float for value in prediction["probabilities"]) for prediction in report["predictions"])
    assert json.loads(json.dumps(report)) == report
    events = [json.loads(line) for line in path.read_text().splitlines()]
    milestones = [event["rows_completed"] for event in events if event["event"] == "evaluation_progress"]
    assert milestones == [25, 50, 75, 100]
    assert all(event["active_memory_bytes"] == 0 and event["cache_memory_bytes"] == 0 for event in events if event["event"] == "evaluation_progress")
    assert progress.summary()["max_observed_cache_memory_bytes"] >= 12345
`);
  });

  it("cleans row arrays and flushes the failure phase when a model produces nonfinite values", () => {
    runPython(String.raw`
worker.final_logits = lambda model, tokens: Array([[float("nan"), 0., 0.]])
path = root / "worker-progress.jsonl"
try:
    with worker.MemoryProgress(path) as progress:
        worker.evaluate_rows(Model(), rows(1), progress, "initial_evaluation")
except ValueError as error:
    assert "nonfinite" in str(error)
else:
    raise AssertionError("Expected nonfinite model output rejection")
assert not Array.instances and core.calls.count("clear") == 1
assert progress.handle.closed
events = [json.loads(line) for line in path.read_text().splitlines()]
assert events[-1]["event"] == "worker_error" and events[-1]["phase"] == "initial_evaluation"
assert events[-1]["error_type"] == "ValueError"
`);
  });

  it("cleans shared evaluation calls without an observer and failures before logits exist", () => {
    runPython(String.raw`
report = worker.evaluate_rows(Model(), rows(30))
assert report["rows"] == 30 and core.calls.count("clear") == 30
assert not Array.instances
def failed_logits(model, tokens):
    raise RuntimeError("synthetic model failure")
worker.final_logits = failed_logits
core.require_empty = False # The nested exception frame owns its tokens until handled.
try:
    worker.evaluate_rows(Model(), rows(1))
except RuntimeError as error:
    assert str(error) == "synthetic model failure"
else:
    raise AssertionError("Expected model failure")
assert not Array.instances and core.calls.count("clear") == 31
`);
  });

  it("preserves existing progress and keeps fusion observation outside its fresh output directory", () => {
    runPython(String.raw`
path = root / "worker-progress.jsonl"
path.write_text("immutable prior evidence")
try:
    worker.MemoryProgress(path)
except FileExistsError:
    pass
else:
    raise AssertionError("Existing progress must not be overwritten")
assert path.read_text() == "immutable prior evidence"
output = root / "fused"
def fuse_fixture(args, progress):
    assert not output.exists() and progress.path is None
    return progress.summary()
worker.fuse_with_progress = fuse_fixture
result = worker.fuse(argparse.Namespace(output=str(output)))
assert not output.exists() and result["progress_file"] is None
`);
  });
});
