#!/usr/bin/env python3
"""Fresh C11 training on the unchanged admitted TRAIN-only FIT set."""
import argparse
import json
import math
import platform
from pathlib import Path
import random
import signal
import time

import cuda_train as objective
import contract
import sampler as fit_sampler

SOURCE_NAMES = {"contract.py", "cuda_train.py", "sampler.py", "campaign.py", "launch.py", "memory_monitor.py", "gemma_fp32.py"}


def load_campaign(path, expected_sha256=None):
    path = Path(path)
    digest = expected_sha256 or contract.sha256(Path(__file__).with_name("recipe.json"))
    recipe = json.loads(objective.exact_file(path, digest))
    expected = {
        "version": 2, "purpose": "c11_fit_only_cuda_training", "qualified": False,
        "runtime": {"torch": "2.10.0+cu128", "cuda": "12.8", "transformers": "5.11.0", "safetensors": "0.8.0"},
        "runtime_profile_basis": "last_documented_windows_wsl_host_2026-09-22_not_recorded_by_historical_c11",
        "steps": 1024, "checkpoints": [128, 256, 512, 1024],
        "precision": {"base": "float32", "lora": "float32", "attention": "eager", "tf32": False},
        "seed": 42, "learning_rate": 1e-4, "effective_batch": 8,
        "validation_rows_passed_to_training": 0, "test_rows_passed_to_training": 0,
        "default_enforcement": "off", "fit_rows": 327, "explicit_pairs": 86,
        "supplement_rows_admitted": 0, "initialization": "original_google_gemma_base_fresh_lora_empty_optimizer",
        "objective_plan_sha256": objective.PLAN_SHA256, "prepared_fit_sha256": objective.TRAIN_SHA256,
        "pair_manifest_sha256": objective.PAIR_SHA256, "family_manifest_sha256": objective.FAMILY_SHA256,
        "memory": {"budget_bytes": 8_000_000_000, "allocator_cap_bytes": 6_500_000_000,
                   "stop_dedicated_delta_bytes": 7_500_000_000, "shared_growth_limit_bytes": 128_000_000,
                   "stop_total_dedicated_bytes": 16_000_000_000},
        "sampler": {"implementation": "sampler.FitSampler", "pair_fraction": 0.5,
                    "initial_pair_coverage": "one_shuffled_pass_over_all_explicit_pairs",
                    "pair_group_policy": "shuffled_round_robin_over_indivisible_group_ids",
                    "pair_item_policy": "shuffled_round_robin_within_group", "row_label_order": ["allow", "confirm"],
                    "row_family_policy": "shuffled_round_robin_within_label", "row_item_policy": "shuffled_round_robin", "seed": 42},
        "precision_verification": {"probability_delta_limit": 0.05, "decisive_margin": 0.5, "decisive_flips": 0},
    }
    if not isinstance(recipe, dict) or set(recipe) != {*expected, "source_sha256"} or any(recipe.get(k) != v for k, v in expected.items()):
        raise ValueError("Current C11 training recipe, lineage or split boundary changed")
    if not isinstance(recipe["source_sha256"], dict) or set(recipe["source_sha256"]) != SOURCE_NAMES:
        raise ValueError("C11 implementation source inventory changed")
    for name in sorted(SOURCE_NAMES):
        source_path = Path(__file__).with_name(name)
        module = {"contract.py": contract, "cuda_train.py": objective, "sampler.py": fit_sampler}.get(name)
        if module is not None:
            source_path = Path(module.__file__)
        objective.exact_file(source_path, recipe["source_sha256"][name])
    return recipe


def validate_args(args, campaign):
    expected_steps = 1 if args.mode == "probe" else campaign["steps"]
    if args.mode not in ("probe", "train") or args.steps != expected_steps:
        raise ValueError("Requested steps differ from frozen campaign")
    if args.budget_bytes != campaign["memory"]["budget_bytes"] or args.allocator_cap_bytes != campaign["memory"]["allocator_cap_bytes"]:
        raise ValueError("Requested memory limits differ from frozen campaign")
    return expected_steps, [1] if args.mode == "probe" else campaign["checkpoints"]


def validate_memory(memory, campaign):
    limits = campaign["memory"]
    if memory["peak_reserved_bytes"] > limits["allocator_cap_bytes"] or memory["cuda_free_delta_bytes"] >= limits["stop_dedicated_delta_bytes"]:
        raise ValueError("Shared host memory budget reached")


def mean_loss(losses):
    if not losses or any(not math.isfinite(loss) for loss in losses):
        raise ValueError("Nonfinite campaign loss")
    return sum(losses) / len(losses)


