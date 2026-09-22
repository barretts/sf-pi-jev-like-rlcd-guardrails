import copy
import unittest
import json
from pathlib import Path
from unittest.mock import patch
import tempfile
import types
import hashlib

import cuda_import as bridge
import cuda_worker


def receipts():
    plan = {"mode": "train", "steps": 256, "budget_bytes": 8_000_000_000,
            "allocator_cap_bytes": 6_500_000_000, "objective": {"arm": "B"},
            "source_sha256": "a" * 64, "contract_sha256": "b" * 64,
            "inputs": {"train": cuda_worker.TRAIN_SHA256, "pairs": cuda_worker.PAIR_SHA256,
                       "families": cuda_worker.FAMILY_SHA256, "plan": cuda_worker.PLAN_SHA256,
                       "base": cuda_worker.BASE_HASHES}}
    receipt = {"mode": "train", "steps": 256, "qualified": False, "adapter_changed": True,
               "source": copy.deepcopy(plan),
               "pre_step_placement": {"parameters": 444, "buffers": 5, "gradients": 104},
               "post_step_placement": {"parameters": 444, "buffers": 5, "gradients": 0, "optimizer_tensors": 208},
               "memory": {"peak_reserved_bytes": 2_500_000_000}}
    exit_receipt = {"ok": True, "steps_completed": 256}
    memory = {"reason": "worker_exit", "samples": 100, "hard_budget_bytes": 8_000_000_000,
              "shared_growth_limit_bytes": 128_000_000, "peak_dedicated_delta_bytes": 2_500_000_000,
              "peak_shared_delta_bytes": 70_000_000}
    launch = {"prepared_fit_sha256": cuda_worker.TRAIN_SHA256, "plan_sha256": cuda_worker.PLAN_SHA256,
              "worker_sha256": "a" * 64, "rfdt_contract_sha256": "b" * 64,
              "hard_budget_bytes": 8_000_000_000}
    return plan, receipt, exit_receipt, memory, launch


def c10_receipts(step=128):
    args = list(receipts())
    plan, receipt, exit_receipt, memory, launch = args
    root = Path(bridge.__file__).resolve().parent
    plan["objective"] = json.loads((root.parent / "fixtures/guardrail/candidate9/objective-plan-B.json").read_text())
    plan.update({"experiment": "candidate10", "steps": step, "campaign_steps": 1024,
        "campaign": json.loads((root.parent / "fixtures/guardrail/candidate10/cuda-campaign.json").read_text()),
        "campaign_sha256": bridge.C10_CAMPAIGN_SHA256, "precision": bridge.C10_PRECISION,
        "source_sha256": bridge.worker.sha256(root / "cuda_campaign.py"),
        "contract_sha256": bridge.worker.sha256(root / "worker.py"),
        "objective_worker_sha256": bridge.worker.sha256(root / "cuda_worker.py")})
    receipt.update({"steps": step, "source": copy.deepcopy(plan), "adapter_sha256": "d" * 64,
        "fit_margins_sha256": "e" * 64,
        "saved_adapter_reload": {"ok": True, "rows": 327, "max_margin_delta": 0.0,
            "margin_delta_limit": 1e-5, "adapter_sha256": "d" * 64,
            "fit_margins_sha256": "e" * 64, "precision": bridge.C10_PRECISION}})
    exit_receipt["steps_completed"] = step
    memory.update({"stop_total_dedicated_bytes": 16_000_000_000, "peak_total_dedicated_bytes": 6_000_000_000})
    launch["stop_total_dedicated_bytes"] = 16_000_000_000
    launch.update({"worker_sha256": plan["source_sha256"], "rfdt_contract_sha256": plan["contract_sha256"],
        "objective_worker_sha256": plan["objective_worker_sha256"],
        "campaign_sha256": bridge.C10_CAMPAIGN_SHA256,
        "code_sha256": {"gemma3_fp32.py": bridge.worker.cuda_local_architecture()["helper_sha256"]}})
    return args


