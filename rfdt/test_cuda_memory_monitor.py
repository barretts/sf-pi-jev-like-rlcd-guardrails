"""Pure counter parsing and fail-closed stop tests for the Windows monitor."""

from __future__ import annotations

from argparse import Namespace
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cuda_memory_monitor as monitor


TAG = "luid_0x00000000_0x00013f43_phys_0"


class MonitorTests(unittest.TestCase):
    def test_counter_probe_cannot_consume_launcher_script_stdin(self) -> None:
        rows = [
            {"Path": f"\\\\host\\gpu adapter memory({TAG})\\dedicated usage", "CookedValue": 600},
            {"Path": f"\\\\host\\gpu adapter memory({TAG})\\shared usage", "CookedValue": 40},
        ]
        result = subprocess.CompletedProcess([], 0, json.dumps(rows), "")
        with patch.object(monitor.subprocess, "run", return_value=result) as call:
            self.assertEqual(monitor.sample(TAG), (600, 40))
        self.assertEqual(call.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_selects_both_counters_for_the_pinned_adapter(self) -> None:
        samples = [
            {"Path": f"\\\\host\\gpu adapter memory({TAG})\\dedicated usage", "CookedValue": 600},
            {"Path": f"\\\\host\\gpu adapter memory({TAG})\\shared usage", "CookedValue": 40},
            {"Path": "\\\\host\\gpu adapter memory(other)\\dedicated usage", "CookedValue": 999},
        ]
        self.assertEqual(monitor.parse_counters(json.dumps(samples), TAG), (600, 40))
        with self.assertRaisesRegex(ValueError, "unavailable"):
            monitor.parse_counters(json.dumps(samples[:1]), TAG)

    def test_stops_exact_worker_before_eight_gb(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            pid = directory / "worker.pid"
            pid.write_text("12345\n")
            output = directory / "memory.jsonl"
            args = Namespace(
                pid_file=str(pid), worker="/probe/cuda_worker.py", run_dir="/probe/output",
                output=str(output), adapter_tag=TAG, baseline_dedicated_bytes=500,
                baseline_shared_bytes=30, hard_budget_bytes=8_000_000_000,
                stop_dedicated_delta_bytes=7_500_000_000,
                shared_growth_limit_bytes=128_000_000, interval_seconds=2.0,
            )
            with patch.object(monitor, "is_owned_worker", return_value=True), patch.object(
                monitor, "sample", return_value=(7_500_000_500, 30)
            ), patch.object(monitor, "stop_owned_worker", return_value=True) as stop:
                monitor.run(args)
            stop.assert_called_once()
            summary = json.loads(output.with_suffix(".summary.json").read_text())
            self.assertEqual(summary["reason"], "dedicated_stop_threshold")
            self.assertEqual(summary["samples"], 1)


    def test_absolute_total_cap_stops_only_owned_worker_below_delta_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "worker.pid").write_text("12345")
            output = root / "memory.jsonl"
            args = Namespace(pid_file=str(root / "worker.pid"), worker="/ours/worker.py", run_dir="/ours/run",
                             output=str(output), adapter_tag=TAG, baseline_dedicated_bytes=10_000_000_000,
                             baseline_shared_bytes=0, hard_budget_bytes=8_000_000_000,
                             stop_dedicated_delta_bytes=7_500_000_000, shared_growth_limit_bytes=128_000_000,
                             interval_seconds=2.0, stop_total_dedicated_bytes=16_000_000_000)
            with patch.object(monitor, "is_owned_worker", return_value=True), patch.object(
                monitor, "sample", return_value=(16_000_000_000, 0)
            ), patch.object(monitor, "stop_owned_worker") as stop:
                monitor.run(args)
            stop.assert_called_once_with(12345, Path("/ours/worker.py"), Path("/ours/run"))
            summary = json.loads(output.with_suffix(".summary.json").read_text())
            self.assertEqual(summary["reason"], "absolute_total_dedicated_limit")
            self.assertEqual(summary["peak_total_dedicated_bytes"], 16_000_000_000)
            self.assertEqual(summary["stop_total_dedicated_bytes"], 16_000_000_000)
            self.assertEqual(summary["peak_dedicated_delta_bytes"], 6_000_000_000)

    def test_worker_ownership_requires_exact_arguments(self):
        worker = Path("/ours/worker.py")
        run = Path("/ours/run")
        for command, owned in [(b"python\0/ours/worker.py\0--output\0/ours/run\0", True),
                               (b"python\0/ours/worker.py.other\0--output\0/ours/run\0", False),
                               (b"python\0/ours/worker.py\0--output\0/ours/run-other\0", False),
                               (b"python\0/ours/worker.py\0--input\0/ours/run\0", False)]:
            with self.subTest(command=command), patch.object(Path, "read_bytes", return_value=command):
                self.assertEqual(monitor.is_owned_worker(123, worker, run), owned)
        with patch.object(monitor, "is_owned_worker", return_value=False), patch.object(monitor.os, "kill") as kill:
            self.assertFalse(monitor.stop_owned_worker(123, worker, run))
            kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
