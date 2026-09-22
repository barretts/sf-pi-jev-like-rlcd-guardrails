#!/usr/bin/env python3
"""Experimental, FIT-only C9-B objective on a bounded CUDA device.

This is a separate training backend. Its output is not an RFDT qualification
artifact until adapter reload, cross-backend, F16, and Q8 checks pass. The
frozen MLX run and all CAL/VALID/TEST inputs are outside this worker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import signal
import sys
import time
from pathlib import Path
from typing import Any

import worker as contract

BASE_HASHES = {
    "model.safetensors": "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6",
    "config.json": "19cb5d28c97778271ba2b3c3df47bf76bdd6706724777a2318b3522230afe91e",
    "tokenizer.json": "4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795",
}
TRAIN_SHA256 = "8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3"
PAIR_SHA256 = "343ed1062e590fca8938099dc058074bea3f9f74d6118efc9df5b9ead35a4773"
FAMILY_SHA256 = "51062c174bfa28d798ca9eb338441e3d03ed73685b1f4ec707af20c41d8dcf13"
PLAN_SHA256 = "a1fbaaa262fa2d103c8ac9771ba1d9db774e7a90be5336cec3665f6b22dd3da9"
MAX_BUDGET_BYTES = 8_000_000_000
MAX_ALLOCATOR_CAP_BYTES = int(6.5 * 1024**3)
ALLOCATOR_HEADROOM_BYTES = 1_000_000_000


def exact_file(path: Path, expected: str, *, allow_symlink: bool = False) -> bytes:
    if not path.is_file() or (path.is_symlink() and not allow_symlink):
        raise ValueError(f"Missing regular frozen input: {path}")
    content = path.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise ValueError(f"Frozen input checksum mismatch: {path.name}")
    return content


def load_contract(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    if (args.pairs_sha256, args.families_sha256, args.plan_sha256) != (PAIR_SHA256, FAMILY_SHA256, PLAN_SHA256):
        raise ValueError("Frozen C9 B pair, family or objective checksum differs")
    base = Path(args.base).resolve()
    contract.verify_local_base(base)
    for name, expected in BASE_HASHES.items():
        exact_file(base / name, expected, allow_symlink=True)
    train_path = Path(args.train).resolve()
    rows = contract.read_rows(train_path, "train", exact_file(train_path, TRAIN_SHA256))
    pair_path, family_path, plan_path = (Path(path).resolve() for path in (args.pairs, args.families, args.plan))
    pair_content = exact_file(pair_path, args.pairs_sha256)
    family_content = exact_file(family_path, args.families_sha256)
    plan_content = exact_file(plan_path, args.plan_sha256)
    pairs = contract.read_guardrail_pairs(pair_path, rows, pair_content)
    families = contract.read_guardrail_families(family_path, rows, family_content)
    plan = contract.read_guardrail_plan(plan_path, args.pairs_sha256, plan_content, args.families_sha256)
    if plan["version"] != 2 or plan["arm"] != "B" or plan["steps"] != 256:
        raise ValueError("Only the frozen C9 B FIT objective is supported")
    if len(rows) != 327 or len(pairs) != 86 or len(families) != 327:
        raise ValueError("C9 B FIT cardinality changed")
    return rows, pairs, families, plan


class DirectScaleLoRA:
    """The MLX form: base(x) + (x @ A @ B) * scale, with A=[in,r]."""

    @staticmethod
    def make(linear: Any, *, rank: int = 16, scale: float = 2.0) -> Any:
        import torch
        from torch import nn

        class LoRALinear(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.linear = linear
                bound = 1.0 / math.sqrt(linear.in_features)
                self.lora_a = nn.Parameter(torch.empty(linear.in_features, rank, device=linear.weight.device, dtype=torch.float32).uniform_(-bound, bound))
                self.lora_b = nn.Parameter(torch.zeros(rank, linear.out_features, device=linear.weight.device, dtype=torch.float32))

            def forward(self, x: Any) -> Any:
                base = self.linear(x)
                update = (x.to(torch.float32) @ self.lora_a) @ self.lora_b
                return base + (scale * update).to(base.dtype)

        return LoRALinear()


def attach_lora(model: Any) -> list[Any]:
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    for layer in model.model.layers:
        for name in ("q_proj", "v_proj"):
            attention = layer.self_attn
            setattr(attention, name, DirectScaleLoRA.make(getattr(attention, name)))
    trainable = [(name, value) for name, value in model.named_parameters() if value.requires_grad]
    if len(trainable) != 104 or any(not name.endswith((".lora_a", ".lora_b")) for name, _ in trainable):
        raise ValueError("Expected 104 query/value LoRA tensors in 26 Gemma layers")
    return trainable


def check_adapter_tensors(weights: dict[str, Any]) -> None:
    import torch

    expected = {}
    for layer in range(26):
        for projection, output in (("q_proj", 1024), ("v_proj", 256)):
            prefix = f"model.layers.{layer}.self_attn.{projection}"
            expected[f"{prefix}.lora_a"] = (1152, 16)
            expected[f"{prefix}.lora_b"] = (16, output)
    if set(weights) != set(expected):
        raise ValueError("CUDA adapter does not contain exactly the 104 approved LoRA tensors")
    for name, value in weights.items():
        if tuple(value.shape) != expected[name] or value.dtype != torch.float32 or not bool(torch.isfinite(value).all().item()):
            raise ValueError(f"Invalid CUDA adapter tensor: {name}")


def selected_margin(model: Any, row: dict[str, Any], device: Any) -> Any:
    import torch

    tokens = torch.tensor([row["prompt_token_ids"]], dtype=torch.long, device=device)
    allowed = torch.tensor(row["allowed_token_ids"], dtype=torch.long, device=device)
    hidden = model.model(input_ids=tokens, use_cache=False).last_hidden_state[:, -1, :]
    # The approved checkpoint ties the LM head to its embedding table. Read
    # only the two selected output rows; no sequence x vocabulary allocation.
    logits = (hidden @ model.lm_head.weight.index_select(0, allowed).T).to(torch.float32)
    return logits[0, 0] - logits[0, 1]


def no_bias_adam_step(parameters: list[Any], state: dict[int, tuple[Any, Any]], *, lr: float = 1e-4) -> None:
    """Match mlx.optimizers.Adam's default bias_correction=False, decay=0."""
    import torch

    with torch.no_grad():
        for index, parameter in enumerate(parameters):
            gradient = parameter.grad
            if gradient is None or not torch.isfinite(gradient).all():
                raise ValueError("Missing or nonfinite LoRA gradient")
            if index not in state:
                state[index] = (torch.zeros_like(parameter), torch.zeros_like(parameter))
            first, second = state[index]
            first.mul_(0.9).add_(gradient, alpha=0.1)
            second.mul_(0.999).addcmul_(gradient, gradient, value=0.001)
            parameter.addcdiv_(first, second.sqrt().add(1e-8), value=-lr)
            parameter.grad = None


