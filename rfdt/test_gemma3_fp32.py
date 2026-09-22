import unittest
import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten
from mlx_lm.models.gemma3_text import Gemma3Model, Model, ModelArgs
import gemma3_fp32 as helper


class ScaleTests(unittest.TestCase):
    def setUp(self):
        self.previous_device = mx.default_device()
        mx.set_default_device(mx.cpu)
        self.args = ModelArgs(model_type='gemma3_text', hidden_size=1152,
            num_hidden_layers=6, intermediate_size=8, num_attention_heads=1,
            num_key_value_heads=1, head_dim=8, vocab_size=4, sliding_window_pattern=6)

    def tearDown(self):
        mx.set_default_device(self.previous_device)

    def test_tree_and_tied_projection_unchanged(self):
        model = Model(self.args)
        model.tie_word_embeddings = True
        original = model.model
        before = dict(tree_flatten(model.parameters()))
        helper.install_fp32_embedding_scale(model)
        after = dict(tree_flatten(model.parameters()))
        self.assertEqual(set(before), set(after))
        self.assertTrue(all(before[key] is after[key] for key in before))
        for key in ['embed_tokens', 'layers', 'norm']:
            self.assertIs(getattr(original, key), getattr(model.model, key))
        self.assertTrue(model.tie_word_embeddings)
        with self.assertRaises(ValueError): helper.install_fp32_embedding_scale(model)

    def test_exact_fp32_normalizer_and_window_mask_behavior(self):
        class Capture(nn.Module):
            def __init__(self):
                super().__init__(); self.mask = None
            def __call__(self, h, mask, cache):
                self.mask = mask
                return h
        original = Gemma3Model(self.args)
        original.layers = [Capture() for _ in range(6)]
        original.norm = nn.Identity()
        wrapped = helper.HfFp32Gemma3Model(original)
        for length in [511, 512, 513, 514]:
            embeddings = mx.ones((1, length, 1152), mx.float32)
            expected = mx.array(1152**0.5, mx.float32).item()
            out = wrapped(None, input_embeddings=embeddings)
            self.assertEqual(out[0, 0, 0].item(), expected)
            self.assertNotEqual(expected, mx.array(1152**0.5, mx.bfloat16).item())
            h = mx.ones((1, length, 1152), mx.float32)
            global_mask = helper.create_attention_mask(h, None)
            local_mask = helper.create_attention_mask(h, None, window_size=512)
            if length <= 512:
                self.assertEqual(local_mask, "causal")
            else:
                self.assertFalse(local_mask[-1, 0].item())
                self.assertTrue(local_mask[-1, -1].item())
            for i, layer in enumerate(wrapped.layers):
                expected_mask = global_mask if i == 5 else local_mask
                self.assertEqual(type(layer.mask), type(expected_mask))
                if isinstance(expected_mask, mx.array):
                    self.assertTrue(mx.array_equal(layer.mask, expected_mask).item())
                else:
                    self.assertEqual(layer.mask, expected_mask)

    def test_rejects_non_fp32_without_global_patch(self):
        model = Model(self.args)
        model.model.embed_tokens.weight = model.model.embed_tokens.weight.astype(mx.bfloat16)
        with self.assertRaises(ValueError): helper.install_fp32_embedding_scale(model)
        self.assertIs(type(model.model), Gemma3Model)


if __name__ == '__main__': unittest.main()
