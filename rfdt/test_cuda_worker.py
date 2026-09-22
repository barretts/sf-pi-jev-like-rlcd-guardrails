"""CPU-only math and boundary tests; no claim about real CUDA memory or scores."""

from __future__ import annotations

import math
import unittest

import torch
from torch import nn

import cuda_worker
import worker as contract


class TinyText(nn.Module):
    def __init__(self, embedding: nn.Embedding, scalar: nn.Parameter) -> None:
        super().__init__()
        self.embed_tokens = embedding
        self.scalar = scalar

    def forward(self, input_ids, use_cache=False):
        del use_cache
        return type("Output", (), {"last_hidden_state": self.embed_tokens(input_ids) * self.scalar})()


class TinySelected(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        embedding = nn.Embedding(4, 2)
        with torch.no_grad():
            embedding.weight.copy_(torch.tensor([[1.0, 0.0], [0.0, 1.0], [0.5, 1.5], [0.2, -0.5]]))
        embedding.weight.requires_grad_(False)
        self.scale = nn.Parameter(torch.tensor(0.6))
        self.model = TinyText(embedding, self.scale)
        self.lm_head = nn.Linear(2, 4, bias=False)
        self.lm_head.weight = self.model.embed_tokens.weight


def row(source: str, token: int, safe: bool) -> dict:
    return {"source_id": source, "prompt_token_ids": [token], "allowed_token_ids": [0, 1], "target_probabilities": [1, 0] if safe else [0, 1]}


class CudaObjectiveTests(unittest.TestCase):
    def test_adapter_requires_all_mlx_named_finite_fp32_tensors(self) -> None:
        weights = {}
        for layer in range(26):
            for projection, output in (("q_proj", 1024), ("v_proj", 256)):
                prefix = f"model.layers.{layer}.self_attn.{projection}"
                weights[f"{prefix}.lora_a"] = torch.zeros((1152, 16), dtype=torch.float32)
                weights[f"{prefix}.lora_b"] = torch.zeros((16, output), dtype=torch.float32)
        cuda_worker.check_adapter_tensors(weights)
        omitted = dict(weights)
        omitted.pop("model.layers.25.self_attn.v_proj.lora_b")
        with self.assertRaisesRegex(ValueError, "exactly the 104"):
            cuda_worker.check_adapter_tensors(omitted)
        weights["model.layers.0.self_attn.q_proj.lora_a"][0, 0] = float("nan")
        with self.assertRaisesRegex(ValueError, "Invalid CUDA adapter tensor"):
            cuda_worker.check_adapter_tensors(weights)

    def test_literal_mlx_lora_scale_and_shapes(self) -> None:
        base = nn.Linear(3, 2, bias=False)
        with torch.no_grad():
            base.weight.zero_()
        adapter = cuda_worker.DirectScaleLoRA.make(base, rank=2, scale=2.0)
        with torch.no_grad():
            adapter.lora_a.copy_(torch.tensor([[1.0, 2.0], [0.0, 1.0], [1.0, 0.0]]))
            adapter.lora_b.copy_(torch.tensor([[2.0, 0.0], [0.0, 3.0]]))
        actual = adapter(torch.tensor([[1.0, 2.0, 3.0]]))
        self.assertEqual(tuple(adapter.lora_a.shape), (3, 2))
        self.assertEqual(tuple(adapter.lora_b.shape), (2, 2))
        self.assertTrue(torch.allclose(actual, torch.tensor([[16.0, 24.0]])))
        fused = 2.0 * adapter.lora_b.T @ adapter.lora_a.T
        self.assertTrue(torch.allclose(actual, torch.tensor([[1.0, 2.0, 3.0]]) @ fused.T))

    def test_no_bias_adam_matches_mlx_first_update(self) -> None:
        parameter = nn.Parameter(torch.tensor([1.0], dtype=torch.float32))
        parameter.grad = torch.tensor([2.0])
        state = {}
        cuda_worker.no_bias_adam_step([parameter], state)
        expected = 1.0 - 1e-4 * 0.2 / (math.sqrt(0.004) + 1e-8)
        self.assertAlmostEqual(parameter.item(), expected, places=7)
        self.assertIsNone(parameter.grad)
        self.assertEqual(len(state), 1)

    def test_c9_b_pair_gradient_matches_direct_loss(self) -> None:
        safe = row("safe", 2, True)
        risky = row("risky", 3, False)
        unit = {"kind": "pair", "safe": safe, "risky": risky}
        actual_model = TinySelected()
        actual_loss = cuda_worker.train_unit(actual_model, unit, torch.device("cpu"))
        actual = actual_model.scale.grad.item()
        direct_model = TinySelected()
        d_safe = cuda_worker.selected_margin(direct_model, safe, torch.device("cpu"))
        d_risky = cuda_worker.selected_margin(direct_model, risky, torch.device("cpu"))
        target = (
            torch.nn.functional.softplus(-d_safe)
            + torch.nn.functional.softplus(2.0 - d_safe)
            + torch.nn.functional.softplus(d_risky)
            + torch.nn.functional.softplus(2.0 + d_risky)
        ) / 2.0 + 0.5 * torch.nn.functional.softplus(4.0 + d_risky - d_safe)
        (target / contract.ACCUMULATION).backward()
        self.assertAlmostEqual(actual_loss, target.item(), places=6)
        self.assertAlmostEqual(actual, direct_model.scale.grad.item(), places=6)

    def test_c9_b_single_gradient_matches_direct_loss(self) -> None:
        safe = row("safe", 2, True)
        actual_model = TinySelected()
        actual_loss = cuda_worker.train_unit(actual_model, {"kind": "single", "row": safe}, torch.device("cpu"))
        direct_model = TinySelected()
        d = cuda_worker.selected_margin(direct_model, safe, torch.device("cpu"))
        target = torch.nn.functional.softplus(-d) + torch.nn.functional.softplus(2.0 - d)
        (target / contract.ACCUMULATION).backward()
        self.assertAlmostEqual(actual_loss, target.item(), places=6)
        self.assertAlmostEqual(actual_model.scale.grad.item(), direct_model.scale.grad.item(), places=6)

    def test_b_sampler_remains_paired_and_label_balanced(self) -> None:
        rows = [row("a", 2, True), row("b", 3, False)]
        pairs = [{"pair_id": "one", "group_id": "g", "safe": rows[0], "risky": rows[1]}]
        families = {"a": "f", "b": "f"}
        sampler = contract.C9BalancedSampler(rows, pairs, families, 42)
        draws = [sampler.draw() for _ in range(16)]
        self.assertEqual([item["kind"] for item in draws], ["pair", "single"] * 8)
        self.assertEqual(sampler.counts["pair:f"], 8)
        self.assertEqual(sampler.counts["row:allow:f"], 4)
        self.assertEqual(sampler.counts["row:confirm:f"], 4)


if __name__ == "__main__":
    unittest.main()
