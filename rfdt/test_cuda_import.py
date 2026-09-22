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
        "campaign_sha256": bridge.C10_CAMPAIGN_SHA256})
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
        modules = {"mlx": types.ModuleType("mlx"), "mlx.core": fake_mx, "mlx.utils": fake_utils,
            "mlx_lm": fake_lm, "mlx_lm.tuner": types.ModuleType("mlx_lm.tuner"),
            "mlx_lm.tuner.utils": fake_tuner}
        manifest = {"local_precision": bridge.C10_PRECISION, "cuda_campaign_sha256": bridge.C10_CAMPAIGN_SHA256,
                    "provenance": {"training_backend": "torch_cuda"},
                    "cuda_source": {"source": {"precision": bridge.C10_PRECISION,
                        "campaign_sha256": bridge.C10_CAMPAIGN_SHA256}, "saved_adapter_reload": {"ok": True}}}
        with tempfile.TemporaryDirectory() as path, patch.dict("sys.modules", modules), \
                patch.object(bridge.worker, "validate_architecture"), \
                patch.object(bridge.worker, "validate_adapter", return_value=manifest):
            base = Path(path); (base / "config.json").write_text("{}")
            bridge.worker.load_model(base, base / "adapter")
        self.assertEqual([event[0] for event in events], ["load", "cast", "update", "adapters"])
        self.assertIsNone(events[0][1])
        self.assertEqual(events[1][1], "fp32")

    def test_fixed_equivalence_limits_and_inventory(self):
        self.assertTrue(bridge.compare_margins({"a": 3.0}, {"a": 3.01})["ok"])
        self.assertFalse(bridge.compare_margins({"a": 3.0}, {"a": -3.0})["ok"])
        with self.assertRaises(ValueError): bridge.compare_margins({"a": 3.0}, {"b": 3.0})
        with self.assertRaises(ValueError): bridge.compare_margins({"a": float("nan")}, {"a": 3.0})


if __name__ == "__main__":
    unittest.main()
