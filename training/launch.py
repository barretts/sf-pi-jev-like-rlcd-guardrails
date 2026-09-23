#!/usr/bin/env python3
"""Stage and supervise one FIT-only guardrail training run on an authorized WSL host.

Staging is local and does not download weights, connect to a host, or start CUDA.
The launch command starts processes only on the host where it is invoked.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time

import campaign
import contract
import cuda_train as objective
import memory_monitor as monitor

CODE_NAMES = frozenset({"campaign.py", "cuda_train.py", "contract.py", "sampler.py",
                        "gemma_fp32.py", "launch.py", "memory_monitor.py"})
MEMORY_LIMITS = {
    "hard_budget_bytes": 8_000_000_000,
    "allocator_cap_bytes": 6_500_000_000,
    "stop_dedicated_delta_bytes": 7_500_000_000,
    "shared_growth_limit_bytes": 128_000_000,
    "stop_total_dedicated_bytes": 16_000_000_000,
}


def digest(path: Path) -> str:
    return contract.sha256(path)


def verify_code(code: Path, expected: dict) -> None:
    if not isinstance(expected, dict) or set(expected) != CODE_NAMES:
        raise ValueError("Pin exactly the current training code hashes")
    for name in sorted(CODE_NAMES):
        sha = expected[name]
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise ValueError("Invalid pinned code SHA256")
        objective.exact_file(code / name, sha)


def contract_args(base: Path, train: Path, pairs: Path, families: Path, plan: Path) -> argparse.Namespace:
    return argparse.Namespace(base=str(base), train=str(train), pairs=str(pairs),
        pairs_sha256=objective.PAIR_SHA256, families=str(families),
        families_sha256=objective.FAMILY_SHA256, plan=str(plan), plan_sha256=objective.PLAN_SHA256)


def stage(args: argparse.Namespace) -> dict:
    """Copy only verified current inputs into a new portable input directory."""
    source = Path(args.training_dir).expanduser().resolve()
    base = Path(args.base).expanduser().resolve()
    output = Path(args.output).expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Training input directory already exists")
    output = output.resolve()
    recipe_path = source / "recipe.json"
    recipe_sha = digest(recipe_path)
    recipe = campaign.load_campaign(recipe_path, recipe_sha)
    verify_code(source, recipe["source_sha256"])
    inputs = contract_args(base, source / "data/prepared-fit.jsonl", source / "data/pairs.json",
                           source / "data/families.json", source / "data/objective.json")
    rows, pairs, families, _ = objective.load_contract(inputs)
    tokenizer_names = {"tokenizer_config.json", "tokenizer.model", "added_tokens.json",
                       "special_tokens_map.json", "chat_template.jinja", "generation_config.json"}
    names = set(objective.BASE_HASHES) | {name for name in tokenizer_names if (base / name).is_file()}
    if "tokenizer_config.json" not in names:
        raise ValueError("Original tokenizer configuration is required for staging")
    # Snapshot symlinks are allowed for original base files, and become regular copies.
    base_hashes = {name: digest(base / name) for name in sorted(names)}
    for name, sha in objective.BASE_HASHES.items():
        if base_hashes[name] != sha:
            raise ValueError("Original Google Gemma base checksum differs")
    output.mkdir(parents=True)
    try:
        for directory in (output / "base", output / "fit", output / "code"):
            directory.mkdir()
        for name, sha in base_hashes.items():
            shutil.copyfile(base / name, output / "base" / name)
            if digest(output / "base" / name) != sha:
                raise ValueError("Base changed while staging")
        base_manifest = {"base_model": contract.BASE_MODEL, "base_revision": contract.BASE_REVISION,
                         "files": base_hashes}
        contract.write_json(output / "base/base-manifest.json", base_manifest)
        copies = {
            **{source / name: output / "code" / name for name in CODE_NAMES},
            recipe_path: output / "code/recipe.json",
            Path(inputs.train): output / "fit/prepared-train.jsonl",
            Path(inputs.pairs): output / "fit/pairs.json",
            Path(inputs.families): output / "fit/families.json",
            Path(inputs.plan): output / "code/objective.json",
        }
        for original, destination in copies.items():
            if original.is_symlink() or not original.is_file():
                raise ValueError("Training sources must be regular files")
            shutil.copyfile(original, destination)
        verify_code(output / "code", recipe["source_sha256"])
        campaign.load_campaign(output / "code/recipe.json", recipe_sha)
        objective.load_contract(contract_args(output / "base", output / "fit/prepared-train.jsonl",
            output / "fit/pairs.json", output / "fit/families.json", output / "code/objective.json"))
        receipt = {"version": 2, "purpose": "guardrail_fit_only_training_inputs",
            "inputs": str(output.resolve()), "recipe_sha256": recipe_sha,
            "prepared_fit_sha256": objective.TRAIN_SHA256, "pairs_sha256": objective.PAIR_SHA256,
            "families_sha256": objective.FAMILY_SHA256, "objective_sha256": objective.PLAN_SHA256,
            "code_sha256": recipe["source_sha256"], "base_sha256": base_hashes,
            "fit_rows": len(rows), "explicit_pairs": len(pairs), "row_families": len(families),
            "qualified": False, "default_enforcement": "off"}
        contract.write_json(output / "stage.json", receipt)
        return receipt
    except BaseException:
        shutil.rmtree(output)
        raise


def stop_owned_children(processes, original_error):
    failures = []
    for process in processes:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        except BaseException as error:
            failures.append(f"Owned child {process.pid} TERM failed: {type(error).__name__}: {error}")
    for process in processes:
        try:
            process.wait(timeout=5)
            continue
        except subprocess.TimeoutExpired:
            pass
        except BaseException as error:
            failures.append(f"Owned child {process.pid} TERM wait failed: {type(error).__name__}: {error}")
        try:
            process.kill()
        except ProcessLookupError:
            pass
        except BaseException as error:
            failures.append(f"Owned child {process.pid} KILL failed: {type(error).__name__}: {error}")
        try:
            process.wait(timeout=5)
        except BaseException as error:
            failures.append(f"Owned child {process.pid} exit not confirmed: {type(error).__name__}: {error}")
    if failures:
        try:
            print("Launch cleanup: " + "; ".join(failures), file=sys.stderr, flush=True)
        except BaseException:
            pass


def run(args: argparse.Namespace) -> dict:
    inputs = Path(args.inputs).resolve()
    root = Path(args.run_root).expanduser().absolute()
    if root.exists() or root.is_symlink():
        raise ValueError("CUDA run root already exists")
    root = root.resolve()
    code = inputs / "code"
    recipe_path = code / "recipe.json"
    recipe = campaign.load_campaign(recipe_path, args.recipe_sha256)
    code_hashes = recipe["source_sha256"]
    verify_code(code, code_hashes)
    if digest(Path(__file__)) != code_hashes["launch.py"] or digest(Path(monitor.__file__)) != code_hashes["memory_monitor.py"]:
        raise ValueError("Launcher or monitor differs from staged training identity")
    worker, watchdog = code / "campaign.py", code / "memory_monitor.py"
    fit = contract_args(inputs / "base", inputs / "fit/prepared-train.jsonl", inputs / "fit/pairs.json",
                        inputs / "fit/families.json", code / "objective.json")
    objective.load_contract(fit)
    steps = 1 if args.mode == "probe" else 1024
    campaign.validate_args(argparse.Namespace(mode=args.mode, steps=steps,
        budget_bytes=8_000_000_000, allocator_cap_bytes=6_500_000_000), recipe)
    baseline_dedicated, baseline_shared = monitor.sample(args.adapter_tag)
    if baseline_dedicated >= MEMORY_LIMITS["stop_total_dedicated_bytes"]:
        raise ValueError("Absolute dedicated memory limit already reached")
    run_dir = root / "run"
    worker_command = [sys.executable, str(worker),
        "--campaign", str(recipe_path), "--campaign-sha256", args.recipe_sha256,
        "--mode", args.mode, "--base", fit.base, "--train", fit.train,
        "--pairs", fit.pairs, "--pairs-sha256", fit.pairs_sha256,
        "--families", fit.families, "--families-sha256", fit.families_sha256,
        "--plan", fit.plan, "--plan-sha256", fit.plan_sha256, "--output", str(run_dir),
        "--steps", str(steps), "--budget-bytes", "8000000000", "--allocator-cap-bytes", "6500000000"]
    watchdog_command = [sys.executable, str(watchdog),
        "--pid-file", str(root / "worker.pid"), "--worker", str(worker), "--run-dir", str(run_dir),
        "--output", str(root / "memory.jsonl"), "--adapter-tag", args.adapter_tag,
        "--baseline-dedicated-bytes", str(baseline_dedicated), "--baseline-shared-bytes", str(baseline_shared),
        "--hard-budget-bytes", "8000000000", "--stop-dedicated-delta-bytes", "7500000000",
        "--shared-growth-limit-bytes", "128000000", "--stop-total-dedicated-bytes", "16000000000",
        "--interval-seconds", "2"]
    verify_code(code, code_hashes)
    campaign.load_campaign(recipe_path, args.recipe_sha256)
    root.mkdir(parents=True)
    watchdog_process = worker_process = None
    try:
        with (root / "watchdog.log").open("xb", buffering=0) as log:
            watchdog_process = subprocess.Popen(watchdog_command, cwd=code, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
            watchdog_start_ticks = process_start_ticks(watchdog_process.pid)
        with (root / "worker.log").open("xb", buffering=0) as log:
            worker_process = subprocess.Popen(worker_command, cwd=code, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
            worker_start_ticks = process_start_ticks(worker_process.pid)
        (root / "worker.pid").write_text(f"{worker_process.pid}\n")
        (root / "watchdog.pid").write_text(f"{watchdog_process.pid}\n")
        receipt = {"version": 2, "purpose": "guardrail_cuda_fit_only_training", "mode": args.mode,
            "started_at": datetime.now(timezone.utc).isoformat(), "worker_pid": worker_process.pid,
            "watchdog_pid": watchdog_process.pid, "inputs": str(inputs), "run_root": str(root),
            "worker_start_ticks": worker_start_ticks, "watchdog_start_ticks": watchdog_start_ticks,
            "prepared_fit_sha256": objective.TRAIN_SHA256, "plan_sha256": objective.PLAN_SHA256,
            "recipe_sha256": args.recipe_sha256, "campaign_sha256": args.recipe_sha256,
            "launcher_sha256": digest(Path(__file__)), "worker_sha256": digest(worker),
            "objective_worker_sha256": digest(code / "cuda_train.py"), "code_sha256": code_hashes,
            "watchdog_sha256": digest(watchdog), "monitor_sha256": digest(watchdog),
            "contract_sha256": digest(code / "contract.py"), "baseline_dedicated_bytes": baseline_dedicated,
            "baseline_shared_bytes": baseline_shared, **MEMORY_LIMITS, "qualification": False,
            "worker_command": worker_command, "watchdog_command": watchdog_command}
        contract.write_json(root / "launch.json", receipt)
        return receipt
    except BaseException as error:
        stop_owned_children([p for p in (worker_process, watchdog_process) if p is not None], error)
        raise


def regular_bytes(path: Path, boundary: Path) -> bytes:
    """Read a regular input without following a file or directory symlink."""
    if not path.is_relative_to(boundary):
        raise ValueError("Checkpoint input is outside its run")
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Checkpoint input must be a regular file: {path.name}")
    for parent in (path.parent, *path.parents):
        if parent == boundary:
            break
        if parent.is_symlink() or not parent.is_dir():
            raise ValueError("Checkpoint input directories must be regular")
    return path.read_bytes()


def validate_snapshot_guardian(raw: bytes, launch: dict, rows: list[dict], completion: float, now: float) -> None:
    """Require a launch-bound supervisor observation covering the completed checkpoint."""
    if not raw or not raw.endswith(b"\n"):
        raise ValueError("Wait for a complete supervisor guardian journal prefix")
    records = [json.loads(line) for line in raw.splitlines()]
    if not records or any(not isinstance(row, dict) for row in records) or records[0].get("status") != "watching":
        raise ValueError("Checkpoint guardian lacks its initial watching identity")
    watching = records[0]
    for key in ("worker_pid", "watchdog_pid", "worker_start_ticks", "watchdog_start_ticks"):
        if (type(launch.get(key)) is not int or launch[key] <= 0
                or type(watching.get(key)) is not int or watching[key] != launch[key]):
            raise ValueError("Checkpoint guardian PID or launch-bound birth identity changed")
    if launch["worker_pid"] == launch["watchdog_pid"]:
        raise ValueError("Checkpoint worker and watchdog must be distinct")
    identities = {json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows}
    previous_time = None
    previous_sample = None
    covered = False
    for index, record in enumerate(records):
        stamp = record.get("time_unix")
        if (type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp > now
                or (previous_time is not None and stamp <= previous_time)):
            raise ValueError("Checkpoint guardian timestamps are invalid or unordered")
        previous_time = stamp
        if index == 0:
            if stamp > completion:
                raise ValueError("Checkpoint guardian attached after checkpoint completion")
            continue
        sample, age = record.get("sample"), record.get("journalAgeSeconds")
        if (record.get("status") == "healthy" and sample is None and stamp < rows[0]["time_unix"]
                and type(age) in (int, float) and math.isfinite(age) and 0 <= age < 30):
            continue
        if (record.get("status") != "healthy" or not isinstance(sample, dict)
                or json.dumps(sample, sort_keys=True, separators=(",", ":")) not in identities
                or sample["time_unix"] > stamp or stamp - sample["time_unix"] >= 30
                or type(age) not in (int, float) or not math.isfinite(age) or not 0 <= age < 30
                or (previous_sample is not None and (sample["time_unix"] < previous_sample["time_unix"]
                    or sample["elapsed_seconds"] < previous_sample["elapsed_seconds"]
                    or ((sample["time_unix"] > previous_sample["time_unix"])
                        != (sample["elapsed_seconds"] > previous_sample["elapsed_seconds"]))))):
            raise ValueError("Checkpoint guardian healthy observation differs from its bound memory journal")
        previous_sample = sample
        if (stamp >= completion and sample["time_unix"] >= completion
                and now - sample["time_unix"] < 30 and now - stamp < 30):
            covered = True
    if not covered:
        raise ValueError("Wait for a fresh healthy guardian observation covering checkpoint completion")


def final_checkpoint_envelope(run_root: Path, output: Path, paths: dict, frozen: dict,
                              plan: dict, receipt: dict, launch: dict, checkpoint_exit: dict) -> dict:
    """Preserve genuine final1024 worker, watchdog and guardian completion proof."""
    final_paths = dict(paths)
    final_frozen = dict(frozen)
    checkpoint_name = "run/checkpoints/step-1024/exit.json"
    final_paths[checkpoint_name] = final_paths.pop("run/exit.json")
    final_frozen[checkpoint_name] = final_frozen.pop("run/exit.json")
    extra = {"run/exit.json": run_root / "run/exit.json",
        "memory.summary.json": run_root / "memory.summary.json",
        "memory.jsonl": run_root / "memory.jsonl",
        "root-guardian.jsonl": run_root / "root-guardian.jsonl"}
    final_paths.update(extra)
    final_frozen.update({name: regular_bytes(path, run_root) for name, path in extra.items()})
    root_exit = json.loads(final_frozen["run/exit.json"])
    memory = json.loads(final_frozen["memory.summary.json"])
    journal, guardian = final_frozen["memory.jsonl"], final_frozen["root-guardian.jsonl"]
    contract.validate_final_memory(plan, receipt, root_exit, memory, launch, journal, guardian, checkpoint_exit)
    validate_monitor_completion(run_root, launch)
    now = time.time()
    if any(json.loads(line)["time_unix"] > now for raw in (journal, guardian) for line in raw.splitlines()):
        raise ValueError("Final checkpoint completion proof contains a future timestamp")
    result = {"reason": "worker_exit", "checkpoint_step": 1024,
        "checkpoint_receipt_sha256": hashlib.sha256(final_frozen["run/receipt.json"]).hexdigest(),
        "worker_pid": launch["worker_pid"], "producer_sha256": digest(Path(__file__)),
        "journal_sha256": hashlib.sha256(journal).hexdigest(),
        "guardian_sha256": hashlib.sha256(guardian).hexdigest(), "snapshot_time_unix": now}
    output.mkdir(parents=True)
    try:
        for name, content in final_frozen.items():
            destination = output / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            if destination.read_bytes() != content:
                raise ValueError("Final checkpoint changed while copying")
        if any(regular_bytes(path, run_root) != final_frozen[name] for name, path in final_paths.items()):
            raise ValueError("Final checkpoint source changed while copying")
    except BaseException:
        shutil.rmtree(output)
        raise
    return result


def snapshot_checkpoint_memory(run_root: Path, checkpoint: Path | int, output: Path | None = None) -> dict:
    """Copy a complete checkpoint and bound memory prefix into an import envelope.

    This does not stop or sample a GPU process. Retry after the next existing
    watchdog sample if its latest complete row predates checkpoint completion.
    At step1024 it preserves the genuine completed worker-exit proof instead.
    The output is fresh and never changes the live run.
    """
    supplied_root = Path(run_root).expanduser().absolute()
    if supplied_root.is_symlink():
        raise ValueError("Run root must be a regular directory")
    run_root = supplied_root.resolve()
    if type(checkpoint) is int:
        checkpoint = run_root / "run" / "checkpoints" / f"step-{checkpoint}"
    checkpoint = Path(checkpoint).expanduser().absolute()
    if checkpoint.is_relative_to(supplied_root):
        checkpoint = run_root / checkpoint.relative_to(supplied_root)
    if output is None:
        output = run_root / "checkpoint-snapshots" / checkpoint.name
    output = Path(output).expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Checkpoint memory snapshot output already exists")
    output = output.resolve()
    paths = {"launch.json": run_root / "launch.json",
        **{f"run/{name}": checkpoint / name for name in (
            "plan.json", "receipt.json", "exit.json", "reload.json", "fit-margins.jsonl",
            "adapter/adapters.safetensors", "adapter/adapter_config.json")}}
    frozen = {name: regular_bytes(path, run_root) for name, path in paths.items()}
    launch = json.loads(frozen["launch.json"])
    producer_sha = digest(Path(__file__))
    if producer_sha != launch.get("launcher_sha256"):
        raise ValueError("Snapshot producer differs from pinned launcher")
    monitor_sha = launch.get("monitor_sha256")
    if monitor_sha != launch.get("watchdog_sha256") or digest(Path(monitor.__file__)) != monitor_sha:
        raise ValueError("Snapshot monitor differs from pinned launch monitor")
    receipt_bytes = frozen["run/receipt.json"]
    receipt = json.loads(receipt_bytes)
    plan = json.loads(frozen["run/plan.json"])
    reload_record = json.loads(frozen["run/reload.json"])
    exit_record = json.loads(frozen["run/exit.json"])
    step = receipt.get("checkpoint_step")
    if (type(step) is not int or step not in (1, 128, 256, 512, 1024)
            or checkpoint != run_root / "run" / "checkpoints" / f"step-{step}"
            or exit_record.get("ok") is not True or type(exit_record.get("steps_completed")) is not int
            or exit_record.get("steps_completed") != step
            or type(plan.get("checkpoint_step")) is not int or plan.get("checkpoint_step") != step
            or type(plan.get("steps")) is not int or plan.get("steps") != step
            or type(receipt.get("steps")) is not int or receipt.get("steps") != step or receipt.get("source") != plan
            or receipt.get("qualified") is not False or receipt.get("adapter_changed") is not True
            or receipt.get("mode") != plan.get("mode") or plan.get("mode") != launch.get("mode")):
        raise ValueError("Checkpoint is not complete for this run")
    source = receipt.get("source", {})
    if source.get("source_sha256") != launch.get("worker_sha256"):
        raise ValueError("Checkpoint worker differs from launch worker")
    code = Path(launch["inputs"]).resolve() / "code"
    verify_code(code, launch.get("code_sha256"))
    recipe = campaign.load_campaign(code / "recipe.json", launch.get("recipe_sha256"))
    if (launch.get("purpose") != "guardrail_cuda_fit_only_training"
            or launch.get("run_root") != str(run_root)
            or recipe != plan.get("campaign") or recipe["source_sha256"] != launch["code_sha256"]
            or plan.get("campaign_sha256") != launch.get("recipe_sha256")
            or launch.get("campaign_sha256") != launch.get("recipe_sha256")
            or launch.get("recipe_sha256") != digest(code / "recipe.json")
            or plan.get("campaign_steps") != (1 if launch["mode"] == "probe" else 1024)
            or plan.get("precision") != recipe["precision"]
            or plan.get("source_sha256") != recipe["source_sha256"]["campaign.py"]
            or plan.get("contract_sha256") != recipe["source_sha256"]["contract.py"]
            or plan.get("objective_worker_sha256") != recipe["source_sha256"]["cuda_train.py"]
            or any(launch.get(key) != value for key, value in MEMORY_LIMITS.items())):
        raise ValueError("Checkpoint recipe or launch identity changed")
    adapter_sha = hashlib.sha256(frozen["run/adapter/adapters.safetensors"]).hexdigest()
    margins_sha = hashlib.sha256(frozen["run/fit-margins.jsonl"]).hexdigest()
    delta = reload_record.get("max_margin_delta")
    if (reload_record != receipt.get("saved_adapter_reload") or reload_record.get("ok") is not True
            or reload_record.get("rows") != 327 or reload_record.get("margin_delta_limit") != 1e-5
            or reload_record.get("precision") != recipe["precision"]
            or type(delta) not in (int, float) or not math.isfinite(delta) or not 0 <= delta <= 1e-5
            or any(record.get("adapter_sha256") != adapter_sha
                   or record.get("fit_margins_sha256") != margins_sha for record in (receipt, reload_record))):
        raise ValueError("Checkpoint adapter, FIT margins or reload proof changed")
    config = json.loads(frozen["run/adapter/adapter_config.json"])
    if config != {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA}:
        raise ValueError("Checkpoint adapter configuration changed")
    margins = [json.loads(line) for line in frozen["run/fit-margins.jsonl"].splitlines()]
    if (len(margins) != 327 or any(not isinstance(row, dict) or not isinstance(row.get("source_id"), str)
            or not row["source_id"] or any(type(row.get(key)) not in (int, float)
                or not math.isfinite(row[key]) for key in ("initial", "final")) for row in margins)
            or len({row["source_id"] for row in margins}) != 327):
        raise ValueError("Checkpoint FIT margin inventory changed")
    completion = exit_record.get("completed_time_unix")
    if type(completion) not in (int, float) or not math.isfinite(completion):
        raise ValueError("Checkpoint completion timestamp is unavailable")
    if step == 1024:
        return final_checkpoint_envelope(run_root, output, paths, frozen, plan, receipt, launch, exit_record)
    raw = regular_bytes(run_root / "memory.jsonl", run_root)
    end = raw.rfind(b"\n") + 1
    prefix = raw[:end]
    rows = [json.loads(line) for line in prefix.splitlines()]
    if len(rows) < 2:
        raise ValueError("Checkpoint snapshot requires at least two memory samples")
    for row in rows:
        if not isinstance(row, dict) or "monitor_error" in row:
            raise ValueError("Checkpoint journal includes invalid or error samples")
        for key in ("time_unix", "elapsed_seconds", "dedicated_bytes", "shared_bytes", "dedicated_delta_bytes", "shared_delta_bytes"):
            value = row.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("Checkpoint journal includes invalid or error samples")
            if key.endswith("bytes") and type(value) is not int:
                raise ValueError("Checkpoint journal counters must be integer bytes")
        if (row["dedicated_delta_bytes"] != max(0, row["dedicated_bytes"] - launch["baseline_dedicated_bytes"])
                or row["shared_delta_bytes"] != max(0, row["shared_bytes"] - launch["baseline_shared_bytes"])):
            raise ValueError("Checkpoint journal deltas differ from launch baseline")
        if (row["dedicated_delta_bytes"] >= launch["stop_dedicated_delta_bytes"]
                or row["shared_delta_bytes"] >= launch["shared_growth_limit_bytes"]
                or row["dedicated_bytes"] >= launch["stop_total_dedicated_bytes"]):
            raise ValueError("Checkpoint journal reaches memory stop limit")
    if any(left["time_unix"] >= right["time_unix"] or left["elapsed_seconds"] >= right["elapsed_seconds"]
           for left, right in zip(rows, rows[1:])):
        raise ValueError("Checkpoint journal timestamps are not ordered")
    if not rows[0]["time_unix"] <= completion < rows[-1]["time_unix"]:
        raise ValueError("Wait for watchdog sample after checkpoint completion")
    now = time.time()
    if now < rows[-1]["time_unix"]:
        raise ValueError("Checkpoint journal has a future sample")
    guardian = regular_bytes(run_root / "root-guardian.jsonl", run_root)
    validate_snapshot_guardian(guardian, launch, rows, completion, now)
    summary = {
        "worker_pid": launch["worker_pid"], "reason": "checkpoint_snapshot",
        "samples": len(rows), "sampling_interval_seconds": 2.0,
        "peak_dedicated_delta_bytes": max(row["dedicated_delta_bytes"] for row in rows),
        "peak_shared_delta_bytes": max(row["shared_delta_bytes"] for row in rows),
        "peak_total_dedicated_bytes": max(row["dedicated_bytes"] for row in rows),
        "hard_budget_bytes": launch["hard_budget_bytes"],
        "stop_dedicated_delta_bytes": launch["stop_dedicated_delta_bytes"],
        "shared_growth_limit_bytes": launch["shared_growth_limit_bytes"],
        "stop_total_dedicated_bytes": launch["stop_total_dedicated_bytes"],
    }
    snapshot = {
        "checkpoint_receipt_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
        "checkpoint_step": step, "worker_pid": launch["worker_pid"],
        "worker_sha256": launch["worker_sha256"], "monitor_sha256": monitor_sha,
        "journal_sha256": hashlib.sha256(prefix).hexdigest(), "snapshot_time_unix": now,
        "guardian_sha256": hashlib.sha256(guardian).hexdigest(),
        "producer_sha256": producer_sha,
    }
    output.mkdir(parents=True)
    try:
        for name, content in frozen.items():
            destination = output / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            if destination.read_bytes() != content:
                raise ValueError("Checkpoint changed while copying")
        (output / "memory.jsonl").write_bytes(prefix)
        (output / "root-guardian.jsonl").write_bytes(guardian)
        contract.write_json(output / "memory.summary.json", summary)
        contract.write_json(output / "memory.snapshot.json", snapshot)
        if any(regular_bytes(path, run_root) != frozen[name] for name, path in paths.items()):
            raise ValueError("Checkpoint source changed while copying")
        if not regular_bytes(run_root / "memory.jsonl", run_root).startswith(prefix):
            raise ValueError("Checkpoint memory journal changed while copying")
        if not regular_bytes(run_root / "root-guardian.jsonl", run_root).startswith(guardian):
            raise ValueError("Checkpoint guardian journal changed while copying")
    except BaseException:
        shutil.rmtree(output)
        raise
    return snapshot


def snapshot_parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Copy a verified checkpoint and memory proof for local import; no GPU operations")
    command.add_argument("--run-root", type=Path, required=True)
    command.add_argument("--checkpoint", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    return command


def process_start_ticks(pid: int) -> int:
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    if fields[0] in {"Z", "X"}:
        raise ProcessLookupError("Owned process has exited")
    return int(fields[19])


def identity(pid, script, output, start_ticks, expected_command=None):
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().decode().split("\0")
        if command[-1] == "":
            command.pop()
        return (process_start_ticks(pid) == start_ticks and str(script) in command
                and (expected_command is None or command == expected_command)
                and any(command[i] == "--output" and command[i + 1] == str(output)
                        for i in range(len(command) - 1)))
    except (FileNotFoundError, ProcessLookupError):
        return False


def confirmed_stop(pid, script, output, start_ticks, expected_command=None, pidfd=None):
    if pidfd is not None and select.select([pidfd], [], [], 0)[0]:
        return {"signalled": False, "exitConfirmed": True}
    if not identity(pid, script, output, start_ticks, expected_command):
        return {"signalled": False, "identityPresent": False}
    try:
        fd = os.pidfd_open(pid) if pidfd is None else pidfd
    except ProcessLookupError:
        return {"signalled": False, "identityPresent": False}
    try:
        if not identity(pid, script, output, start_ticks, expected_command):
            return {"signalled": False, "identityPresent": False}
        try:
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            if select.select([fd], [], [], 5)[0]:
                return {"signalled": True, "exitConfirmed": True, "signal": "SIGTERM"}
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            return {"signalled": True, "exitConfirmed": bool(select.select([fd], [], [], 5)[0]),
                    "signal": "SIGKILL"}
        except ProcessLookupError:
            return {"signalled": True, "exitConfirmed": bool(select.select([fd], [], [], 5)[0])}
    finally:
        if pidfd is None:
            os.close(fd)


def last_record(path):
    with path.open("rb") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(max(0, size - 8192))
        raw = stream.read()
    lines = raw.splitlines()
    if not raw.endswith(b"\n"):
        lines = lines[:-1]
    return json.loads(lines[-1])


def validate_monitor_completion(root: Path, launch: dict) -> None:
    journal, summary_path = root / "memory.jsonl", root / "memory.summary.json"
    if any(not path.is_file() or path.is_symlink() for path in (journal, summary_path)):
        raise ValueError("Completed watchdog files must be regular files")
    raw = journal.read_bytes()
    if raw and not raw.endswith(b"\n"):
        raise ValueError("Completed watchdog journal has a partial line")
    rows = [json.loads(line) for line in raw.splitlines()]
    summary = json.loads(summary_path.read_bytes())
    if len(rows) < 2:
        raise ValueError("Completed watchdog requires at least two genuine samples")
    if any(not isinstance(row, dict) or "monitor_error" in row for row in rows):
        raise ValueError("Completed watchdog journal contains a monitor error")
    if (not isinstance(summary, dict) or summary.get("reason") != "worker_exit"
            or type(summary.get("worker_pid")) is not int or summary["worker_pid"] != launch["worker_pid"]
            or type(summary.get("samples")) is not int or summary["samples"] != len(rows)
            or summary.get("sampling_interval_seconds") != 2.0):
        raise ValueError("Completed watchdog summary is not a bound worker_exit")
    for key in ("hard_budget_bytes", "stop_dedicated_delta_bytes", "shared_growth_limit_bytes", "stop_total_dedicated_bytes"):
        if summary.get(key) != launch[key]:
            raise ValueError("Completed watchdog stop contract changed")
    peaks = {"peak_total_dedicated_bytes": 0, "peak_dedicated_delta_bytes": 0, "peak_shared_delta_bytes": 0}
    previous = None
    for row in rows:
        stamp, elapsed = row.get("time_unix"), row.get("elapsed_seconds")
        if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (stamp, elapsed))
                or elapsed < 0 or stamp > time.time()
                or any(type(row.get(key)) is not int or row[key] < 0 for key in (
                    "dedicated_bytes", "shared_bytes", "dedicated_delta_bytes", "shared_delta_bytes"))
                or (previous is not None and (stamp <= previous[0] or elapsed <= previous[1]))
                or row["dedicated_delta_bytes"] != max(0, row["dedicated_bytes"] - launch["baseline_dedicated_bytes"])
                or row["shared_delta_bytes"] != max(0, row["shared_bytes"] - launch["baseline_shared_bytes"])):
            raise ValueError("Completed watchdog sample identity or clocks changed")
        previous = (stamp, elapsed)
        for key, value in (("peak_total_dedicated_bytes", row["dedicated_bytes"]),
                           ("peak_dedicated_delta_bytes", row["dedicated_delta_bytes"]),
                           ("peak_shared_delta_bytes", row["shared_delta_bytes"])):
            peaks[key] = max(peaks[key], value)
    if (any(type(summary.get(key)) is not int or summary[key] != value for key, value in peaks.items())
            or peaks["peak_total_dedicated_bytes"] <= 0
            or peaks["peak_total_dedicated_bytes"] >= launch["stop_total_dedicated_bytes"]
            or peaks["peak_dedicated_delta_bytes"] >= launch["stop_dedicated_delta_bytes"]
            or peaks["peak_shared_delta_bytes"] >= launch["shared_growth_limit_bytes"]):
        raise ValueError("Completed watchdog peaks or memory limits changed")


def supervise(run_root: Path, launch_sha256: str) -> dict:
    """Root attaches this independent guard to its own pinned launch, without CUDA allocation."""
    root = Path(run_root).resolve()
    if (not isinstance(launch_sha256, str) or len(launch_sha256) != 64
            or any(c not in "0123456789abcdef" for c in launch_sha256)):
        raise ValueError("Root supervision requires the explicit launch receipt SHA256")
    launch_path = root / "launch.json"
    launch = json.loads(objective.exact_file(launch_path, launch_sha256))
    if (launch.get("purpose") != "guardrail_cuda_fit_only_training"
            or launch.get("run_root") != str(root)
            or launch.get("launcher_sha256") != digest(Path(__file__))):
        raise ValueError("Root supervision requires its own pinned campaign launch")
    code = Path(launch["inputs"]).resolve() / "code"
    verify_code(code, launch["code_sha256"])
    recipe = campaign.load_campaign(code / "recipe.json", launch.get("recipe_sha256"))
    if (launch.get("recipe_sha256") != digest(code / "recipe.json")
            or launch.get("campaign_sha256") != launch.get("recipe_sha256")
            or recipe["source_sha256"] != launch["code_sha256"]):
        raise ValueError("Root supervision recipe differs from launch identity")
    script = code / "campaign.py"
    watchdog = code / "memory_monitor.py"
    if (launch.get("worker_sha256") != digest(script)
            or launch.get("watchdog_sha256") != digest(watchdog)
            or launch.get("monitor_sha256") != digest(watchdog)):
        raise ValueError("Root supervision code differs from launch identity")
    for key, value in (("hard_budget_bytes", 8_000_000_000), ("allocator_cap_bytes", 6_500_000_000),
                       ("stop_dedicated_delta_bytes", 7_500_000_000), ("shared_growth_limit_bytes", 128_000_000),
                       ("stop_total_dedicated_bytes", 16_000_000_000)):
        if launch.get(key) != value:
            raise ValueError("Root supervision memory stop contract changed")
    for key in ("worker_pid", "watchdog_pid", "worker_start_ticks", "watchdog_start_ticks"):
        if type(launch.get(key)) is not int or launch[key] <= 0:
            raise ValueError("Missing owned launch PID")
    if launch["worker_pid"] == launch["watchdog_pid"]:
        raise ValueError("Worker and independent watchdog must be distinct")
    for key in ("worker_command", "watchdog_command"):
        if not isinstance(launch.get(key), list) or any(not isinstance(arg, str) for arg in launch[key]):
            raise ValueError("Missing exact launched process command")
    worker = (launch["worker_pid"], script, root / "run", process_start_ticks(launch["worker_pid"]), launch["worker_command"])
    monitor_identity = (launch["watchdog_pid"], watchdog, root / "memory.jsonl",
                        process_start_ticks(launch["watchdog_pid"]), launch["watchdog_command"])
    if worker[3] != launch["worker_start_ticks"] or monitor_identity[3] != launch["watchdog_start_ticks"]:
        raise ValueError("Launched worker or watchdog birth identity changed before supervision")
    if not identity(*worker) or not identity(*monitor_identity):
        raise ValueError("Expected owned worker and watchdog are absent")
    previous_time = None
    previous_elapsed = None
    last_change = time.monotonic()
    last_status = 0
    with contextlib.ExitStack() as guard:
        worker_fd = os.pidfd_open(worker[0])
        guard.callback(os.close, worker_fd)
        def stop_on_guard_exit():
            outcome = confirmed_stop(*worker, pidfd=worker_fd)
            if outcome.get("identityPresent") is not False and outcome.get("exitConfirmed") is not True:
                raise RuntimeError("Owned worker stop was not confirmed during guard cleanup")
        guard.callback(stop_on_guard_exit)
        monitor_fd = os.pidfd_open(monitor_identity[0])
        guard.callback(os.close, monitor_fd)
        def interrupted(signum, _frame):
            raise InterruptedError(f"Root supervision interrupted by signal {signum}")
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous = signal.signal(sig, interrupted)
            guard.callback(signal.signal, sig, previous)
        if not identity(*worker) or not identity(*monitor_identity):
            raise RuntimeError("Owned worker or watchdog changed before guard attachment")
        with (root / "root-guardian.jsonl").open("x", buffering=1) as log:
            def record(value):
                value["time_unix"] = time.time()
                log.write(json.dumps(value, allow_nan=False) + "\n")
                print(json.dumps(value, allow_nan=False), flush=True)
                return value
            record({"status": "watching", "worker_pid": worker[0], "watchdog_pid": monitor_identity[0],
                    "worker_start_ticks": worker[3], "watchdog_start_ticks": monitor_identity[3]})
            while identity(*worker):
                reason = None
                sample = None
                if not identity(*monitor_identity):
                    if select.select([worker_fd], [], [], 0)[0]:
                        break
                    reason = "watchdog_missing"
                try:
                    journal = root / "memory.jsonl"
                    if journal.is_symlink():
                        raise ValueError("Watchdog journal must be a regular file")
                    sample = last_record(journal)
                    if not isinstance(sample, dict):
                        raise ValueError("Watchdog sample must be an object")
                    if "monitor_error" in sample:
                        reason = "watchdog_error"
                    else:
                        for key in ("dedicated_bytes", "shared_bytes", "dedicated_delta_bytes", "shared_delta_bytes"):
                            if type(sample.get(key)) is not int or sample[key] < 0:
                                raise ValueError("Invalid watchdog memory counter")
                        stamp = sample.get("time_unix")
                        elapsed = sample.get("elapsed_seconds")
                        if (type(stamp) not in (int, float) or not math.isfinite(stamp)
                                or type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0
                                or stamp > time.time()
                                or (previous_time is not None and stamp < previous_time)
                                or (previous_elapsed is not None and elapsed < previous_elapsed)
                                or (previous_time is not None and ((stamp > previous_time) != (elapsed > previous_elapsed)))
                                or sample["dedicated_delta_bytes"] != max(0, sample["dedicated_bytes"] - launch["baseline_dedicated_bytes"])
                                or sample["shared_delta_bytes"] != max(0, sample["shared_bytes"] - launch["baseline_shared_bytes"])):
                            raise ValueError("Invalid watchdog sample identity or timestamp")
                        if previous_time is None or stamp > previous_time:
                            previous_time = stamp
                            previous_elapsed = elapsed
                            last_change = time.monotonic()
                        if time.time() - stamp >= 30:
                            reason = "watchdog_journal_stale"
                        elif sample["dedicated_bytes"] >= launch["stop_total_dedicated_bytes"]:
                            reason = "absolute_total_dedicated_limit"
                        elif sample["dedicated_delta_bytes"] >= launch["stop_dedicated_delta_bytes"]:
                            reason = "dedicated_stop_threshold"
                        elif sample["shared_delta_bytes"] >= launch["shared_growth_limit_bytes"]:
                            reason = "shared_memory_growth"
                except (FileNotFoundError, IndexError):
                    sample = None
                except (OSError, ValueError, KeyError, TypeError):
                    reason = "watchdog_journal_invalid"
                if time.monotonic() - last_change >= 30:
                    reason = "watchdog_journal_stale"
                if reason:
                    outcome = confirmed_stop(*worker, pidfd=worker_fd)
                    result = record({"status": "stop", "reason": reason, "worker": outcome})
                    if outcome.get("identityPresent") is not False and outcome.get("exitConfirmed") is not True:
                        raise RuntimeError("Owned worker stop was not confirmed")
                    return result
                now = time.monotonic()
                if now - last_status >= 30:
                    record({"status": "healthy", "journalAgeSeconds": now - last_change, "sample": sample})
                    last_status = now
                time.sleep(1)
            if not select.select([worker_fd], [], [], 5)[0]:
                raise RuntimeError("Owned worker identity disappeared without confirmed exit")
            # A counter call already in flight must finish, preserving its real outcome.
            if not select.select([monitor_fd], [], [], 20)[0]:
                raise RuntimeError("Owned watchdog completion was not confirmed within 20 seconds")
            try:
                validate_monitor_completion(root, launch)
            except (OSError, ValueError, KeyError, TypeError):
                return record({"status": "stop", "reason": "watchdog_completion_invalid",
                               "worker": {"signalled": False, "exitConfirmed": True}})
            return record({"status": "worker_exit", "worker_pid": worker[0]})


def supervise_parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Root-owned pinned campaign supervision; no CUDA allocation")
    command.add_argument("--run-root", type=Path, required=True)
    command.add_argument("--launch-sha256", required=True)
    return command


def stage_parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Stage verified inputs locally; no remote or GPU operations")
    command.add_argument("--base", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--training-dir", type=Path, default=Path(__file__).resolve().parent)
    return command


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--inputs", required=True)
    command.add_argument("--recipe-sha256", required=True, help="Explicit SHA256 from the verified staging receipt")
    command.add_argument("--run-root", required=True)
    command.add_argument("--adapter-tag", required=True)
    command.add_argument("--mode", choices=["probe", "train"], required=True)
    return command


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "stage":
        print(json.dumps(stage(stage_parser().parse_args(sys.argv[2:]))))
    elif len(sys.argv) > 1 and sys.argv[1] == "supervise":
        args = supervise_parser().parse_args(sys.argv[2:])
        print(json.dumps(supervise(args.run_root, args.launch_sha256)))
    elif len(sys.argv) > 1 and sys.argv[1] == "snapshot":
        args = snapshot_parser().parse_args(sys.argv[2:])
        print(json.dumps(snapshot_checkpoint_memory(args.run_root, args.checkpoint, args.output)))
    else:
        receipt = run(parser().parse_args())
        print(json.dumps({key: receipt[key] for key in ("mode", "worker_pid", "watchdog_pid", "run_root")}))
