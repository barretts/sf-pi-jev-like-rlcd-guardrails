import copy
import hashlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract
import import_checkpoint as bridge
import local_export


def c11_receipts(step=128):
    root = Path(bridge.__file__).resolve().parent
    recipe = json.loads((root / "recipe.json").read_text())
    recipe_sha = contract.sha256(root / "recipe.json")
    objective = json.loads((root / "data/objective.json").read_text())
    code = {name: contract.sha256(root / name) for name in (
        "campaign.py", "cuda_train.py", "contract.py", "sampler.py", "gemma_fp32.py", "launch.py", "memory_monitor.py")}
    plan = {"experiment": "c11", "mode": "train", "steps": step,
        "runtime": {"python": "3.13.11", **recipe["runtime"]},
        "campaign_steps": 1024, "checkpoint_step": step, "campaign": recipe, "campaign_sha256": recipe_sha,
        "source_objective_plan": objective,
        "objective": {**objective, "purpose": "c11_train_only", "sampler": recipe["sampler"], "steps": 1024},
        "initialization": recipe["initialization"], "sampler_source_sha256": code["sampler.py"],
        "source_sha256": code["campaign.py"], "contract_sha256": code["contract.py"],
        "objective_worker_sha256": code["cuda_train.py"], "budget_bytes": 8_000_000_000,
        "allocator_cap_bytes": 6_500_000_000, "precision": bridge.PRECISION,
        "inputs": {"train": contract.TRAIN_SHA256, "pairs": contract.PAIR_SHA256,
            "families": contract.FAMILY_SHA256, "plan": contract.PLAN_SHA256, "base": contract.BASE_HASHES}}
    receipt = {"mode": "train", "steps": step, "checkpoint_step": step, "qualified": False,
        "adapter_changed": True, "source": copy.deepcopy(plan), "adapter_sha256": "d" * 64,
        "fit_margins_sha256": "e" * 64,
        "pre_step_placement": {"parameters": 444, "buffers": 5, "gradients": 104},
        "post_step_placement": {"parameters": 444, "buffers": 5, "gradients": 0, "optimizer_tensors": 208},
        "memory": {"peak_reserved_bytes": 2_500_000_000},
        "saved_adapter_reload": {"ok": True, "rows": 327, "max_margin_delta": 0.0,
            "margin_delta_limit": 1e-5, "adapter_sha256": "d" * 64, "fit_margins_sha256": "e" * 64,
            "precision": bridge.PRECISION}}
    exit_receipt = {"ok": True, "steps_completed": step}
    memory = {"reason": "worker_exit", "samples": 100, "hard_budget_bytes": 8_000_000_000,
        "shared_growth_limit_bytes": 128_000_000, "peak_dedicated_delta_bytes": 2_500_000_000,
        "peak_shared_delta_bytes": 70_000_000, "stop_total_dedicated_bytes": 16_000_000_000,
        "peak_total_dedicated_bytes": 6_000_000_000}
    launch = {"purpose": "guardrail_cuda_fit_only_training", "recipe_sha256": recipe_sha,
        "campaign_sha256": recipe_sha, "code_sha256": code, "launcher_sha256": code["launch.py"],
        "worker_sha256": code["campaign.py"], "contract_sha256": code["contract.py"],
        "objective_worker_sha256": code["cuda_train.py"], "monitor_sha256": code["memory_monitor.py"],
        "watchdog_sha256": code["memory_monitor.py"], "prepared_fit_sha256": contract.TRAIN_SHA256,
        "plan_sha256": contract.PLAN_SHA256, "allocator_cap_bytes": 6_500_000_000,
        "watchdog_pid": 1233, "worker_start_ticks": 12345, "watchdog_start_ticks": 12345,
        "hard_budget_bytes": 8_000_000_000, "stop_dedicated_delta_bytes": 7_500_000_000,
        "shared_growth_limit_bytes": 128_000_000, "stop_total_dedicated_bytes": 16_000_000_000}
    return [plan, receipt, exit_receipt, memory, launch]