def memory_sample(device: Any, baseline_free: int) -> dict[str, int]:
    import torch

    torch.cuda.synchronize(device)
    free, total = torch.cuda.mem_get_info(device)
    return {
        "allocated_bytes": torch.cuda.memory_allocated(device),
        "reserved_bytes": torch.cuda.memory_reserved(device),
        "peak_allocated_bytes": torch.cuda.max_memory_allocated(device),
        "peak_reserved_bytes": torch.cuda.max_memory_reserved(device),
        "cuda_free_bytes": free,
        "cuda_total_bytes": total,
        "cuda_free_delta_bytes": baseline_free - free,
    }


def assert_cuda_placement(model: Any, trainable: list[Any], state: dict[int, tuple[Any, Any]], device: Any) -> dict[str, int]:
    import torch

    parameters = list(model.parameters())
    buffers = list(model.buffers())
    gradients = [value.grad for _, value in trainable if value.grad is not None]
    optimizers = [tensor for values in state.values() for tensor in values]
    if any(tensor.device != device for tensor in parameters + buffers + gradients + optimizers):
        raise ValueError("Model, gradient, buffer or optimizer state left cuda:0")
    if any(tensor.dtype != torch.float32 for _, tensor in trainable):
        raise ValueError("LoRA tensors are not FP32")
    if len(optimizers) != 2 * len(trainable):
        raise ValueError("Missing CUDA Adam state after a real optimizer update")
    return {"parameters": len(parameters), "buffers": len(buffers), "gradients": len(gradients), "optimizer_tensors": len(optimizers)}


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def score_rows(model: Any, rows: list[dict[str, Any]], device: Any) -> tuple[dict[str, float], float]:
    import torch

    model.eval()
    margins = {}
    losses = []
    with torch.no_grad():
        for row in rows:
            value = float(selected_margin(model, row, device).item())
            if not math.isfinite(value):
                raise ValueError("Nonfinite FIT selected margin")
            margins[row["source_id"]] = value
            losses.append(contract.c9b_row_loss(value, row["target_probabilities"] == [1, 0]))
    return margins, sum(losses) / len(losses)


