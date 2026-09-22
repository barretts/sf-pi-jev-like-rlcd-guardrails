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
import os
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
FREE_CACHE_LIMIT_BYTES = 256 * 1024 * 1024
PROGRESS_ROW_INTERVAL = 25
GUARDRAIL_PAIR_MARGIN = 2.0
GUARDRAIL_ANCHOR_MARGIN = 1.0
GUARDRAIL_CE_WEIGHT = 0.25
GUARDRAIL_ANCHOR_WEIGHT = 0.5
C9_B_LOSS = {"ce_weight": 1.0, "anchor_weight": 1.0, "anchor_margin": 2.0, "pair_weight": 0.5, "pair_margin": 4.0}
C9_B_SAMPLER = {"pair_fraction": 0.5, "row_label_order": ["allow", "confirm"], "family_policy": "round_robin_within_label_or_pair", "item_policy": "shuffled_round_robin", "seed": SEED}


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
            "clear_after_training_microbatch": True,
            "clear_after_optimizer_update": True,
            "max_observed_active_memory_bytes": self.max_active,
            "max_observed_cache_memory_bytes": self.max_cache,
            "peak_memory_bytes": self.peak,
            "peak_scope": "since_worker_observer_start",
            "progress_file": str(self.path) if self.path is not None else None,
        }


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


def read_rows(path: Path, split: str | None = None, content: bytes | None = None) -> list[dict[str, Any]]:
    rows = []
    ids = set()
    versions = set()
    for line_number, line in enumerate((content.decode("utf-8") if content is not None else path.read_text()).splitlines(), 1):
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


def read_guardrail_pairs(path: Path, rows: list[dict[str, Any]], content: bytes | None = None) -> list[dict[str, Any]]:
    """Admit only explicit, disjoint pairs from the prepared TRAIN branch."""
    manifest = json.loads(content if content is not None else path.read_bytes())
    if not isinstance(manifest, dict) or set(manifest) != {"version", "pairs"} or type(manifest["version"]) is not int or manifest["version"] != 1 or not isinstance(manifest["pairs"], list) or not manifest["pairs"]:
        raise ValueError("Invalid guardrail TRAIN pair manifest")
    by_source = {}
    for row in rows:
        source = row.get("source_id")
        if not isinstance(source, str) or not source or source in by_source:
            raise ValueError("Guardrail pair training requires unique prepared source IDs")
        if row.get("split") != "train" or row.get("question_id") != "risk" or row.get("question_type") != "choice" or row.get("answer_labels") != ["allow", "confirm"] or row.get("target_probabilities") not in ([1, 0], [0, 1]) or len(row["allowed_token_ids"]) != 2:
            raise ValueError("Guardrail pair training requires exact allow/confirm TRAIN targets")
        by_source[source] = row
    pair_ids = set()
    used_sources = set()
    pairs = []
    for pair in manifest["pairs"]:
        if not isinstance(pair, dict) or set(pair) != {"pair_id", "group_id", "safe_id", "risky_id"} or any(not isinstance(value, str) or not value or len(value) > 256 for value in pair.values()):
            raise ValueError("Invalid guardrail pair record")
        pair_id, group, safe_id, risky_id = (pair[key] for key in ("pair_id", "group_id", "safe_id", "risky_id"))
        if pair_id in pair_ids or safe_id == risky_id or safe_id in used_sources or risky_id in used_sources:
            raise ValueError("Duplicate guardrail pair ID or reused TRAIN source")
        safe, risky = by_source.get(safe_id), by_source.get(risky_id)
        if safe is None or risky is None or safe["group"] != group or risky["group"] != group:
            raise ValueError("Guardrail pair must name two TRAIN rows from its own group")
        if safe["target_probabilities"] != [1, 0] or risky["target_probabilities"] != [0, 1]:
            raise ValueError("Guardrail pair requires safe then risky targets")
        if safe.get("prompt_token_ids") == risky.get("prompt_token_ids"):
            raise ValueError("Opposite guardrail targets cannot share one rendered prompt")
        pair_ids.add(pair_id)
        used_sources.update((safe_id, risky_id))
        pairs.append({"pair_id": pair_id, "group_id": group, "safe": safe, "risky": risky})
    return pairs


def read_guardrail_families(path: Path, rows: list[dict[str, Any]], content: bytes | None = None) -> dict[str, str]:
    """Bind every prepared FIT source to its reviewed family and target."""
    manifest = json.loads(content if content is not None else path.read_bytes())
    if not isinstance(manifest, dict) or set(manifest) != {"version", "purpose", "rows"} or type(manifest["version"]) is not int or manifest["version"] != 1 or manifest["purpose"] != "candidate9_fit_families" or not isinstance(manifest["rows"], list) or len(manifest["rows"]) != len(rows):
        raise ValueError("Invalid C9 FIT family manifest")
    by_source = {row.get("source_id"): row for row in rows}
    if len(by_source) != len(rows) or None in by_source:
        raise ValueError("C9 FIT requires unique prepared source IDs")
    families = {}
    for item in manifest["rows"]:
        if not isinstance(item, dict) or set(item) != {"id", "group_id", "family", "expected"}:
            raise ValueError("Invalid C9 FIT family record")
        source, group, family, expected = (item[key] for key in ("id", "group_id", "family", "expected"))
        row = by_source.get(source)
        if not isinstance(source, str) or source in families or row is None or not isinstance(group, str) or group != row["group"] or not isinstance(family, str) or not family or len(family) > 128 or expected not in {"allow", "confirm"} or row["target_probabilities"] != ([1, 0] if expected == "allow" else [0, 1]):
            raise ValueError("C9 FIT family, group, or target differs from prepared TRAIN")
        families[source] = family
    if set(families) != set(by_source):
        raise ValueError("C9 FIT family manifest omitted prepared source IDs")
    return families


