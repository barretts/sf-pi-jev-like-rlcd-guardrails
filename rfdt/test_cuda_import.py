import copy
import unittest

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

    def test_fixed_equivalence_limits_and_inventory(self):
        self.assertTrue(bridge.compare_margins({"a": 3.0}, {"a": 3.01})["ok"])
        self.assertFalse(bridge.compare_margins({"a": 3.0}, {"a": -3.0})["ok"])
        with self.assertRaises(ValueError): bridge.compare_margins({"a": 3.0}, {"b": 3.0})
        with self.assertRaises(ValueError): bridge.compare_margins({"a": float("nan")}, {"a": 3.0})


if __name__ == "__main__":
    unittest.main()
