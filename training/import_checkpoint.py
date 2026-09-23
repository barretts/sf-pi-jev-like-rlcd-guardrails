#!/usr/bin/env python3
"""Import a complete C11 checkpoint with bound supervision and FIT parity proof."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path

import contract
import cuda_train
import campaign
import local_export

PRECISION = local_export.PRECISION
MAX_PROBABILITY_DELTA = 0.05
DECISIVE_MARGIN = 0.5

def document(path: Path) -> dict:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Expected a regular CUDA receipt: {path.name}")
    return json.loads(path.read_text())

def validate_checkpoint_snapshot(plan, receipt, exit_receipt, memory, launch, snapshot, journal, receipt_sha256, guardian):
    if not isinstance(snapshot, dict) or not isinstance(journal, bytes) or not isinstance(guardian, bytes) or not receipt_sha256:
        raise ValueError("Checkpoint snapshot requires the complete bound memory journal")
    monitor_sha = contract.sha256(Path(__file__).with_name("memory_monitor.py"))
    producer_sha = contract.sha256(Path(__file__).with_name("launch.py"))
    if (snapshot.get("producer_sha256") != producer_sha
            or launch.get("launcher_sha256") != producer_sha
            or snapshot.get("checkpoint_receipt_sha256") != receipt_sha256
            or snapshot.get("checkpoint_step") != plan["steps"]
            or receipt.get("checkpoint_step") != plan["steps"]
            or snapshot.get("worker_pid") != launch.get("worker_pid")
            or memory.get("worker_pid") != launch.get("worker_pid")
            or type(launch.get("worker_pid")) is not int or launch["worker_pid"] <= 0
            or snapshot.get("worker_sha256") != plan["source_sha256"]
            or snapshot.get("monitor_sha256") != monitor_sha
            or launch.get("monitor_sha256") != monitor_sha
            or launch.get("watchdog_sha256") != monitor_sha
            or snapshot.get("journal_sha256") != hashlib.sha256(journal).hexdigest()):
        raise ValueError("Checkpoint memory snapshot identity or journal checksum changed")
    if not journal.endswith(b"\n"):
        raise ValueError("Checkpoint memory snapshot contains an incomplete journal record")
    rows = [json.loads(line) for line in journal.splitlines()]
    if len(rows) < 2 or memory.get("samples") != len(rows):
        raise ValueError("Checkpoint memory snapshot sample inventory differs")
    baseline_dedicated, baseline_shared = launch.get("baseline_dedicated_bytes"), launch.get("baseline_shared_bytes")
    if any(type(value) is not int or value < 0 for value in (baseline_dedicated, baseline_shared)):
        raise ValueError("Missing pinned checkpoint memory baselines")
    times, elapsed_times, peaks = [], [], {"peak_total_dedicated_bytes": 0, "peak_dedicated_delta_bytes": 0, "peak_shared_delta_bytes": 0}
    for row in rows:
        timestamp = row.get("time_unix")
        elapsed = row.get("elapsed_seconds")
        if ("monitor_error" in row or type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                or type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0):
            raise ValueError("Checkpoint memory journal contains an invalid sample")
        for key in ("dedicated_bytes", "shared_bytes", "dedicated_delta_bytes", "shared_delta_bytes"):
            if type(row.get(key)) is not int or row[key] < 0:
                raise ValueError("Invalid checkpoint memory counter")
        if (row["dedicated_delta_bytes"] != max(0, row["dedicated_bytes"] - baseline_dedicated)
                or row["shared_delta_bytes"] != max(0, row["shared_bytes"] - baseline_shared)):
            raise ValueError("Checkpoint memory delta differs from pinned baseline")
        times.append(timestamp)
        elapsed_times.append(elapsed)
        for key, value in (("peak_total_dedicated_bytes", row["dedicated_bytes"]),
                           ("peak_dedicated_delta_bytes", row["dedicated_delta_bytes"]),
                           ("peak_shared_delta_bytes", row["shared_delta_bytes"])):
            peaks[key] = max(peaks[key], value)
    completed, captured = exit_receipt.get("completed_time_unix"), snapshot.get("snapshot_time_unix")
    if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (completed, captured))
            or any(a >= b for a, b in zip(times, times[1:]))
            or any(a >= b for a, b in zip(elapsed_times, elapsed_times[1:]))
            or not times[0] <= completed < times[-1] <= captured):
        raise ValueError("Checkpoint completion is not bracketed by the memory journal")
    if any(memory.get(key) != value for key, value in peaks.items()):
        raise ValueError("Checkpoint memory summary differs from complete journal statistics")
    validate_snapshot_guardian(launch, snapshot, guardian, rows, completed)
    if (memory.get("stop_dedicated_delta_bytes") != 7_500_000_000
            or launch.get("stop_dedicated_delta_bytes") != 7_500_000_000):
        raise ValueError("Checkpoint dedicated stop threshold changed")

def validate_snapshot_guardian(launch: dict, snapshot: dict, guardian: bytes, samples: list, completed: float) -> None:
    if (not isinstance(guardian, bytes) or not guardian.endswith(b"\n")
            or snapshot.get("guardian_sha256") != hashlib.sha256(guardian).hexdigest()):
        raise ValueError("Checkpoint requires the complete bound guardian journal")
    records = [json.loads(line) for line in guardian.splitlines()]
    if (len(records) < 2 or any(not isinstance(row, dict) for row in records)
            or records[0].get("status") != "watching"
            or any(row.get("status") != "healthy" for row in records[1:])):
        raise ValueError("Checkpoint guardian lacks a successful watching and healthy prefix")
    watching = records[0]
    for key in ("worker_pid", "watchdog_pid", "worker_start_ticks", "watchdog_start_ticks"):
        value = launch.get(key)
        if type(value) is not int or value <= 0 or type(watching.get(key)) is not int or watching.get(key) != value:
            raise ValueError("Checkpoint guardian PID or birth identity differs from launch")
    if launch["worker_pid"] == launch["watchdog_pid"]:
        raise ValueError("Checkpoint guardian worker and watchdog identities collide")
    times = [record.get("time_unix") for record in records]
    captured = snapshot["snapshot_time_unix"]
    if (any(type(value) not in (int, float) or not math.isfinite(value) for value in times)
            or any(a >= b for a, b in zip(times, times[1:]))
            or not times[0] <= completed <= times[-1] <= captured):
        raise ValueError("Checkpoint completion lacks historical guardian coverage")
    identities = {json.dumps(row, sort_keys=True, separators=(",", ":")) for row in samples}
    covered, previous = False, None
    for record in records[1:]:
        sample, age = record.get("sample"), record.get("journalAgeSeconds")
        if (sample is None and record["time_unix"] < samples[0]["time_unix"]
                and type(age) in (int, float) and math.isfinite(age) and 0 <= age < 30):
            continue
        if (not isinstance(sample, dict) or json.dumps(sample, sort_keys=True, separators=(",", ":")) not in identities
                or not 0 <= record["time_unix"] - sample["time_unix"] < 30
                or type(age) not in (int, float) or not math.isfinite(age) or not 0 <= age < 30
                or (previous is not None and (sample["time_unix"] < previous["time_unix"]
                    or sample["elapsed_seconds"] < previous["elapsed_seconds"]
                    or ((sample["time_unix"] > previous["time_unix"]) != (sample["elapsed_seconds"] > previous["elapsed_seconds"]))))):
            raise ValueError("Checkpoint guardian healthy observation is stale or differs from bound memory journal")
        previous = sample
        covered |= (sample["time_unix"] >= completed and record["time_unix"] >= completed
                    and captured - sample["time_unix"] < 30 and captured - record["time_unix"] < 30)
    if not covered:
        raise ValueError("Checkpoint guardian has no genuine healthy observation after completion")


def validate_c11_final_memory(plan, receipt, exit_receipt, memory, launch, journal, guardian, checkpoint_exit):
    contract.validate_final_memory(plan, receipt, exit_receipt, memory, launch, journal, guardian, checkpoint_exit)


def probability(margin: float) -> float:
    if not math.isfinite(margin):
        raise ValueError("Nonfinite cross-backend margin")
    return 1 / (1 + math.exp(-margin)) if margin >= 0 else math.exp(margin) / (1 + math.exp(margin))

def compare_margins(expected: dict[str, float], actual: dict[str, float]) -> dict:
    if not expected or set(expected) != set(actual):
        raise ValueError("Cross-backend FIT margin inventory differs")
    delta = max(abs(probability(expected[key]) - probability(actual[key])) for key in expected)
    flips = sum(abs(expected[key]) >= DECISIVE_MARGIN and expected[key] * actual[key] <= 0 for key in expected)
    return {"rows": len(expected), "max_probability_delta": delta,
            "max_margin_delta": max(abs(expected[key] - actual[key]) for key in expected),
            "decisive_sign_flips": flips, "max_probability_delta_limit": MAX_PROBABILITY_DELTA,
            "decisive_margin": DECISIVE_MARGIN,
            "ok": delta <= MAX_PROBABILITY_DELTA and flips == 0}

def current_campaign() -> dict:
    path = Path(__file__).with_name("recipe.json")
    return campaign.load_campaign(path, contract.sha256(path))


def validate_c11_checkpoint(plan: dict, receipt: dict, launch: dict | None = None) -> None:
    root = Path(__file__).resolve().parent
    recipe_path = root / "recipe.json"
    recipe = current_campaign()
    recipe_sha = contract.sha256(recipe_path)
    source_definition = json.loads(cuda_train.exact_file(root / "data/objective.json", contract.PLAN_SHA256))
    definition = {**source_definition, "purpose": "c11_train_only", "sampler": recipe["sampler"], "steps": recipe["steps"]}
    runtime = plan.get("runtime", {})
    if (not isinstance(runtime, dict) or set(runtime) != {"python", *recipe["runtime"]}
            or not isinstance(runtime.get("python"), str) or not runtime["python"]
            or any(runtime.get(name) != value for name, value in recipe["runtime"].items())):
        raise ValueError("C11 actual training runtime differs from recipe pins")
    code = {name: contract.sha256(root / name) for name in (
        "campaign.py", "sampler.py", "cuda_train.py", "contract.py", "gemma_fp32.py", "memory_monitor.py", "launch.py")}
    if (plan.get("experiment") != "c11" or plan.get("campaign") != recipe
            or plan.get("campaign_sha256") != recipe_sha
            or plan.get("source_objective_plan") != source_definition or plan.get("objective") != definition
            or plan.get("campaign_steps") != recipe["steps"]
            or plan.get("steps") not in recipe["checkpoints"] or plan.get("mode") != "train"
            or plan.get("checkpoint_step") != plan.get("steps") or receipt.get("checkpoint_step") != plan.get("steps")
            or plan.get("initialization") != recipe["initialization"]
            or plan.get("sampler_source_sha256") != code["sampler.py"]
            or plan.get("precision") != PRECISION
            or plan.get("source_sha256") != code["campaign.py"]
            or plan.get("contract_sha256") != code["contract.py"]
            or plan.get("objective_worker_sha256") != code["cuda_train.py"]
            or plan.get("inputs") != {"train": contract.TRAIN_SHA256, "pairs": contract.PAIR_SHA256,
                "families": contract.FAMILY_SHA256, "plan": contract.PLAN_SHA256, "base": contract.BASE_HASHES}
            or receipt.get("source") != plan or receipt.get("qualified") is not False
            or receipt.get("mode") != "train" or receipt.get("steps") != plan.get("steps")
            or receipt.get("adapter_changed") is not True):
        raise ValueError("Frozen C11 recipe, objective, sampler, initialization, precision, or code identity changed")
    if launch is not None:
        if (launch.get("campaign_sha256") != recipe_sha or launch.get("recipe_sha256") != recipe_sha
                or launch.get("purpose") != "guardrail_cuda_fit_only_training"
                or launch.get("code_sha256") != code
                or launch.get("launcher_sha256") != code["launch.py"]
                or launch.get("objective_worker_sha256") != code["cuda_train.py"]
                or launch.get("contract_sha256") != code["contract.py"]
                or launch.get("watchdog_sha256") != code["memory_monitor.py"]
                or launch.get("monitor_sha256") != code["memory_monitor.py"]):
            raise ValueError("C11 launch source fingerprints changed")
        for key, value in (("allocator_cap_bytes", 6_500_000_000), ("stop_dedicated_delta_bytes", 7_500_000_000),
                           ("shared_growth_limit_bytes", 128_000_000)):
            if launch.get(key) != value:
                raise ValueError("C11 launch memory stop contract changed")
    proof = receipt.get("saved_adapter_reload", {})
    delta = proof.get("max_margin_delta")
    if (proof.get("ok") is not True or proof.get("rows") != 327
            or proof.get("adapter_sha256") != receipt.get("adapter_sha256")
            or proof.get("fit_margins_sha256") != receipt.get("fit_margins_sha256")
            or proof.get("precision") != PRECISION or proof.get("margin_delta_limit") != 1e-5
            or type(delta) not in (int, float) or not math.isfinite(delta) or not 0 <= delta <= 1e-5):
        raise ValueError("C11 checkpoint lacks exact saved-adapter reload proof")


def validate_receipts(plan: dict, receipt: dict, exit_receipt: dict, memory: dict, launch: dict,
                      snapshot: dict | None = None, journal: bytes | None = None,
                      receipt_sha256: str | None = None, guardian: bytes | None = None,
                      checkpoint_exit: dict | None = None) -> None:
    validate_c11_checkpoint(plan, receipt, launch)
    steps = plan["steps"]
    total = memory.get("peak_total_dedicated_bytes")
    if (memory.get("stop_total_dedicated_bytes") != 16_000_000_000
            or launch.get("stop_total_dedicated_bytes") != 16_000_000_000
            or type(total) is not int or not 0 < total < 16_000_000_000):
        raise ValueError("C11 total dedicated memory proof is missing or exceeded")
    if exit_receipt.get("ok") is not True or exit_receipt.get("steps_completed") != steps:
        raise ValueError("CUDA import requires a completed checkpoint")
    if (launch.get("prepared_fit_sha256") != contract.TRAIN_SHA256
            or launch.get("plan_sha256") != contract.PLAN_SHA256
            or launch.get("worker_sha256") != plan.get("source_sha256")
            or launch.get("contract_sha256") != plan.get("contract_sha256")):
        raise ValueError("CUDA source, lineage, FIT, or objective identity changed")
    reason = memory.get("reason")
    if reason == "checkpoint_snapshot":
        validate_checkpoint_snapshot(plan, receipt, exit_receipt, memory, launch, snapshot, journal, receipt_sha256, guardian)
    elif reason == "worker_exit":
        validate_c11_final_memory(plan, receipt, exit_receipt, memory, launch, journal, guardian, checkpoint_exit)
    else:
        raise ValueError("Import requires bound checkpoint supervision proof")
    if (receipt.get("pre_step_placement") != {"parameters": 444, "buffers": 5, "gradients": 104}
            or receipt.get("post_step_placement") != {"parameters": 444, "buffers": 5, "gradients": 0, "optimizer_tensors": 208}):
        raise ValueError("Missing real CUDA gradient/optimizer placement proof")
    if (memory.get("samples", 0) < 2 or memory.get("hard_budget_bytes") != 8_000_000_000
            or memory.get("shared_growth_limit_bytes") != 128_000_000
            or launch.get("hard_budget_bytes") != 8_000_000_000
            or plan.get("budget_bytes") != 8_000_000_000):
        raise ValueError("Missing successful shared-host memory monitoring")
    for key, limit in (("peak_dedicated_delta_bytes", 7_500_000_000), ("peak_shared_delta_bytes", 128_000_000)):
        value = memory.get(key)
        if type(value) is not int or not 0 <= value < limit:
            raise ValueError("CUDA run exceeded shared-host memory limit")
    peak = receipt.get("memory", {}).get("peak_reserved_bytes")
    if type(peak) is not int or not 0 < peak <= plan.get("allocator_cap_bytes", 0) <= 6_500_000_000:
        raise ValueError("CUDA allocator peak/cap exceeds the contract")


def check_tensors(tensors, mx) -> None:
    expected = {}
    for layer in range(26):
        for projection, width in (("q_proj", 1024), ("v_proj", 256)):
            prefix = f"model.layers.{layer}.self_attn.{projection}"
            expected[prefix + ".lora_a"] = (1152, 16)
            expected[prefix + ".lora_b"] = (16, width)
    if set(tensors) != set(expected) or any(tuple(tensors[key].shape) != expected[key]
            or tensors[key].dtype != mx.float32 or not bool(mx.all(mx.isfinite(tensors[key])).item()) for key in expected):
        raise ValueError("CUDA adapter tensors differ from approved Gemma LoRA")


def write_import_report(output: Path, result: dict) -> dict:
    """Persist the successful bridge handoff and its actual local-margin digest."""
    margins = output / "local-fit-margins.jsonl"
    if not margins.is_file() or margins.is_symlink():
        raise ValueError("Import report requires regular local FIT margins")
    result["local_fit_margins_sha256"] = contract.sha256(margins)
    contract.write_json(output / "import-report.json", result)
    return result


def run(args: argparse.Namespace) -> dict:
    import mlx.core as mx
    source, output, data, base = (Path(value).expanduser().resolve() for value in (args.cuda_run, args.output, args.data, args.model))
    if output.exists():
        raise ValueError("Import output already exists; preserve previous attempt")
    paths = {"sourcePlan": source / "run/plan.json", "sourceReceipt": source / "run/receipt.json",
        "sourceLaunch": source / "launch.json", "sourceExit": source / "run/exit.json",
        "sourceMemory": source / "memory.summary.json", "sourceMemoryJournal": source / "memory.jsonl",
        "sourceAdapter": source / "run/adapter/adapters.safetensors",
        "sourceAdapterConfig": source / "run/adapter/adapter_config.json", "sourceMargins": source / "run/fit-margins.jsonl"}
    # Pin the raw bytes before evaluation and recheck every source at completion.
    for path in paths.values():
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Expected a regular C11 source file: {path.name}")
    raw = {name: path.read_bytes() for name, path in paths.items()}
    hashes = {name: hashlib.sha256(value).hexdigest() for name, value in raw.items()}
    if hashes["sourceReceipt"] != args.receipt_sha256:
        raise ValueError("CUDA receipt differs from explicit pre-import pin")
    plan, receipt, memory, launch, exit_receipt = (json.loads(raw[name]) for name in (
        "sourcePlan", "sourceReceipt", "sourceMemory", "sourceLaunch", "sourceExit"))
    snapshot, guardian, checkpoint_exit = None, None, None
    if memory.get("reason") == "checkpoint_snapshot":
        paths["sourceSnapshot"] = source / "memory.snapshot.json"
        paths["sourceGuardian"] = source / "root-guardian.jsonl"
    elif memory.get("reason") == "worker_exit":
        paths["sourceGuardian"] = source / "root-guardian.jsonl"
        paths["sourceCheckpointExit"] = source / "run/checkpoints/step-1024/exit.json"
    for name, path in paths.items():
        if name not in raw:
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"Expected a regular C11 supervision file: {path.name}")
            raw[name] = path.read_bytes()
            hashes[name] = hashlib.sha256(raw[name]).hexdigest()
    if "sourceSnapshot" in raw:
        snapshot = json.loads(raw["sourceSnapshot"])
    if "sourceGuardian" in raw:
        guardian = raw["sourceGuardian"]
    if "sourceCheckpointExit" in raw:
        checkpoint_exit = json.loads(raw["sourceCheckpointExit"])
    validate_receipts(plan, receipt, exit_receipt, memory, launch, snapshot,
                      raw["sourceMemoryJournal"], args.receipt_sha256, guardian, checkpoint_exit)
    local_export.verify_base_files(base)
    local_identity = contract.provenance()
    data_sha = contract.sha256(data)
    if data_sha != contract.TRAIN_SHA256:
        raise ValueError("Local prepared FIT differs from CUDA training")
    if hashes["sourceAdapter"] != receipt.get("adapter_sha256"):
        raise ValueError("CUDA adapter checksum changed")
    config = json.loads(raw["sourceAdapterConfig"])
    if config != {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA}:
        raise ValueError("Unsupported CUDA adapter configuration")
    check_tensors(mx.load(str(paths["sourceAdapter"])), mx)
    if hashes["sourceMargins"] != receipt.get("fit_margins_sha256"):
        raise ValueError("CUDA FIT reference margins changed")
    margins = [json.loads(line) for line in raw["sourceMargins"].splitlines()]
    expected_margins = {row["source_id"]: row["final"] for row in margins}
    if len(expected_margins) != len(margins) or len(expected_margins) != 327:
        raise ValueError("CUDA FIT margin inventory differs")
    rows = contract.read_rows(data, "train")
    if len(rows) != 327:
        raise ValueError("Prepared C11 FIT must have 327 TRAIN rows")
    output.mkdir(parents=True)
    (output / "adapters.safetensors").write_bytes(raw["sourceAdapter"])
    contract.write_json(output / "adapter_config.json", config)
    manifest = {"schema_version": 2, "template_version": "v2", "objective": plan["objective"]["objective"],
        "provenance": {**local_identity, "training_backend": "torch_cuda"},
        "adapter_sha256": receipt["adapter_sha256"], "training_data_sha256": data_sha,
        "cuda_receipt_sha256": args.receipt_sha256, "cuda_source": receipt, "qualified": False,
        "local_precision": PRECISION, "local_architecture": local_export.local_architecture(),
        "cuda_campaign_sha256": plan["campaign_sha256"]}
    contract.write_json(output / "adapter-manifest.json", manifest)
    model, tokenizer, _ = local_export.load_model(base, output)
    contract.verify_prompt_parity(tokenizer, rows)
    actual = {row["source_id"]: float(local_export.selected_logit_margin(model,
        mx.array([row["prompt_token_ids"]]), mx.array(row["allowed_token_ids"])).item()) for row in rows}
    comparison = compare_margins(expected_margins, actual)
    local_margins = output / "local-fit-margins.jsonl"
    with local_margins.open("x") as handle:
        for key, margin in actual.items():
            handle.write(json.dumps({"source_id": key, "margin": margin}, allow_nan=False) + "\n")
    contract.write_json(output / "import-equivalence.json", comparison)
    if not comparison["ok"]:
        raise ValueError("Saved adapter failed local cross-backend FIT equivalence; attempt retained")
    if any(not path.is_file() or path.is_symlink() or contract.sha256(path) != hashes[name] for name, path in paths.items()) or contract.sha256(data) != data_sha:
        raise ValueError("C11 source envelope changed during local import")
    result = {"ok": True, "adapter_changed": True, "reload_verified": True,
        "adapter_dir": str(output), "training_backend": "torch_cuda", "qualified": False,
        "cuda_receipt_sha256": args.receipt_sha256, "cuda_source": receipt,
        "cross_backend_equivalence": comparison,
        "cuda_campaign_sha256": plan["campaign_sha256"], "checkpoint_step": plan["steps"],
        "local_precision": PRECISION, "local_architecture": local_export.local_architecture(),
        "source_envelope_sha256": hashes, "local_environment": local_identity["dependencies"]}
    return write_import_report(output, result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cuda-run", "receipt-sha256", "model", "data", "output"):
        parser.add_argument("--" + name, required=True)
    print(json.dumps(run(parser.parse_args()), allow_nan=False))