def snapshot_receipts():
    args = c10_receipts()
    plan, receipt, exit_receipt, memory, launch = args
    monitor_sha = bridge.worker.sha256(Path(bridge.__file__).with_name("cuda_memory_monitor.py"))
    producer_sha = bridge.worker.sha256(Path(bridge.__file__).with_name("cuda_campaign_launch.py"))
    launch.update({"launcher_sha256": producer_sha, "worker_pid": 1234, "monitor_sha256": monitor_sha, "watchdog_sha256": monitor_sha,
        "baseline_dedicated_bytes": 500, "baseline_shared_bytes": 100, "stop_dedicated_delta_bytes": 7_500_000_000})
    receipt["checkpoint_step"] = plan["steps"]
    exit_receipt["completed_time_unix"] = 12.0
    rows = [{"time_unix": timestamp, "elapsed_seconds": timestamp-10,
        "dedicated_bytes": 1000, "shared_bytes": 200,
        "dedicated_delta_bytes": 500, "shared_delta_bytes": 100} for timestamp in (11.0, 13.0)]
    journal = b"".join(json.dumps(row).encode()+b"\n" for row in rows)
    snapshot = {"producer_sha256": producer_sha, "checkpoint_receipt_sha256": "f" * 64, "checkpoint_step": plan["steps"],
        "worker_pid": 1234, "worker_sha256": plan["source_sha256"], "monitor_sha256": monitor_sha,
        "journal_sha256": hashlib.sha256(journal).hexdigest(), "snapshot_time_unix": 14.0}
    memory.update({"reason": "checkpoint_snapshot", "worker_pid": 1234, "samples": 2,
        "peak_total_dedicated_bytes": 1000, "peak_dedicated_delta_bytes": 500,
        "peak_shared_delta_bytes": 100, "stop_dedicated_delta_bytes": 7_500_000_000})
    return args+[snapshot, journal, "f" * 64]


def c11_receipts(step=128):
    args = c10_receipts(step)
    plan, receipt, exit_receipt, memory, launch = args
    root = Path(bridge.__file__).resolve().parent
    campaign = bridge.c11_cuda_campaign.load_campaign(root.parent / "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json")
    source_definition = copy.deepcopy(plan["objective"])
    plan.update({"experiment": "candidate11", "campaign": campaign,
        "campaign_sha256": bridge.c11_cuda_campaign.CAMPAIGN_SHA256,
        "objective": {**source_definition, "purpose": "candidate11_train_only",
                      "sampler": campaign["sampler"], "steps": 1024},
        "source_objective_plan": source_definition, "initialization": campaign["initialization"],
        "checkpoint_step": step, "sampler_source_sha256": campaign["source_sha256"]["c11_fit_sampler.py"],
        "source_sha256": bridge.worker.sha256(root / "c11_cuda_campaign.py")})
    receipt.update({"source": copy.deepcopy(plan), "checkpoint_step": step})
    launch.update({"purpose": "candidate11_cuda_fit_only_campaign",
        "campaign_sha256": bridge.c11_cuda_campaign.CAMPAIGN_SHA256,
        "launcher_sha256": bridge.worker.sha256(root / "cuda_campaign_launch.py"),
        "worker_sha256": plan["source_sha256"], "allocator_cap_bytes": 6_500_000_000,
        "stop_dedicated_delta_bytes": 7_500_000_000, "shared_growth_limit_bytes": 128_000_000,
        "code_sha256": {name: bridge.worker.sha256(root / name) for name in (
            "c11_cuda_campaign.py", "c11_fit_sampler.py", "cuda_worker.py", "worker.py",
            "gemma3_fp32.py", "cuda_memory_monitor.py")},
        "monitor_sha256": bridge.worker.sha256(root / "cuda_memory_monitor.py"),
        "watchdog_sha256": bridge.worker.sha256(root / "cuda_memory_monitor.py")})
    return args


def c11_snapshot_receipts(step=128):
    args = c11_receipts(step)
    plan, receipt, exit_receipt, memory, launch = args
    monitor_sha = bridge.worker.sha256(Path(bridge.__file__).with_name("cuda_memory_monitor.py"))
    launch.update({"worker_pid": 1234, "baseline_dedicated_bytes": 500, "baseline_shared_bytes": 100})
    exit_receipt["completed_time_unix"] = 12.0
    rows = [{"time_unix": timestamp, "elapsed_seconds": timestamp-10,
        "dedicated_bytes": 1000, "shared_bytes": 200,
        "dedicated_delta_bytes": 500, "shared_delta_bytes": 100} for timestamp in (11.0, 13.0)]
    journal = b"".join(json.dumps(row).encode()+b"\n" for row in rows)
    snapshot = {"producer_sha256": launch["launcher_sha256"], "checkpoint_receipt_sha256": "f" * 64,
        "checkpoint_step": step, "worker_pid": 1234, "worker_sha256": plan["source_sha256"], "monitor_sha256": monitor_sha,
        "journal_sha256": hashlib.sha256(journal).hexdigest(), "snapshot_time_unix": 14.0}
    memory.update({"reason": "checkpoint_snapshot", "worker_pid": 1234, "samples": 2,
        "peak_total_dedicated_bytes": 1000, "peak_dedicated_delta_bytes": 500,
        "peak_shared_delta_bytes": 100, "stop_dedicated_delta_bytes": 7_500_000_000})
    return args + [snapshot, journal, "f" * 64]


