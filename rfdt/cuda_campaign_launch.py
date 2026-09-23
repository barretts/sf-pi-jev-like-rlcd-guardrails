#!/usr/bin/env python3
"""Launch one isolated frozen CUDA campaign with a separate Windows memory watchdog."""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

import cuda_memory_monitor as monitor
import cuda_worker


def campaign_for_candidate(candidate: str):
    if candidate not in {"candidate10", "candidate11"}:
        raise ValueError("Use the explicit candidate10 or candidate11 profile")
    return importlib.import_module("c11_cuda_campaign" if candidate == "candidate11" else "cuda_campaign")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_code(code: Path, expected: dict, candidate: str = "candidate10") -> None:
    names = {"cuda_worker.py", "cuda_memory_monitor.py", "worker.py", "gemma3_fp32.py"}
    if candidate == "candidate10":
        names.add("cuda_campaign.py")
    elif candidate == "candidate11":
        names.update({"c11_cuda_campaign.py", "c11_fit_sampler.py"})
    else:
        raise ValueError("Use the explicit candidate10 or candidate11 profile")
    if not isinstance(expected, dict) or set(expected) != names:
        raise ValueError("Pin exactly the selected campaign code hashes")
    for name in sorted(names):
        sha = expected[name]
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise ValueError("Invalid pinned code SHA256")
        cuda_worker.exact_file(code / name, sha)


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
    root = Path(args.run_root).resolve()
    if root.exists():
        raise ValueError("CUDA run root already exists")
    code = inputs / "code"
    candidate = getattr(args, "candidate", "candidate10")
    if candidate not in {"candidate10", "candidate11"}:
        raise ValueError("Use the explicit candidate10 or candidate11 profile")
    campaign_module = campaign_for_candidate(candidate)
    worker = code / ("c11_cuda_campaign.py" if candidate == "candidate11" else "cuda_campaign.py")
    watchdog = code / "cuda_memory_monitor.py"
    code_hashes = json.loads(args.code_sha256_json)
    verify_code(code, code_hashes, candidate)
    campaign_path = code / "cuda-campaign.json"
    campaign = campaign_module.load_campaign(campaign_path)
    if candidate == "candidate11" and any(code_hashes[name] != sha for name, sha in campaign["source_sha256"].items()):
        raise ValueError("C11 staged code differs from frozen campaign source identity")
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
    campaign_module.validate_args(argparse.Namespace(
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
    verify_code(code, code_hashes, candidate)
    campaign_module.load_campaign(campaign_path)
    root.mkdir(parents=True)
    watchdog_process = None
    worker_process = None
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
        (root / "worker.pid").write_text(f"{worker_process.pid}\n")
        (root / "watchdog.pid").write_text(f"{watchdog_process.pid}\n")
        receipt = {
            "purpose": f"{candidate}_cuda_fit_only_campaign",
            "mode": args.mode,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "worker_pid": worker_process.pid,
            "watchdog_pid": watchdog_process.pid,
            "inputs": str(inputs),
            "run_root": str(root),
            "prepared_fit_sha256": cuda_worker.TRAIN_SHA256,
            "plan_sha256": cuda_worker.PLAN_SHA256,
            "campaign_sha256": campaign_module.CAMPAIGN_SHA256,
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

    except BaseException as error:
        stop_owned_children([process for process in (worker_process, watchdog_process) if process is not None], error)
        raise



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
    if any(left["time_unix"] >= right["time_unix"] or left["elapsed_seconds"] >= right["elapsed_seconds"]
           for left, right in zip(rows, rows[1:])):
        raise ValueError("Checkpoint journal timestamps are not ordered")
    if not rows[0]["time_unix"] <= completion < rows[-1]["time_unix"]:
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
    launch = json.loads(cuda_worker.exact_file(launch_path, launch_sha256))
    candidate = "candidate11" if launch.get("purpose") == "candidate11_cuda_fit_only_campaign" else "candidate10"
    if (launch.get("purpose") != f"{candidate}_cuda_fit_only_campaign"
            or launch.get("run_root") != str(root)
            or launch.get("launcher_sha256") != digest(Path(__file__))):
        raise ValueError("Root supervision requires its own pinned campaign launch")
    code = Path(launch["inputs"]).resolve() / "code"
    verify_code(code, launch["code_sha256"], candidate)
    script = code / ("c11_cuda_campaign.py" if candidate == "candidate11" else "cuda_campaign.py")
    watchdog = code / "cuda_memory_monitor.py"
    if (launch.get("worker_sha256") != digest(script)
            or launch.get("watchdog_sha256") != digest(watchdog)
            or launch.get("monitor_sha256") != digest(watchdog)):
        raise ValueError("Root supervision code differs from launch identity")
    for key, value in (("hard_budget_bytes", 8_000_000_000), ("allocator_cap_bytes", 6_500_000_000),
                       ("stop_dedicated_delta_bytes", 7_500_000_000), ("shared_growth_limit_bytes", 128_000_000),
                       ("stop_total_dedicated_bytes", 16_000_000_000)):
        if launch.get(key) != value:
            raise ValueError("Root supervision memory stop contract changed")
    for key in ("worker_pid", "watchdog_pid"):
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


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--inputs", required=True)
    command.add_argument("--code-sha256-json", required=True,
                         help="Externally pinned JSON map of all selected campaign Python code SHA256 hashes")
    command.add_argument("--run-root", required=True)
    command.add_argument("--adapter-tag", required=True)
    command.add_argument("--mode", choices=["probe", "train"], required=True)
    command.add_argument("--candidate", choices=["candidate10", "candidate11"], default="candidate10")
    return command


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "supervise":
        arguments = supervise_parser().parse_args(sys.argv[2:])
        print(json.dumps(supervise(arguments.run_root, arguments.launch_sha256)))
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "snapshot":
        arguments = snapshot_parser().parse_args(sys.argv[2:])
        print(json.dumps(snapshot_checkpoint_memory(arguments.run_root, arguments.checkpoint, arguments.output)))
        sys.exit(0)
    receipt = run(parser().parse_args())
    print(json.dumps({"mode": receipt["mode"], "worker_pid": receipt["worker_pid"], "watchdog_pid": receipt["watchdog_pid"], "run_root": receipt["run_root"]}))
