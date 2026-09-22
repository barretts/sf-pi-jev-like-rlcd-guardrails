#!/usr/bin/env python3
"""Stop one identified CUDA worker before it exceeds the shared Windows GPU budget."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


COUNTER_COMMAND = (
    "Get-Counter -Counter '\\GPU Adapter Memory(*)\\Dedicated Usage',"
    "'\\GPU Adapter Memory(*)\\Shared Usage' | "
    "Select-Object -ExpandProperty CounterSamples | "
    "Select-Object Path,CookedValue | ConvertTo-Json -Compress"
)


def parse_counters(raw: str, adapter_tag: str) -> tuple[int, int]:
    data = json.loads(raw)
    rows = data if isinstance(data, list) else [data]
    found: dict[str, int] = {}
    for row in rows:
        path = str(row.get("Path", "")).lower()
        if adapter_tag.lower() not in path:
            continue
        value = row.get("CookedValue")
        if not isinstance(value, (int, float)) or value < 0:
            raise ValueError("Invalid Windows GPU counter")
        if "dedicated usage" in path:
            found["dedicated"] = int(value)
        elif "shared usage" in path:
            found["shared"] = int(value)
    if set(found) != {"dedicated", "shared"}:
        raise ValueError("Pinned Windows GPU adapter counters are unavailable")
    return found["dedicated"], found["shared"]


def sample(adapter_tag: str) -> tuple[int, int]:
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", COUNTER_COMMAND],
        check=True,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=15,
    )
    return parse_counters(result.stdout, adapter_tag)


def is_owned_worker(pid: int, worker: Path, run_dir: Path) -> bool:
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace")
    except FileNotFoundError:
        return False
    return str(worker.resolve()) in command and str(run_dir.resolve()) in command


def stop_owned_worker(pid: int, worker: Path, run_dir: Path) -> bool:
    if not is_owned_worker(pid, worker, run_dir):
        return False
    os.kill(pid, signal.SIGTERM)
    return True


def run(args: argparse.Namespace) -> None:
    if not 0 < args.stop_dedicated_delta_bytes < args.hard_budget_bytes:
        raise ValueError("Dedicated stop threshold must precede the hard budget")
    if args.interval_seconds <= 0 or args.shared_growth_limit_bytes <= 0:
        raise ValueError("Invalid monitor sampling settings")
    output = Path(args.output)
    if output.exists():
        raise ValueError("Memory monitor output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    pid_file = Path(args.pid_file)
    for _ in range(60):
        if pid_file.is_file():
            break
        time.sleep(0.5)
    if not pid_file.is_file():
        raise ValueError("Worker PID did not appear within 30 seconds")
    pid = int(pid_file.read_text().strip())
    worker = Path(args.worker)
    run_dir = Path(args.run_dir)
    if not is_owned_worker(pid, worker, run_dir):
        raise ValueError("PID does not identify this CUDA worker and run")
    peak_dedicated_delta = 0
    peak_shared_delta = 0
    samples = 0
    reason = "worker_exit"
    with output.open("x", buffering=1) as journal:
        while is_owned_worker(pid, worker, run_dir):
            try:
                dedicated, shared = sample(args.adapter_tag)
                dedicated_delta = max(0, dedicated - args.baseline_dedicated_bytes)
                shared_delta = max(0, shared - args.baseline_shared_bytes)
                peak_dedicated_delta = max(peak_dedicated_delta, dedicated_delta)
                peak_shared_delta = max(peak_shared_delta, shared_delta)
                record = {
                    "time_unix": time.time(),
                    "elapsed_seconds": time.monotonic() - started,
                    "dedicated_bytes": dedicated,
                    "shared_bytes": shared,
                    "dedicated_delta_bytes": dedicated_delta,
                    "shared_delta_bytes": shared_delta,
                }
                journal.write(json.dumps(record) + "\n")
                samples += 1
                if dedicated_delta >= args.stop_dedicated_delta_bytes:
                    reason = "dedicated_stop_threshold"
                elif shared_delta >= args.shared_growth_limit_bytes:
                    reason = "shared_memory_growth"
            except BaseException as error:
                journal.write(json.dumps({
                    "time_unix": time.time(),
                    "monitor_error": type(error).__name__,
                    "detail": str(error)[:500],
                }) + "\n")
                reason = "monitor_error"
            if reason != "worker_exit":
                stop_owned_worker(pid, worker, run_dir)
                break
            time.sleep(args.interval_seconds)
    summary = {
        "worker_pid": pid,
        "reason": reason,
        "samples": samples,
        "sampling_interval_seconds": args.interval_seconds,
        "peak_dedicated_delta_bytes": peak_dedicated_delta,
        "peak_shared_delta_bytes": peak_shared_delta,
        "hard_budget_bytes": args.hard_budget_bytes,
        "stop_dedicated_delta_bytes": args.stop_dedicated_delta_bytes,
        "shared_growth_limit_bytes": args.shared_growth_limit_bytes,
    }
    output.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2) + "\n")


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--pid-file", required=True)
    command.add_argument("--worker", required=True)
    command.add_argument("--run-dir", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--adapter-tag", required=True)
    command.add_argument("--baseline-dedicated-bytes", type=int, required=True)
    command.add_argument("--baseline-shared-bytes", type=int, required=True)
    command.add_argument("--hard-budget-bytes", type=int, default=8_000_000_000)
    command.add_argument("--stop-dedicated-delta-bytes", type=int, default=7_500_000_000)
    command.add_argument("--shared-growth-limit-bytes", type=int, default=128_000_000)
    command.add_argument("--interval-seconds", type=float, default=2.0)
    return command


if __name__ == "__main__":
    run(parser().parse_args())