def final_c11_receipts():
    args = c11_receipts(1024)
    plan, receipt, exit_receipt, memory, launch = args
    root, inputs, python = Path("/synthetic/c11-root"), Path("/synthetic/c11-inputs"), "/synthetic/python"
    code, run = inputs / "code", root / "run"
    launch.update({"mode": "train", "run_root": str(root), "inputs": str(inputs), "worker_pid": 1234, "watchdog_pid": 1233,
        "baseline_dedicated_bytes": 500, "baseline_shared_bytes": 100, "started_at": "1970-01-01T00:00:10+00:00"})
    launch["worker_command"] = [python, str(code / "c11_cuda_campaign.py"),
        "--campaign", str(code / "cuda-campaign.json"), "--mode", "train",
        "--base", str(inputs / "base"), "--train", str(inputs / "fit/prepared-train.jsonl"),
        "--pairs", str(inputs / "fit/pairs.json"), "--pairs-sha256", cuda_worker.PAIR_SHA256,
        "--families", str(inputs / "fit/families.json"), "--families-sha256", cuda_worker.FAMILY_SHA256,
        "--plan", str(code / "objective-plan-B.json"), "--plan-sha256", cuda_worker.PLAN_SHA256,
        "--output", str(run), "--steps", "1024", "--budget-bytes", "8000000000", "--allocator-cap-bytes", "6500000000"]
    launch["watchdog_command"] = [python, str(code / "cuda_memory_monitor.py"), "--pid-file", str(root / "worker.pid"),
        "--worker", str(code / "c11_cuda_campaign.py"), "--run-dir", str(run), "--output", str(root / "memory.jsonl"),
        "--adapter-tag", "synthetic", "--baseline-dedicated-bytes", "500", "--baseline-shared-bytes", "100",
        "--hard-budget-bytes", "8000000000", "--stop-dedicated-delta-bytes", "7500000000", "--shared-growth-limit-bytes", "128000000",
        "--stop-total-dedicated-bytes", "16000000000", "--interval-seconds", "2"]
    exit_receipt.update({"elapsed_seconds": 3.5})
    rows = [{"time_unix": timestamp, "elapsed_seconds": timestamp-10,
        "dedicated_bytes": 1000, "shared_bytes": 200,
        "dedicated_delta_bytes": 500, "shared_delta_bytes": 100} for timestamp in (11.0, 12.0)]
    memory.update({"reason": "worker_exit", "worker_pid": 1234, "samples": 2, "sampling_interval_seconds": 2.0,
        "peak_total_dedicated_bytes": 1000, "peak_dedicated_delta_bytes": 500,
        "peak_shared_delta_bytes": 100, "stop_dedicated_delta_bytes": 7_500_000_000})
    guard = [{"status": "watching", "worker_pid": 1234, "watchdog_pid": 1233,
        "worker_start_ticks": 12345, "watchdog_start_ticks": 12345, "time_unix": 10.5},
        {"status": "healthy", "sample": rows[-1], "journalAgeSeconds": 0.5, "time_unix": 12.5},
        {"status": "worker_exit", "worker_pid": 1234, "time_unix": 14.0}]
    encode = lambda records: b"".join(json.dumps(row).encode()+b"\n" for row in records)
    return args + [None, encode(rows), "f" * 64, encode(guard),
        {"ok": True, "steps_completed": 1024, "completed_time_unix": 13.0}]


def local_manifest(candidate="candidate11"):
    _, receipt, _, _, _ = c11_receipts() if candidate == "candidate11" else c10_receipts()
    return {"local_architecture": bridge.worker.cuda_local_architecture(),
            "local_precision": bridge.C10_PRECISION, "cuda_campaign_sha256": receipt["source"]["campaign_sha256"],
            "provenance": {"training_backend": "torch_cuda"}, "cuda_source": receipt,
            "training_data_sha256": cuda_worker.TRAIN_SHA256, "adapter_sha256": receipt["adapter_sha256"]}


