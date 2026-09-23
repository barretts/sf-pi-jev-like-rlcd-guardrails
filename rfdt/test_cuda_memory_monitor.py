"""Pure counter parsing and fail-closed stop tests for the Windows monitor."""

from __future__ import annotations

from argparse import Namespace
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cuda_memory_monitor as monitor


TAG = "luid_0x00000000_0x00013f43_phys_0"


@contextlib.contextmanager
def captured_worker():
    with patch.object(monitor, "process_start_ticks", return_value=456), \
            patch.object(monitor, "process_command", return_value=["python", "/ours/worker.py", "--output", "/ours/run"]), \
            patch.object(monitor.os, "pidfd_open", create=True, return_value=99), \
            patch.object(monitor.os, "close") as close:
        yield close


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
            with captured_worker(), patch.object(monitor.select, "select", return_value=([], [], [])), \
                    patch.object(monitor, "is_owned_worker", return_value=True), patch.object(
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
            with captured_worker(), patch.object(monitor.select, "select", return_value=([], [], [])), \
                    patch.object(monitor, "is_owned_worker", return_value=True), patch.object(
                monitor, "sample", return_value=(16_000_000_000, 0)
            ), patch.object(monitor, "stop_owned_worker") as stop:
                monitor.run(args)
            stop.assert_called_once_with(12345, Path("/ours/worker.py"), Path("/ours/run"), 456,
                                        ["python", "/ours/worker.py", "--output", "/ours/run"], 99)
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

    def run_fixture(self, root):
        (root / "worker.pid").write_text("12345")
        return Namespace(pid_file=str(root / "worker.pid"), worker="/ours/worker.py", run_dir="/ours/run",
            output=str(root / "memory.jsonl"), adapter_tag=TAG, baseline_dedicated_bytes=500,
            baseline_shared_bytes=30, hard_budget_bytes=8_000_000_000,
            stop_dedicated_delta_bytes=7_500_000_000, shared_growth_limit_bytes=128_000_000,
            interval_seconds=2.0, stop_total_dedicated_bytes=16_000_000_000)

    def test_confirmed_exit_prevents_new_sample_even_with_stale_owned_cmdline(self):
        for readiness in ([True], [False, True]):
            with self.subTest(readiness=readiness), tempfile.TemporaryDirectory() as temporary:
                args = self.run_fixture(Path(temporary))
                with captured_worker() as close, patch.object(monitor, "is_owned_worker", return_value=True), \
                        patch.object(monitor.select, "select", side_effect=lambda *_: ([99], [], []) if readiness.pop(0) else ([], [], [])), \
                        patch.object(monitor, "sample") as sample, patch.object(monitor, "stop_owned_worker") as stop:
                    monitor.run(args)
                sample.assert_not_called(); stop.assert_not_called(); close.assert_called_once_with(99)
                self.assertEqual(Path(args.output).read_bytes(), b"")
                summary = json.loads(Path(args.output).with_suffix(".summary.json").read_text())
                self.assertEqual((summary["reason"], summary["samples"]), ("worker_exit", 0))

    def test_identity_loss_requires_bounded_pidfd_exit_confirmation(self):
        for confirmed in (True, False):
            with self.subTest(confirmed=confirmed), tempfile.TemporaryDirectory() as temporary:
                args = self.run_fixture(Path(temporary))
                with captured_worker(), patch.object(monitor, "is_owned_worker", side_effect=[True, True, False]), \
                        patch.object(monitor.select, "select", side_effect=[([], [], []), ([99] if confirmed else [], [], [])]) as wait, \
                        patch.object(monitor, "sample") as sample, patch.object(monitor, "stop_owned_worker"):
                    if confirmed:
                        monitor.run(args)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "without confirmed exit"): monitor.run(args)
                sample.assert_not_called()
                self.assertEqual(wait.call_args_list[-1].args[-1], 5)
                summary = json.loads(Path(args.output).with_suffix(".summary.json").read_text())
                self.assertEqual(summary["reason"], "worker_exit" if confirmed else "monitor_error")
                if not confirmed:
                    self.assertEqual(json.loads(Path(args.output).read_text())["monitor_error"], "RuntimeError")

    def test_inflight_nonzero_counter_failure_is_preserved_after_worker_exit(self):
        for active, cleanup_failure in ((False, False), (True, False), (False, True)):
            with self.subTest(active=active, cleanup_failure=cleanup_failure), tempfile.TemporaryDirectory() as temporary:
                args = self.run_fixture(Path(temporary))
                original = subprocess.CalledProcessError(1, ["powershell.exe"], stderr="synthetic stderr "*100)
                state = {"exited": False}
                cleanup_log = io.StringIO()
                def counter_failure(_):
                    state["exited"] = not active
                    raise original
                def wait(*_): return ([99] if state["exited"] else [], [], [])
                def send(*_): state["exited"] = True
                with captured_worker(), patch.object(monitor, "is_owned_worker", side_effect=lambda *_: not state["exited"]), \
                        patch.object(monitor.select, "select", side_effect=wait), \
                        patch.object(monitor.signal, "pidfd_send_signal", create=True, side_effect=send) as signal, \
                        patch.object(monitor, "sample", side_effect=counter_failure), \
                        patch.object(monitor.sys, "stderr", cleanup_log), \
                        patch.object(monitor, "stop_owned_worker", side_effect=RuntimeError("stop failure") if cleanup_failure else None,
                                     wraps=None if cleanup_failure else monitor.stop_owned_worker) as stop:
                    with self.assertRaises(subprocess.CalledProcessError) as caught: monitor.run(args)
                self.assertIs(caught.exception, original)
                stop.assert_called_once()
                self.assertEqual(signal.call_count, 1 if active else 0)
                record = json.loads(Path(args.output).read_text())
                self.assertEqual(record["monitor_error"], "CalledProcessError")
                self.assertEqual(record["returncode"], 1)
                self.assertEqual(record["stderr"], original.stderr[:500])
                self.assertEqual(len(record["stderr"]), 500)
                self.assertIn("non-zero exit status 1", record["detail"])
                self.assertEqual(json.loads(Path(args.output).with_suffix(".summary.json").read_text())["reason"], "monitor_error")
                if cleanup_failure: self.assertIn("stop also failed", cleanup_log.getvalue())

    def test_shared_growth_stop_preserves_original_threshold(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.run_fixture(Path(temporary))
            with captured_worker(), patch.object(monitor, "is_owned_worker", return_value=True), \
                    patch.object(monitor.select, "select", return_value=([], [], [])), \
                    patch.object(monitor, "sample", return_value=(600, 128_000_030)), \
                    patch.object(monitor, "stop_owned_worker") as stop:
                monitor.run(args)
            stop.assert_called_once()
            self.assertEqual(json.loads(Path(args.output).with_suffix(".summary.json").read_text())["reason"], "shared_memory_growth")

    def test_successful_inflight_sample_is_retained_and_no_next_sample_starts(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.run_fixture(Path(temporary))
            with captured_worker(), patch.object(monitor, "is_owned_worker", return_value=True), \
                    patch.object(monitor.select, "select", side_effect=[([], [], []), ([], [], []), ([99], [], [])]), \
                    patch.object(monitor, "sample", return_value=(600, 40)) as sample:
                monitor.run(args)
            sample.assert_called_once_with(TAG)
            self.assertEqual(json.loads(Path(args.output).read_text())["dedicated_bytes"], 600)
            summary = json.loads(Path(args.output).with_suffix(".summary.json").read_text())
            self.assertEqual((summary["reason"], summary["samples"]), ("worker_exit", 1))

    def test_captured_birth_and_full_command_are_required_and_stop_uses_owned_pidfd(self):
        command = ["python", "/ours/worker.py", "--output", "/ours/run"]
        with patch.object(monitor, "process_command", return_value=command), patch.object(monitor, "process_start_ticks", return_value=456):
            self.assertTrue(monitor.is_owned_worker(123, Path(command[1]), Path('/ours/run'), 456, command))
            self.assertFalse(monitor.is_owned_worker(123, Path(command[1]), Path('/ours/run'), 457, command))
            self.assertFalse(monitor.is_owned_worker(123, Path(command[1]), Path('/ours/run'), 456, command+['--resume']))
        for term_exit in (True, False):
            with patch.object(monitor, "is_owned_worker", return_value=True), \
                    patch.object(monitor.signal, "pidfd_send_signal", create=True) as send, \
                    patch.object(monitor.select, "select", side_effect=[([], [], []), ([99] if term_exit else [], [], []), ([99], [], [])]):
                self.assertTrue(monitor.stop_owned_worker(123, Path(command[1]), Path('/ours/run'), 456, command, 99))
            self.assertEqual([call.args for call in send.call_args_list], [(99, monitor.signal.SIGTERM)] if term_exit else [(99, monitor.signal.SIGTERM), (99, monitor.signal.SIGKILL)])


if __name__ == "__main__":
    unittest.main()
