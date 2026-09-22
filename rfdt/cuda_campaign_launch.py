#!/usr/bin/env python3
"""Launch one isolated frozen C10 CUDA campaign with a separate Windows memory watchdog."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

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
        "worker_sha256": digest(worker),
        "objective_worker_sha256": digest(code / "cuda_worker.py"),
        "code_sha256": code_hashes,
        "watchdog_sha256": digest(watchdog),
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
    receipt = run(parser().parse_args())
    print(json.dumps({"mode": receipt["mode"], "worker_pid": receipt["worker_pid"], "watchdog_pid": receipt["watchdog_pid"], "run_root": receipt["run_root"]}))
