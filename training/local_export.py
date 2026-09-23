#!/usr/bin/env python3
"""Local FP32 fusion of a verified C11 CUDA adapter; never grants enforcement."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

import contract
from contract import (BASE_MODEL, BASE_REVISION, LORA, FREE_CACHE_LIMIT_BYTES,
                      sha256, write_json, provenance, read_rows, resolve_model,
                      load_tokenizer, validate_architecture, verify_prompt_parity)

PRECISION = {"base": "float32", "lora": "float32", "attention": "eager", "tf32": False}

class MemoryProgress:
    """Bound free MLX buffers and retain only scalar progress observations."""

    def __init__(self, path: Path | None = None) -> None:
        import mlx.core as mx

        self.mx = mx
        self.previous_cache_limit = int(mx.set_cache_limit(FREE_CACHE_LIMIT_BYTES))
        mx.reset_peak_memory()
        self.started = time.monotonic()
        self.path = path
        self.phase = "startup"
        self.max_active = 0
        self.max_cache = 0
        self.peak = 0
        self.handle = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            self.handle = os.fdopen(descriptor, "w")

    def __enter__(self) -> MemoryProgress:
        self.emit("worker_start", phase="startup", free_cache_limit_bytes=FREE_CACHE_LIMIT_BYTES)
        return self

    def __exit__(self, error_type: Any, error: Any, traceback: Any) -> None:
        try:
            if error_type is not None:
                self.emit("worker_error", phase=self.phase, error_type=error_type.__name__)
        finally:
            if self.handle is not None:
                self.handle.close()

    def sample(self) -> dict[str, int]:
        active = int(self.mx.get_active_memory())
        cache = int(self.mx.get_cache_memory())
        peak = int(self.mx.get_peak_memory())
        self.max_active = max(self.max_active, active)
        self.max_cache = max(self.max_cache, cache)
        self.peak = max(self.peak, peak)
        return {"active_memory_bytes": active, "cache_memory_bytes": cache, "peak_memory_bytes": peak}

    def clear(self) -> None:
        self.sample()
        self.mx.clear_cache()
        self.sample()

    def emit(self, event: str, **fields: Any) -> None:
        self.phase = fields.get("phase", self.phase)
        record = {"event": event, "elapsed_seconds": time.monotonic() - self.started, **fields, **self.sample()}
        line = json.dumps(record, allow_nan=False)
        if self.handle is not None:
            self.handle.write(line + "\n")
            self.handle.flush()
        print(line, file=sys.stderr, flush=True)

    def summary(self) -> dict[str, Any]:
        self.sample()
        return {
            "free_cache_limit_bytes": FREE_CACHE_LIMIT_BYTES,
            "previous_free_cache_limit_bytes": self.previous_cache_limit,
            "clear_after_evaluation_row": True,
            "max_observed_active_memory_bytes": self.max_active,
            "max_observed_cache_memory_bytes": self.max_cache,
            "peak_memory_bytes": self.peak,
            "peak_scope": "since_worker_observer_start",
            "progress_file": str(self.path) if self.path is not None else None,
        }

def final_logits(model: Any, prompt_tokens: Any) -> Any:
    # The transformer sees the full real prompt, without a KV cache or detached
    # prefix. Projecting only its last hidden state avoids an N x vocabulary tensor.
    hidden = model.model(prompt_tokens, cache=None)[:, -1:, :]
    if model.tie_word_embeddings:
        return model.model.embed_tokens.as_linear(hidden)[:, -1, :]
    return model.lm_head(hidden)[:, -1, :]

def selected_logit_margin(model: Any, tokens: Any, allowed: Any) -> Any:
    import mlx.core as mx

    logits = mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32)
    return logits[0] - logits[1]

def project_text_tokenizer(model_dir: Path, output: Path, vocab_size: int) -> dict[str, Any]:
    """Restore the source tokenizer and remove only its untrained image placeholder."""
    placeholder = "<image_soft_token>"
    names = ["tokenizer.json", "tokenizer_config.json", "added_tokens.json", "special_tokens_map.json", "tokenizer.model", "chat_template.jinja"]
    source = {name: (model_dir / name).read_bytes() for name in names if (model_dir / name).is_file()}
    if "tokenizer.json" not in source or "tokenizer_config.json" not in source:
        raise ValueError("Text tokenizer projection requires the original tokenizer JSON and configuration")
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate original tokenizer JSON key: {key}")
            result[key] = value
        return result

    documents = {name: json.loads(content, object_pairs_hook=unique_object) for name, content in source.items() if name.endswith(".json")}
    tokenizer = documents["tokenizer.json"]
    vocab = tokenizer.get("model", {}).get("vocab")
    if type(vocab_size) is not int or vocab_size <= 0 or not isinstance(vocab, dict):
        raise ValueError("Text tokenizer projection requires a model vocabulary and embedding vocabulary size")
    if len(vocab) != vocab_size or any(type(token) is not int for token in vocab.values()) or set(vocab.values()) != set(range(vocab_size)):
        raise ValueError("Original tokenizer model vocabulary must exactly cover the trained embedding IDs")
    inverse_vocab = {token: content for content, token in vocab.items()}
    removed = []
    changed = set()
    drop = object()
    token_fields = {"content", "id", "lstrip", "normalized", "rstrip", "single_word", "special"}

    def token_object(value: dict[str, Any], name: str, location: str, expected_id: int | None = None) -> None:
        if not set(value).issubset(token_fields):
            raise ValueError(f"Unsupported original tokenizer token metadata: {name}/{location}")
        if "id" in value and (type(value["id"]) is not int or (expected_id is not None and value["id"] != expected_id)):
            raise ValueError(f"Contradictory original tokenizer token ID: {name}/{location}")

    def added_token(name: str, location: str, token: Any, content: Any) -> bool:
        if type(token) is not int or token < 0 or not isinstance(content, str):
            raise ValueError(f"Invalid original tokenizer token declaration: {name}/{location}")
        if token == vocab_size and content == placeholder and placeholder not in vocab:
            removed.append({"file": name, "location": location})
            changed.add(name)
            return True
        if token >= vocab_size:
            raise ValueError(f"Unexpected out-of-range tokenizer token: {name}/{location}")
        if inverse_vocab[token] != content:
            raise ValueError(f"Added token changes a trained model vocabulary entry: {name}/{location}")
        return False

    added = tokenizer.get("added_tokens", [])
    if not isinstance(added, list) or any(not isinstance(item, dict) for item in added):
        raise ValueError("Original tokenizer added_tokens must be token declarations")
    for index, item in enumerate(added):
        token_object(item, "tokenizer.json", f"added_tokens/{index}")
    tokenizer["added_tokens"] = [item for index, item in enumerate(added) if not added_token("tokenizer.json", f"added_tokens/{index}", item.get("id"), item.get("content"))]
    config = documents["tokenizer_config.json"]
    decoder = config.get("added_tokens_decoder", {})
    if not isinstance(decoder, dict):
        raise ValueError("Original tokenizer added_tokens_decoder must be an object")
    for key, item in list(decoder.items()):
        if not isinstance(key, str) or not key.isdecimal() or str(int(key)) != key or not isinstance(item, dict):
            raise ValueError("Invalid original tokenizer added_tokens_decoder entry")
        token_object(item, "tokenizer_config.json", f"added_tokens_decoder/{key}", int(key))
        if added_token("tokenizer_config.json", f"added_tokens_decoder/{key}", int(key), item.get("content")):
            del decoder[key]
    extra = documents.get("added_tokens.json", {})
    if not isinstance(extra, dict):
        raise ValueError("Original added_tokens.json must be an object")
    for content, token in list(extra.items()):
        if added_token("added_tokens.json", content, token, content):
            del extra[content]

    def clean_special(name: str, location: str, value: Any) -> Any:
        if value is None:
            return value
        content = value.get("content") if isinstance(value, dict) and "content" in value else value
        if isinstance(content, str):
            if isinstance(value, dict):
                token_object(value, name, location, vocab_size if content == placeholder and removed else vocab.get(content))
            if content == placeholder and removed and placeholder not in vocab:
                removed.append({"file": name, "location": location})
                changed.add(name)
                return drop
            if content not in vocab:
                raise ValueError(f"Special token is outside the trained vocabulary: {name}/{location}")
            return value
        if isinstance(value, list):
            return [cleaned for index, item in enumerate(value) if (cleaned := clean_special(name, f"{location}/{index}", item)) is not drop]
        if isinstance(value, dict):
            return {key: cleaned for key, item in value.items() if (cleaned := clean_special(name, f"{location}/{key}", item)) is not drop}
        raise ValueError(f"Invalid special token declaration: {name}/{location}")

    for name in ["tokenizer_config.json", "special_tokens_map.json"]:
        document = documents.get(name, {})
        if not isinstance(document, dict):
            raise ValueError(f"Original {name} must be an object")
        for key, value in list(document.items()):
            if key in {"extra_special_tokens", "additional_special_tokens", "model_specific_special_tokens"} or (key.endswith("_token") and not key.startswith("add_")):
                cleaned = clean_special(name, key, value)
                if cleaned is drop:
                    del document[key]
                else:
                    document[key] = cleaned
            elif key == "image_token_id" and type(value) is int and value == vocab_size and removed:
                del document[key]
                removed.append({"file": name, "location": key})
                changed.add(name)

    def verify_ids(value: Any, location: str = "") -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"id", "ids", "token_index"} or key.endswith("_id") or key.endswith("_ids") or key.endswith("_token_index"):
                    tokens = item if isinstance(item, list) else [item]
                    if key == "id" and isinstance(item, str):
                        tokens = [vocab.get(item)]
                    if any(type(token) is not int or not 0 <= token < vocab_size for token in tokens):
                        raise ValueError(f"Unexpected out-of-range tokenizer metadata: {location}/{key}")
                verify_ids(item, f"{location}/{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                verify_ids(item, f"{location}/{index}")

    for name, document in documents.items():
        verify_ids(document, name)
    if tokenizer["model"]["vocab"] != vocab:
        raise ValueError("Text tokenizer projection changed the trained model vocabulary")
    output.mkdir(parents=True, exist_ok=True)
    for name in names:
        target = output / name
        if name in source:
            target.write_bytes(source[name])
        elif target.is_file():
            target.unlink()
    for name in changed:
        write_json(output / name, documents[name])
    return {
        "derivation": "original tokenizer with only the untrained out-of-range image placeholder removed",
        "model_vocab_size": vocab_size,
        "source_model_config_sha256": sha256(model_dir / "config.json"),
        "model_vocab_sha256": hashlib.sha256(json.dumps(vocab, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
        "removed_special_tokens": [{"id": vocab_size, "content": placeholder, "occurrences": removed}] if removed else [],
        "source_files": {name: hashlib.sha256(content).hexdigest() for name, content in source.items()},
        "export_files": {name: sha256(output / name) for name in source},
    }

def fusion_training_rows(adapter: Path, manifest: dict[str, Any], data: str | None = None) -> tuple[Path, list[dict[str, Any]]]:
    path = Path(data).expanduser().resolve() if data else adapter.parent / "train.jsonl"
    if not path.is_file() or sha256(path) != manifest.get("training_data_sha256"):
        raise ValueError("Fusion requires the exact frozen training prompts from the adapter manifest")
    rows = read_rows(path, "train")
    if rows[0]["template_version"] != manifest.get("template_version"):
        raise ValueError("Fusion training prompt template does not match the adapter")
    return path, rows

def local_architecture() -> dict[str, str]:
    helper = Path(__file__).with_name("gemma_fp32.py")
    if not helper.is_file() or helper.is_symlink():
        raise ValueError("FP32 architecture helper must be a regular file")
    return {"kind": "hf_fp32_embedding_scale", "helper_sha256": sha256(helper),
            "embedding_scale_policy": "sqrt_hidden_size_in_fp32"}


def validate_local_profile(manifest: dict[str, Any]) -> None:
    import import_checkpoint
    receipt = manifest.get("cuda_source", {})
    source = receipt.get("source", {})
    if (manifest.get("schema_version") != 2 or manifest.get("qualified") is not False
            or manifest.get("local_precision") != PRECISION
            or manifest.get("provenance", {}).get("training_backend") != "torch_cuda"
            or source.get("precision") != PRECISION
            or source.get("campaign_sha256") != manifest.get("cuda_campaign_sha256")
            or manifest.get("training_data_sha256") != contract.TRAIN_SHA256
            or receipt.get("adapter_sha256") != manifest.get("adapter_sha256")
            or manifest.get("local_architecture") != local_architecture()):
        raise ValueError("Unrecognized local C11 precision, lineage, data, or architecture")
    import_checkpoint.validate_c11_checkpoint(source, receipt)


def validate_adapter(adapter: Path) -> dict[str, Any]:
    for name in ("adapter-manifest.json", "adapters.safetensors", "adapter_config.json"):
        path = adapter / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Expected a regular adapter file: {name}")
    manifest = json.loads((adapter / "adapter-manifest.json").read_text())
    identity = manifest.get("provenance", {})
    if identity.get("base_model") != BASE_MODEL or identity.get("base_revision") != BASE_REVISION:
        raise ValueError("Adapter base lineage/revision differs from approved Google Gemma")
    if sha256(adapter / "adapters.safetensors") != manifest.get("adapter_sha256"):
        raise ValueError("Adapter checksum differs from its manifest")
    config = json.loads((adapter / "adapter_config.json").read_text())
    if config != {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": LORA}:
        raise ValueError("Adapter configuration differs from approved C11 hyperparameters")
    if manifest.get("template_version") != "v2":
        raise ValueError("C11 requires the frozen v2 prepared prompts")
    validate_local_profile(manifest)
    return manifest


def require_verified_import(adapter: Path, manifest: dict[str, Any]) -> None:
    paths = {name: adapter / name for name in ("import-report.json", "import-equivalence.json", "local-fit-margins.jsonl")}
    if any(not path.is_file() or path.is_symlink() for path in paths.values()):
        raise ValueError("Fusion requires a completed successful local import report")
    report = json.loads(paths["import-report.json"].read_text())
    comparison = json.loads(paths["import-equivalence.json"].read_text())
    delta = comparison.get("max_probability_delta")
    if (report.get("ok") is not True or report.get("reload_verified") is not True
            or report.get("qualified") is not False or report.get("training_backend") != "torch_cuda"
            or report.get("cuda_source") != manifest["cuda_source"]
            or report.get("cuda_receipt_sha256") != manifest.get("cuda_receipt_sha256")
            or report.get("local_architecture") != manifest["local_architecture"]
            or report.get("local_precision") != PRECISION
            or report.get("cuda_campaign_sha256") != manifest["cuda_campaign_sha256"]
            or report.get("cross_backend_equivalence") != comparison
            or report.get("local_fit_margins_sha256") != sha256(paths["local-fit-margins.jsonl"])
            or comparison.get("ok") is not True or comparison.get("rows") != 327
            or comparison.get("max_probability_delta_limit") != 0.05
            or comparison.get("decisive_margin") != 0.5 or comparison.get("decisive_sign_flips") != 0
            or type(delta) not in (int, float) or not math.isfinite(delta) or not 0 <= delta <= 0.05):
        raise ValueError("Local import report or fixed FIT equivalence proof changed")


def expand_fp32(model: Any) -> None:
    import mlx.core as mx
    from mlx.utils import tree_map
    model.update(tree_map(lambda p: p.astype(mx.float32) if mx.issubdtype(p.dtype, mx.floating) else p,
                          model.parameters()))


def install_local_architecture(model: Any, manifest: dict[str, Any]) -> None:
    validate_local_profile(manifest)
    from gemma_fp32 import install_fp32_embedding_scale
    install_fp32_embedding_scale(model)


def verify_base_files(model_dir: Path) -> None:
    contract.verify_local_base(model_dir)
    for name, digest in contract.BASE_HASHES.items():
        path = model_dir / name
        if not path.is_file() or sha256(path) != digest:
            raise ValueError(f"Approved original Gemma file pin differs: {name}")


def load_model(model_dir: Path, adapter: Path | None = None) -> tuple[Any, Any, dict[str, Any]]:
    from mlx_lm import load
    validate_architecture(json.loads((model_dir / "config.json").read_text()))
    manifest = validate_adapter(adapter) if adapter is not None else None
    model, tokenizer, config = load(str(model_dir), adapter_path=None,
                                    return_config=True, trust_remote_code=False)
    if manifest:
        from mlx_lm.tuner.utils import load_adapters
        expand_fp32(model)
        install_local_architecture(model, manifest)
        load_adapters(model, str(adapter))
    return model, tokenizer, config


def run(args: argparse.Namespace) -> dict[str, Any]:
    with MemoryProgress() as progress:
        return run_with_progress(args, progress)


def run_with_progress(args: argparse.Namespace, progress: MemoryProgress) -> dict[str, Any]:
    from mlx.utils import tree_unflatten
    from mlx_lm.tuner.utils import load_adapters
    from mlx_lm.utils import save
    identity = provenance()
    adapter = Path(args.adapter).expanduser().resolve()
    manifest = validate_adapter(adapter)
    require_verified_import(adapter, manifest)
    data_path, rows = fusion_training_rows(adapter, manifest, args.data)
    model_dir = resolve_model(args.model, fetch=False)
    verify_base_files(model_dir)
    source_parity = verify_prompt_parity(load_tokenizer(model_dir), rows)
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise ValueError("Fusion output already exists; use a fresh directory")
    progress.emit("phase_begin", phase="fusion")
    model, tokenizer, config = load_model(model_dir)
    # Expand the complete floating tree before LoRA construction. Explicit F16
    # conversion is a later pinned llama.cpp step, preserving small LoRA deltas.
    expand_fp32(model)
    install_local_architecture(model, manifest)
    load_adapters(model, str(adapter))
    linears = [(name, module.fuse(dequantize=True)) for name, module in model.named_modules() if hasattr(module, "fuse")]
    if len(linears) != 52:
        raise ValueError("Expected 52 query/value LoRA modules to fuse")
    model.update_modules(tree_unflatten(linears))
    save(output, model_dir, model, tokenizer, config, donate_model=False)
    progress.clear()
    progress.emit("phase_end", phase="fusion")
    projection = project_text_tokenizer(model_dir, output, config["vocab_size"])
    export_tokenizer = load_tokenizer(output)
    if any(type(token) is not int or not 0 <= token < config["vocab_size"] for token in export_tokenizer.get_vocab().values()):
        raise ValueError("Projected tokenizer contains a token outside trained embedding vocabulary")
    export_parity = verify_prompt_parity(export_tokenizer, rows)
    projection["prompt_parity"] = {"source": source_parity, "export": export_parity,
        "training_data_file": str(data_path), "training_data_sha256": sha256(data_path)}
    files = {file.name: sha256(file) for file in sorted(output.iterdir()) if file.is_file()}
    result = {"ok": True, "qualified": False, "fused": True, "fusion_dtype": "float32",
        "output_dir": str(output), "format": "safetensors", "gguf_exported": False,
        "provenance": identity, "template_version": manifest["template_version"],
        "adapter_sha256": manifest["adapter_sha256"], "tokenizer_projection": projection,
        "local_architecture": local_architecture(), "files": files, "memory": progress.summary()}
    write_json(output / "fused-manifest.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("model", "adapter", "data", "output"):
        parser.add_argument("--" + name, required=True)
    print(json.dumps(run(parser.parse_args()), allow_nan=False))