def objective_from_margins(rows: list[dict[str, Any]], pairs: list[dict[str, Any]], families: dict[str, str], margins: dict[str, float]) -> float:
    pair_cells: dict[str, list[float]] = {}
    for pair in pairs:
        family = families[pair["safe"]["source_id"]]
        pair_cells.setdefault(family, []).append(contract.c9b_pair_loss(margins[pair["safe"]["source_id"]], margins[pair["risky"]["source_id"]]))
    row_cells: dict[str, dict[str, list[float]]] = {"allow": {}, "confirm": {}}
    for row in rows:
        safe = row["target_probabilities"] == [1, 0]
        label = "allow" if safe else "confirm"
        family = families[row["source_id"]]
        row_cells[label].setdefault(family, []).append(contract.c9b_row_loss(margins[row["source_id"]], safe))
    pair_mean = sum(sum(values) / len(values) for values in pair_cells.values()) / len(pair_cells)
    label_means = [sum(sum(values) / len(values) for values in cells.values()) / len(cells) for cells in row_cells.values()]
    return (pair_mean + sum(label_means) / len(label_means)) / 2.0


def train_unit(model: Any, unit: dict[str, Any], device: Any) -> float:
    import torch

    if unit["kind"] == "single":
        row = unit["row"]
        margin = selected_margin(model, row, device)
        value = float(margin.detach().item())
        coefficient = contract.c9b_row_derivative(value, row["target_probabilities"] == [1, 0])
        (margin * (coefficient / contract.ACCUMULATION)).backward()
        return contract.c9b_row_loss(value, row["target_probabilities"] == [1, 0])
    with torch.no_grad():
        safe_value = float(selected_margin(model, unit["safe"], device).item())
        risky_value = float(selected_margin(model, unit["risky"], device).item())
    safe_coefficient, risky_coefficient = contract.c9b_pair_derivatives(safe_value, risky_value)
    for row, coefficient in ((unit["safe"], safe_coefficient), (unit["risky"], risky_coefficient)):
        margin = selected_margin(model, row, device)
        (margin * (coefficient / contract.ACCUMULATION)).backward()
    return contract.c9b_pair_loss(safe_value, risky_value)


def load_model(base: Path, device: Any) -> Any:
    import torch
    from transformers import Gemma3ForCausalLM

    config = json.loads((base / "config.json").read_text())
    contract.validate_architecture(config)
    model = Gemma3ForCausalLM.from_pretrained(str(base), local_files_only=True, dtype=torch.bfloat16, low_cpu_mem_usage=True)
    if not model.config.tie_word_embeddings or model.lm_head.weight.data_ptr() != model.model.embed_tokens.weight.data_ptr():
        raise ValueError("Google Gemma checkpoint lacks expected tied output embedding")
    model.to(device)
    model.config.use_cache = False
    return model


