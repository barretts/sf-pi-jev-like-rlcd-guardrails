"""Exercise the embedding wrapper with scalar CPU fakes, without model inference."""
import importlib.util
import math
import struct
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def fp32(value):
    return struct.unpack("f", struct.pack("f", value))[0]


class Tensor:
    def __init__(self, value=1.0, dtype="float32"):
        self.value, self.dtype = value, dtype
    def __imul__(self, other):
        self.value = fp32(self.value * other)
        return self


class Module(dict):
    def __init__(self):
        super().__init__(); self._no_grad = set(); self._training = False
    def __getattr__(self, key):
        try: return self[key]
        except KeyError: raise AttributeError(key) from None
    def __setattr__(self, key, value):
        if key.startswith("_"): object.__setattr__(self, key, value)
        else: self[key] = value


class Gemma3Model(Module):
    pass


class Embedding:
    def __init__(self, dtype="float32"):
        self.weight = Tensor(dtype=dtype)
    def __call__(self, _):
        return Tensor()


class Capture:
    def __init__(self): self.observation = None
    def __call__(self, hidden, mask, cache):
        self.observation = (mask, cache)
        return hidden


class Model:
    def __init__(self, pattern=6):
        self.model = Gemma3Model()
        self.model.args = types.SimpleNamespace(hidden_size=1152)
        self.model.embed_tokens = Embedding()
        self.model.layers = [Capture() for _ in range(6)]
        self.model.norm = lambda h: h
        self.model.sliding_window_pattern = pattern
        self.model.window_size = 512
        self.tie_word_embeddings = True
    def parameters(self):
        return {"embed_tokens.weight": self.model.embed_tokens.weight}


class ScaleTests(unittest.TestCase):
    def setUp(self):
        mx = types.ModuleType("mlx.core")
        mx.float32 = "float32"; mx.array = lambda value, dtype: fp32(value)
        nn = types.ModuleType("mlx.nn"); nn.Module = Module
        utils = types.ModuleType("mlx.utils"); utils.tree_flatten = lambda value: list(value.items())
        gemma = types.ModuleType("mlx_lm.models.gemma3_text")
        gemma.Gemma3Model = Gemma3Model
        gemma.create_attention_mask = lambda h, cache, window_size=None: ("mask", window_size, cache)
        package = types.ModuleType("mlx"); package.__path__ = []; package.core, package.nn = mx, nn
        lm = types.ModuleType("mlx_lm"); lm.__path__ = []
        models = types.ModuleType("mlx_lm.models"); models.__path__ = []
        self.modules = patch.dict("sys.modules", {"mlx": package, "mlx.core": mx, "mlx.nn": nn,
            "mlx.utils": utils, "mlx_lm": lm, "mlx_lm.models": models,
            "mlx_lm.models.gemma3_text": gemma})
        self.modules.start()
        path = Path(__file__).resolve().parents[1] / "gemma_fp32.py"
        spec = importlib.util.spec_from_file_location("c11_test_gemma_fp32", path)
        self.helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.helper)
    def tearDown(self): self.modules.stop()

    def test_wrap_preserves_parameter_objects_and_tied_projection(self):
        model = Model(); original = model.model
        before = model.parameters()
        self.helper.install_fp32_embedding_scale(model)
        self.assertEqual(before, model.parameters())
        self.assertIs(before["embed_tokens.weight"], model.parameters()["embed_tokens.weight"])
        for key in ("embed_tokens", "layers", "norm"):
            self.assertIs(getattr(original, key), getattr(model.model, key))
        self.assertTrue(model.tie_word_embeddings)
        self.assertEqual(original._no_grad, model.model._no_grad)
        self.assertIsNot(original._no_grad, model.model._no_grad)
        with self.assertRaisesRegex(ValueError, "unwrapped"): self.helper.install_fp32_embedding_scale(model)

    def test_fp32_scale_and_global_sliding_attention_routing(self):
        model = Model(); self.helper.install_fp32_embedding_scale(model)
        caches = [f"cache-{index}" for index in range(6)]
        result = model.model(None, cache=caches, input_embeddings=Tensor())
        self.assertEqual(result.value, fp32(math.sqrt(1152)))
        # BF16 rounding would produce 34.0 rather than the HF FP32 scalar.
        self.assertNotEqual(result.value, 34.0)
        for index, layer in enumerate(model.model.layers):
            mask, cache = layer.observation
            self.assertEqual(cache, caches[index])
            self.assertEqual(mask, ("mask", None, caches[-1]) if index == 5 else ("mask", 512, caches[0]))
        model = Model(pattern=1); self.helper.install_fp32_embedding_scale(model)
        model.model(None, input_embeddings=Tensor())
        self.assertTrue(all(layer.observation[0] == ("mask", None, None) for layer in model.model.layers))

    def test_rejects_non_fp32_and_foreign_architecture(self):
        model = Model(); model.model.embed_tokens.weight.dtype = "bfloat16"
        with self.assertRaisesRegex(ValueError, "FP32 embedding"): self.helper.install_fp32_embedding_scale(model)
        self.assertIs(type(model.model), Gemma3Model)
        model.model = Module()
        with self.assertRaisesRegex(ValueError, "unwrapped"): self.helper.install_fp32_embedding_scale(model)


if __name__ == "__main__": unittest.main()
