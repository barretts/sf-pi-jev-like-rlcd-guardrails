#!/usr/bin/env python3
"""Launch one isolated frozen C10 CUDA campaign with a separate Windows memory watchdog."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time

import cuda_memory_monitor as monitor
import cuda_worker
import cuda_campaign


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_code(code: Path, expected: dict) -> None:
    names = {"cuda_campaign.py", "cuda_worker.py", "cuda_memory_monitor.py", "worker.py"}
    if not isinstance(expected, dict) or set(expected) != names:
        raise ValueError("Pin exactly the four campaign code hashes")
    for name in sorted(names):
        sha = expected[name]
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise ValueError("Invalid pinned code SHA256")
        cuda_worker.exact_file(code / name, sha)


def run(args: argparse.Namespace) -> dict:
    inputs = Path(args.inputs).resolve()
    root = Path(args.run_root).resolve()
    if root.exists():
        raise ValueError("CUDA run root already exists")
    code = inputs / "code"
    worker = code / "cuda_campaign.py"
    watchdog = code / "cuda_memory_monitor.py"
    code_hashes = json.loads(args.code_sha256_json)
    verify_code(code, code_hashes)
    campaign_path = code / "cuda-campaign.json"
    campaign = cuda_campaign.load_campaign(campaign_path)
    contract = argparse.Namespace(
        base=str(inputs / "base"),
        train=str(inputs / "fit" / "prepared-train.jsonl"),
        pairs=str(inputs / "fit" / "pairs.json"),
        pairs_sha256=cuda_worker.PAIR_SHA256,
        families=str(inputs / "fit" / "families.json"),
        families_sha256=cuda_worker.FAMILY_SHA256,
        plan=str(code / "objective-plan-B.json"),
        plan_sha256=cuda_worker.PLAN_SHA256,
    )
    cuda_worker.load_contract(contract)
    if args.mode not in {"probe", "train"}:
        raise ValueError("Use probe or train")
    steps = 1 if args.mode == "probe" else 1024
    cuda_campaign.validate_args(argparse.Namespace(
        mode=args.mode, steps=steps, budget_bytes=8_000_000_000,
        allocator_cap_bytes=6_500_000_000), campaign)
    baseline_dedicated, baseline_shared = monitor.sample(args.adapter_tag)
    if baseline_dedicated >= 16_000_000_000:
        raise ValueError("Absolute dedicated memory limit already reached")
    run_dir = root / "run"
    worker_command = [
        sys.executable,
        str(worker),
        "--campaign", str(campaign_path),
        "--mode", args.mode,
        "--base", contract.base,
        "--train", contract.train,
        "--pairs", contract.pairs,
        "--pairs-sha256", contract.pairs_sha256,
        "--families", contract.families,
        "--families-sha256", contract.families_sha256,
        "--plan", contract.plan,
        "--plan-sha256", contract.plan_sha256,
        "--output", str(run_dir),
        "--steps", str(steps),
        "--budget-bytes", "8000000000",
        "--allocator-cap-bytes", "6500000000",
    ]
    watchdog_command = [
        sys.executable,
        str(watchdog),
        "--pid-file", str(root / "worker.pid"),
        "--worker", str(worker),
        "--run-dir", str(run_dir),
        "--output", str(root / "memory.jsonl"),
        "--adapter-tag", args.adapter_tag,
        "--baseline-dedicated-bytes", str(baseline_dedicated),
        "--baseline-shared-bytes", str(baseline_shared),
        "--hard-budget-bytes", "8000000000",
        "--stop-dedicated-delta-bytes", "7500000000",
        "--shared-growth-limit-bytes", "128000000",
        "--stop-total-dedicated-bytes", "16000000000",
        "--interval-seconds", "2",
    ]
    verify_code(code, code_hashes)
    cuda_campaign.load_campaign(campaign_path)
    root.mkdir(parents=True)
    try:
        with (root / "watchdog.log").open("xb", buffering=0) as watchdog_log:
            watchdog_process = subprocess.Popen(
                watchdog_command,
                cwd=code,
                stdin=subprocess.DEVNULL,
                stdout=watchdog_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        with (root / "worker.log").open("xb", buffering=0) as worker_log:
            worker_process = subprocess.Popen(
                worker_command,
                cwd=code,
                stdin=subprocess.DEVNULL,
                stdout=worker_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
    except BaseException:
        if "watchdog_process" in locals():
            watchdog_process.terminate()
        raise
    (root / "worker.pid").write_text(f"{worker_process.pid}\n")
    (root / "watchdog.pid").write_text(f"{watchdog_process.pid}\n")
    receipt = {
        "purpose": "candidate10_cuda_fit_only_campaign",
        "mode": args.mode,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "worker_pid": worker_process.pid,
        "watchdog_pid": watchdog_process.pid,
        "inputs": str(inputs),
        "run_root": str(root),
        "prepared_fit_sha256": cuda_worker.TRAIN_SHA256,
        "plan_sha256": cuda_worker.PLAN_SHA256,
        "campaign_sha256": cuda_campaign.CAMPAIGN_SHA256,
        "launcher_sha256": digest(Path(__file__)),
        "worker_sha256": digest(worker),
        "objective_worker_sha256": digest(code / "cuda_worker.py"),
        "code_sha256": code_hashes,
        "watchdog_sha256": digest(watchdog),
        "monitor_sha256": digest(watchdog),
        "rfdt_contract_sha256": digest(code / "worker.py"),
        "baseline_dedicated_bytes": baseline_dedicated,
        "baseline_shared_bytes": baseline_shared,
        "hard_budget_bytes": 8_000_000_000,
        "allocator_cap_bytes": 6_500_000_000,
        "stop_dedicated_delta_bytes": 7_500_000_000,
        "shared_growth_limit_bytes": 128_000_000,
        "stop_total_dedicated_bytes": 16_000_000_000,
        "qualification": False,
        "worker_command": worker_command,
        "watchdog_command": watchdog_command,
    }
    (root / "launch.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt



def snapshot_checkpoint_memory(run_root: Path, checkpoint: Path | int, output: Path | None = None) -> dict:
    """Copy a complete immutable journal prefix after a finished checkpoint.

    This does not stop or sample a GPU process. Retry after the next existing
    watchdog sample if its latest complete row predates checkpoint completion.
    The output is fresh, and never substitutes for the final worker-exit record.
    """
    run_root = Path(run_root).resolve()
    if type(checkpoint) is int:
        checkpoint = run_root / "run" / "checkpoints" / f"step-{checkpoint}"
    checkpoint = Path(checkpoint).resolve()
    if output is None:
        output = run_root / "checkpoint-snapshots" / checkpoint.name
    output = Path(output).resolve()
    if output.exists():
        raise ValueError("Checkpoint memory snapshot output already exists")
    launch = json.loads((run_root / "launch.json").read_text())
    producer_sha = digest(Path(__file__))
    if producer_sha != launch.get("launcher_sha256"):
        raise ValueError("Snapshot producer differs from pinned launcher")
    monitor_sha = launch.get("monitor_sha256")
    if monitor_sha != launch.get("watchdog_sha256") or digest(Path(monitor.__file__)) != monitor_sha:
        raise ValueError("Snapshot monitor differs from pinned launch monitor")
    receipt_path = checkpoint / "receipt.json"
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    exit_record = json.loads((checkpoint / "exit.json").read_text())
    step = receipt.get("checkpoint_step")
    if (type(step) is not int or step not in (1, 128, 256, 512, 1024)
            or checkpoint != run_root / "run" / "checkpoints" / f"step-{step}"
            or exit_record.get("ok") is not True or exit_record.get("steps_completed") != step):
        raise ValueError("Checkpoint is not complete for this run")
    source = receipt.get("source", {})
    if source.get("source_sha256") != launch.get("worker_sha256"):
        raise ValueError("Checkpoint worker differs from launch worker")
    completion = exit_record.get("completed_time_unix")
    if type(completion) not in (int, float) or not math.isfinite(completion):
        raise ValueError("Checkpoint completion timestamp is unavailable")
    raw = (run_root / "memory.jsonl").read_bytes()
    end = raw.rfind(b"\n") + 1
    prefix = raw[:end]
    rows = [json.loads(line) for line in prefix.splitlines()]
    if len(rows) < 2:
        raise ValueError("Checkpoint snapshot requires at least two memory samples")
    for row in rows:
        for key in ("time_unix", "elapsed_seconds", "dedicated_bytes", "shared_bytes", "dedicated_delta_bytes", "shared_delta_bytes"):
            value = row.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("Checkpoint journal includes invalid or error samples")
        if (row["dedicated_delta_bytes"] != max(0, row["dedicated_bytes"] - launch["baseline_dedicated_bytes"])
                or row["shared_delta_bytes"] != max(0, row["shared_bytes"] - launch["baseline_shared_bytes"])):
            raise ValueError("Checkpoint journal deltas differ from launch baseline")
        if (row["dedicated_delta_bytes"] >= launch["stop_dedicated_delta_bytes"]
                or row["shared_delta_bytes"] >= launch["shared_growth_limit_bytes"]
                or row["dedicated_bytes"] >= launch["stop_total_dedicated_bytes"]):
            raise ValueError("Checkpoint journal reaches memory stop limit")
    if any(left["time_unix"] >= right["time_unix"] for left, right in zip(rows, rows[1:])):
        raise ValueError("Checkpoint journal timestamps are not ordered")
    if not rows[0]["time_unix"] <= completion <= rows[-1]["time_unix"]:
        raise ValueError("Wait for watchdog sample after checkpoint completion")
    now = time.time()
    if now < rows[-1]["time_unix"]:
        raise ValueError("Checkpoint journal has a future sample")
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
        "producer_sha256": producer_sha,
    }
    output.mkdir(parents=True)
    (output / "memory.jsonl").write_bytes(prefix)
    (output / "memory.summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (output / "memory.snapshot.json").write_text(json.dumps(snapshot, indent=2) + "\n")
    return snapshot


def snapshot_parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Snapshot pinned checkpoint memory; no GPU operations")
    command.add_argument("--run-root", type=Path, required=True)
    command.add_argument("--checkpoint", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    return command


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--inputs", required=True)
    command.add_argument("--code-sha256-json", required=True,
                         help="Externally pinned JSON map of all four Python code SHA256 hashes")
    command.add_argument("--run-root", required=True)
    command.add_argument("--adapter-tag", required=True)
    command.add_argument("--mode", choices=["probe", "train"], required=True)
    return command


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "snapshot":
        arguments = snapshot_parser().parse_args(sys.argv[2:])
        print(json.dumps(snapshot_checkpoint_memory(arguments.run_root, arguments.checkpoint, arguments.output)))
        sys.exit(0)
    receipt = run(parser().parse_args())
    print(json.dumps({"mode": receipt["mode"], "worker_pid": receipt["worker_pid"], "watchdog_pid": receipt["watchdog_pid"], "run_root": receipt["run_root"]}))