def run(args: argparse.Namespace) -> dict[str, Any]:
    import torch
    from safetensors.torch import save_file

    if args.budget_bytes != MAX_BUDGET_BYTES or not 0 < args.allocator_cap_bytes <= min(MAX_ALLOCATOR_CAP_BYTES, args.budget_bytes - ALLOCATOR_HEADROOM_BYTES):
        raise ValueError("CUDA allocator cap exceeds the shared 8 GB budget")
    if args.mode == "train" and args.steps != 256 or args.mode == "probe" and args.steps != 1:
        raise ValueError("Use 256 steps for the candidate or one step for a separate memory probe")
    output = Path(args.output).resolve()
    if output.exists():
        raise ValueError("Use a new, empty run path; existing runs are immutable")
    rows, pairs, families, plan = load_contract(args)
    output.mkdir(parents=True)
    plan_receipt = {
        "mode": args.mode,
        "objective": plan,
        "inputs": {"train": TRAIN_SHA256, "pairs": args.pairs_sha256, "families": args.families_sha256, "plan": args.plan_sha256, "base": BASE_HASHES},
        "source_sha256": contract.sha256(Path(__file__)),
        "contract_sha256": contract.sha256(Path(contract.__file__)),
        "steps": args.steps,
        "budget_bytes": args.budget_bytes,
        "allocator_cap_bytes": args.allocator_cap_bytes,
        "backend": "torch_cuda_experimental_not_qualified",
        "precision": {"base": "bfloat16", "lora": "float32", "selected_projection": "bfloat16_then_float32_margin"},
    }
    write_json(output / "plan.json", plan_receipt)
    progress = (output / "progress.jsonl").open("x", buffering=1)
    started = time.monotonic()

    def emit(event: str, **fields: Any) -> None:
        record = {"event": event, "elapsed_seconds": time.monotonic() - started, **fields}
        progress.write(json.dumps(record, allow_nan=False) + "\n")
        print(json.dumps(record, allow_nan=False), flush=True)

    def stop_requested(signum: int, _frame: Any) -> None:
        raise InterruptedError(f"Run stopped by signal {signum}")

    prior_sigterm = signal.signal(signal.SIGTERM, stop_requested)

    try:
        if not torch.cuda.is_available():
            raise ValueError("CUDA is unavailable; CPU training is forbidden")
        device = torch.device("cuda:0")
        total = torch.cuda.get_device_properties(device).total_memory
        free, _ = torch.cuda.mem_get_info(device)
        if free < args.allocator_cap_bytes + ALLOCATOR_HEADROOM_BYTES:
            raise ValueError("Insufficient free dedicated CUDA memory for the bounded run")
        torch.cuda.set_per_process_memory_fraction(args.allocator_cap_bytes / total, device)
        torch.cuda.reset_peak_memory_stats(device)
        random.seed(contract.SEED)
        torch.manual_seed(contract.SEED)
        torch.cuda.manual_seed_all(contract.SEED)
        emit("preflight", cuda_name=torch.cuda.get_device_name(device), torch_version=torch.__version__, cuda_version=torch.version.cuda, cuda_free_bytes=free, cuda_total_bytes=total)
        tokenizer = contract.load_tokenizer(Path(args.base))
        parity = contract.verify_prompt_parity(tokenizer, rows)
        model = load_model(Path(args.base), device)
        trainable = attach_lora(model)
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        initial_values = {name: value.detach().clone() for name, value in trainable}
        initial_margins, initial_row_loss = score_rows(model, rows, device)
        initial_objective = objective_from_margins(rows, pairs, families, initial_margins)
        emit("initial_evaluation", fit_rows=len(rows), initial_objective=initial_objective, initial_row_loss=initial_row_loss, **memory_sample(device, free))
        if args.mode == "probe":
            longest = max(rows, key=lambda item: len(item["prompt_token_ids"]))
            model.train()
            train_unit(model, {"kind": "single", "row": longest}, device)
            emit("longest_prompt_gradient_probe", prompt_tokens=len(longest["prompt_token_ids"]), **memory_sample(device, free))
            for _, value in trainable:
                value.grad = None
        sampler = contract.C9BalancedSampler(rows, pairs, families, contract.SEED)
        state: dict[int, tuple[Any, Any]] = {}
        model.train()
        first_step_placement = None
        losses = []
        for step in range(args.steps):
            unit_losses = [train_unit(model, sampler.draw(), device) for _ in range(contract.ACCUMULATION)]
            if any(not math.isfinite(loss) for loss in unit_losses):
                raise ValueError("Nonfinite objective loss")
            if step == 0:
                pre_step_placement = assert_cuda_placement_before_step(model, trainable, device)
            no_bias_adam_step([value for _, value in trainable], state)
            if step == 0:
                first_step_placement = assert_cuda_placement(model, trainable, state, device)
            average = sum(unit_losses) / len(unit_losses)
            losses.append(average)
            sample = memory_sample(device, free)
            if sample["cuda_free_delta_bytes"] >= args.budget_bytes:
                raise ValueError("Observed CUDA free-memory delta reached shared 8 GB limit")
            emit("training_step", step=step + 1, steps_total=args.steps, loss=average, **sample)
        changed = any(not torch.equal(value, initial_values[name]) for name, value in trainable)
        final_margins, final_row_loss = score_rows(model, rows, device)
        final_objective = objective_from_margins(rows, pairs, families, final_margins)
        margin_file = output / "fit-margins.jsonl"
        with margin_file.open("x") as handle:
            for row in rows:
                source = row["source_id"]
                handle.write(json.dumps({"source_id": source, "initial": initial_margins[source], "final": final_margins[source]}, allow_nan=False) + "\n")
        adapter = output / "adapter"
        adapter.mkdir()
        weights = {name: value.detach().to("cpu").contiguous() for name, value in trainable}
        check_adapter_tensors(weights)
        save_file(weights, str(adapter / "adapters.safetensors"))
        write_json(adapter / "adapter_config.json", {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": contract.LORA})
        receipt = {
            "qualified": False,
            "mode": args.mode,
            "steps": args.steps,
            "initial_objective": initial_objective,
            "final_objective": final_objective,
            "initial_row_loss": initial_row_loss,
            "final_row_loss": final_row_loss,
            "adapter_changed": changed,
            "adapter_sha256": contract.sha256(adapter / "adapters.safetensors"),
            "fit_margins_sha256": contract.sha256(margin_file),
            "sampler_counts": dict(sorted(sampler.counts.items())),
            "sampler_draws": sampler.draws,
            "prompt_parity": parity,
            "pre_step_placement": pre_step_placement,
            "post_step_placement": first_step_placement,
            "memory": memory_sample(device, free),
            "source": plan_receipt,
        }
        write_json(output / "receipt.json", receipt)
        emit("complete", steps_completed=args.steps, adapter_changed=changed, final_objective=final_objective, **receipt["memory"])
        write_json(output / "exit.json", {"ok": True, "steps_completed": args.steps, "elapsed_seconds": time.monotonic() - started})
        return receipt
    except BaseException as error:
        write_json(output / "exit.json", {"ok": False, "error_type": type(error).__name__, "error": str(error), "elapsed_seconds": time.monotonic() - started})
        raise
    finally:
        signal.signal(signal.SIGTERM, prior_sigterm)
        progress.close()


def assert_cuda_placement_before_step(model: Any, trainable: list[Any], device: Any) -> dict[str, int]:
    parameters = list(model.parameters())
    buffers = list(model.buffers())
    gradients = [value.grad for _, value in trainable if value.grad is not None]
    if len(gradients) != len(trainable) or any(tensor.device != device for tensor in parameters + buffers + gradients):
        raise ValueError("Model or LoRA gradient is not wholly on cuda:0")
    return {"parameters": len(parameters), "buffers": len(buffers), "gradients": len(gradients)}


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--mode", choices=["probe", "train"], required=True)
    command.add_argument("--base", required=True)
    command.add_argument("--train", required=True)
    command.add_argument("--pairs", required=True)
    command.add_argument("--pairs-sha256", required=True)
    command.add_argument("--families", required=True)
    command.add_argument("--families-sha256", required=True)
    command.add_argument("--plan", required=True)
    command.add_argument("--plan-sha256", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--steps", type=int, required=True)
    command.add_argument("--budget-bytes", type=int, default=MAX_BUDGET_BYTES)
    command.add_argument("--allocator-cap-bytes", type=int, default=6_500_000_000)
    return command


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except BaseException as error:
        print(f"CUDA FIT worker failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        raise