def compare_reload(expected, actual):
    if not expected or set(expected) != set(actual):
        raise ValueError("Saved-adapter reload FIT inventory differs")
    if any(not math.isfinite(value) for value in [*expected.values(), *actual.values()]):
        raise ValueError("Nonfinite saved-adapter reload margin")
    delta = max(abs(expected[key] - actual[key]) for key in expected)
    return {"ok": delta <= 1e-5, "rows": len(actual), "max_margin_delta": delta,
            "margin_delta_limit": 1e-5}


def runtime_versions():
    """Verify the declared CUDA profile before allocating or loading any model."""
    import torch
    import transformers
    import safetensors
    versions = {"python": platform.python_version(), "torch": str(torch.__version__),
                "cuda": torch.version.cuda, "transformers": transformers.__version__,
                "safetensors": safetensors.__version__}
    expected = {"torch": "2.10.0+cu128", "cuda": "12.8", "transformers": "5.11.0", "safetensors": "0.8.0"}
    if any(versions[name] != value for name, value in expected.items()):
        raise ValueError("CUDA runtime differs from the declared pinned training profile")
    return versions


def load_model(base, device):
    import torch
    from transformers import Gemma3ForCausalLM
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    model = Gemma3ForCausalLM.from_pretrained(str(base), local_files_only=True,
        dtype=torch.float32, attn_implementation="eager").to(device)
    if not model.config.tie_word_embeddings or model.lm_head.weight.data_ptr() != model.model.embed_tokens.weight.data_ptr():
        raise ValueError("Expected tied Google Gemma output embedding")
    model.config.use_cache = False
    return model