def read_guardrail_plan(path: Path, pair_sha256: str, content: bytes | None = None, family_sha256: str | None = None) -> dict[str, Any]:
    plan = json.loads(content if content is not None else path.read_bytes())
    expected_loss = {"pair_margin": GUARDRAIL_PAIR_MARGIN, "anchor_margin": GUARDRAIL_ANCHOR_MARGIN, "ce_weight": GUARDRAIL_CE_WEIGHT, "anchor_weight": GUARDRAIL_ANCHOR_WEIGHT}
    if isinstance(plan, dict) and plan.get("version") == 2:
        if set(plan) != {"version", "purpose", "arm", "objective", "pair_manifest_sha256", "family_manifest_sha256", "loss", "sampler", "steps", "cutoff_status", "validation_rows_passed_to_training", "test_rows_passed_to_training"}:
            raise ValueError("Invalid C9 TRAIN objective plan")
        arm = plan["arm"]
        if type(plan["version"]) is not int or plan["purpose"] != "candidate9_train_only" or arm not in {"A", "B"} or plan["objective"] != ("guardrail_train_group_pair_margin_v1" if arm == "A" else "guardrail_train_balanced_symmetric_v1") or plan["pair_manifest_sha256"] != pair_sha256 or plan["family_manifest_sha256"] != family_sha256 or not isinstance(family_sha256, str) or len(family_sha256) != 64 or plan["steps"] != 256 or type(plan["steps"]) is not int or plan["cutoff_status"] != "unset_requires_c9_train_cal_hard_veto_before_valid" or type(plan["validation_rows_passed_to_training"]) is not int or plan["validation_rows_passed_to_training"] != 0 or type(plan["test_rows_passed_to_training"]) is not int or plan["test_rows_passed_to_training"] != 0:
            raise ValueError("C9 TRAIN objective identity or split boundary changed")
        expected = expected_loss if arm == "A" else C9_B_LOSS
        sampler = {"mode": "c8_group_balanced", "seed": SEED} if arm == "A" else C9_B_SAMPLER
        if not isinstance(plan["loss"], dict) or set(plan["loss"]) != set(expected) or any(type(plan["loss"][key]) not in {int, float} or not math.isfinite(plan["loss"][key]) or plan["loss"][key] != value for key, value in expected.items()) or plan["sampler"] != sampler:
            raise ValueError("C9 TRAIN loss or sampler parameters changed")
        return plan
    if not isinstance(plan, dict) or set(plan) != {"version", "purpose", "objective", "pair_manifest_sha256", "loss", "cutoff_status", "validation_rows_passed_to_training", "test_rows_passed_to_training"}:
        raise ValueError("Invalid guardrail TRAIN objective plan")
    if type(plan["version"]) is not int or plan["version"] != 1 or plan["purpose"] != "candidate8_train_only" or plan["objective"] != "guardrail_train_group_pair_margin_v1" or plan["pair_manifest_sha256"] != pair_sha256 or plan["cutoff_status"] != "unset_requires_train_calibration_before_VALID" or type(plan["validation_rows_passed_to_training"]) is not int or plan["validation_rows_passed_to_training"] != 0 or type(plan["test_rows_passed_to_training"]) is not int or plan["test_rows_passed_to_training"] != 0:
        raise ValueError("Guardrail TRAIN objective plan identity or split boundary changed")
    loss = plan["loss"]
    if not isinstance(loss, dict) or set(loss) != set(expected_loss) or any(type(loss[key]) not in {int, float} or not math.isfinite(loss[key]) or loss[key] != expected for key, expected in expected_loss.items()):
        raise ValueError("Guardrail TRAIN objective plan loss parameters changed")
    return plan


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


def selected_logit_margin(model: Any, tokens: Any, allowed: Any) -> Any:
    import mlx.core as mx

    logits = mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32)
    return logits[0] - logits[1]


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value)) if value >= 0 else math.exp(value) / (1.0 + math.exp(value))


def softplus(value: float) -> float:
    return max(value, 0.0) + math.log1p(math.exp(-abs(value)))


def guardrail_row_loss(margin: float, safe: bool) -> float:
    ce = softplus(-margin if safe else margin)
    anchor = softplus(GUARDRAIL_ANCHOR_MARGIN - margin if safe else GUARDRAIL_ANCHOR_MARGIN + margin)
    return ce + GUARDRAIL_ANCHOR_WEIGHT * anchor


def guardrail_pair_loss(safe_margin: float, risky_margin: float) -> float:
    separation = softplus(GUARDRAIL_PAIR_MARGIN + risky_margin - safe_margin)
    ce = (softplus(-safe_margin) + softplus(risky_margin)) / 2.0
    anchors = softplus(GUARDRAIL_ANCHOR_MARGIN - safe_margin) + softplus(GUARDRAIL_ANCHOR_MARGIN + risky_margin)
    return separation + GUARDRAIL_CE_WEIGHT * ce + GUARDRAIL_ANCHOR_WEIGHT * anchors


def guardrail_pair_derivatives(safe_margin: float, risky_margin: float) -> tuple[float, float]:
    pair = sigmoid(GUARDRAIL_PAIR_MARGIN + risky_margin - safe_margin)
    safe = -pair + (GUARDRAIL_CE_WEIGHT / 2.0) * (sigmoid(safe_margin) - 1.0) - GUARDRAIL_ANCHOR_WEIGHT * sigmoid(GUARDRAIL_ANCHOR_MARGIN - safe_margin)
    risky = pair + (GUARDRAIL_CE_WEIGHT / 2.0) * sigmoid(risky_margin) + GUARDRAIL_ANCHOR_WEIGHT * sigmoid(GUARDRAIL_ANCHOR_MARGIN + risky_margin)
    return safe, risky


def guardrail_row_derivative(margin: float, safe: bool) -> float:
    if safe:
        return sigmoid(margin) - 1.0 - GUARDRAIL_ANCHOR_WEIGHT * sigmoid(GUARDRAIL_ANCHOR_MARGIN - margin)
    return sigmoid(margin) + GUARDRAIL_ANCHOR_WEIGHT * sigmoid(GUARDRAIL_ANCHOR_MARGIN + margin)


def c9b_row_loss(margin: float, safe: bool) -> float:
    return softplus(-margin if safe else margin) + softplus(C9_B_LOSS["anchor_margin"] - margin if safe else C9_B_LOSS["anchor_margin"] + margin)