class CudaImportTests(unittest.TestCase):
    def test_accepts_completed_fit_only_run(self):
        bridge.validate_receipts(*receipts())

    def test_rejects_probe_failed_or_qualified_run(self):
        for index, key, value in ((0, "mode", "probe"), (1, "qualified", True),
                                  (2, "ok", False), (2, "steps_completed", 255)):
            args = list(receipts()); args[index][key] = value
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_rejects_changed_source_and_missing_optimizer(self):
        for change in ("source", "optimizer", "fit"):
            args = list(receipts())
            if change == "source": args[4]["worker_sha256"] = "c" * 64
            if change == "optimizer": args[1]["post_step_placement"]["optimizer_tensors"] = 0
            if change == "fit": args[0]["inputs"]["train"] = "c" * 64
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_rejects_memory_limit_or_failed_monitor(self):
        for key, value in (("peak_dedicated_delta_bytes", 7_500_000_000),
                           ("peak_shared_delta_bytes", 128_000_000),
                           ("reason", "counter_error"), ("samples", 0)):
            args = list(receipts()); args[3][key] = value
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_accepts_only_frozen_c10_checkpoints(self):
        for step in (128, 256, 512, 1024):
            bridge.validate_receipts(*c10_receipts(step))
        for step in (1, 127, 1023):
            with self.assertRaises(ValueError): bridge.validate_receipts(*c10_receipts(step))

    def test_c10_requires_bound_saved_adapter_reload(self):
        for key, value in (("ok", False), ("rows", 326), ("max_margin_delta", 1.1e-5),
                           ("max_margin_delta", float("nan")), ("margin_delta_limit", 0.05),
                           ("adapter_sha256", "f" * 64), ("fit_margins_sha256", "f" * 64),
                           ("precision", {"base": "bfloat16"})):
            args = c10_receipts(); args[1]["saved_adapter_reload"][key] = value
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c10_receipts(); del args[1]["saved_adapter_reload"]
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_c10_rejects_campaign_precision_and_code_tampering(self):
        for key, value in (("campaign_steps", 256), ("campaign_sha256", "f" * 64),
                           ("precision", {"base": "bfloat16"}), ("source_sha256", "f" * 64),
                           ("objective_worker_sha256", "f" * 64), ("contract_sha256", "f" * 64)):
            args = c10_receipts(); args[0][key] = value; args[1]["source"] = copy.deepcopy(args[0])
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c10_receipts(); args[4]["code_sha256"]["gemma3_fp32.py"] = "f"*64
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c10_receipts(); args[0]["objective"]["loss"]["margin"] = 999
        args[1]["source"] = copy.deepcopy(args[0])
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c10_receipts(); args[0]["campaign"]["qualification"]["unsafe_allows"] = 1
        args[1]["source"] = copy.deepcopy(args[0])
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_c10_requires_total_host_memory_proof(self):
        for key, value in (("peak_total_dedicated_bytes", 16_000_000_000),
                           ("peak_total_dedicated_bytes", None), ("stop_total_dedicated_bytes", None),
                           ("reason", "checkpoint_snapshot")):
            args = c10_receipts(); args[3][key] = value
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_accepts_bound_checkpoint_memory_snapshot(self):
        bridge.validate_receipts(*snapshot_receipts())

    def test_rejects_snapshot_summary_identity_time_or_pin_tampering(self):
        for index, key, value in ((3, "peak_total_dedicated_bytes", 999), (3, "samples", 3),
                (3, "worker_pid", 999), (4, "launcher_sha256", "a"*64), (4, "monitor_sha256", "a"*64),
                (5, "checkpoint_step", 256), (5, "checkpoint_receipt_sha256", "a"*64),
                (5, "producer_sha256", "a"*64), (5, "worker_sha256", "a"*64), (5, "worker_pid", 999),
                (5, "journal_sha256", "a"*64), (5, "snapshot_time_unix", 12.0),
                (2, "completed_time_unix", 13.0), (2, "completed_time_unix", 14.0), (2, "completed_time_unix", float("nan"))):
            args = snapshot_receipts(); args[index][key] = value
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_rejects_rehashed_invalid_snapshot_journal(self):
        for key, value in (("dedicated_delta_bytes", 1), ("dedicated_bytes", 16_000_000_000),
                ("monitor_error", "counter_error"), ("time_unix", 11.0), ("elapsed_seconds", float("nan"))):
            args = snapshot_receipts(); rows = [json.loads(line) for line in args[6].splitlines()]
            rows[1][key] = value
            args[6] = b"".join(json.dumps(row).encode()+b"\n" for row in rows)
            args[5]["journal_sha256"] = hashlib.sha256(args[6]).hexdigest()
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = snapshot_receipts(); args[6] = args[6].rstrip(b"\n")
        args[5]["journal_sha256"] = hashlib.sha256(args[6]).hexdigest()
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_fp32_base_is_loaded_before_adapter(self):
        events = []
        class Parameter:
            dtype = "bf16"
            def astype(self, dtype):
                events.append(("cast", dtype)); return self
        class Model:
            def parameters(self): return Parameter()
            def update(self, value): events.append(("update", value))
        model = Model()
        def load(*args, **kwargs):
            events.append(("load", kwargs["adapter_path"])); return model, None, {}
        fake_mx = types.ModuleType("mlx.core")
        fake_mx.float32 = "fp32"; fake_mx.floating = "floating"
        fake_mx.issubdtype = lambda *args: True
        fake_utils = types.ModuleType("mlx.utils"); fake_utils.tree_map = lambda fn, tree: fn(tree)
        fake_lm = types.ModuleType("mlx_lm"); fake_lm.load = load
        fake_tuner = types.ModuleType("mlx_lm.tuner.utils")
        fake_tuner.load_adapters = lambda *args: events.append(("adapters", args[1]))
        fake_architecture = types.ModuleType("gemma3_fp32")
        fake_architecture.install_fp32_embedding_scale = lambda value: events.append(("architecture", value))
        modules = {"gemma3_fp32": fake_architecture,"mlx": types.ModuleType("mlx"), "mlx.core": fake_mx, "mlx.utils": fake_utils,
            "mlx_lm": fake_lm, "mlx_lm.tuner": types.ModuleType("mlx_lm.tuner"),
            "mlx_lm.tuner.utils": fake_tuner}
        manifest = {"local_architecture": bridge.worker.cuda_local_architecture(), "local_precision": bridge.C10_PRECISION, "cuda_campaign_sha256": bridge.C10_CAMPAIGN_SHA256,
                    "provenance": {"training_backend": "torch_cuda"},
                    "cuda_source": {"source": {"precision": bridge.C10_PRECISION,
                        "campaign_sha256": bridge.C10_CAMPAIGN_SHA256}, "saved_adapter_reload": {"ok": True}}}
        with tempfile.TemporaryDirectory() as path, patch.dict("sys.modules", modules), \
                patch.object(bridge.worker, "validate_architecture"), \
                patch.object(bridge.worker, "validate_adapter", return_value=manifest):
            base = Path(path); (base / "config.json").write_text("{}")
            bridge.worker.load_model(base, base / "adapter")
            for change in ("helper_sha256", "embedding_scale_policy", "kind"):
                invalid = copy.deepcopy(manifest); invalid["local_architecture"][change] = "invalid"
                with patch.object(bridge.worker, "validate_adapter", return_value=invalid):
                    with self.assertRaises(ValueError): bridge.worker.load_model(base, base / "adapter")
            with patch.object(bridge.worker, "validate_adapter", return_value={}):
                original_events = list(events); events.clear()
                bridge.worker.load_model(base, base / "adapter")
                self.assertEqual(events, [("load", str(base / "adapter"))])
                events[:] = original_events
        self.assertEqual([event[0] for event in events], ["load", "cast", "update", "architecture", "adapters"])
        self.assertIsNone(events[0][1])
        self.assertEqual(events[1][1], "fp32")

    def test_fixed_equivalence_limits_and_inventory(self):
        self.assertTrue(bridge.compare_margins({"a": 3.0}, {"a": 3.01})["ok"])
        self.assertFalse(bridge.compare_margins({"a": 3.0}, {"a": -3.0})["ok"])
        with self.assertRaises(ValueError): bridge.compare_margins({"a": 3.0}, {"b": 3.0})
        with self.assertRaises(ValueError): bridge.compare_margins({"a": float("nan")}, {"a": 3.0})

    def test_accepts_only_exact_c11_campaign_checkpoints_and_profile(self):
        for step in (128, 256, 512, 1024):
            args = c11_snapshot_receipts(step)
            bridge.validate_receipts(*args)
            manifest = local_manifest()
            manifest["cuda_source"] = args[1]
            bridge.worker.validate_cuda_local_profile(manifest)
        for step in (1, 127, 1023):
            with self.assertRaises(ValueError): bridge.validate_receipts(*c11_snapshot_receipts(step))

    def test_c11_rejects_objective_sampler_code_initialization_and_memory_changes(self):
        for index, key, value in (
                (0, "source_objective_plan", {}), (0, "objective", {}),
                (0, "initialization", "resume_c10"), (0, "sampler_source_sha256", "f" * 64),
                (0, "source_sha256", "f" * 64), (0, "campaign_sha256", bridge.C10_CAMPAIGN_SHA256),
                (0, "campaign_steps", 256), (0, "checkpoint_step", 256),
                (4, "allocator_cap_bytes", 6_500_000_001), (4, "stop_dedicated_delta_bytes", 8_000_000_000),
                (4, "shared_growth_limit_bytes", 128_000_001), (4, "launcher_sha256", "f" * 64),
                (3, "peak_total_dedicated_bytes", 16_000_000_000), (3, "samples", 0)):
            args = c11_snapshot_receipts(); args[index][key] = value
            args[1]["source"] = copy.deepcopy(args[0])
            with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                bridge.validate_receipts(*args)
        for name in ("c11_cuda_campaign.py", "c11_fit_sampler.py", "gemma3_fp32.py"):
            args = c11_snapshot_receipts(); args[4]["code_sha256"][name] = "f" * 64
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        for key, value in (("rows", 326), ("ok", False), ("max_margin_delta", 1.1e-5),
                           ("margin_delta_limit", 0.05), ("adapter_sha256", "f" * 64)):
            args = c11_snapshot_receipts(); args[1]["saved_adapter_reload"][key] = value
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_accepts_final_c11_worker_exit_without_post_completion_sample(self):
        args = final_c11_receipts()
        self.assertLess(json.loads(args[6].splitlines()[-1])["time_unix"], args[9]["completed_time_unix"])
        bridge.validate_receipts(*args)

    def test_final_c11_rejects_nonfinal_unfinished_missing_identity_and_memory_drift(self):
        for index, key, value in ((0, "steps", 512), (0, "campaign_steps", 512), (2, "ok", False),
                (2, "steps_completed", 512), (2, "elapsed_seconds", float("nan")),
                (9, "ok", False), (9, "completed_time_unix", 15.0), (9, "steps_completed", 512),
                (3, "worker_pid", 999), (3, "samples", 3), (3, "peak_shared_delta_bytes", 99),
                (3, "stop_total_dedicated_bytes", 16_000_000_001), (4, "watchdog_pid", 1234),
                (4, "baseline_dedicated_bytes", 501), (4, "inputs", "/other/inputs"),
                (3, "worker_pid", True), (4, "started_at", "1970-01-01T00:00:10")):
            args = final_c11_receipts(); args[index][key] = value
            if index == 0: args[1]["source"] = copy.deepcopy(args[0])
            with self.subTest(index=index, key=key), self.assertRaises(ValueError): bridge.validate_receipts(*args)
        for index in (6, 8):
            args = final_c11_receipts(); args[index] = args[index].rstrip(b"\n")
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        for key in ("worker_command", "watchdog_command"):
            args = final_c11_receipts(); args[4][key][1] = "/other/script.py"
            with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_final_c11_rejects_guardian_stop_bad_birth_identity_unmatched_samples_and_terminal_drift(self):
        for row, key, value in ((0, "worker_pid", 999), (0, "watchdog_pid", 999),
                (0, "worker_start_ticks", 0), (0, "watchdog_start_ticks", True),
                (1, "sample", None), (1, "journalAgeSeconds", 30), (1, "status", "stop"),
                (2, "worker_pid", 999), (2, "status", "stop"), (2, "time_unix", 12.8)):
            args = final_c11_receipts(); records = [json.loads(line) for line in args[8].splitlines()]
            records[row][key] = value
            args[8] = b"".join(json.dumps(record).encode()+b"\n" for record in records)
            with self.subTest(row=row, key=key), self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = final_c11_receipts(); args[8] += args[8].splitlines()[-1] + b"\n"
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        for key, value in (("time_unix", 11), ("elapsed_seconds", 0), ("dedicated_delta_bytes", 499),
                ("shared_bytes", float("inf")), ("monitor_error", "injected")):
            args = final_c11_receipts(); rows = [json.loads(line) for line in args[6].splitlines()]
            rows[-1][key] = value
            args[6] = b"".join(json.dumps(row).encode()+b"\n" for row in rows)
            with self.subTest(key=key), self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_final_c11_healthy_sample_bool_is_not_a_numeric_journal_match(self):
        args = final_c11_receipts(); rows = [json.loads(line) for line in args[6].splitlines()]
        rows[-1]["shared_delta_bytes"] = 1; rows[-1]["shared_bytes"] = 101
        rows[0]["shared_delta_bytes"] = 1; rows[0]["shared_bytes"] = 101
        args[3]["peak_shared_delta_bytes"] = 1
        args[6] = b"".join(json.dumps(row).encode()+b"\n" for row in rows)
        records = [json.loads(line) for line in args[8].splitlines()]
        records[1]["sample"] = {**rows[-1], "shared_delta_bytes": True}
        args[8] = b"".join(json.dumps(row).encode()+b"\n" for row in records)
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_final_c11_mock_import_emits_exact_raw_digest_map_and_rejects_mid_import_drift(self):
        for drift in (False, True):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); source, output, data, base = root / "source", root / "output", root / "data", root / "base"
                (source / "run/adapter").mkdir(parents=True)
                (source / "run/checkpoints/step-1024").mkdir(parents=True)
                args = final_c11_receipts(); plan, receipt, exit_record, memory, launch = args[:5]
                adapter = source / "run/adapter/adapters.safetensors"; adapter.write_bytes(b"synthetic adapter bytes")
                margins = source / "run/fit-margins.jsonl"
                margins.write_text("".join(json.dumps({"source_id": f"synthetic-fit-{index}", "initial": 0, "final": 1})+"\n" for index in range(327)))
                receipt["adapter_sha256"] = bridge.worker.sha256(adapter)
                receipt["fit_margins_sha256"] = bridge.worker.sha256(margins)
                receipt["saved_adapter_reload"].update({"adapter_sha256": receipt["adapter_sha256"], "fit_margins_sha256": receipt["fit_margins_sha256"]})
                documents = {"run/plan.json": plan, "run/receipt.json": receipt, "run/exit.json": exit_record,
                    "memory.summary.json": memory, "launch.json": launch, "run/checkpoints/step-1024/exit.json": args[9],
                    "run/adapter/adapter_config.json": {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": bridge.worker.LORA}}
                for name, document in documents.items(): (source / name).write_text(json.dumps(document)+"\n")
                (source / "memory.jsonl").write_bytes(args[6]); (source / "root-guardian.jsonl").write_bytes(args[8])
                data.write_bytes(b"synthetic compiled TRAIN marker")
                tensors = {}
                for layer in range(26):
                    for projection, width in (("q_proj", 1024), ("v_proj", 256)):
                        prefix = f"model.layers.{layer}.self_attn.{projection}"
                        tensors[prefix+".lora_a"] = types.SimpleNamespace(shape=(1152, 16), dtype="fp32")
                        tensors[prefix+".lora_b"] = types.SimpleNamespace(shape=(16, width), dtype="fp32")
                mx = types.ModuleType("mlx.core"); mx.float32 = "fp32"; mx.load = lambda _: tensors
                mx.isfinite = lambda _: True; mx.all = lambda _: types.SimpleNamespace(item=lambda: True); mx.array = lambda value: value
                package = types.ModuleType("mlx"); package.core = mx; package.__path__ = []
                rows = [{"source_id": f"synthetic-fit-{index}", "prompt_token_ids": [1], "allowed_token_ids": [1, 2]} for index in range(327)]
                sha256 = bridge.worker.sha256; changed = False
                def selected(*_):
                    nonlocal changed
                    if drift and not changed:
                        changed = True
                        with (source / "root-guardian.jsonl").open("ab") as stream: stream.write(b"\n")
                    return types.SimpleNamespace(item=lambda: 1.0)
                values = types.SimpleNamespace(cuda_run=str(source), output=str(output), data=str(data), model=str(base),
                    receipt_sha256=sha256(source / "run/receipt.json"))
                with patch.dict("sys.modules", {"mlx": package, "mlx.core": mx}), patch.object(bridge.worker, "verify_local_base"), \
                        patch.object(bridge.worker, "sha256", side_effect=lambda path: cuda_worker.TRAIN_SHA256 if Path(path).resolve() == data.resolve() else sha256(path)), \
                        patch.object(bridge.worker, "read_rows", return_value=rows), patch.object(bridge.worker, "load_model", return_value=(None, None, None)), \
                        patch.object(bridge.worker, "verify_prompt_parity"), patch.object(bridge.worker, "selected_logit_margin", side_effect=selected):
                    if drift:
                        with self.assertRaisesRegex(ValueError, "changed during local import"): bridge.run(values)
                        self.assertFalse((output / "cuda-import-report.json").exists())
                    else:
                        result = bridge.run(values)
                        expected = {name: sha256(source / path) for name, path in {
                            "sourceLaunch": "launch.json", "sourceExit": "run/exit.json", "sourceCheckpointExit": "run/checkpoints/step-1024/exit.json",
                            "sourceMemory": "memory.summary.json", "sourceMemoryJournal": "memory.jsonl", "sourceGuardian": "root-guardian.jsonl"}.items()}
                        self.assertEqual(result["final_envelope_sha256"], expected)
                        self.assertEqual(result["cuda_source"], receipt)
                        self.assertEqual(json.loads((output / "cuda-import-report.json").read_text()), result)

    def test_final_c11_allows_genuine_inflight_monitor_sample_after_guard_exit(self):
        args = final_c11_receipts(); rows = [json.loads(line) for line in args[6].splitlines()]
        rows.append({**rows[-1], "time_unix": 15.0, "elapsed_seconds": 5.0})
        args[6] = b"".join(json.dumps(row).encode()+b"\n" for row in rows); args[3]["samples"] = 3
        bridge.validate_receipts(*args)

    def test_c11_profile_cannot_bypass_source_or_helper_identity(self):
        for key, value in (("objective", {}), ("source_objective_plan", {}),
                           ("experiment", "candidate12"), ("initialization", "resume"),
                           ("campaign", {}), ("source_sha256", "f" * 64),
                           ("contract_sha256", "f" * 64), ("sampler_source_sha256", "f" * 64)):
            manifest = local_manifest(); manifest["cuda_source"]["source"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                bridge.worker.validate_cuda_local_profile(manifest)
        manifest = local_manifest(); manifest["local_architecture"]["helper_sha256"] = "f" * 64
        with self.assertRaises(ValueError): bridge.worker.validate_cuda_local_profile(manifest)

    def test_c11_complete_floating_base_tree_expands_before_helper_and_adapter_in_load_and_fuse(self):
        events = []
        class Parameter:
            def __init__(self, name, dtype): self.name, self.dtype = name, dtype
            def astype(self, dtype):
                events.append(("cast", self.name, dtype)); self.dtype = dtype; return self
        class Model:
            def __init__(self):
                self.tree = {"embed_tokens": Parameter("embedding", "bf16"),
                    "layers": [{"query": Parameter("query", "bf16"), "value": Parameter("value", "float16")},
                               {"norm": Parameter("layer_norm", "fp32")}],
                    "norm": Parameter("final_norm", "bf16"), "integer": Parameter("integer", "int")}
            def parameters(self): return self.tree
            def update(self, value): events.append(("update", value))
        def tree_map(fn, tree):
            if isinstance(tree, dict): return {key: tree_map(fn, value) for key, value in tree.items()}
            if isinstance(tree, list): return [tree_map(fn, value) for value in tree]
            return fn(tree)
        fake_mx = types.ModuleType("mlx.core")
        fake_mx.float32, fake_mx.floating = "fp32", "floating"
        fake_mx.issubdtype = lambda dtype, _: dtype in {"bf16", "float16", "fp32"}
        fake_utils = types.ModuleType("mlx.utils")
        fake_utils.tree_map, fake_utils.tree_unflatten = tree_map, lambda tree: tree
        fake_lm = types.ModuleType("mlx_lm")
        fake_tuner = types.ModuleType("mlx_lm.tuner.utils")
        fake_save = types.ModuleType("mlx_lm.utils"); fake_save.save = lambda *args: None
        fake_architecture = types.ModuleType("gemma3_fp32")
        fake_architecture.install_fp32_embedding_scale = lambda model: events.append(("architecture", model))
        modules = {"gemma3_fp32": fake_architecture, "mlx": types.ModuleType("mlx"), "mlx.core": fake_mx,
            "mlx.utils": fake_utils, "mlx_lm": fake_lm, "mlx_lm.tuner": types.ModuleType("mlx_lm.tuner"),
            "mlx_lm.tuner.utils": fake_tuner, "mlx_lm.utils": fake_save}
        for candidate in ("candidate10", "candidate11"):
            for stage in ("load", "fuse"):
                with self.subTest(candidate=candidate, stage=stage), tempfile.TemporaryDirectory() as directory:
                    events.clear(); model = Model(); manifest = local_manifest(candidate)
                    base = Path(directory); (base / "config.json").write_text("{}")
                    fake_lm.load = lambda *args, **kwargs: (events.append(("load", kwargs["adapter_path"])) or (model, None, {}))
                    fake_tuner.load_adapters = lambda *args: events.append(("adapters", args[1]))
                    with patch.dict("sys.modules", modules), patch.object(bridge.worker, "validate_architecture"), \
                            patch.object(bridge.worker, "validate_adapter", return_value=manifest):
                        if stage == "load":
                            bridge.worker.load_model(base, base / "adapter")
                        else:
                            def stop_at_adapter(*args):
                                events.append(("adapters", args[1])); raise InterruptedError("mocked fusion stop")
                            fake_tuner.load_adapters = stop_at_adapter
                            with patch.object(bridge.worker, "provenance", return_value={}), \
                                    patch.object(bridge.worker, "fusion_training_rows", return_value=(base / "train.jsonl", [])), \
                                    patch.object(bridge.worker, "resolve_model", return_value=base), \
                                    patch.object(bridge.worker, "load_tokenizer"), \
                                    patch.object(bridge.worker, "verify_prompt_parity"):
                                with self.assertRaisesRegex(InterruptedError, "mocked fusion stop"):
                                    bridge.worker.fuse_with_progress(types.SimpleNamespace(adapter=str(base / "adapter"),
                                        model=str(base), output=str(base / "fresh-fused")), types.SimpleNamespace(emit=lambda *args, **kwargs: None))
                    self.assertEqual([event[0] for event in events], ["load"] + ["cast"] * 5 + ["update", "architecture", "adapters"])
                    self.assertEqual({event[1] for event in events if event[0] == "cast"},
                                     {"embedding", "query", "value", "layer_norm", "final_norm"})
                    self.assertEqual(model.tree["integer"].dtype, "int")
                    self.assertIsNone(events[0][1])


if __name__ == "__main__":
    unittest.main()
