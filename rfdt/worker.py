#!/usr/bin/env python3
"""Train Jev's selected-answer objective with full-context Gemma gradients.

The TypeScript/native compiler supplies the authoritative rendered prompt and
token IDs. This worker checks their HF-tokenizer parity before doing any model
optimization. Model weights, adapters, and run output belong outside Git.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import platform
import random
import sys
import time
from pathlib import Path
from typing import Any

BASE_MODEL = "google/gemma-3-1b-it"
BASE_REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752"
MLX_VERSION = "0.32.2"
MLX_LM_REVISION = "9d1e356e7cc6549e7d1697adabe2ea01ff8e062c"
MAX_PROMPT_TOKENS = 2048
LORA = {
    "rank": 16,
    "scale": 2.0,
    "dropout": 0.0,
    "keys": ["self_attn.q_proj", "self_attn.v_proj"],
}
ACCUMULATION = 8
LEARNING_RATE = 1e-4
SEED = 42


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def dependencies() -> dict[str, str]:
    if sys.version_info[:2] != (3, 13):
        raise ValueError("RFDT requires Python 3.13")
    versions = {
        name: importlib.metadata.version(name)
        for name in ["mlx", "mlx-lm", "transformers", "huggingface-hub"]
    }
    if versions["mlx"] != MLX_VERSION:
        raise ValueError(f"RFDT requires mlx=={MLX_VERSION}")
    if versions["transformers"] != "5.11.0":
        raise ValueError("RFDT requires transformers==5.11.0")
    distribution = importlib.metadata.distribution("mlx-lm")
    direct_url = distribution.read_text("direct_url.json")
    if not direct_url:
        raise ValueError("Install MLX-LM from the pinned Git commit in requirements.txt")
    source = json.loads(direct_url)
    if source.get("vcs_info", {}).get("commit_id") != MLX_LM_REVISION:
        raise ValueError(f"RFDT requires MLX-LM commit {MLX_LM_REVISION}")
    return {"python": platform.python_version(), **versions, "mlx_lm_revision": MLX_LM_REVISION}


def provenance() -> dict[str, Any]:
    return {
        "base_model": BASE_MODEL,
        "base_revision": BASE_REVISION,
        "lineage": "Google Gemma 3",
        "dependencies": dependencies(),
    }


def verify_local_base(path: Path) -> None:
    """Accept the pinned HF snapshot or a checksum-verified staged equivalent."""
    if path.parent.name == "snapshots" and path.name == BASE_REVISION:
        repository = path.parent.parent.name
        if repository != "models--google--gemma-3-1b-it":
            raise ValueError("The snapshot repository is not the approved Google Gemma base")
        return
    manifest_path = path / "rfdt-base-manifest.json"
    if not manifest_path.is_file():
        raise ValueError("A local base requires the pinned HF snapshot or rfdt-base-manifest.json")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("base_model") != BASE_MODEL or manifest.get("base_revision") != BASE_REVISION:
        raise ValueError("Local base lineage/revision is not the approved Google Gemma checkpoint")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files or "config.json" not in files or "tokenizer.json" not in files:
        raise ValueError("Local base manifest must cover configuration, tokenizer, and every safetensor")
    for name, checksum in files.items():
        file = (path / name).resolve()
        if not file.is_relative_to(path) or not file.is_file() or sha256(file) != checksum:
            raise ValueError(f"Local base file failed verification: {name}")
    weight_names = {str(file.relative_to(path)) for file in path.glob("*.safetensors")}
    if not weight_names or not weight_names.issubset(files):
        raise ValueError("Local base manifest does not cover every model safetensor")


def resolve_model(model: str, *, fetch: bool, cache_dir: str | None = None) -> Path:
    local = Path(model).expanduser()
    if local.exists():
        resolved = local.resolve()
        verify_local_base(resolved)
        return resolved
    if model != BASE_MODEL:
        raise ValueError("Only the pinned Google Gemma 3 1B checkpoint is permitted for RFDT")
    from huggingface_hub import snapshot_download

    path = Path(
        snapshot_download(
            repo_id=BASE_MODEL,
            revision=BASE_REVISION,
            cache_dir=cache_dir,
            local_files_only=not fetch,
            allow_patterns=["*.json", "*.safetensors", "tokenizer.model", "*.jinja", "*.txt"],
        )
    ).resolve()
    verify_local_base(path)
    return path


def read_rows(path: Path, split: str | None = None) -> list[dict[str, Any]]:
    rows = []
    ids = set()
    versions = set()
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        prefix = f"{path.name}:{line_number}"
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError(f"{prefix}: a nonempty row ID is required")
        if row["id"] in ids:
            raise ValueError(f"{prefix}: duplicate row ID")
        ids.add(row["id"])
        row["group"] = row.get("group", row.get("group_id"))
        if not isinstance(row.get("group"), str) or not row["group"]:
            raise ValueError(f"{prefix}: a context/source group is required")
        if row.get("split") not in {"train", "validation", "test"}:
            raise ValueError(f"{prefix}: split must be train, validation, or test")
        if split is not None and row["split"] != split:
            continue
        prompt = row.get("prompt")
        tokens = row.get("prompt_token_ids")
        allowed = row.get("allowed_token_ids")
        targets = row.get("target_probabilities")
        if not isinstance(prompt, str) or not prompt:
            raise ValueError(f"{prefix}: a rendered prompt is required")
        if not isinstance(tokens, list) or not 1 <= len(tokens) <= MAX_PROMPT_TOKENS:
            raise ValueError(f"{prefix}: prompt must have 1..{MAX_PROMPT_TOKENS} tokens; truncation is forbidden")
        if not isinstance(allowed, list) or not 2 <= len(allowed) <= 50 or len(set(allowed)) != len(allowed):
            raise ValueError(f"{prefix}: distinct answer token IDs are required")
        for token in tokens + allowed:
            if type(token) is not int or not 0 <= token < 262144:
                raise ValueError(f"{prefix}: invalid Gemma token ID")
        if not isinstance(targets, list) or len(targets) != len(allowed):
            raise ValueError(f"{prefix}: target distribution must match allowed tokens")
        if any(type(value) not in {int, float} or not math.isfinite(value) or value < 0 for value in targets):
            raise ValueError(f"{prefix}: targets must be finite nonnegative probabilities")
        if not math.isclose(sum(targets), 1.0, abs_tol=1e-6):
            raise ValueError(f"{prefix}: target probabilities must sum to one")
        version = row.get("template_version", "v2")
        if version not in {"v1", "v2"}:
            raise ValueError(f"{prefix}: invalid template version")
        row["template_version"] = version
        versions.add(version)
        rows.append(row)
    if not rows:
        raise ValueError(f"No {split or 'prepared'} rows in {path}")
    if len(versions) != 1:
        raise ValueError("One training/evaluation input must use one template version")
    return rows


def verify_prompt_parity(tokenizer: Any, rows: list[dict[str, Any]]) -> dict[str, Any]:
    labels_checked = 0
    for row in rows:
        expected = row["prompt_token_ids"]
        actual = tokenizer.encode(row["prompt"], add_special_tokens=False)
        if actual != expected:
            first = next((i for i, pair in enumerate(zip(actual, expected)) if pair[0] != pair[1]), min(len(actual), len(expected)))
            raise ValueError(f"{row['id']}: native/HF prompt token mismatch at position {first}")
        labels = row.get("output_labels")
        if labels is not None and (not isinstance(labels, list) or len(labels) != len(row["allowed_token_ids"])):
            raise ValueError(f"{row['id']}: output labels must match allowed tokens")
        for index, token in enumerate(row["allowed_token_ids"]):
            label = labels[index] if labels is not None else tokenizer.decode([token], clean_up_tokenization_spaces=False, skip_special_tokens=False)
            if not isinstance(label, str) or not label:
                raise ValueError(f"{row['id']}: invalid answer label")
            with_label = tokenizer.encode(row["prompt"] + label, add_special_tokens=False)
            if with_label != expected + [token]:
                raise ValueError(f"{row['id']}: answer label {label!r} is not exactly one token at the prompt boundary")
            labels_checked += 1
    return {
        "rows_checked": len(rows),
        "labels_checked": labels_checked,
        "rendered_prompt_tokens": True,
        "answer_label_boundaries": True,
        "add_special_tokens": False,
        "template_version": rows[0]["template_version"],
    }


def load_tokenizer(model_dir: Path) -> Any:
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, trust_remote_code=False)


def validate_architecture(config: dict[str, Any]) -> None:
    if config.get("model_type") != "gemma3_text":
        raise ValueError("RFDT requires Google's Gemma 3 text architecture")
    expected = {
        "num_hidden_layers": 26,
        "hidden_size": 1152,
        "intermediate_size": 6912,
        "num_attention_heads": 4,
        "num_key_value_heads": 1,
        "head_dim": 256,
        "vocab_size": 262144,
    }
    if any(config.get(key) != value for key, value in expected.items()):
        raise ValueError("RFDT requires the approved Google Gemma 3 1B architecture")
    if config.get("quantization") or config.get("quantization_config"):
        raise ValueError("RFDT starts from the unquantized Google checkpoint")


def load_model(model_dir: Path, adapter: Path | None = None) -> tuple[Any, Any, dict[str, Any]]:
    from mlx_lm import load

    config = json.loads((model_dir / "config.json").read_text())
    validate_architecture(config)
    if adapter is not None:
        validate_adapter(adapter)
    model, tokenizer, config = load(
        str(model_dir),
        adapter_path=str(adapter) if adapter else None,
        return_config=True,
        trust_remote_code=False,
    )
    return model, tokenizer, config


def validate_adapter(adapter: Path, template_version: str | None = None) -> dict[str, Any]:
    manifest = json.loads((adapter / "rfdt-manifest.json").read_text())
    identity = manifest.get("provenance", {})
    if identity.get("base_model") != BASE_MODEL or identity.get("base_revision") != BASE_REVISION:
        raise ValueError("Adapter base lineage/revision does not match the approved Google Gemma checkpoint")
    if sha256(adapter / "adapters.safetensors") != manifest.get("adapter_sha256"):
        raise ValueError("Adapter checksum does not match its RFDT manifest")
    config = json.loads((adapter / "adapter_config.json").read_text())
    if config != {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": LORA}:
        raise ValueError("Adapter configuration does not match the approved RFDT hyperparameters")
    if template_version is not None and manifest.get("template_version") != template_version:
        raise ValueError("Adapter template version does not match prepared prompts")
    return manifest


def final_logits(model: Any, prompt_tokens: Any) -> Any:
    # The transformer sees the full real prompt, without a KV cache or detached
    # prefix. Projecting only its last hidden state avoids an N x vocabulary tensor.
    hidden = model.model(prompt_tokens, cache=None)[:, -1:, :]
    if model.tie_word_embeddings:
        return model.model.embed_tokens.as_linear(hidden)[:, -1, :]
    return model.lm_head(hidden)[:, -1, :]


def selected_loss(model: Any, tokens: Any, allowed: Any, targets: Any) -> Any:
    import mlx.core as mx

    logits = mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32)
    log_probabilities = logits - mx.logsumexp(logits)
    return -mx.sum(targets * log_probabilities)


def row_arrays(row: dict[str, Any]) -> tuple[Any, Any, Any]:
    import mlx.core as mx

    return (
        mx.array([row["prompt_token_ids"]], dtype=mx.int32),
        mx.array(row["allowed_token_ids"], dtype=mx.int32),
        mx.array(row["target_probabilities"], dtype=mx.float32),
    )


def evaluate_rows(model: Any, rows: list[dict[str, Any]]) -> dict[str, Any]:
    import mlx.core as mx

    model.eval()
    predictions = []
    correct = 0
    total_loss = 0.0
    for row in rows:
        tokens, allowed, targets = row_arrays(row)
        logits = mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32)
        probabilities = mx.softmax(logits)
        loss = -mx.sum(targets * (logits - mx.logsumexp(logits)))
        mx.eval(probabilities, loss)
        values = probabilities.tolist()
        scalar_loss = float(loss.item())
        if not math.isfinite(scalar_loss) or any(not math.isfinite(value) for value in values):
            raise ValueError(f"{row['id']}: model produced nonfinite values")
        prediction = max(range(len(values)), key=values.__getitem__)
        target = max(range(len(values)), key=row["target_probabilities"].__getitem__)
        correct += prediction == target
        total_loss += scalar_loss
        predictions.append({"id": row["id"], "group": row["group"], "split": row["split"], "probabilities": values, "selected_index": prediction, "loss": scalar_loss})
    return {"rows": len(rows), "mean_loss": total_loss / len(rows), "selected_label_accuracy": correct / len(rows), "predictions": predictions}


def train(args: argparse.Namespace) -> dict[str, Any]:
    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optimizers
    from mlx.utils import tree_flatten, tree_map
    from mlx_lm.tuner.utils import linear_to_lora_layers

    identity = provenance()
    output = Path(args.output).expanduser().resolve()
    adapter = output / "adapter"
    if adapter.exists():
        raise ValueError("The output adapter directory already exists; use a new run directory")
    model_dir = resolve_model(args.model, fetch=True)
    rows = read_rows(Path(args.data), "train")
    validation = read_rows(Path(args.validation_data), "validation") if args.validation_data else []
    if validation:
        if {row["group"] for row in rows} & {row["group"] for row in validation}:
            raise ValueError("Training and validation context/source groups overlap")
        if validation[0]["template_version"] != rows[0]["template_version"]:
            raise ValueError("Training and validation template versions differ")
    tokenizer = load_tokenizer(model_dir)
    parity = verify_prompt_parity(tokenizer, rows + validation)
    random.seed(SEED)
    mx.random.seed(SEED)
    model, _, _ = load_model(model_dir)
    model.freeze()
    linear_to_lora_layers(model, 26, LORA)
    trainable = dict(tree_flatten(model.trainable_parameters()))
    if len(trainable) != 104 or any(not name.endswith((".lora_a", ".lora_b")) for name in trainable):
        raise ValueError("Expected exactly query/value LoRA parameters in all 26 Gemma layers")
    mx.eval(trainable)
    initial_parameters = {name: mx.array(value) for name, value in trainable.items()}
    initial_report = evaluate_rows(model, rows)
    optimizer = optimizers.Adam(learning_rate=LEARNING_RATE)
    loss_and_grad = nn.value_and_grad(model, selected_loss)
    adapter.mkdir(parents=True)
    history = []
    order = list(range(len(rows)))
    cursor = 0
    started = time.monotonic()
    model.train()
    for step in range(args.steps):
        accumulated = None
        losses = []
        for _ in range(ACCUMULATION):
            if cursor % len(order) == 0:
                random.shuffle(order)
            row = rows[order[cursor % len(order)]]
            cursor += 1
            loss, gradients = loss_and_grad(model, *row_arrays(row))
            mx.eval(loss, gradients)
            scalar = float(loss.item())
            if not math.isfinite(scalar):
                raise ValueError(f"Nonfinite loss at optimizer step {step + 1}")
            losses.append(scalar)
            accumulated = gradients if accumulated is None else tree_map(lambda total, current: total + current, accumulated, gradients)
            mx.eval(accumulated)
        gradients = tree_map(lambda gradient: gradient / ACCUMULATION, accumulated)
        if any(not bool(mx.all(mx.isfinite(gradient)).item()) for _, gradient in tree_flatten(gradients)):
            raise ValueError(f"Nonfinite gradient at optimizer step {step + 1}")
        optimizer.update(model, gradients)
        mx.eval(model.parameters(), optimizer.state)
        history.append({"step": step + 1, "loss": sum(losses) / len(losses)})
        print(json.dumps({"event": "training_step", **history[-1]}), file=sys.stderr, flush=True)
    changed = any(bool(mx.any(value != initial_parameters[name]).item()) for name, value in tree_flatten(model.trainable_parameters()))
    final_report = evaluate_rows(model, rows)
    validation_report = evaluate_rows(model, validation) if validation else None
    weights = dict(tree_flatten(model.trainable_parameters()))
    mx.save_safetensors(str(adapter / "adapters.safetensors"), weights)
    write_json(adapter / "adapter_config.json", {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": LORA})
    manifest = {
        "schema_version": 1,
        "objective": "selected_label_soft_cross_entropy_at_final_real_prompt_position",
        "template_version": rows[0]["template_version"],
        "provenance": identity,
        "prompt_parity": parity,
        "training_data_sha256": sha256(Path(args.data)),
        "validation_data_sha256": sha256(Path(args.validation_data)) if args.validation_data else None,
        "adapter_sha256": sha256(adapter / "adapters.safetensors"),
        "hyperparameters": {"batch_size": 1, "gradient_accumulation": ACCUMULATION, "learning_rate": LEARNING_RATE, "seed": SEED, "max_prompt_tokens": MAX_PROMPT_TOKENS, "truncation": False, "lora": LORA, "layers": 26, "steps": args.steps},
        "adapter_dir": str(adapter),
        "initial_loss": initial_report["mean_loss"],
        "final_loss": final_report["mean_loss"],
        "steps": args.steps,
        "adapter_changed": changed,
        "training_loss_decreased": final_report["mean_loss"] < initial_report["mean_loss"],
        "reload_verified": False,
        "duration_seconds": time.monotonic() - started,
        "history": history,
        "validation": validation_report,
    }
    write_json(adapter / "rfdt-manifest.json", manifest)
    # Release model/optimizer state before constructing a fresh checkpoint load.
    expected_predictions = final_report["predictions"]
    del model, optimizer, loss_and_grad, weights, trainable, initial_parameters, gradients, accumulated
    import gc

    gc.collect()
    mx.clear_cache()
    reloaded, _, _ = load_model(model_dir, adapter)
    reload_report = evaluate_rows(reloaded, rows)
    delta = max(abs(before - after) for expected, actual in zip(expected_predictions, reload_report["predictions"]) for before, after in zip(expected["probabilities"], actual["probabilities"]))
    manifest["reload_max_probability_delta"] = delta
    manifest["reload_verified"] = delta <= 1e-5
    write_json(adapter / "rfdt-manifest.json", manifest)
    write_json(output / "training-report.json", manifest)
    if not changed or not manifest["reload_verified"]:
        raise ValueError("Training did not change adapters or checkpoint reload failed equivalence")
    return {"ok": True, **manifest}


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    identity = provenance()
    rows = read_rows(Path(args.data), args.split)
    adapter = Path(args.adapter).expanduser().resolve() if args.adapter else None
    if adapter:
        validate_adapter(adapter, rows[0]["template_version"])
    model_dir = resolve_model(args.model, fetch=True)
    parity = verify_prompt_parity(load_tokenizer(model_dir), rows)
    model, _, _ = load_model(model_dir, adapter)
    return {"ok": True, "provenance": identity, "prompt_parity": parity, "adapter_dir": str(adapter) if adapter else None, **evaluate_rows(model, rows)}


def fuse(args: argparse.Namespace) -> dict[str, Any]:
    import mlx.core as mx
    from mlx.utils import tree_map, tree_unflatten
    from mlx_lm.tuner.utils import load_adapters
    from mlx_lm.utils import save

    identity = provenance()
    adapter = Path(args.adapter).expanduser().resolve()
    manifest = validate_adapter(adapter)
    model_dir = resolve_model(args.model, fetch=True)
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise ValueError("The fusion output already exists; use a new directory")
    model, tokenizer, config = load_model(model_dir)
    # Expand the base before adding LoRA deltas so BF16 rounding cannot erase
    # small trained updates. llama.cpp performs the final explicit F16 conversion.
    model.update(tree_map(lambda parameter: parameter.astype(mx.float32) if mx.issubdtype(parameter.dtype, mx.floating) else parameter, model.parameters()))
    load_adapters(model, str(adapter))
    linears = [(name, module.fuse(dequantize=True)) for name, module in model.named_modules() if hasattr(module, "fuse")]
    if len(linears) != 52:
        raise ValueError("Expected 52 query/value LoRA modules to fuse")
    model.update_modules(tree_unflatten(linears))
    save(output, model_dir, model, tokenizer, config, donate_model=False)
    files = {file.name: sha256(file) for file in sorted(output.iterdir()) if file.is_file()}
    result = {"ok": True, "fused": True, "fusion_dtype": "float32", "output_dir": str(output), "format": "safetensors", "gguf_exported": False, "provenance": identity, "template_version": manifest["template_version"], "adapter_sha256": manifest["adapter_sha256"], "files": files}
    write_json(output / "rfdt-fused-manifest.json", result)
    return result


def doctor(args: argparse.Namespace) -> dict[str, Any]:
    import mlx.core as mx

    identity = provenance()
    result = {"ok": True, "provenance": identity, "metal_available": mx.metal.is_available(), "default_device": str(mx.default_device()), "training_ready": False}
    try:
        model_dir = resolve_model(args.model, fetch=args.fetch)
        result["model_dir"] = str(model_dir)
        result["model_cached"] = True
        validate_architecture(json.loads((model_dir / "config.json").read_text()))
        weight_files = list(model_dir.glob("*.safetensors"))
        index = model_dir / "model.safetensors.index.json"
        if index.is_file():
            required = set(json.loads(index.read_text())["weight_map"].values())
            result["weights_cached"] = bool(required) and all((model_dir / name).is_file() for name in required)
        else:
            result["weights_cached"] = bool(weight_files)
        result["training_ready"] = result["metal_available"] and result["weights_cached"]
        if args.data:
            result["prompt_parity"] = verify_prompt_parity(load_tokenizer(model_dir), read_rows(Path(args.data)))
    except Exception as error:
        result["model_cached"] = False
        result["model_status"] = "unavailable"
        result["model_error"] = str(error)
        if args.fetch or args.data or args.model != BASE_MODEL:
            result["ok"] = False
        else:
            from huggingface_hub import get_hf_file_metadata, hf_hub_url

            try:
                get_hf_file_metadata(hf_hub_url(BASE_MODEL, "config.json", revision=BASE_REVISION))
                result["checkpoint_access"] = "authorized"
            except Exception as access_error:
                result["checkpoint_access"] = "unavailable"
                result["checkpoint_access_error"] = str(access_error)
    return result


def fetch(args: argparse.Namespace) -> dict[str, Any]:
    if not args.accept_gemma_terms:
        raise ValueError("Checkpoint download requires --accept-gemma-terms and authorized Hugging Face access")
    identity = provenance()
    path = resolve_model(BASE_MODEL, fetch=True, cache_dir=str(Path(args.output).expanduser().resolve()))
    validate_architecture(json.loads((path / "config.json").read_text()))
    return {"ok": True, "model_dir": str(path), **identity, "gemma_terms_accepted": True}


def self_test(_: argparse.Namespace) -> dict[str, Any]:
    """Weights-free math/gradient fixture; never evidence about the real checkpoint."""
    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optimizers
    from mlx.utils import tree_flatten, tree_map, tree_unflatten
    from mlx_lm.models.gemma3_text import Model, ModelArgs
    from mlx_lm.tuner.utils import linear_to_lora_layers, load_adapters
    import tempfile

    identity = dependencies()
    # A separate CPU fixture can run while the real native classifier uses Metal.
    mx.set_default_device(mx.cpu)
    mx.random.seed(SEED)
    model_args = ModelArgs(model_type="gemma3_text", hidden_size=16, intermediate_size=32, num_hidden_layers=6, num_attention_heads=2, num_key_value_heads=1, head_dim=8, vocab_size=64, sliding_window=16, max_position_embeddings=64)
    model = Model(model_args)
    base_weights = list(tree_flatten(model.parameters()))
    model.freeze()
    fixture_lora = {**LORA, "rank": 4}
    linear_to_lora_layers(model, 6, fixture_lora)
    initial_adapters = dict(tree_flatten(model.trainable_parameters()))
    tokens = mx.array([[1, 7, 12, 3, 21]], dtype=mx.int32)
    allowed = mx.array([2, 3, 4], dtype=mx.int32)
    targets = mx.array([0.1, 0.8, 0.1], dtype=mx.float32)
    value_and_grad = nn.value_and_grad(model, selected_loss)
    before, gradients = value_and_grad(model, tokens, allowed, targets)
    mx.eval(before, gradients)
    leaves = dict(tree_flatten(gradients))
    first_layer = [gradient for name, gradient in leaves.items() if "layers.0." in name]
    if not first_layer or not any(bool(mx.any(gradient != 0).item()) for gradient in first_layer):
        raise ValueError("Selected-answer loss did not propagate into the first context layer")
    optimizer = optimizers.Adam(learning_rate=1e-3)
    for _ in range(8):
        _, gradients = value_and_grad(model, tokens, allowed, targets)
        optimizer.update(model, gradients)
        mx.eval(model.parameters(), optimizer.state)
    after = selected_loss(model, tokens, allowed, targets)
    mx.eval(after)
    if float(after.item()) >= float(before.item()):
        raise ValueError("Tiny Gemma selected-answer loss did not decrease")
    changed = any(bool(mx.any(parameter != initial_adapters[name]).item()) for name, parameter in tree_flatten(model.trainable_parameters()))
    expected = mx.softmax(mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32))
    with tempfile.TemporaryDirectory(prefix="jev-rfdt-fixture-") as temporary:
        adapter = Path(temporary)
        mx.save_safetensors(str(adapter / "adapters.safetensors"), dict(tree_flatten(model.trainable_parameters())))
        write_json(adapter / "adapter_config.json", {"fine_tune_type": "lora", "num_layers": 6, "lora_parameters": fixture_lora})
        reloaded = Model(model_args)
        reloaded.load_weights(base_weights)
        reloaded.freeze()
        load_adapters(reloaded, str(adapter))
        actual = mx.softmax(mx.take(final_logits(reloaded, tokens)[0], allowed).astype(mx.float32))
        reload_delta = float(mx.max(mx.abs(expected - actual)).item())
        reloaded.update(tree_map(lambda parameter: parameter.astype(mx.float32) if mx.issubdtype(parameter.dtype, mx.floating) else parameter, reloaded.parameters()))
        linears = [(name, module.fuse(dequantize=True)) for name, module in reloaded.named_modules() if hasattr(module, "fuse")]
        reloaded.update_modules(tree_unflatten(linears))
        fused = mx.softmax(mx.take(final_logits(reloaded, tokens)[0], allowed).astype(mx.float32))
        fusion_delta = float(mx.max(mx.abs(expected - fused)).item())
    if not changed or reload_delta > 1e-5 or fusion_delta > 1e-5 or len(linears) != 12:
        raise ValueError("Tiny Gemma adapter change/reload/fusion equivalence failed")
    return {"ok": True, "fixture": "random_tiny_gemma3_no_checkpoint_weights", "device": "cpu", "dependencies": identity, "full_context_gradient_verified": True, "initial_loss": float(before.item()), "final_loss": float(after.item()), "trainable_leaves": len(leaves), "adapter_changed": changed, "reload_verified": True, "reload_max_probability_delta": reload_delta, "fusion_verified": True, "fusion_max_probability_delta": fusion_delta, "fusion_dtype": "float32"}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    for name in ["doctor", "train", "evaluate", "fuse"]:
        command = commands.add_parser(name)
        command.add_argument("--model", default=BASE_MODEL)
        if name in {"train", "evaluate"}:
            command.add_argument("--data", required=True)
        if name in {"train", "fuse"}:
            command.add_argument("--output", required=True)
        if name == "train":
            command.add_argument("--validation-data")
            command.add_argument("--steps", type=int, default=8)
        elif name == "evaluate":
            command.add_argument("--adapter")
            command.add_argument("--split", choices=["train", "validation", "test"])
        elif name == "fuse":
            command.add_argument("--adapter", required=True)
        elif name == "doctor":
            command.add_argument("--data")
            command.add_argument("--fetch", action="store_true")
    command = commands.add_parser("fetch")
    command.add_argument("--output", required=True)
    command.add_argument("--accept-gemma-terms", action="store_true")
    commands.add_parser("self-test")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "train" and not 1 <= args.steps <= 100000:
            raise ValueError("--steps must be 1..100000 optimizer updates")
        # Third-party status output goes to stderr; stdout stays one JSON object.
        with contextlib.redirect_stdout(sys.stderr):
            result = {"doctor": doctor, "fetch": fetch, "train": train, "evaluate": evaluate, "fuse": fuse, "self-test": self_test}[args.command](args)
        print(json.dumps(result, allow_nan=False), flush=True)
        return 0 if result.get("ok") else 1
    except Exception as error:
        print(json.dumps({"ok": False, "command": args.command, "error": str(error), "error_type": type(error).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