def c9b_pair_loss(safe_margin: float, risky_margin: float) -> float:
    rows = (c9b_row_loss(safe_margin, True) + c9b_row_loss(risky_margin, False)) / 2.0
    return rows + C9_B_LOSS["pair_weight"] * softplus(C9_B_LOSS["pair_margin"] + risky_margin - safe_margin)


def c9b_row_derivative(margin: float, safe: bool) -> float:
    if safe:
        return sigmoid(margin) - 1.0 - sigmoid(C9_B_LOSS["anchor_margin"] - margin)
    return sigmoid(margin) + sigmoid(C9_B_LOSS["anchor_margin"] + margin)


def c9b_pair_derivatives(safe_margin: float, risky_margin: float) -> tuple[float, float]:
    pair = C9_B_LOSS["pair_weight"] * sigmoid(C9_B_LOSS["pair_margin"] + risky_margin - safe_margin)
    return c9b_row_derivative(safe_margin, True) / 2.0 - pair, c9b_row_derivative(risky_margin, False) / 2.0 + pair


class C9ShuffledCycle:
    def __init__(self, values: list[Any], rng: random.Random) -> None:
        if not values:
            raise ValueError("C9 balanced sampler has an empty family or label cell")
        self.values = list(values)
        self.rng = rng
        self.cursor = len(self.values)

    def draw(self) -> Any:
        if self.cursor == len(self.values):
            self.rng.shuffle(self.values)
            self.cursor = 0
        value = self.values[self.cursor]
        self.cursor += 1
        return value