def c11_snapshot_receipts(step=128):
    args = c11_receipts(step)
    plan, receipt, exit_receipt, memory, launch = args
    monitor_sha = contract.sha256(Path(bridge.__file__).with_name("memory_monitor.py"))
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
    guardian = [{"status": "watching", "worker_pid": 1234, "watchdog_pid": 1233,
        "worker_start_ticks": 12345, "watchdog_start_ticks": 12345, "time_unix": 10.5},
        {"status": "healthy", "sample": rows[-1], "journalAgeSeconds": 0.5, "time_unix": 13.5}]
    guardian = b"".join(json.dumps(row).encode() + b"\n" for row in guardian)
    snapshot["guardian_sha256"] = hashlib.sha256(guardian).hexdigest()
    return args + [snapshot, journal, "f" * 64, guardian]

def final_c11_receipts():
    args = c11_receipts(1024)
    plan, receipt, exit_receipt, memory, launch = args
    root, inputs, python = Path("/synthetic/c11-root"), Path("/synthetic/c11-inputs"), "/synthetic/python"
    code, run = inputs / "code", root / "run"
    launch.update({"mode": "train", "run_root": str(root), "inputs": str(inputs), "worker_pid": 1234, "watchdog_pid": 1233,
        "baseline_dedicated_bytes": 500, "baseline_shared_bytes": 100, "started_at": "1970-01-01T00:00:10+00:00"})
    launch["worker_command"] = [python, str(code / "campaign.py"),
        "--campaign", str(code / "recipe.json"), "--campaign-sha256", plan["campaign_sha256"], "--mode", "train",
        "--base", str(inputs / "base"), "--train", str(inputs / "fit/prepared-train.jsonl"),
        "--pairs", str(inputs / "fit/pairs.json"), "--pairs-sha256", contract.PAIR_SHA256,
        "--families", str(inputs / "fit/families.json"), "--families-sha256", contract.FAMILY_SHA256,
        "--plan", str(code / "objective.json"), "--plan-sha256", contract.PLAN_SHA256,
        "--output", str(run), "--steps", "1024", "--budget-bytes", "8000000000", "--allocator-cap-bytes", "6500000000"]
    launch["watchdog_command"] = [python, str(code / "memory_monitor.py"), "--pid-file", str(root / "worker.pid"),
        "--worker", str(code / "campaign.py"), "--run-dir", str(run), "--output", str(root / "memory.jsonl"),
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

def write_final_run(root):
    """Persist a genuine completed1024 envelope; no sampling or model execution."""
    root = root.resolve()
    args = final_c11_receipts()
    plan, receipt, exit_record, memory, launch = args[:5]
    code = root / "inputs/code"; code.mkdir(parents=True)
    current = Path(bridge.__file__).resolve().parent
    import launch as supervisor
    for name in supervisor.CODE_NAMES:
        (code / name).write_bytes((current / name).read_bytes())
    (code / "recipe.json").write_bytes((current / "recipe.json").read_bytes())
    launch["run_root"], launch["inputs"] = str(root), str(root / "inputs")
    for key in ("worker_command", "watchdog_command"):
        launch[key] = [value.replace("/synthetic/c11-root", str(root)).replace("/synthetic/c11-inputs", str(root / "inputs")) for value in launch[key]]
    checkpoint = root / "run/checkpoints/step-1024"; (checkpoint / "adapter").mkdir(parents=True)
    adapter = checkpoint / "adapter/adapters.safetensors"; adapter.write_bytes(b"complete final1024 adapter")
    margins = checkpoint / "fit-margins.jsonl"
    margins.write_text("".join(json.dumps({"source_id": str(index), "initial": 0.0, "final": 1.0}) + "\n" for index in range(327)))
    receipt["adapter_sha256"] = contract.sha256(adapter)
    receipt["fit_margins_sha256"] = contract.sha256(margins)
    receipt["saved_adapter_reload"].update({"adapter_sha256": receipt["adapter_sha256"], "fit_margins_sha256": receipt["fit_margins_sha256"]})
    documents = {"plan.json": plan, "receipt.json": receipt, "exit.json": args[9],
        "reload.json": receipt["saved_adapter_reload"],
        "adapter/adapter_config.json": {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA}}
    for name, document in documents.items(): contract.write_json(checkpoint / name, document)
    for name, document in (("launch.json", launch), ("memory.summary.json", memory), ("run/exit.json", exit_record)):
        contract.write_json(root / name, document)
    (root / "memory.jsonl").write_bytes(args[6]); (root / "root-guardian.jsonl").write_bytes(args[8])
    return args, checkpoint


class ImportTests(unittest.TestCase):
    def test_fixed_equivalence_limits_and_inventory(self):
        self.assertTrue(bridge.compare_margins({"a": 3.0}, {"a": 3.01})["ok"])
        self.assertFalse(bridge.compare_margins({"a": 3.0}, {"a": -3.0})["ok"])
        with self.assertRaises(ValueError): bridge.compare_margins({"a": 3.0}, {"b": 3.0})
        with self.assertRaises(ValueError): bridge.compare_margins({"a": float("nan")}, {"a": 3.0})

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

    def test_final_c11_allows_genuine_inflight_monitor_sample_after_guard_exit(self):
        args = final_c11_receipts(); rows = [json.loads(line) for line in args[6].splitlines()]
        rows.append({**rows[-1], "time_unix": 15.0, "elapsed_seconds": 5.0})
        args[6] = b"".join(json.dumps(row).encode()+b"\n" for row in rows); args[3]["samples"] = 3
        bridge.validate_receipts(*args)

    def test_accepts_only_exact_c11_checkpoints(self):
        for step in (128, 256, 512, 1024):
            bridge.validate_receipts(*c11_snapshot_receipts(step))
        for step in (1, 127, 1023):
            with self.assertRaises(ValueError):
                bridge.validate_receipts(*c11_snapshot_receipts(step))

    def test_rejects_source_reload_memory_and_snapshot_drift(self):
        changes = ((0, "initialization", "resume"), (0, "source_sha256", "f" * 64),
            (0, "runtime", {}), (0, "objective", {}), (0, "source_objective_plan", {}), (0, "precision", {}),
            (1, "qualified", True), (1, "adapter_changed", False), (2, "ok", False),
            (3, "peak_total_dedicated_bytes", 16_000_000_000), (3, "peak_shared_delta_bytes", -1),
            (3, "samples", 3), (4, "worker_sha256", "f" * 64),
            (5, "worker_pid", 999), (5, "journal_sha256", "f" * 64),
            (5, "checkpoint_receipt_sha256", "a" * 64), (5, "snapshot_time_unix", 12))
        for index, key, value in changes:
            args = c11_snapshot_receipts()
            args[index][key] = value
            if index == 0: args[1]["source"] = copy.deepcopy(args[0])
            with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                bridge.validate_receipts(*args)
        for key, value in (("ok", False), ("rows", 326), ("max_margin_delta", 1.1e-5),
            ("max_margin_delta", float("nan")), ("adapter_sha256", "f" * 64), ("margin_delta_limit", 0.05)):
            args = c11_snapshot_receipts(); args[1]["saved_adapter_reload"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c11_snapshot_receipts(); args[4]["code_sha256"]["gemma_fp32.py"] = "f" * 64
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_rejects_rehashed_invalid_snapshot_journal(self):
        for key, value in (("dedicated_delta_bytes", 1), ("dedicated_bytes", 16_000_000_000),
            ("monitor_error", "counter_error"), ("time_unix", 11), ("elapsed_seconds", float("nan"))):
            args = c11_snapshot_receipts(); rows = [json.loads(line) for line in args[6].splitlines()]
            rows[-1][key] = value
            args[6] = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
            args[5]["journal_sha256"] = hashlib.sha256(args[6]).hexdigest()
            with self.subTest(key=key), self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c11_snapshot_receipts(); args[6] = args[6].rstrip(b"\n")
        args[5]["journal_sha256"] = hashlib.sha256(args[6]).hexdigest()
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_snapshot_pending_health_before_first_sample_requires_valid_age(self):
        for age in (0.75, None, 30.0, float("nan"), True):
            args = c11_snapshot_receipts(); records = [json.loads(line) for line in args[8].splitlines()]
            records.insert(1, {"status": "healthy", "sample": None, "time_unix": 10.75, "journalAgeSeconds": age})
            args[8] = b"".join(json.dumps(record).encode() + b"\n" for record in records)
            args[5]["guardian_sha256"] = hashlib.sha256(args[8]).hexdigest()
            with self.subTest(age=age):
                if age == 0.75: bridge.validate_receipts(*args)
                else:
                    with self.assertRaises(ValueError): bridge.validate_receipts(*args)

    def test_snapshot_rejects_missing_stale_or_mismatched_guardian(self):
        args = c11_snapshot_receipts(); args[5]["snapshot_time_unix"] = 100.0
        with self.assertRaisesRegex(ValueError, "after completion"): bridge.validate_receipts(*args)
        args = c11_snapshot_receipts(); args[8] = None
        with self.assertRaises(ValueError): bridge.validate_receipts(*args)
        for row, key, value in ((0, "worker_start_ticks", 999), (0, "watchdog_start_ticks", 999),
            (0, "worker_pid", 999), (1, "status", "stop"), (1, "sample", None),
            (1, "journalAgeSeconds", 30), (1, "time_unix", 14.5)):
            args = c11_snapshot_receipts(); records = [json.loads(line) for line in args[8].splitlines()]
            records[row][key] = value
            args[8] = b"".join(json.dumps(record).encode() + b"\n" for record in records)
            args[5]["guardian_sha256"] = hashlib.sha256(args[8]).hexdigest()
            with self.subTest(key=key), self.assertRaises(ValueError): bridge.validate_receipts(*args)
        args = c11_snapshot_receipts(); records = [json.loads(line) for line in args[8].splitlines()]
        records[-1]["sample"] = json.loads(args[6].splitlines()[0])
        args[8] = b"".join(json.dumps(record).encode() + b"\n" for record in records)
        args[5]["guardian_sha256"] = hashlib.sha256(args[8]).hexdigest()
        with self.assertRaisesRegex(ValueError, "after completion"): bridge.validate_receipts(*args)

    def test_report_writer_binds_actual_margin_bytes_and_preserves_handoff_schema(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            result = {"ok": True, "reload_verified": True, "training_backend": "torch_cuda", "qualified": False}
            with self.assertRaisesRegex(ValueError, "regular local FIT"): bridge.write_import_report(output, result)
            margins = output / "local-fit-margins.jsonl"
            margins.write_text("".join(json.dumps({"source_id": f"fit-{index}", "margin": index / 100}) + "\n" for index in range(327)))
            actual = bridge.write_import_report(output, result)
            self.assertIs(actual, result)
            self.assertEqual(actual["local_fit_margins_sha256"], contract.sha256(margins))
            self.assertEqual(json.loads((output / "import-report.json").read_text()), actual)
            self.assertTrue(actual["reload_verified"]); self.assertFalse(actual["qualified"])
            margins.rename(output / "source-margins.jsonl"); margins.symlink_to(output / "source-margins.jsonl")
            with self.assertRaisesRegex(ValueError, "regular local FIT"): bridge.write_import_report(output, result)

    def test_final1024_snapshot_producer_preserves_terminal_envelope_for_import(self):
        import launch as supervisor
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); args, checkpoint = write_final_run(root)
            ready = root / "ready"
            supervisor.snapshot_checkpoint_memory(root, 1024, ready)
            documents = [json.loads((ready / name).read_text()) for name in (
                "run/plan.json", "run/receipt.json", "run/exit.json", "memory.summary.json", "launch.json")]
            bridge.validate_receipts(*documents, None, (ready / "memory.jsonl").read_bytes(),
                contract.sha256(ready / "run/receipt.json"), (ready / "root-guardian.jsonl").read_bytes(),
                json.loads((ready / "run/checkpoints/step-1024/exit.json").read_text()))
            self.assertLess(json.loads(args[6].splitlines()[-1])["time_unix"], args[9]["completed_time_unix"])
            for name in ("memory.summary.json", "memory.jsonl", "root-guardian.jsonl", "run/exit.json"):
                self.assertEqual((ready / name).read_bytes(), (root / name).read_bytes())
            self.assertEqual((ready / "run/checkpoints/step-1024/exit.json").read_bytes(), (checkpoint / "exit.json").read_bytes())
            self.assertFalse((ready / "memory.snapshot.json").exists())

    def test_final1024_snapshot_rejects_missing_stale_or_failed_terminal_proof(self):
        import launch as supervisor
        for defect in ("missing-memory", "missing-guardian", "missing-root-exit", "failed-root-exit", "missing-checkpoint-exit", "stale", "terminal", "birth"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); args, checkpoint = write_final_run(root)
                if defect == "missing-memory": (root / "memory.summary.json").unlink()
                if defect == "missing-guardian": (root / "root-guardian.jsonl").unlink()
                if defect == "missing-root-exit": (root / "run/exit.json").unlink()
                if defect == "missing-checkpoint-exit": (checkpoint / "exit.json").unlink()
                if defect == "failed-root-exit": contract.write_json(root / "run/exit.json", {**args[2], "ok": False})
                if defect in ("stale", "terminal", "birth"):
                    records = [json.loads(line) for line in args[8].splitlines()]
                    if defect == "stale": records[1]["journalAgeSeconds"] = 30
                    if defect == "terminal": records[-1]["status"] = "stop"
                    if defect == "birth": records[0]["worker_start_ticks"] += 1
                    (root / "root-guardian.jsonl").write_bytes(b"".join(json.dumps(record).encode() + b"\n" for record in records))
                ready = root / "ready"
                with self.assertRaises((ValueError, FileNotFoundError)): supervisor.snapshot_checkpoint_memory(root, 1024, ready)
                self.assertFalse(ready.exists())

    def test_supervision_snapshot_emits_import_compatible_envelope(self):
        import launch as supervisor
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); code = root / "inputs/code"; code.mkdir(parents=True)
            current = Path(bridge.__file__).resolve().parent
            for name in supervisor.CODE_NAMES:
                (code / name).write_bytes((current / name).read_bytes())
            (code / "recipe.json").write_bytes((current / "recipe.json").read_bytes())
            args = c11_snapshot_receipts()
            plan, receipt, exit_record, _, launch, _, journal = args[:7]
            launch.update({"mode": "train", "run_root": str(root), "inputs": str(root / "inputs")})
            checkpoint = root / "run/checkpoints/step-128"; (checkpoint / "adapter").mkdir(parents=True)
            adapter = checkpoint / "adapter/adapters.safetensors"; adapter.write_bytes(b"complete adapter")
            margins = checkpoint / "fit-margins.jsonl"
            margins.write_text("".join(json.dumps({"source_id": str(index), "initial": 0.0, "final": 1.0}) + "\n" for index in range(327)))
            receipt["adapter_sha256"] = contract.sha256(adapter)
            receipt["fit_margins_sha256"] = contract.sha256(margins)
            receipt["saved_adapter_reload"].update({"adapter_sha256": receipt["adapter_sha256"], "fit_margins_sha256": receipt["fit_margins_sha256"]})
            documents = {"plan.json": plan, "receipt.json": receipt, "exit.json": exit_record,
                "reload.json": receipt["saved_adapter_reload"],
                "adapter/adapter_config.json": {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA}}
            for name, document in documents.items(): contract.write_json(checkpoint / name, document)
            contract.write_json(root / "launch.json", launch)
            (root / "memory.jsonl").write_bytes(journal + b'{"partial":')
            (root / "root-guardian.jsonl").write_bytes(args[8])
            ready = root / "ready"
            with patch.object(supervisor.time, "time", return_value=14.0):
                supervisor.snapshot_checkpoint_memory(root, 128, ready)
            receipt_sha = contract.sha256(ready / "run/receipt.json")
            bridge.validate_receipts(*(json.loads((ready / name).read_text()) for name in (
                "run/plan.json", "run/receipt.json", "run/exit.json", "memory.summary.json", "launch.json", "memory.snapshot.json")),
                (ready / "memory.jsonl").read_bytes(), receipt_sha, (ready / "root-guardian.jsonl").read_bytes())
            self.assertEqual((ready / "run/adapter/adapters.safetensors").read_bytes(), adapter.read_bytes())
            self.assertEqual((ready / "memory.jsonl").read_bytes(), journal)

    def test_import_checks_every_source_again_before_emitting_success(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); source, output = root / "source", root / "output"
                args = c11_snapshot_receipts(); plan, receipt, exit_record, memory, launch, snapshot = args[:6]
                adapter = source / "run/adapter/adapters.safetensors"; adapter.parent.mkdir(parents=True)
                adapter.write_bytes(b"synthetic adapter bytes")
                data = Path(bridge.__file__).parent / "data/prepared-fit.jsonl"
                rows = contract.read_rows(data, "train")
                margins = source / "run/fit-margins.jsonl"
                margins.write_text("".join(json.dumps({"source_id": row["source_id"], "final": 1.0}) + "\n" for row in rows))
                receipt["adapter_sha256"] = contract.sha256(adapter)
                receipt["fit_margins_sha256"] = contract.sha256(margins)
                receipt["saved_adapter_reload"].update({"adapter_sha256": receipt["adapter_sha256"],
                    "fit_margins_sha256": receipt["fit_margins_sha256"]})
                documents = {"run/plan.json": plan, "run/receipt.json": receipt, "run/exit.json": exit_record,
                    "memory.summary.json": memory, "launch.json": launch,
                    "run/adapter/adapter_config.json": {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA}}
                for name, document in documents.items(): (source / name).write_text(json.dumps(document) + "\n")
                receipt_sha = contract.sha256(source / "run/receipt.json")
                snapshot["checkpoint_receipt_sha256"] = receipt_sha
                (source / "memory.snapshot.json").write_text(json.dumps(snapshot) + "\n")
                (source / "memory.jsonl").write_bytes(args[6])
                (source / "root-guardian.jsonl").write_bytes(args[8])
                tensors = {}
                for layer in range(26):
                    for projection, width in (("q_proj", 1024), ("v_proj", 256)):
                        prefix = f"model.layers.{layer}.self_attn.{projection}"
                        tensors[prefix + ".lora_a"] = types.SimpleNamespace(shape=(1152, 16), dtype="fp32")
                        tensors[prefix + ".lora_b"] = types.SimpleNamespace(shape=(16, width), dtype="fp32")
                mx = types.ModuleType("mlx.core"); mx.float32 = "fp32"; mx.load = lambda _: tensors
                mx.isfinite = lambda _: True; mx.all = lambda _: types.SimpleNamespace(item=lambda: True)
                mx.array = lambda value: value
                package = types.ModuleType("mlx"); package.core = mx; package.__path__ = []
                changed = False
                def selected(*_):
                    nonlocal changed
                    if drift and not changed:
                        changed = True
                        with (source / "memory.jsonl").open("ab") as handle: handle.write(b"\n")
                    return types.SimpleNamespace(item=lambda: 1.0)
                values = types.SimpleNamespace(cuda_run=str(source), output=str(output), data=str(data),
                    model=str(root / "base"), receipt_sha256=receipt_sha)
                with patch.dict("sys.modules", {"mlx": package, "mlx.core": mx}), \
                    patch.object(local_export, "verify_base_files"), patch.object(contract, "verify_prompt_parity"), \
                    patch.object(contract, "provenance", return_value={"dependencies": {"python": "mocked"}}), \
                    patch.object(local_export, "load_model", return_value=(None, None, None)), \
                    patch.object(local_export, "selected_logit_margin", side_effect=selected):
                    if drift:
                        with self.assertRaisesRegex(ValueError, "changed during local import"): bridge.run(values)
                        self.assertFalse((output / "import-report.json").exists())
                    else:
                        result = bridge.run(values)
                        self.assertTrue(result["reload_verified"]); self.assertFalse(result["qualified"])
                        self.assertEqual(result["source_envelope_sha256"]["sourceReceipt"], receipt_sha)
                        self.assertEqual(json.loads((output / "import-report.json").read_text()), result)


if __name__ == "__main__": unittest.main()