def run(args):
    campaign = load_campaign(args.campaign, args.campaign_sha256)
    steps, checkpoints = validate_args(args, campaign)
    output = Path(args.output).resolve()
    if output.exists():
        raise ValueError("Use a fresh campaign path")
    rows, pairs, families, source_definition = objective.load_contract(args)
    runtime = runtime_versions()
    definition = {**source_definition, "purpose": "c11_train_only",
                  "sampler": campaign["sampler"], "steps": steps}
    import torch
    from safetensors.torch import save_file, load_file
    output.mkdir(parents=True)
    started = time.monotonic()
    plan = {"experiment": "c11", "mode": args.mode, "steps": steps, "runtime": runtime,
        "campaign": campaign, "campaign_sha256": contract.sha256(Path(args.campaign)),
        "objective": definition,
        "source_objective_plan": source_definition,
        "sampler_source_sha256": campaign["source_sha256"]["sampler.py"],
        "initialization": campaign["initialization"],
        "inputs": {"train": objective.TRAIN_SHA256, "pairs": objective.PAIR_SHA256,
            "families": objective.FAMILY_SHA256, "plan": objective.PLAN_SHA256,
            "base": objective.BASE_HASHES},
        "source_sha256": contract.sha256(Path(__file__)),
        "objective_worker_sha256": contract.sha256(Path(objective.__file__)),
        "contract_sha256": contract.sha256(Path(contract.__file__)),
        "budget_bytes": 8_000_000_000, "allocator_cap_bytes": 6_500_000_000,
        "precision": campaign["precision"], "backend": "torch_cuda_experimental_not_qualified"}
    contract.write_json(output / "plan.json", plan)

    def stop(signum, _frame):
        raise InterruptedError(f"Stopped owned campaign by signal {signum}")

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    completed = 0
    try:
        device = torch.device("cuda:0")
        free, total = torch.cuda.mem_get_info(device)
        if free < 7_500_000_000:
            raise ValueError("Insufficient dedicated CUDA headroom")
        torch.cuda.set_per_process_memory_fraction(6_500_000_000 / total, device)
        torch.cuda.reset_peak_memory_stats(device)
        random.seed(42)
        torch.manual_seed(42)
        torch.cuda.manual_seed_all(42)
        parity = contract.verify_prompt_parity(contract.load_tokenizer(Path(args.base)), rows)
        model = load_model(Path(args.base), device)
        trainable = objective.attach_lora(model)
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        initial = {name: p.detach().clone() for name, p in trainable}
        initial_margins, _ = objective.score_rows(model, rows, device)
        sampler = fit_sampler.FitSampler(rows, pairs, families, 42)
        state = {}
        model.train()
        if args.mode == "probe":
            longest = max(rows, key=lambda row: len(row["prompt_token_ids"]))
            mean_loss([objective.train_unit(model, {"kind": "single", "row": longest}, device)])
            for _, p in trainable:
                p.grad = None
        with (output / "progress.jsonl").open("x", buffering=1) as journal:
            for step in range(1, steps + 1):
                losses = [objective.train_unit(model, sampler.draw(), device) for _ in range(8)]
                loss = mean_loss(losses)
                before = objective.assert_cuda_placement_before_step(model, trainable, device)
                objective.no_bias_adam_step([p for _, p in trainable], state, lr=campaign["learning_rate"])
                after = objective.assert_cuda_placement(model, trainable, state, device)
                completed = step
                memory = objective.memory_sample(device, free)
                validate_memory(memory, campaign)
                record = {"step": step, "steps_total": steps, "loss": loss,
                    "elapsed_seconds": time.monotonic()-started, "memory": memory}
                journal.write(json.dumps(record, allow_nan=False)+"\n")
                print(json.dumps(record), flush=True)
                if step in checkpoints:
                    checkpoint = output / "checkpoints" / f"step-{step}"
                    checkpoint.mkdir(parents=True)
                    margins, row_loss = objective.score_rows(model, rows, device)
                    adapter = checkpoint / "adapter"
                    adapter.mkdir()
                    weights = {name: p.detach().cpu().contiguous() for name, p in trainable}
                    objective.check_adapter_tensors(weights)
                    save_file(weights, str(adapter / "adapters.safetensors"))
                    contract.write_json(adapter / "adapter_config.json", {"fine_tune_type": "lora",
                        "num_layers": 26, "lora_parameters": contract.LORA})
                    with (checkpoint / "fit-margins.jsonl").open("x") as handle:
                        for row in rows:
                            key = row["source_id"]
                            handle.write(json.dumps({"source_id": key, "initial": initial_margins[key],
                                "final": margins[key]})+"\n")
                    saved = load_file(str(adapter / "adapters.safetensors"), device="cpu")
                    objective.check_adapter_tensors(saved)
                    with torch.no_grad():
                        for name, parameter in trainable:
                            parameter.zero_()
                            parameter.copy_(saved[name])
                    actual, _ = objective.score_rows(model, rows, device)
                    reload_result = compare_reload(margins, actual)
                    contract.write_json(checkpoint / "reload.json", reload_result)
                    if not reload_result["ok"]:
                        raise ValueError("Saved-adapter reload differs from checkpoint FIT margins")
                    reload_result.update({"adapter_sha256": contract.sha256(adapter / "adapters.safetensors"),
                                          "fit_margins_sha256": contract.sha256(checkpoint / "fit-margins.jsonl"),
                                          "precision": campaign["precision"]})
                    contract.write_json(checkpoint / "reload.json", reload_result)
                    model.train()
                    checkpoint_memory = objective.memory_sample(device, free)
                    validate_memory(checkpoint_memory, campaign)
                    checkpoint_plan = {**plan, "steps": step, "campaign_steps": steps,
                                       "checkpoint_step": step}
                    contract.write_json(checkpoint / "plan.json", checkpoint_plan)
                    changed = any(not torch.equal(p, initial[name]) for name, p in trainable)
                    if not changed:
                        raise ValueError("Checkpoint adapter did not change after optimizer updates")
                    receipt = {"qualified": False, "mode": args.mode, "steps": step,
                        "adapter_changed": changed,
                        "adapter_sha256": contract.sha256(adapter / "adapters.safetensors"),
                        "fit_margins_sha256": contract.sha256(checkpoint / "fit-margins.jsonl"),
                        "source": checkpoint_plan, "prompt_parity": parity,
                        "pre_step_placement": before, "post_step_placement": after,
                        "fit_row_loss": row_loss, "memory": checkpoint_memory,
                        "saved_adapter_reload": reload_result, "checkpoint_step": step,
                        "sampler_counts": dict(sampler.counts), "sampler_draws": sampler.draws}
                    contract.write_json(checkpoint / "receipt.json", receipt)
                    contract.write_json(checkpoint / "exit.json", {"ok": True, "steps_completed": step,
                        "completed_time_unix": time.time()})
        contract.write_json(output / "exit.json", {"ok": True, "steps_completed": steps,
            "elapsed_seconds": time.monotonic()-started})
        return {"qualified": False, "steps": steps, "checkpoints": checkpoints}
    except BaseException as error:
        contract.write_json(output / "exit.json", {"ok": False, "error": str(error), "steps_completed": completed,
            "canceled": isinstance(error, (InterruptedError, KeyboardInterrupt)),
            "elapsed_seconds": time.monotonic()-started})
        raise
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    parser = objective.parser()
    parser.add_argument("--campaign", required=True)
    parser.add_argument("--campaign-sha256", required=True)
    print(json.dumps(run(parser.parse_args())))
