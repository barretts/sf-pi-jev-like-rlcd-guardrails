#!/usr/bin/env python3
"""C11 selected-label gradients and FP32 query/value LoRA on CUDA."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any
import contract
from contract import BASE_HASHES, TRAIN_SHA256, PAIR_SHA256, FAMILY_SHA256, PLAN_SHA256
MAX_BUDGET_BYTES = 8_000_000_000
MAX_ALLOCATOR_CAP_BYTES = 6_500_000_000

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
        raise ValueError("Frozen C11 pair, family or objective checksum differs")
    base = Path(args.base).resolve()
    contract.verify_local_base(base)
    for name, expected in BASE_HASHES.items():
        exact_file(base / name, expected, allow_symlink=True)
    contract.validate_architecture(json.loads((base / "config.json").read_text()))
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
        raise ValueError("Only the frozen C11 FIT objective is supported")
    if len(rows) != 327 or len(pairs) != 86 or len(families) != 327:
        raise ValueError("C11 FIT cardinality changed")
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
            losses.append(contract.row_loss(value, row["target_probabilities"] == [1, 0]))
    return margins, sum(losses) / len(losses)


def train_unit(model: Any, unit: dict[str, Any], device: Any) -> float:
    import torch

    if unit["kind"] == "single":
        row = unit["row"]
        margin = selected_margin(model, row, device)
        value = float(margin.detach().item())
        coefficient = contract.row_derivative(value, row["target_probabilities"] == [1, 0])
        (margin * (coefficient / contract.ACCUMULATION)).backward()
        return contract.row_loss(value, row["target_probabilities"] == [1, 0])
    with torch.no_grad():
        safe_value = float(selected_margin(model, unit["safe"], device).item())
        risky_value = float(selected_margin(model, unit["risky"], device).item())
    safe_coefficient, risky_coefficient = contract.pair_derivatives(safe_value, risky_value)
    for row, coefficient in ((unit["safe"], safe_coefficient), (unit["risky"], risky_coefficient)):
        margin = selected_margin(model, row, device)
        (margin * (coefficient / contract.ACCUMULATION)).backward()
    return contract.pair_loss(safe_value, risky_value)


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
