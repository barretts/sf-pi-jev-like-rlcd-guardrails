#!/usr/bin/env python3
"""Stop one identified CUDA worker before it exceeds the shared Windows GPU budget."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
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


def process_command(pid: int) -> list[str]:
    command = Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace").split("\0")
    if command[-1] == "":
        command.pop()
    return command


def process_start_ticks(pid: int) -> int:
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    if fields[0] in {"Z", "X"}:
        raise ProcessLookupError("Owned process has exited")
    return int(fields[19])


def is_owned_worker(pid: int, worker: Path, run_dir: Path,
                    start_ticks: int | None = None, expected_command: list[str] | None = None) -> bool:
    try:
        command = process_command(pid)
        if ((start_ticks is not None and process_start_ticks(pid) != start_ticks)
                or (expected_command is not None and command != expected_command)):
            return False
    except (FileNotFoundError, ProcessLookupError):
        return False
    if str(worker.resolve()) not in command:
        return False
    return any(command[index] == "--output" and command[index + 1] == str(run_dir.resolve())
               for index in range(len(command) - 1))


def stop_owned_worker(pid: int, worker: Path, run_dir: Path,
                      start_ticks: int | None = None, expected_command: list[str] | None = None,
                      pidfd: int | None = None) -> bool:
    if pidfd is None:
        if not is_owned_worker(pid, worker, run_dir, start_ticks, expected_command):
            return False
        start_ticks = process_start_ticks(pid) if start_ticks is None else start_ticks
        expected_command = process_command(pid) if expected_command is None else expected_command
        pidfd = os.pidfd_open(pid)
        try:
            return stop_owned_worker(pid, worker, run_dir, start_ticks, expected_command, pidfd)
        finally:
            os.close(pidfd)
    if select.select([pidfd], [], [], 0)[0]:
        return True
    if not is_owned_worker(pid, worker, run_dir, start_ticks, expected_command):
        if select.select([pidfd], [], [], 5)[0]:
            return True
        raise RuntimeError("Owned worker identity disappeared without confirmed exit")
    try:
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        if select.select([pidfd], [], [], 5)[0]:
            return True
        if not is_owned_worker(pid, worker, run_dir, start_ticks, expected_command):
            if select.select([pidfd], [], [], 5)[0]:
                return True
            raise RuntimeError("Owned worker identity changed before escalation")
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if not select.select([pidfd], [], [], 5)[0]:
        raise RuntimeError("Owned worker stop was not confirmed")
    return True


def run(args: argparse.Namespace) -> None:
    if not 0 < args.stop_dedicated_delta_bytes < args.hard_budget_bytes:
        raise ValueError("Dedicated stop threshold must precede the hard budget")
    if args.interval_seconds <= 0 or args.shared_growth_limit_bytes <= 0:
        raise ValueError("Invalid monitor sampling settings")
    total_limit = getattr(args, "stop_total_dedicated_bytes", None)
    if total_limit is not None and total_limit <= 0:
        raise ValueError("Invalid absolute dedicated memory limit")
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
    start_ticks, command = process_start_ticks(pid), process_command(pid)
    peak_dedicated = 0
    peak_dedicated_delta = 0
    peak_shared_delta = 0
    samples = 0
    reason = "worker_exit"
    failure = None
    with contextlib.ExitStack() as owned:
        pidfd = os.pidfd_open(pid)
        owned.callback(os.close, pidfd)
        if not is_owned_worker(pid, worker, run_dir, start_ticks, command):
            raise ValueError("Worker identity changed before monitor attachment")
        with output.open("x", buffering=1) as journal:
            while True:
                try:
                    if select.select([pidfd], [], [], 0)[0]:
                        break
                    if not is_owned_worker(pid, worker, run_dir, start_ticks, command):
                        if select.select([pidfd], [], [], 5)[0]:
                            break
                        raise RuntimeError("Owned worker identity disappeared without confirmed exit")
                    # Recheck after the ownership read, before starting another counter child.
                    if select.select([pidfd], [], [], 0)[0]:
                        break
                    dedicated, shared = sample(args.adapter_tag)
                    dedicated_delta = max(0, dedicated - args.baseline_dedicated_bytes)
                    shared_delta = max(0, shared - args.baseline_shared_bytes)
                    peak_dedicated = max(peak_dedicated, dedicated)
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
                    if total_limit is not None and dedicated >= total_limit:
                        reason = "absolute_total_dedicated_limit"
                    elif dedicated_delta >= args.stop_dedicated_delta_bytes:
                        reason = "dedicated_stop_threshold"
                    elif shared_delta >= args.shared_growth_limit_bytes:
                        reason = "shared_memory_growth"
                except BaseException as error:
                    error_record = {
                        "time_unix": time.time(),
                        "monitor_error": type(error).__name__,
                        "detail": str(error)[:500],
                    }
                    if isinstance(error, subprocess.CalledProcessError):
                        stderr = error.stderr.decode("utf-8", "replace") if isinstance(error.stderr, bytes) else str(error.stderr or "")
                        error_record.update({"returncode": error.returncode, "stderr": stderr[:500]})
                    journal.write(json.dumps(error_record) + "\n")
                    reason = "monitor_error"
                    failure = error
                if reason != "worker_exit":
                    try:
                        stop_owned_worker(pid, worker, run_dir, start_ticks, command, pidfd)
                    except BaseException as error:
                        if failure is None:
                            failure = error
                        else:
                            print(f"Owned worker stop also failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                    break
                if select.select([pidfd], [], [], args.interval_seconds)[0]:
                    break
    summary = {
        "worker_pid": pid,
        "reason": reason,
        "samples": samples,
        "sampling_interval_seconds": args.interval_seconds,
        "peak_total_dedicated_bytes": peak_dedicated,
        "stop_total_dedicated_bytes": total_limit,
        "peak_dedicated_delta_bytes": peak_dedicated_delta,
        "peak_shared_delta_bytes": peak_shared_delta,
        "hard_budget_bytes": args.hard_budget_bytes,
        "stop_dedicated_delta_bytes": args.stop_dedicated_delta_bytes,
        "shared_growth_limit_bytes": args.shared_growth_limit_bytes,
    }
    output.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    if failure is not None:
        raise failure


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
    command.add_argument("--stop-total-dedicated-bytes", type=int)
    command.add_argument("--interval-seconds", type=float, default=2.0)
    return command


if __name__ == "__main__":
    run(parser().parse_args())