class C9BalancedSampler:
    """Exactly half pair draws; singleton draws balance labels and families."""

    def __init__(self, rows: list[dict[str, Any]], pairs: list[dict[str, Any]], families: dict[str, str], seed: int = SEED) -> None:
        self.rng = random.Random(seed)
        self.draws = 0
        self.counts: dict[str, int] = {}
        pair_by_family: dict[str, list[dict[str, Any]]] = {}
        for pair in pairs:
            safe_family = families[pair["safe"]["source_id"]]
            if safe_family != families[pair["risky"]["source_id"]]:
                raise ValueError("C9 explicit pair crosses eligible families")
            pair_by_family.setdefault(safe_family, []).append({"kind": "pair", **pair})
        self.pair_families = C9ShuffledCycle(sorted(pair_by_family), self.rng)
        self.pair_items = {family: C9ShuffledCycle(sorted(items, key=lambda item: item["pair_id"]), self.rng) for family, items in pair_by_family.items()}
        row_by_label_family: dict[str, dict[str, list[dict[str, Any]]]] = {"allow": {}, "confirm": {}}
        for row in rows:
            label = "allow" if row["target_probabilities"] == [1, 0] else "confirm"
            family = families[row["source_id"]]
            row_by_label_family[label].setdefault(family, []).append({"kind": "single", "row": row})
        self.row_families = {label: C9ShuffledCycle(sorted(cells), self.rng) for label, cells in row_by_label_family.items()}
        self.row_items = {(label, family): C9ShuffledCycle(sorted(items, key=lambda item: item["row"]["source_id"]), self.rng) for label, cells in row_by_label_family.items() for family, items in cells.items()}

    def draw(self) -> dict[str, Any]:
        if self.draws % 2 == 0:
            family = self.pair_families.draw()
            unit = self.pair_items[family].draw()
            key = f"pair:{family}"
        else:
            label = C9_B_SAMPLER["row_label_order"][(self.draws // 2) % 2]
            family = self.row_families[label].draw()
            unit = self.row_items[(label, family)].draw()
            key = f"row:{label}:{family}"
        self.draws += 1
        self.counts[key] = self.counts.get(key, 0) + 1
        return unit


def c9b_objective_report(model: Any, rows: list[dict[str, Any]], pairs: list[dict[str, Any]], families: dict[str, str], progress: MemoryProgress | None = None) -> float:
    import mlx.core as mx

    model.eval()
    margins = {}
    for row in rows:
        tokens = allowed = margin = None
        try:
            tokens, allowed, _ = row_arrays(row)
            margin = selected_logit_margin(model, tokens, allowed)
            mx.eval(margin)
            value = float(margin.item())
            if not math.isfinite(value):
                raise ValueError("Nonfinite C9 selected logit margin")
            margins[row["source_id"]] = value
        finally:
            del tokens, allowed, margin
            progress.clear() if progress is not None else mx.clear_cache()
    pair_by_family: dict[str, list[float]] = {}
    for pair in pairs:
        family = families[pair["safe"]["source_id"]]
        pair_by_family.setdefault(family, []).append(c9b_pair_loss(margins[pair["safe"]["source_id"]], margins[pair["risky"]["source_id"]]))
    row_by_label_family: dict[str, dict[str, list[float]]] = {"allow": {}, "confirm": {}}
    for row in rows:
        safe = row["target_probabilities"] == [1, 0]
        label = "allow" if safe else "confirm"
        family = families[row["source_id"]]
        row_by_label_family[label].setdefault(family, []).append(c9b_row_loss(margins[row["source_id"]], safe))
    pair_mean = sum(sum(values) / len(values) for values in pair_by_family.values()) / len(pair_by_family)
    label_means = [sum(sum(values) / len(values) for values in cells.values()) / len(cells) for cells in row_by_label_family.values()]
    return (pair_mean + sum(label_means) / len(label_means)) / 2.0


def guardrail_training_units(rows: list[dict[str, Any]], pairs: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    used = {row["source_id"] for pair in pairs for row in (pair["safe"], pair["risky"])}
    units: dict[str, list[dict[str, Any]]] = {}
    for pair in pairs:
        units.setdefault(pair["group_id"], []).append({"kind": "pair", **pair})
    for row in rows:
        if row["source_id"] not in used:
            units.setdefault(row["group"], []).append({"kind": "single", "row": row})
    return units


def guardrail_objective_report(model: Any, units: dict[str, list[dict[str, Any]]], progress: MemoryProgress | None = None) -> float:
    import mlx.core as mx

    model.eval()
    losses = []
    for group in sorted(units):
        group_losses = []
        for unit in units[group]:
            margins = []
            for row in (unit["safe"], unit["risky"]) if unit["kind"] == "pair" else (unit["row"],):
                tokens = allowed = margin = None
                try:
                    tokens, allowed, _ = row_arrays(row)
                    margin = selected_logit_margin(model, tokens, allowed)
                    mx.eval(margin)
                    value = float(margin.item())
                    if not math.isfinite(value):
                        raise ValueError("Nonfinite guardrail logit margin")
                    margins.append(value)
                finally:
                    del tokens, allowed, margin
                    progress.clear() if progress is not None else mx.clear_cache()
            if unit["kind"] == "pair":
                group_losses.append(guardrail_pair_loss(*margins))
            else:
                group_losses.append(guardrail_row_loss(margins[0], unit["row"]["target_probabilities"] == [1, 0]))
        losses.append(sum(group_losses) / len(group_losses))
    return sum(losses) / len(losses)


def guardrail_margin_and_gradient(model: Any, row: dict[str, Any], value_and_grad: Any, progress: MemoryProgress) -> tuple[float, Any]:
    import mlx.core as mx

    tokens, allowed, _ = row_arrays(row)
    margin, gradient = value_and_grad(model, tokens, allowed)
    mx.eval(margin, gradient)
    value = float(margin.item())
    del tokens, allowed, margin
    if not math.isfinite(value):
        raise ValueError("Nonfinite guardrail logit margin")
    progress.clear()
    return value, gradient


def guardrail_unit_gradient(model: Any, unit: dict[str, Any], value_and_grad: Any, progress: MemoryProgress, arm_b: bool = False) -> tuple[float, Any]:
    import mlx.core as mx
    from mlx.utils import tree_map

    if unit["kind"] == "single":
        row = unit["row"]
        margin, gradient = guardrail_margin_and_gradient(model, row, value_and_grad, progress)
        coefficient = (c9b_row_derivative if arm_b else guardrail_row_derivative)(margin, row["target_probabilities"] == [1, 0])
        combined = tree_map(lambda value: coefficient * value, gradient)
        loss = (c9b_row_loss if arm_b else guardrail_row_loss)(margin, row["target_probabilities"] == [1, 0])
    else:
        safe_margin, safe_gradient = guardrail_margin_and_gradient(model, unit["safe"], value_and_grad, progress)
        risky_margin, risky_gradient = guardrail_margin_and_gradient(model, unit["risky"], value_and_grad, progress)
        safe_coefficient, risky_coefficient = (c9b_pair_derivatives if arm_b else guardrail_pair_derivatives)(safe_margin, risky_margin)
        combined = tree_map(lambda safe, risky: safe_coefficient * safe + risky_coefficient * risky, safe_gradient, risky_gradient)
        loss = (c9b_pair_loss if arm_b else guardrail_pair_loss)(safe_margin, risky_margin)
    mx.eval(combined)
    return loss, combined


def row_arrays(row: dict[str, Any]) -> tuple[Any, Any, Any]:
    import mlx.core as mx

    return (
        mx.array([row["prompt_token_ids"]], dtype=mx.int32),
        mx.array(row["allowed_token_ids"], dtype=mx.int32),
        mx.array(row["target_probabilities"], dtype=mx.float32),
    )


def evaluate_row(model: Any, row: dict[str, Any]) -> tuple[list[float], float]:
    import mlx.core as mx

    tokens = allowed = targets = logits = probabilities = loss = None
    try:
        tokens, allowed, targets = row_arrays(row)
        logits = mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32)
        probabilities = mx.softmax(logits)
        loss = -mx.sum(targets * (logits - mx.logsumexp(logits)))
        mx.eval(probabilities, loss)
        values = probabilities.tolist()
        scalar_loss = float(loss.item())
        if not math.isfinite(scalar_loss) or any(not math.isfinite(value) for value in values):
            raise ValueError(f"{row['id']}: model produced nonfinite values")
        return values, scalar_loss
    finally:
        # Release this frame's row arrays before the caller clears free buffers.
        del tokens, allowed, targets, logits, probabilities, loss


def evaluate_rows(model: Any, rows: list[dict[str, Any]], progress: MemoryProgress | None = None, phase: str = "evaluation") -> dict[str, Any]:
    import mlx.core as mx

    if progress is not None:
        progress.emit("phase_begin", phase=phase, rows_total=len(rows))
    model.eval()
    predictions = []
    correct = 0
    total_loss = 0.0
    for index, row in enumerate(rows, 1):
        try:
            values, scalar_loss = evaluate_row(model, row)
        finally:
            progress.clear() if progress is not None else mx.clear_cache()
        prediction = max(range(len(values)), key=values.__getitem__)
        target = max(range(len(values)), key=row["target_probabilities"].__getitem__)
        correct += prediction == target
        total_loss += scalar_loss
        predictions.append({"id": row["id"], "group": row["group"], "split": row["split"], "probabilities": values, "selected_index": prediction, "loss": scalar_loss})
        if progress is not None and (index % PROGRESS_ROW_INTERVAL == 0 or index == len(rows)):
            progress.emit("evaluation_progress", phase=phase, rows_completed=index, rows_total=len(rows))
    if progress is not None:
        progress.emit("phase_end", phase=phase, rows_completed=len(rows), rows_total=len(rows))
    return {"rows": len(rows), "mean_loss": total_loss / len(rows), "selected_label_accuracy": correct / len(rows), "predictions": predictions}


def train(args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.output).expanduser().resolve()
    adapter = output / "adapter"
    if adapter.exists():
        raise ValueError("The output adapter directory already exists; use a new run directory")
    with MemoryProgress(output / "worker-progress.jsonl") as progress:
        return train_with_progress(args, output, adapter, progress)


def train_with_progress(args: argparse.Namespace, output: Path, adapter: Path, progress: MemoryProgress) -> dict[str, Any]:
    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optimizers
    from mlx.utils import tree_flatten, tree_map
    from mlx_lm.tuner.utils import linear_to_lora_layers

    identity = provenance()
    pair_path = Path(args.guardrail_pairs).expanduser().resolve() if getattr(args, "guardrail_pairs", None) else None
    plan_path = Path(args.guardrail_plan).expanduser().resolve() if getattr(args, "guardrail_plan", None) else None
    family_path = Path(args.guardrail_families).expanduser().resolve() if getattr(args, "guardrail_families", None) else None
    if (pair_path is None) != (plan_path is None):
        raise ValueError("Guardrail pair manifest and TRAIN objective plan must be supplied together")
    if family_path is not None and pair_path is None:
        raise ValueError("C9 FIT family manifest requires a guardrail TRAIN plan")
    if pair_path is not None and args.validation_data:
        raise ValueError("Guardrail pair training cannot inspect a validation split")
    train_content = Path(args.data).read_bytes()
    train_sha256 = hashlib.sha256(train_content).hexdigest()
    rows = read_rows(Path(args.data), "train", train_content)
    validation = read_rows(Path(args.validation_data), "validation") if args.validation_data else []
    pair_content = pair_path.read_bytes() if pair_path is not None else None
    plan_content = plan_path.read_bytes() if plan_path is not None else None
    family_content = family_path.read_bytes() if family_path is not None else None
    pair_sha256 = hashlib.sha256(pair_content).hexdigest() if pair_content is not None else None
    plan_sha256 = hashlib.sha256(plan_content).hexdigest() if plan_content is not None else None
    family_sha256 = hashlib.sha256(family_content).hexdigest() if family_content is not None else None
    plan = read_guardrail_plan(plan_path, pair_sha256, plan_content, family_sha256) if plan_path is not None else None
    if plan is not None and ((plan.get("version") == 2) != (family_path is not None)):
        raise ValueError("C9 family manifest is required only for C9 TRAIN plans")
    if plan is not None and plan.get("version") == 2 and args.steps != plan["steps"]:
        raise ValueError("C9 optimizer schedule differs from frozen TRAIN plan")
    pairs = read_guardrail_pairs(pair_path, rows, pair_content) if pair_path is not None else []
    families = read_guardrail_families(family_path, rows, family_content) if family_path is not None else {}
    arm_b = plan is not None and plan.get("arm") == "B"
    sampler = C9BalancedSampler(rows, pairs, families, plan["sampler"]["seed"]) if arm_b else None
    pair_units = guardrail_training_units(rows, pairs) if pair_path is not None else {}
    model_dir = resolve_model(args.model, fetch=True)
    if validation:
        if {row["group"] for row in rows} & {row["group"] for row in validation}:
            raise ValueError("Training and validation context/source groups overlap")
        if validation[0]["template_version"] != rows[0]["template_version"]:
            raise ValueError("Training and validation template versions differ")
    tokenizer = load_tokenizer(model_dir)
    parity = verify_prompt_parity(tokenizer, rows + validation)
    random.seed(SEED)
    mx.random.seed(SEED)
    progress.emit("phase_begin", phase="model_load")
    model, _, _ = load_model(model_dir)
    model.freeze()
    linear_to_lora_layers(model, 26, LORA)
    trainable = dict(tree_flatten(model.trainable_parameters()))
    if len(trainable) != 104 or any(not name.endswith((".lora_a", ".lora_b")) for name in trainable):
        raise ValueError("Expected exactly query/value LoRA parameters in all 26 Gemma layers")
    mx.eval(trainable)
    initial_parameters = {name: mx.array(value) for name, value in trainable.items()}
    progress.emit("phase_end", phase="model_load")
    initial_report = evaluate_rows(model, rows, progress, "initial_evaluation")
    initial_objective = c9b_objective_report(model, rows, pairs, families, progress) if arm_b else guardrail_objective_report(model, pair_units, progress) if pair_path is not None else initial_report["mean_loss"]
    optimizer = optimizers.Adam(learning_rate=LEARNING_RATE)
    loss_and_grad = nn.value_and_grad(model, selected_logit_margin if pair_path is not None else selected_loss)
    adapter.mkdir(parents=True)
    history = []
    order = list(range(len(rows)))
    group_order = sorted(pair_units)
    group_visits = {group: 0 for group in group_order}
    cursor = 0
    started = time.monotonic()
    model.train()
    progress.emit("phase_begin", phase="optimization", steps_total=args.steps)
    for step in range(args.steps):
        accumulated = None
        losses = []
        for _ in range(ACCUMULATION):
            if sampler is not None:
                unit = sampler.draw()
                scalar, gradients = guardrail_unit_gradient(model, unit, loss_and_grad, progress, arm_b=True)
            elif pair_path is None:
                if cursor % len(order) == 0:
                    random.shuffle(order)
                row = rows[order[cursor % len(order)]]
                loss, gradients = loss_and_grad(model, *row_arrays(row))
                mx.eval(loss, gradients)
                scalar = float(loss.item())
                del loss
            else:
                if cursor % len(group_order) == 0:
                    random.shuffle(group_order)
                group = group_order[cursor % len(group_order)]
                units = pair_units[group]
                unit = units[group_visits[group] % len(units)]
                group_visits[group] += 1
                scalar, gradients = guardrail_unit_gradient(model, unit, loss_and_grad, progress)
            cursor += 1
            if not math.isfinite(scalar):
                raise ValueError(f"Nonfinite loss at optimizer step {step + 1}")
            losses.append(scalar)
            accumulated = gradients if accumulated is None else tree_map(lambda total, current: total + current, accumulated, gradients)
            mx.eval(accumulated)
            del gradients
            progress.clear()
        gradients = tree_map(lambda gradient: gradient / ACCUMULATION, accumulated)
        if any(not bool(mx.all(mx.isfinite(gradient)).item()) for _, gradient in tree_flatten(gradients)):
            raise ValueError(f"Nonfinite gradient at optimizer step {step + 1}")
        optimizer.update(model, gradients)
        mx.eval(model.parameters(), optimizer.state)
        del gradients, accumulated
        progress.clear()
        history.append({"step": step + 1, "loss": sum(losses) / len(losses)})
        progress.emit("training_step", phase="optimization", steps_total=args.steps, **history[-1])
    progress.emit("phase_end", phase="optimization", steps_completed=args.steps, steps_total=args.steps)
    changed = any(bool(mx.any(value != initial_parameters[name]).item()) for name, value in tree_flatten(model.trainable_parameters()))
    final_report = evaluate_rows(model, rows, progress, "final_evaluation")
    final_objective = c9b_objective_report(model, rows, pairs, families, progress) if arm_b else guardrail_objective_report(model, pair_units, progress) if pair_path is not None else final_report["mean_loss"]
    validation_report = evaluate_rows(model, validation, progress, "validation_evaluation") if validation else None
    if pair_path is not None and sha256(pair_path) != pair_sha256:
        raise ValueError("Guardrail TRAIN pair manifest changed during optimization")
    if plan_path is not None and sha256(plan_path) != plan_sha256:
        raise ValueError("Guardrail TRAIN objective plan changed during optimization")
    if family_path is not None and sha256(family_path) != family_sha256:
        raise ValueError("C9 FIT family manifest changed during optimization")
    if sha256(Path(args.data)) != train_sha256:
        raise ValueError("TRAIN data changed during optimization")
    weights = dict(tree_flatten(model.trainable_parameters()))
    mx.save_safetensors(str(adapter / "adapters.safetensors"), weights)
    write_json(adapter / "adapter_config.json", {"fine_tune_type": "lora", "num_layers": 26, "lora_parameters": LORA})
    manifest = {
        "schema_version": 1,
        "objective": plan["objective"] if plan is not None else "selected_label_soft_cross_entropy_at_final_real_prompt_position",
        "template_version": rows[0]["template_version"],
        "provenance": identity,
        "prompt_parity": parity,
        "training_data_sha256": train_sha256,
        "validation_data_sha256": sha256(Path(args.validation_data)) if args.validation_data else None,
        "adapter_sha256": sha256(adapter / "adapters.safetensors"),
        "hyperparameters": {"batch_size": 1, "gradient_accumulation": ACCUMULATION, "learning_rate": LEARNING_RATE, "seed": SEED, "max_prompt_tokens": MAX_PROMPT_TOKENS, "truncation": False, "lora": LORA, "layers": 26, "steps": args.steps},
        "adapter_dir": str(adapter),
        "initial_loss": initial_objective,
        "final_loss": final_objective,
        "steps": args.steps,
        "adapter_changed": changed,
        "training_loss_decreased": final_objective < initial_objective,
        "reload_verified": False,
        "duration_seconds": time.monotonic() - started,
        "history": history,
        "validation": validation_report,
        "memory": progress.summary(),
    }
    if pair_path is not None:
        pair_report = {"file": str(pair_path), "sha256": pair_sha256, "pairs": len(pairs), "groups": len(pair_units), "pair_margin": GUARDRAIL_PAIR_MARGIN, "anchor_margin": GUARDRAIL_ANCHOR_MARGIN, "ce_weight": GUARDRAIL_CE_WEIGHT, "anchor_weight": GUARDRAIL_ANCHOR_WEIGHT, "group_balanced": True} if plan["version"] == 1 else {"file": str(pair_path), "sha256": pair_sha256, "pairs": len(pairs), "groups": len(pair_units), "loss": plan["loss"], "group_balanced": not arm_b}
        manifest.update({
            "selected_ce_initial_loss": initial_report["mean_loss"],
            "selected_ce_final_loss": final_report["mean_loss"],
            "guardrail_pairs": pair_report,
            "guardrail_train_plan": {"file": str(plan_path), "sha256": plan_sha256, "content": plan},
        })
    if family_path is not None:
        manifest["guardrail_fit_families"] = {"file": str(family_path), "sha256": family_sha256, "rows": len(families), "families": sorted(set(families.values()))}
    if sampler is not None:
        manifest["c9_balanced_sampler"] = {"configuration": C9_B_SAMPLER, "draws": sampler.draws, "counts": dict(sorted(sampler.counts.items()))}
    write_json(adapter / "rfdt-manifest.json", manifest)
    # Release model/optimizer state before constructing a fresh checkpoint load.
    expected_predictions = final_report["predictions"]
    del model, optimizer, loss_and_grad, weights, trainable, initial_parameters
    import gc

    gc.collect()
    progress.clear()
    progress.emit("phase_begin", phase="adapter_reload")
    reloaded, _, _ = load_model(model_dir, adapter)
    progress.emit("phase_end", phase="adapter_reload")
    reload_report = evaluate_rows(reloaded, rows, progress, "reload_evaluation")
    delta = max(abs(before - after) for expected, actual in zip(expected_predictions, reload_report["predictions"]) for before, after in zip(expected["probabilities"], actual["probabilities"]))
    manifest["reload_max_probability_delta"] = delta
    manifest["reload_verified"] = delta <= 1e-5
    manifest["memory"] = progress.summary()
    write_json(adapter / "rfdt-manifest.json", manifest)
    write_json(output / "training-report.json", manifest)
    if not changed or not manifest["reload_verified"]:
        raise ValueError("Training did not change adapters or checkpoint reload failed equivalence")
    progress.emit("worker_complete", phase="complete", steps_completed=args.steps, adapter_changed=changed, reload_verified=manifest["reload_verified"])
    return {"ok": True, **manifest}


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    with MemoryProgress() as progress:
        return evaluate_with_progress(args, progress)


def evaluate_with_progress(args: argparse.Namespace, progress: MemoryProgress) -> dict[str, Any]:
    identity = provenance()
    rows = read_rows(Path(args.data), args.split)
    adapter = Path(args.adapter).expanduser().resolve() if args.adapter else None
    if adapter:
        validate_adapter(adapter, rows[0]["template_version"])
    model_dir = resolve_model(args.model, fetch=True)
    parity = verify_prompt_parity(load_tokenizer(model_dir), rows)
    progress.emit("phase_begin", phase="model_load")
    model, _, _ = load_model(model_dir, adapter)
    progress.emit("phase_end", phase="model_load")
    report = evaluate_rows(model, rows, progress)
    return {"ok": True, "provenance": identity, "prompt_parity": parity, "adapter_dir": str(adapter) if adapter else None, **report, "memory": progress.summary()}


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


def fuse(args: argparse.Namespace) -> dict[str, Any]:
    # Fusion keeps progress on stderr so observing it cannot create the fresh
    # output directory before the existing output guard and model saver.
    with MemoryProgress() as progress:
        return fuse_with_progress(args, progress)


def fuse_with_progress(args: argparse.Namespace, progress: MemoryProgress) -> dict[str, Any]:
    import mlx.core as mx
    from mlx.utils import tree_map, tree_unflatten
    from mlx_lm.tuner.utils import load_adapters
    from mlx_lm.utils import save

    identity = provenance()
    adapter = Path(args.adapter).expanduser().resolve()
    manifest = validate_adapter(adapter)
    data_path, rows = fusion_training_rows(adapter, manifest, getattr(args, "data", None))
    model_dir = resolve_model(args.model, fetch=True)
    source_parity = verify_prompt_parity(load_tokenizer(model_dir), rows)
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise ValueError("The fusion output already exists; use a new directory")
    progress.emit("phase_begin", phase="fusion")
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
    progress.clear()
    progress.emit("phase_end", phase="fusion")
    projection = project_text_tokenizer(model_dir, output, config["vocab_size"])
    export_tokenizer = load_tokenizer(output)
    if any(type(token) is not int or not 0 <= token < config["vocab_size"] for token in export_tokenizer.get_vocab().values()):
        raise ValueError("Projected export tokenizer contains a token outside the trained embedding vocabulary")
    export_parity = verify_prompt_parity(export_tokenizer, rows)
    projection["prompt_parity"] = {"source": source_parity, "export": export_parity, "training_data_file": str(data_path), "training_data_sha256": sha256(data_path)}
    files = {file.name: sha256(file) for file in sorted(output.iterdir()) if file.is_file()}
    result = {"ok": True, "fused": True, "fusion_dtype": "float32", "output_dir": str(output), "format": "safetensors", "gguf_exported": False, "provenance": identity, "template_version": manifest["template_version"], "adapter_sha256": manifest["adapter_sha256"], "tokenizer_projection": projection, "files": files, "memory": progress.summary()}
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


def self_test(args: argparse.Namespace) -> dict[str, Any]:
    """Weights-free math/gradient fixture; never evidence about the real checkpoint."""
    import mlx.core as mx

    mx.set_default_device(mx.cpu)
    with MemoryProgress() as progress:
        return self_test_with_progress(args, progress)


def self_test_with_progress(_: argparse.Namespace, progress: MemoryProgress) -> dict[str, Any]:
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
    progress.clear()
    leaves = dict(tree_flatten(gradients))
    first_layer = [gradient for name, gradient in leaves.items() if "layers.0." in name]
    if not first_layer or not any(bool(mx.any(gradient != 0).item()) for gradient in first_layer):
        raise ValueError("Selected-answer loss did not propagate into the first context layer")
    optimizer = optimizers.Adam(learning_rate=1e-3)
    for _ in range(8):
        _, gradients = value_and_grad(model, tokens, allowed, targets)
        optimizer.update(model, gradients)
        mx.eval(model.parameters(), optimizer.state)
        progress.clear()
    after = selected_loss(model, tokens, allowed, targets)
    mx.eval(after)
    if float(after.item()) >= float(before.item()):
        raise ValueError("Tiny Gemma selected-answer loss did not decrease")
    changed = any(bool(mx.any(parameter != initial_adapters[name]).item()) for name, parameter in tree_flatten(model.trainable_parameters()))
    expected = mx.softmax(mx.take(final_logits(model, tokens)[0], allowed).astype(mx.float32))
    fixture_row = {"id": "tiny-full-context", "group": "tiny-full-context", "split": "train", "prompt_token_ids": tokens.tolist()[0], "allowed_token_ids": allowed.tolist(), "target_probabilities": targets.tolist()}
    row_report = evaluate_rows(model, [fixture_row], progress, "fixture_evaluation")
    row_delta = max(abs(before - after) for before, after in zip(expected.tolist(), row_report["predictions"][0]["probabilities"]))
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
    if not changed or reload_delta > 1e-5 or fusion_delta > 1e-5 or row_delta > 1e-6 or len(linears) != 12:
        raise ValueError("Tiny Gemma adapter change/reload/fusion equivalence failed")
    return {"ok": True, "fixture": "random_tiny_gemma3_no_checkpoint_weights", "device": "cpu", "dependencies": identity, "full_context_gradient_verified": True, "initial_loss": float(before.item()), "final_loss": float(after.item()), "trainable_leaves": len(leaves), "adapter_changed": changed, "reload_verified": True, "reload_max_probability_delta": reload_delta, "fusion_verified": True, "fusion_max_probability_delta": fusion_delta, "fusion_dtype": "float32", "evaluation_max_probability_delta": row_delta, "selected_probabilities": expected.tolist(), "memory": progress.summary()}


def guardrail_pair_self_test(_: argparse.Namespace, arm_b: bool = False) -> dict[str, Any]:
    """Compare the memory-bounded pair gradient with direct autograd on random tiny Gemma."""
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten
    from mlx_lm.models.gemma3_text import Model, ModelArgs
    from mlx_lm.tuner.utils import linear_to_lora_layers

    mx.set_default_device(mx.cpu)
    identity = dependencies()
    with MemoryProgress() as progress:
        mx.random.seed(SEED)
        args = ModelArgs(model_type="gemma3_text", hidden_size=16, intermediate_size=32, num_hidden_layers=6, num_attention_heads=2, num_key_value_heads=1, head_dim=8, vocab_size=64, sliding_window=16, max_position_embeddings=64)
        model = Model(args)
        model.freeze()
        linear_to_lora_layers(model, 6, {**LORA, "rank": 4})
        model.train()
        allowed = mx.array([2, 3], dtype=mx.int32)
        safe_tokens = mx.array([[1, 7, 12, 3, 21]], dtype=mx.int32)
        risky_tokens = mx.array([[1, 7, 12, 3, 22]], dtype=mx.int32)

        def direct_loss(model: Any, safe_tokens: Any, risky_tokens: Any, allowed: Any) -> Any:
            safe = selected_logit_margin(model, safe_tokens, allowed)
            risky = selected_logit_margin(model, risky_tokens, allowed)
            zero = mx.array(0.0)
            if arm_b:
                rows = (mx.logaddexp(zero, -safe) + mx.logaddexp(zero, risky) + mx.logaddexp(zero, C9_B_LOSS["anchor_margin"] - safe) + mx.logaddexp(zero, C9_B_LOSS["anchor_margin"] + risky)) / 2.0
                return rows + C9_B_LOSS["pair_weight"] * mx.logaddexp(zero, C9_B_LOSS["pair_margin"] + risky - safe)
            return mx.logaddexp(zero, GUARDRAIL_PAIR_MARGIN + risky - safe) + (GUARDRAIL_CE_WEIGHT / 2.0) * (mx.logaddexp(zero, -safe) + mx.logaddexp(zero, risky)) + GUARDRAIL_ANCHOR_WEIGHT * (mx.logaddexp(zero, GUARDRAIL_ANCHOR_MARGIN - safe) + mx.logaddexp(zero, GUARDRAIL_ANCHOR_MARGIN + risky))

        direct, direct_gradient = nn.value_and_grad(model, direct_loss)(model, safe_tokens, risky_tokens, allowed)
        mx.eval(direct, direct_gradient)
        direct_value = float(direct.item())
        direct_leaves = {name: value.tolist() for name, value in tree_flatten(direct_gradient)}
        direct_peak = int(mx.get_peak_memory())
        del direct, direct_gradient
        import gc
        gc.collect()
        progress.clear()
        safe_row = {"id": "tiny-safe:risk", "source_id": "tiny-safe", "group": "tiny-pair", "split": "train", "prompt_token_ids": safe_tokens.tolist()[0], "allowed_token_ids": allowed.tolist(), "target_probabilities": [1, 0]}
        risky_row = {"id": "tiny-risky:risk", "source_id": "tiny-risky", "group": "tiny-pair", "split": "train", "prompt_token_ids": risky_tokens.tolist()[0], "allowed_token_ids": allowed.tolist(), "target_probabilities": [0, 1]}
        unit = {"kind": "pair", "safe": safe_row, "risky": risky_row}
        mx.reset_peak_memory()
        sequential, sequential_gradient = guardrail_unit_gradient(model, unit, nn.value_and_grad(model, selected_logit_margin), progress, arm_b=arm_b)
        sequential_peak = int(mx.get_peak_memory())
        sequential_leaves = dict(tree_flatten(sequential_gradient))
        if direct_leaves.keys() != sequential_leaves.keys():
            raise ValueError("Pair gradient changed the trainable parameter set")
        gradient_delta = max(float(mx.max(mx.abs(mx.array(direct_leaves[name]) - sequential_leaves[name])).item()) for name in direct_leaves)
        first_layer = [gradient for name, gradient in sequential_leaves.items() if "layers.0." in name]
        if not first_layer or not any(bool(mx.any(gradient != 0).item()) for gradient in first_layer):
            raise ValueError("Pair loss did not reach the first context layer")
        if abs(direct_value - sequential) > 1e-5 or gradient_delta > 1e-4:
            raise ValueError("Sequential pair gradient differs from direct autograd")
        if sequential_peak > 128 * 1024 * 1024:
            raise ValueError("Tiny sequential pair gradient exceeded its memory envelope")
        del direct_leaves, sequential_gradient, sequential_leaves
        progress.clear()
        return {"ok": True, "fixture": "random_tiny_gemma3_c9b_pair_no_checkpoint_weights" if arm_b else "random_tiny_gemma3_pair_no_checkpoint_weights", "device": "cpu", "dependencies": identity, "direct_loss": direct_value, "sequential_loss": sequential, "max_gradient_delta": gradient_delta, "direct_peak_memory_bytes": direct_peak, "sequential_peak_memory_bytes": sequential_peak, "full_context_gradient_verified": True, "memory": progress.summary()}


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
            command.add_argument("--guardrail-pairs", help="Explicit TRAIN-only allow/confirm pairs; enables the optional guardrail margin objective")
            command.add_argument("--guardrail-plan", help="Hash-pinned TRAIN-only objective and loss parameters; required with guardrail pairs")
            command.add_argument("--guardrail-families", help="C9 FIT-only source/group/family/label map; required by C9 TRAIN plans")
            command.add_argument("--steps", type=int, default=8)
        elif name == "evaluate":
            command.add_argument("--adapter")
            command.add_argument("--split", choices=["train", "validation", "test"])
        elif name == "fuse":
            command.add_argument("--adapter", required=True)
            command.add_argument("--data")
        elif name == "doctor":
            command.add_argument("--data")
            command.add_argument("--fetch", action="store_true")
    command = commands.add_parser("fetch")
    command.add_argument("--output", required=True)
    command.add_argument("--accept-gemma-terms", action="store_true")
    commands.add_parser("self-test")
    commands.add_parser("pair-self-test")
    commands.add_parser("c9-pair-self-test")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "train" and not 1 <= args.steps <= 100000:
            raise ValueError("--steps must be 1..100000 optimizer updates")
        # Third-party status output goes to stderr; stdout stays one JSON object.
        with contextlib.redirect_stdout(sys.stderr):
            result = {"doctor": doctor, "fetch": fetch, "train": train, "evaluate": evaluate, "fuse": fuse, "self-test": self_test, "pair-self-test": guardrail_pair_self_test, "c9-pair-self-test": lambda value: guardrail_pair_self_test(value, arm_b=True)}[args.command](args)
        print(json.dumps(result, allow_nan=False), flush=True)
        return 0 if result.get("ok") else 1
    except Exception as error:
        print(json.dumps({"ok": False, "command": args.command, "error": str(error), "error_type": type(error).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
