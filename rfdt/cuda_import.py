#!/usr/bin/env python3
"""Import a completed FIT-only CUDA adapter for local RFDT export.

This bridge preserves CUDA provenance; it does not approve a guardrail model.
Cross-backend tolerances are fixed before any CUDA task evaluation.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import shutil

import worker
import cuda_worker

C10_CAMPAIGN_SHA256 = "64ee24b219d43eacbcad725720b42835cd23b083a9bf337661ac088fee538edf"
C10_PRECISION = {"base": "float32", "lora": "float32", "attention": "eager", "tf32": False}

MAX_PROBABILITY_DELTA = 0.05
DECISIVE_MARGIN = 0.5


def document(path: Path) -> dict:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Expected a regular CUDA receipt: {path.name}")
    return json.loads(path.read_text())


def validate_receipts(plan: dict, receipt: dict, exit_receipt: dict, memory: dict, launch: dict) -> None:
    c10 = plan.get("experiment") == "candidate10"
    steps = plan.get("steps")
    if c10:
        validate_c10_checkpoint(plan, receipt, launch)
        total = memory.get("peak_total_dedicated_bytes")
        if (memory.get("stop_total_dedicated_bytes") != 16_000_000_000
                or launch.get("stop_total_dedicated_bytes") != 16_000_000_000
                or type(total) is not int or not 0 < total < 16_000_000_000):
            raise ValueError("C10 shared-host total dedicated memory proof is missing or exceeded")
    if (plan.get("mode") != "train" or (steps not in (128, 256, 512, 1024) if c10 else steps != 256)
            or receipt.get("mode") != "train" or receipt.get("steps") != steps
            or receipt.get("qualified") is not False
            or receipt.get("adapter_changed") is not True
            or exit_receipt.get("ok") is not True or exit_receipt.get("steps_completed") != steps
            or receipt.get("source") != plan):
        raise ValueError("CUDA import requires a completed, changed, unqualified frozen training checkpoint")
    expected = {"train": cuda_worker.TRAIN_SHA256, "pairs": cuda_worker.PAIR_SHA256,
                "families": cuda_worker.FAMILY_SHA256, "plan": cuda_worker.PLAN_SHA256,
                "base": cuda_worker.BASE_HASHES}
    if (plan.get("inputs") != expected
            or launch.get("prepared_fit_sha256") != cuda_worker.TRAIN_SHA256
            or launch.get("plan_sha256") != cuda_worker.PLAN_SHA256
            or launch.get("worker_sha256") != plan.get("source_sha256")
            or launch.get("rfdt_contract_sha256") != plan.get("contract_sha256")
            or plan.get("objective", {}).get("arm") != "B"):
        raise ValueError("CUDA source, lineage, FIT, or objective identity changed")
    before, after = receipt.get("pre_step_placement", {}), receipt.get("post_step_placement", {})
    if (before != {"parameters": 444, "buffers": 5, "gradients": 104}
            or after != {"parameters": 444, "buffers": 5, "gradients": 0, "optimizer_tensors": 208}):
        raise ValueError("Missing real CUDA gradient/optimizer placement proof")
    if (memory.get("reason") != "worker_exit" or memory.get("samples", 0) < 2
            or memory.get("hard_budget_bytes") != 8_000_000_000
            or memory.get("shared_growth_limit_bytes") != 128_000_000
            or launch.get("hard_budget_bytes") != 8_000_000_000
            or plan.get("budget_bytes") != 8_000_000_000):
        raise ValueError("Missing successful shared-host memory monitoring")
    for key, limit in (("peak_dedicated_delta_bytes", 7_500_000_000),
                       ("peak_shared_delta_bytes", 128_000_000)):
        value = memory.get(key)
        if type(value) is not int or value >= limit:
            raise ValueError("CUDA run exceeded its shared-host memory limit")
    peak = receipt.get("memory", {}).get("peak_reserved_bytes")
    if type(peak) is not int or not 0 < peak <= plan.get("allocator_cap_bytes", 0) <= 6_500_000_000:
        raise ValueError("CUDA allocator peak/cap does not satisfy the 8 GB contract")


def validate_c10_checkpoint(plan: dict, receipt: dict, launch: dict) -> None:
    campaign_path = Path(__file__).resolve().parent.parent / "fixtures/guardrail/candidate10/cuda-campaign.json"
    if worker.sha256(campaign_path) != C10_CAMPAIGN_SHA256:
        raise ValueError("C10 campaign changed")
    campaign = document(campaign_path)
    if (plan.get("campaign") != campaign or plan.get("campaign_sha256") != C10_CAMPAIGN_SHA256
            or plan.get("campaign_steps") != 1024 or plan.get("precision") != C10_PRECISION
            or launch.get("campaign_sha256") != C10_CAMPAIGN_SHA256
            or launch.get("objective_worker_sha256") != plan.get("objective_worker_sha256")
            or plan.get("source_sha256") != worker.sha256(Path(__file__).with_name("cuda_campaign.py"))
            or plan.get("contract_sha256") != worker.sha256(Path(worker.__file__))
            or plan.get("objective_worker_sha256") != worker.sha256(Path(cuda_worker.__file__))):
        raise ValueError("Frozen C10 campaign, precision, or code identity changed")
    proof = receipt.get("saved_adapter_reload", {})
    delta = proof.get("max_margin_delta")
    if (proof.get("ok") is not True or proof.get("rows") != 327
            or proof.get("adapter_sha256") != receipt.get("adapter_sha256")
            or proof.get("fit_margins_sha256") != receipt.get("fit_margins_sha256")
            or proof.get("precision") != C10_PRECISION or proof.get("margin_delta_limit") != 1e-5
            or type(delta) not in (int, float) or not math.isfinite(delta) or not 0 <= delta <= 1e-5):
        raise ValueError("C10 checkpoint lacks exact original CUDA saved-adapter reload proof")


def probability(margin: float) -> float:
    if not math.isfinite(margin):
        raise ValueError("Nonfinite cross-backend margin")
    return 1 / (1 + math.exp(-margin)) if margin >= 0 else math.exp(margin) / (1 + math.exp(margin))


def compare_margins(expected: dict[str, float], actual: dict[str, float]) -> dict:
    if not expected or set(expected) != set(actual):
        raise ValueError("Cross-backend FIT margin inventory differs")
    delta = max(abs(probability(expected[key]) - probability(actual[key])) for key in expected)
    flips = sum(abs(expected[key]) >= DECISIVE_MARGIN and expected[key] * actual[key] <= 0 for key in expected)
    return {"rows": len(expected), "max_probability_delta": delta,
            "max_margin_delta": max(abs(expected[key] - actual[key]) for key in expected),
            "decisive_sign_flips": flips, "max_probability_delta_limit": MAX_PROBABILITY_DELTA,
            "decisive_margin": DECISIVE_MARGIN,
            "ok": delta <= MAX_PROBABILITY_DELTA and flips == 0}


def run(args: argparse.Namespace) -> dict:
    import mlx.core as mx

    source, output, data, base = (Path(value).resolve() for value in (args.cuda_run, args.output, args.data, args.model))
    if output.exists():
        raise ValueError("Import output already exists; preserve the previous attempt")
    receipt_path = source / "run/receipt.json"
    if worker.sha256(receipt_path) != args.receipt_sha256:
        raise ValueError("CUDA receipt differs from its explicit pre-import pin")
    plan, receipt = document(source / "run/plan.json"), document(receipt_path)
    validate_receipts(plan, receipt, document(source / "run/exit.json"),
                      document(source / "memory.summary.json"), document(source / "launch.json"))
    worker.verify_local_base(base)
    if worker.sha256(data) != cuda_worker.TRAIN_SHA256:
        raise ValueError("Local prepared FIT prompts differ from CUDA training")
    adapter = source / "run/adapter/adapters.safetensors"
    if adapter.is_symlink() or worker.sha256(adapter) != receipt["adapter_sha256"]:
        raise ValueError("CUDA adapter checksum changed")
    config = document(source / "run/adapter/adapter_config.json")
    if config != {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": worker.LORA}:
        raise ValueError("Unsupported CUDA adapter configuration")
    tensors = mx.load(str(adapter))
    expected = {}
    for layer in range(26):
        for projection, width in (("q_proj", 1024), ("v_proj", 256)):
            prefix = f"model.layers.{layer}.self_attn.{projection}"
            expected[prefix + ".lora_a"] = (1152, 16)
            expected[prefix + ".lora_b"] = (16, width)
    if set(tensors) != set(expected) or any(tuple(tensors[k].shape) != expected[k]
            or tensors[k].dtype != mx.float32 or not bool(mx.all(mx.isfinite(tensors[k])).item()) for k in expected):
        raise ValueError("CUDA adapter tensors differ from approved Gemma LoRA")
    margins_path = source / "run/fit-margins.jsonl"
    if worker.sha256(margins_path) != receipt["fit_margins_sha256"]:
        raise ValueError("CUDA FIT reference margins changed")
    margins = [json.loads(line) for line in margins_path.read_text().splitlines()]
    expected_margins = {row["source_id"]: row["final"] for row in margins}
    if len(expected_margins) != len(margins):
        raise ValueError("Duplicate CUDA FIT margin identity")
    output.mkdir(parents=True)
    shutil.copyfile(adapter, output / "adapters.safetensors")
    worker.write_json(output / "adapter_config.json", config)
    manifest = {"schema_version": 1, "template_version": "v2", "objective": plan["objective"]["objective"],
                "provenance": {"base_model": worker.BASE_MODEL, "base_revision": worker.BASE_REVISION,
                               "lineage": "Google Gemma 3", "training_backend": "torch_cuda"},
                "adapter_sha256": receipt["adapter_sha256"], "training_data_sha256": cuda_worker.TRAIN_SHA256,
                "cuda_receipt_sha256": args.receipt_sha256, "cuda_source": receipt, "qualified": False}
    if plan.get("experiment") == "candidate10":
        manifest["local_precision"] = C10_PRECISION
        manifest["cuda_campaign_sha256"] = C10_CAMPAIGN_SHA256
    worker.write_json(output / "rfdt-manifest.json", manifest)
    rows = worker.read_rows(data, "train")
    model, tokenizer, _ = worker.load_model(base, output)
    worker.verify_prompt_parity(tokenizer, rows)
    actual = {}
    for row in rows:
        actual[row["source_id"]] = float(worker.selected_logit_margin(model,
            mx.array([row["prompt_token_ids"]]), mx.array(row["allowed_token_ids"])).item())
    comparison = compare_margins(expected_margins, actual)
    local_margins = output / "local-fit-margins.jsonl"
    with local_margins.open("x") as handle:
        for key, margin in actual.items():
            handle.write(json.dumps({"source_id": key, "margin": margin}, allow_nan=False) + "\n")
    worker.write_json(output / "cuda-import-equivalence.json", comparison)
    if not comparison["ok"]:
        raise ValueError("Saved CUDA adapter failed local cross-backend FIT equivalence; attempt retained")
    result = {"ok": True, "adapter_changed": True, "reload_verified": True,
              "adapter_dir": str(output), "training_backend": "torch_cuda", "qualified": False,
              "cuda_receipt_sha256": args.receipt_sha256, "cuda_source": receipt,
              "local_fit_margins_sha256": worker.sha256(local_margins),
              "cross_backend_equivalence": comparison}
    if plan.get("experiment") == "candidate10":
        result.update({"cuda_campaign_sha256": C10_CAMPAIGN_SHA256,
                       "checkpoint_step": plan["steps"], "local_precision": C10_PRECISION})
    worker.write_json(output / "cuda-import-report.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cuda-run", "receipt-sha256", "output", "data", "model"):
        parser.add_argument("--" + name, required=True)
    print(json.dumps(run(parser.parse_args()), allow_nan=False))
