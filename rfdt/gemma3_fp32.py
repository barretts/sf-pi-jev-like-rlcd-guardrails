"""Explicit Gemma FP32 embedding scale; no package or global modifications."""
import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten
from mlx_lm.models.gemma3_text import Gemma3Model, create_attention_mask


class HfFp32Gemma3Model(Gemma3Model):
    """Reuse the complete tree, changing only the embedding scale precision."""
    def __init__(self, original):
        nn.Module.__init__(self)
        dict.update(self, original)
        self.__dict__.update(original.__dict__)
        self._no_grad = set(original._no_grad)
        self._training = original._training

    def __call__(self, inputs, cache=None, input_embeddings=None):
        h = input_embeddings if input_embeddings is not None else self.embed_tokens(inputs)
        h *= mx.array(self.args.hidden_size**0.5, h.dtype)
        if cache is None:
            cache = [None] * len(self.layers)
        global_mask = create_attention_mask(h, cache[self.sliding_window_pattern - 1])
        if self.sliding_window_pattern > 1:
            sliding_window_mask = create_attention_mask(h, cache[0], window_size=self.window_size)
        else:
            sliding_window_mask = None
        for i, (layer, c) in enumerate(zip(self.layers, cache)):
            is_global = i % self.sliding_window_pattern == self.sliding_window_pattern - 1
            h = layer(h, global_mask if is_global else sliding_window_mask, c)
        return self.norm(h)


def install_fp32_embedding_scale(model):
    original = model.model
    if type(original) is not Gemma3Model:
        raise ValueError("Expected an unwrapped standard Gemma3Model")
    before = dict(tree_flatten(model.parameters()))
    if original.embed_tokens.weight.dtype != mx.float32:
        raise ValueError("Explicit FP32 scaling requires FP32 embedding weights")
    wrapped = HfFp32Gemma3Model(original)
    model.model = wrapped
    after = dict(tree_flatten(model.parameters()))
    if set(before) != set(after) or any(before[key] is not after[key] for key in before):
        raise ValueError("FP32 scaling wrapper changed parameter tree identities")
    return model
